import { InlineKeyboard, type Bot, type Context } from "grammy";
import { PublicKey } from "@solana/web3.js";

import {
  createSolConversionUtilities,
  type PendingSendTransaction,
} from "../bot/flows/sol-conversion";
import {
  MIN_SOL_FOR_TX,
  WSOL_MINT,
  INPUT_TIMEOUT_HINT,
} from "../utils/constants";
import {
  createBackToWalletKeyboard,
  createCancelKeyboard,
  createConfirmUnwrapKeyboard,
  createConfirmWrapKeyboard,
  createTradeConfirmKeyboard,
} from "../utils/keyboards";
import {
  buildQuickAmountKeyboard,
  buildWalletActionMenuForUser,
  persistInputPrompt,
  persistInputPromptFromContext,
  showCustomAmountPrompt,
  upsertWalletMenuMessage,
  type QuickAmountKeyboardConfig,
  type WalletMenuBalances,
} from "../utils/wallet-ui";
import { respondWithMenu } from "../utils/menu-response";
import {
  safeAnswerCallbackQuery,
  resolveTelegramIdOrRespond,
  requireTelegramId,
  getTelegramId,
  getTelegramIdString,
} from "../utils/context-helpers";
import { presentTradeAmount, parseDecimalAmount } from "../utils/amount";
import { escapeHtml } from "../utils/format-amount";
import { formatUserFriendlyError } from "../utils/errors";
import { buildTransactionLinkMessage, NetworkDetector } from "../utils/network-detector";
import {
  storePendingTransaction,
  getPendingTransaction,
  type InputSessionState,
} from "../utils/user-state";
import type { WalletManager } from "../utils/wallet";
import type {
  WalletActionMenuHandlerConfig,
  WalletCacheSnapshot as CachedWalletData,
} from "./wallet-menu";
import type { RegisterCallbackPrefixHandler, WrapCallbackHandler } from "../utils/callback-registry";
import type { TokenBalanceLike } from "../types/wallet";
import { generateTransactionId } from "../utils/transaction-id";

type PresentSpendAmountParams = {
  amount: string;
  assetTicker: string;
  decimals: number;
  solBalance: number;
  tokenBalance?: TokenBalanceLike;
  formatSol: (lamports: number) => string;
  formatToken: (amount: number, decimals: number) => string;
  applySolFeeBuffer?: boolean;
  solFeeBufferLamports?: number;
};

type SendAmountPromptParams = {
  token: string;
  rawAmount: string;
  decimals: number;
  solBalance: number;
  tokenBalance?: TokenBalanceLike;
  exampleAddress?: string;
  formatSol: (lamports: number) => string;
  formatToken: (amount: number, decimals: number) => string;
  solFeeBufferLamports: number;
};

type SendAmountPromptResult = {
  displayLabel: string;
  storedAmount: string;
  messageText: string;
};

type WrapConfirmationParams = {
  lamportsToWrap: number;
  availableSolLamports: number;
  currentWsolLamports: number;
  selectionLabel?: string;
};

type WrapConfirmationResult = {
  text: string;
  keyboard: InlineKeyboard;
  displayAmount: string;
};

export type WalletTransactionsModuleOptions = {
  bot: Bot;
  wallet: WalletManager;
  registerWalletActionMenuHandler: (
    config: WalletActionMenuHandlerConfig
  ) => void;
  registerCallbackPrefixHandler: RegisterCallbackPrefixHandler;
  defaultWalletActionMenuDeps: {
    requireTelegramId: typeof requireTelegramId;
    getWalletAddress: (telegramId: bigint) => string;
    getWalletBalances: (telegramId: bigint) => Promise<WalletMenuBalances>;
    formatSolBalance: (lamports: number) => string;
    formatTokenBalance: (balance: number, decimals: number) => string;
  };
  getCachedWalletData: (telegramId: bigint) => Promise<CachedWalletData>;
  clearWalletCache: (telegramId: bigint) => void;
  wrapCallbackHandler: WrapCallbackHandler;
  getSolFeeBufferLamports: () => number;
};

export type WalletTransactionsModule = {
  registerHandlers: () => void;
  executeWrapFlow: ReturnType<typeof createSolConversionUtilities>["executeWrapFlow"];
  executeUnwrapFlow: ReturnType<typeof createSolConversionUtilities>["executeUnwrapFlow"];
  validatePendingTransaction: ReturnType<
    typeof createSolConversionUtilities
  >["validatePendingTransaction"];
  presentSpendAmount: (params: PresentSpendAmountParams) => {
    rawAmount: number;
    displayAmount: string;
    normalizedAmount: string;
  };
  buildQuickAmountKeyboard: (config: QuickAmountKeyboardConfig) => InlineKeyboard;
  buildWrapConfirmation: (params: WrapConfirmationParams) => WrapConfirmationResult;
  handleCustomAmountInput: (
    ctx: Context,
    userState: any,
    amount: string
  ) => Promise<void>;
  handleAddressInput: (
    ctx: Context,
    userState: any,
    address: string
  ) => Promise<void>;
  handleWrapAmountInput: (
    ctx: Context,
    userState: any,
    amount: string
  ) => Promise<void>;
  renderSolConversionSuccess: typeof renderSolConversionSuccess;
  buildSolscanSuccessMessage: typeof buildSolscanSuccessMessage;
};

const toRawAmount = (value: string, decimals: number): number =>
  parseDecimalAmount(value, decimals, { returnType: "number" });

const tryGetUserWalletAddress = (
  wallet: WalletManager,
  telegramId: bigint
): string | undefined => {
  if (telegramId === 0n) {
    return undefined;
  }

  try {
    return wallet.getKeyPair(telegramId).publicKey.toBase58();
  } catch {
    return undefined;
  }
};

const buildSolscanSuccessMessage = ({
  title,
  bodyLines,
  signature,
  linkText = "🔗 View transaction",
}: {
  title: string;
  bodyLines: string[];
  signature?: string;
  linkText?: string;
}): { text: string; disablePreview: boolean } => {
  const lines: string[] = [title];
  const normalizedBody = bodyLines.filter(
    (line) => typeof line === "string" && line.trim().length > 0
  );

  if (normalizedBody.length > 0) {
    lines.push("", ...normalizedBody);
  }

  const { message, previewDisabled, solscanUrl } =
    buildTransactionLinkMessage({
      signature,
      networkOverride: process.env["SOLANA_NETWORK"],
      linkText,
      format: "html",
      fallbackToSignature: false,
    });

  let finalMessage = message;
  let disablePreview = previewDisabled;

  if (!solscanUrl && signature) {
    const fallbackUrl = NetworkDetector.buildSolscanTxUrl(signature, "mainnet");
    if (fallbackUrl) {
      finalMessage = `<a href="${fallbackUrl}">${linkText}</a>`;
      disablePreview = true;
    }
  }

  if (finalMessage) {
    lines.push("", finalMessage);
  }

  return { text: lines.join("\n"), disablePreview };
};

const assertSessionOwnership = (
  ctx: Context,
  session: Pick<InputSessionState, "initiatorId">
): string => {
  const userId = getTelegramIdString(ctx);

  if (!userId) {
    throw new Error("Unable to resolve user for prompt session");
  }

  if (
    typeof session?.initiatorId === "string" &&
    session.initiatorId.length > 0 &&
    session.initiatorId !== userId
  ) {
    throw new Error("Input prompt locked to a different user");
  }

  return userId;
};

const renderSolConversionSuccess = ({
  kind,
  formattedAmount,
  signature,
}: {
  kind: "wrap" | "unwrap";
  formattedAmount: string | undefined;
  signature: string;
}): { text: string; disablePreview: boolean } => {
  const safeAmount = escapeHtml(formattedAmount ?? "0");
  const { title, body } =
    kind === "wrap"
      ? {
          title: "✅ <b>Wrap Completed</b>",
          body: `Wrapped ${safeAmount} SOL to WSOL`,
        }
      : {
          title: "✅ <b>Unwrap Completed</b>",
          body: `Unwrapped ${safeAmount} WSOL to SOL`,
        };

  return buildSolscanSuccessMessage({
    title,
    bodyLines: [body],
    signature,
  });
};

const renderSendSuccessMessage = ({
  formattedAmount,
  token,
  address,
  signature,
}: {
  formattedAmount: string | undefined;
  token: string | undefined;
  address: string | undefined;
  signature: string;
}): { text: string; disablePreview: boolean } => {
  const safeAmount = escapeHtml(formattedAmount ?? "");
  const safeToken = escapeHtml(token ?? "");
  const safeAddress = escapeHtml(address ?? "");

  return buildSolscanSuccessMessage({
    title: "✅ <b>Transaction Completed</b>",
    bodyLines: [
      `Sent ${safeAmount} ${safeToken}`,
      `To: <code>${safeAddress}</code>`,
    ],
    signature,
    linkText: "🔗 View transaction",
  });
};

export const createWalletTransactionsModule = (
  options: WalletTransactionsModuleOptions
): WalletTransactionsModule => {
  const {
    bot,
    wallet,
    registerWalletActionMenuHandler,
    registerCallbackPrefixHandler,
    defaultWalletActionMenuDeps,
    getCachedWalletData,
    clearWalletCache,
    wrapCallbackHandler,
    getSolFeeBufferLamports,
  } = options;

  const presentSpendAmount = ({
    amount,
    assetTicker,
    decimals,
    solBalance,
    tokenBalance,
    formatSol,
    formatToken,
    applySolFeeBuffer = true,
    solFeeBufferLamports = getSolFeeBufferLamports(),
  }: PresentSpendAmountParams) => {
    const presentation = presentTradeAmount({
      amount,
      assetTicker,
      decimals,
      solBalance,
      tokenBalance,
      applySolFeeBuffer,
      ...(applySolFeeBuffer
        ? {
            solFeeBufferLamports,
            insufficientSolForFeesMessage:
              "Not enough SOL to cover purchase and fees",
            insufficientSolBalanceMessage:
              "Insufficient SOL balance for this purchase",
          }
        : {}),
      formatSol,
      formatToken,
    });

    return {
      rawAmount: presentation.rawAmount,
      displayAmount: presentation.displayAmount,
      normalizedAmount: presentation.normalizedAmount,
    };
  };

  const resolveSendAmountSelection = ({
    token,
    rawAmount,
    decimals,
    solBalance,
    tokenBalance,
    exampleAddress,
    formatSol,
    formatToken,
    solFeeBufferLamports,
  }: SendAmountPromptParams): SendAmountPromptResult => {
    const spend = presentSpendAmount({
      amount: rawAmount,
      assetTicker: token,
      decimals,
      solBalance,
      tokenBalance,
      formatSol,
      formatToken,
      applySolFeeBuffer: true,
      solFeeBufferLamports,
    });

    const normalized = rawAmount.trim();
    const lower = normalized.toLowerCase();
    const displayLabel = (() => {
      if (lower === "max") {
        return `MAX (~${spend.displayAmount} ${token})`;
      }
      if (normalized.endsWith("%")) {
        return `${normalized} (~${spend.displayAmount} ${token})`;
      }
      return `${spend.displayAmount} ${token}`;
    })();

    const storedAmount = lower === "max" ? "max" : spend.displayAmount;

    const response = [
      `📤 <b>Send ${escapeHtml(displayLabel)}</b>`,
      "",
      `<b>Step 2:</b> Enter destination address`,
      "",
      `Reply to this message with the Solana wallet address.`,
      "",
      `<b>Format:</b> Public key (44 characters)`,
    ];

    if (exampleAddress) {
      response.push(`<b>Example:</b> <code>${escapeHtml(exampleAddress)}</code>`);
    }

    response.push("", INPUT_TIMEOUT_HINT);

    return {
      displayLabel,
      storedAmount,
      messageText: response.join("\n"),
    };
  };

  const buildWrapConfirmation = ({
    lamportsToWrap,
    availableSolLamports,
    currentWsolLamports,
    selectionLabel,
  }: WrapConfirmationParams): WrapConfirmationResult => {
    const displayAmount = wallet.formatSolBalance(lamportsToWrap);
    const availableSolDisplay = wallet.formatSolBalance(availableSolLamports);
    const currentWsolDisplay = wallet.formatSolBalance(currentWsolLamports);

    const lines = [
      `✅ <b>Wrap Confirmation</b>`,
      "",
      `<b>Amount:</b> ${escapeHtml(displayAmount)} SOL → WSOL`,
      `<b>Available SOL:</b> ${escapeHtml(availableSolDisplay)}`,
      `<b>Current WSOL:</b> ${escapeHtml(currentWsolDisplay)}`,
      "",
    ];

    if (selectionLabel) {
      lines.push(
        `<b>Selection:</b> ${escapeHtml(selectionLabel)} of available SOL`,
        ""
      );
    }

    lines.push(
      `⚠️ <b>Please confirm this transaction</b>`,
      `This will convert ${escapeHtml(displayAmount)} SOL to ${escapeHtml(
        displayAmount
      )} WSOL.`
    );

    return {
      text: lines.join("\n"),
      keyboard: createConfirmWrapKeyboard(lamportsToWrap),
      displayAmount,
    };
  };

  const handleCustomAmountInput = async (
    ctx: Context,
    userState: any,
    amount: string
  ): Promise<void> => {
    const initiatorId = assertSessionOwnership(ctx, userState);
    const token = userState.token;
    const telegramId = requireTelegramId(ctx, "send custom amount");
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

    const isSol = token === "SOL";
    const selectedToken = !isSol
      ? tokenBalances.find((t) => t.ticker === token)
      : undefined;

    if (!isSol && !selectedToken) {
      throw new Error(`Token ${token} not found in wallet`);
    }

    const exampleAddress = tryGetUserWalletAddress(wallet, telegramId);
    const amountResolution = resolveSendAmountSelection({
      token,
      rawAmount: amount,
      decimals: isSol ? 9 : selectedToken!.decimals,
      solBalance,
      tokenBalance: selectedToken
        ? { balance: selectedToken.balance, decimals: selectedToken.decimals }
        : undefined,
      exampleAddress,
      formatSol: (lamports) => wallet.formatSolBalance(lamports),
      formatToken: (value, decimals) => wallet.formatTokenBalance(value, decimals),
      solFeeBufferLamports: getSolFeeBufferLamports(),
    });

    await persistInputPrompt({
      ctx,
      userState,
      text: amountResolution.messageText,
      keyboard: createCancelKeyboard(`send_select_${token}`),
      session: {
        type: "send_address",
        token,
        amount: amountResolution.storedAmount,
        amountDisplay: amountResolution.displayLabel,
        initiatorId,
      },
      logLabel: "handleCustomAmountInput",
      initiatorId,
    });
  };

  const handleAddressInput = async (
    ctx: Context,
    userState: any,
    address: string
  ): Promise<void> => {
    assertSessionOwnership(ctx, userState);
    const token = userState.token;
    const amount = userState.amount;
    const amountDisplay =
      userState.amountDisplay ??
      (amount === "max" ? `MAX ${token}` : `${amount} ${token}`);

    if (address.length < 30 || address.length > 50) {
      throw new Error("Invalid wallet address format");
    }

    try {
      // Ensure address is a valid base58 public key before persisting state
      new PublicKey(address);
    } catch {
      throw new Error("Invalid wallet address format");
    }

    const txId = generateTransactionId();
    storePendingTransaction(txId, {
      type: "send",
      token: token,
      amount: amount,
      address: address,
      userId: getTelegramId(ctx).toString(),
      amountDisplay,
    });

    const response = [
      `✅ <b>Send Confirmation</b>`,
      "",
      `<b>Amount:</b> ${escapeHtml(amountDisplay)}`,
      `<b>To:</b> <code>${escapeHtml(address)}</code>`,
      "",
      `⚠️ <b>Please confirm this transaction</b>`,
      `This action cannot be undone.`,
    ];

    const messageText = response.join("\n");
    const keyboard = createTradeConfirmKeyboard({
      confirmLabel: "✅ Confirm Send",
      confirmCallback: `confirm_send_${txId}`,
      cancelLabel: "❌ Cancel",
      cancelCallback: `send_select_${token}`,
    });

    const targetChatId =
      typeof userState.chatId === "number"
        ? userState.chatId
        : typeof ctx.chat?.id === "number"
        ? ctx.chat.id
        : undefined;
    const targetMessageId =
      typeof userState.messageId === "number" ? userState.messageId : undefined;

    await upsertWalletMenuMessage({
      ctx,
      text: messageText,
      keyboard,
      parseMode: "HTML",
      targetChatId,
      targetMessageId,
      replyToMessageId: ctx.message?.message_id ?? undefined,
      logLabel: "handleAddressInput",
    });
  };

  const handleWrapAmountInput = async (
    ctx: Context,
    userState: any,
    amount: string
  ): Promise<void> => {
    const initiatorId = assertSessionOwnership(ctx, userState);
    const trimmedAmount = amount.trim();
    const lamportsToWrap = toRawAmount(trimmedAmount, 9);

    if (!Number.isFinite(lamportsToWrap) || lamportsToWrap <= 0) {
      throw new Error("Invalid amount format");
    }

    const telegramId = requireTelegramId(ctx, "wrap custom amount input");
    let nativeSolBalance = 0;
    let wsolBalance = 0;

    try {
      const balances = await getCachedWalletData(telegramId);
      nativeSolBalance = balances.nativeSolBalance;
      wsolBalance = balances.wsolBalance;
    } catch (error) {
      console.warn("Failed to load wallet balances for wrap confirmation:", error);
    }

    const confirmation = buildWrapConfirmation({
      lamportsToWrap,
      availableSolLamports: nativeSolBalance,
      currentWsolLamports: wsolBalance,
    });

    const userId = getTelegramIdString(ctx);

    await persistInputPrompt({
      ctx,
      userState,
      text: confirmation.text,
      keyboard: confirmation.keyboard,
      session: { type: "wrap_custom_amount", initiatorId },
      logLabel: "handleWrapAmountInput",
      persistSession: Boolean(userId),
      initiatorId,
    });
  };

  const { executeWrapFlow, executeUnwrapFlow, validatePendingTransaction } =
    createSolConversionUtilities({
      wallet,
      clearWalletCache,
      buildTransactionLinkMessage,
      getPendingTransaction,
      getSolFeeBufferLamports,
    });

  const registerHandlers = () => {
    registerWalletActionMenuHandler({
      callback: "cmd_withdraw",
      logLabel: "cmd_withdraw",
      errorAck: "❌ Error loading send menu",
      resolve: async () => ({
        menuOptions: {
          title: `💸 <b>Withdraw</b>`,
          bodyLines: [
            `<b>From:</b> <code>{{WALLET_ADDRESS}}</code>`,
            "",
            `<b>Select token to withdraw:</b>`,
          ],
          quickActions: {
            type: "token-select",
            actionPrefix: "send_select_",
            includeSol: true,
            limit: 5,
          },
        },
        successAck: "💸 Select Token to Withdraw",
      }),
    });

    registerWalletActionMenuHandler({
      callback: "cmd_wrap",
      logLabel: "cmd_wrap",
      errorAck: "❌ Error loading wrap menu",
      resolve: async () => ({
        menuOptions: {
          title: `🔧 <b>Wrap SOL</b>`,
          bodyLines: ({ solBalance, tokenBalances }) => {
            const formattedSolBalance = wallet.formatSolBalance(solBalance);
            const wsolLamports =
              tokenBalances.find((token) => token.mint === WSOL_MINT)?.balance ??
              0;
            const formattedWsolBalance = wallet.formatSolBalance(wsolLamports);
            return [
              `<b>Native SOL:</b> ${escapeHtml(formattedSolBalance)}`,
              `<b>WSOL:</b> ${escapeHtml(formattedWsolBalance)}`,
              "",
              `Convert native SOL to WSOL tokens for DeFi operations.`,
              "",
              `<b>Quick Wrap Amounts:</b>`,
            ];
          },
          quickActions: {
            type: "wrap",
            callbackPrefix: "wrap_amount_",
        amounts: [
          { label: "25%", value: "25%" },
          { label: "50%", value: "50%" },
          { label: "75%", value: "75%" },
          { label: "MAX", value: "MAX" },
        ],
        customAction: { label: "✏️ Custom Amount", callback: "wrap_custom" },
        insufficientLabel: "❌ Insufficient SOL balance",
        minimumLamports: 10_000,
      },
      backButton: { label: "← Back to Settings", callback: "wallet_settings" },
      getBalances: async (telegramId) => {
        const [solBalance, wsolBalance] = await Promise.all([
          wallet.getBalance(telegramId),
          wallet.getTokenBalance(telegramId, WSOL_MINT),
        ]);

            return {
              solBalance,
              tokenBalances: [
                {
                  mint: WSOL_MINT,
                  ticker: "WSOL",
                  balance: wsolBalance,
                  decimals: 9,
                  rawBalance: wsolBalance.toString(),
                },
              ],
            };
          },
        },
        successAck: "🔧 Select wrap amount",
      }),
    });

    registerWalletActionMenuHandler({
      callback: "cmd_unwrap",
      logLabel: "cmd_unwrap",
      errorAck: "❌ Error loading unwrap menu",
      resolve: async (ctx) => {
        const telegramId = await resolveTelegramIdOrRespond(ctx, "unwrap menu");
        if (telegramId == null) {
          return null;
        }

        const balances = await getCachedWalletData(telegramId);
        const hasBalance = balances.wsolBalance > 0;

        return {
          menuOptions: {
            title: `🧼 <b>Unwrap WSOL</b>`,
            bodyLines: ({ solBalance, tokenBalances }) => {
              const wsolLamports =
                tokenBalances.find((token) => token.mint === WSOL_MINT)?.balance ??
                0;
              const formattedSolBalance = wallet.formatSolBalance(solBalance);
              const formattedWsolBalance = wallet.formatSolBalance(wsolLamports);

              const lines = [
                `<b>Native SOL:</b> ${escapeHtml(formattedSolBalance)}`,
                `<b>WSOL:</b> ${escapeHtml(formattedWsolBalance)}`,
              ];

              if (wsolLamports > 0) {
                lines.push(
                  "",
                  "Unwrap converts WSOL back to native SOL and closes the WSOL account."
                );
              } else {
                lines.push(
                  "",
                  "You currently have no WSOL to unwrap."
                );
              }

              return lines;
            },
            quickActions: {
              type: "prebuilt",
              keyboard: createConfirmUnwrapKeyboard(hasBalance),
            },
            backButton: { label: "← Back to Settings", callback: "wallet_settings" },
            getBalances: async () => ({
              solBalance: balances.nativeSolBalance,
              tokenBalances: [
                {
                  mint: WSOL_MINT,
                  ticker: "WSOL",
                  balance: balances.wsolBalance,
                  decimals: 9,
                  rawBalance: balances.wsolBalance.toString(),
                },
              ],
            }),
          },
          successAck: hasBalance
            ? "🧼 Ready to unwrap WSOL"
            : "ℹ️ No WSOL balance found",
        };
      },
    });

    bot.on(
      "callback_query",
      wrapCallbackHandler(
        async (ctx, next) => {
          const callbackData = ctx.callbackQuery?.data;
          if (callbackData !== "wrap_custom") {
            return await next();
          }

          const userId = getTelegramIdString(ctx);
          if (!userId) return;

          await showCustomAmountPrompt({
            ctx,
            userId,
            title: "✏️ <b>Custom Wrap Amount</b>",
            instructions: [
              "Reply to this message with the amount of SOL you want to wrap.",
            ],
            examples: ["• <code>0.5</code>", "• <code>1.25</code>"],
            cancelCallback: "cmd_wrap",
            state: { type: "wrap_custom_amount" },
          });

          await safeAnswerCallbackQuery(ctx, "Send the amount as a message");
        },
        { action: "wrap_custom", errorAck: "❌ Error processing custom amount" }
      )
    );

    registerCallbackPrefixHandler("wrap_amount_", async (ctx, { payload }) => {
      try {
        const telegramId = await resolveTelegramIdOrRespond(
          ctx,
          "wrap amount selection"
        );
        if (telegramId == null) {
          return;
        }

        const amountChoice = payload;
        const { nativeSolBalance, wsolBalance } = await getCachedWalletData(telegramId);
        const availableSolLamports = nativeSolBalance;

        const spend = presentSpendAmount({
          amount: amountChoice,
          assetTicker: "SOL",
          decimals: 9,
          solBalance: availableSolLamports,
          formatSol: (lamports) => wallet.formatSolBalance(lamports),
          formatToken: (value, decimals) =>
            wallet.formatTokenBalance(value, decimals),
        });

        const lamportsToWrap = spend.rawAmount;

        if (!Number.isFinite(lamportsToWrap) || lamportsToWrap <= 0) {
          throw new Error("Amount is too small to wrap");
        }

        const selection = amountChoice.trim().toUpperCase();
        const confirmation = buildWrapConfirmation({
          lamportsToWrap,
          availableSolLamports,
          currentWsolLamports: wsolBalance,
          selectionLabel:
            selection === "MAX" || selection.endsWith("%") ? selection : undefined,
        });

        await respondWithMenu(ctx, {
          text: confirmation.text,
          keyboard: confirmation.keyboard,
        });

        await safeAnswerCallbackQuery(
          ctx,
          `Wrap ${confirmation.displayAmount} SOL`
        );
      } catch (error) {
        console.error("Error in wrap amount selection:", error);
        const message =
          error instanceof Error ? error.message : "Error processing wrap amount";
        await safeAnswerCallbackQuery(ctx, `❌ ${message}`);
      }
    });

    bot.callbackQuery("unwrap_confirm", async (ctx) => {
      try {
        const telegramId = await resolveTelegramIdOrRespond(
          ctx,
          "unwrap confirmation"
        );
        if (telegramId == null) {
          return;
        }

        const result = await executeUnwrapFlow(telegramId, {
          onProcessing: async (formattedAmount) => {
            await respondWithMenu(ctx, {
              text: `🔄 <b>Processing Unwrap</b>\n\nUnwrapping ${escapeHtml(
                formattedAmount ?? "0"
              )} WSOL to SOL...\n\n<i>Please wait...</i>`,
              keyboard: new InlineKeyboard(),
            });
          },
          onNoBalance: async () => {
            await respondWithMenu(ctx, {
              text: `❌ <b>Unwrap Failed</b>\n\nYour WSOL account is already empty.`,
              keyboard: createBackToWalletKeyboard(),
            });
          },
          onSuccess: async ({ signature, formattedAmount }) => {
            const successView = renderSolConversionSuccess({
              kind: "unwrap",
              formattedAmount,
              signature,
            });

            await respondWithMenu(ctx, {
              text: successView.text,
              keyboard: createBackToWalletKeyboard(),
              disableLinkPreview: successView.disablePreview,
            });
          },
          onError: async (error) => {
            console.error("Error in unwrap confirmation:", error);
            const userFriendlyError = formatUserFriendlyError(error, wallet);
            await respondWithMenu(ctx, {
              text: userFriendlyError,
              keyboard: createBackToWalletKeyboard(),
            });
          },
        });

        if (result.status === "success") {
          await safeAnswerCallbackQuery(ctx, "✅ WSOL unwrapped");
        } else if (result.status === "empty") {
          await safeAnswerCallbackQuery(ctx, "ℹ️ No WSOL to unwrap");
        } else {
          await safeAnswerCallbackQuery(ctx, "❌ Unwrap failed");
        }
      } catch (error) {
        console.error("Error in unwrap confirmation:", error);
        const userFriendlyError = formatUserFriendlyError(error, wallet);
        await respondWithMenu(ctx, {
          text: userFriendlyError,
          keyboard: createBackToWalletKeyboard(),
        });
        await safeAnswerCallbackQuery(ctx, "❌ Unwrap failed");
      }
    });

    bot.callbackQuery(/^confirm_wrap_/, async (ctx) => {
      try {
        const callbackData = ctx.callbackQuery?.data || "";
        const lamportsRaw = callbackData.replace("confirm_wrap_", "");
        const lamportsToWrap = Number.parseInt(lamportsRaw, 10);

        if (!Number.isFinite(lamportsToWrap) || lamportsToWrap <= 0) {
          throw new Error("Invalid wrap amount");
        }

        const formattedAmount = wallet.formatSolBalance(lamportsToWrap);
        const telegramId = await resolveTelegramIdOrRespond(
          ctx,
          "wrap confirmation"
        );
        if (telegramId == null) {
          return;
        }

        const result = await executeWrapFlow(telegramId, lamportsToWrap, {
          onProcessing: async (amountDisplay) => {
            await respondWithMenu(ctx, {
              text: `🔄 <b>Processing Wrap</b>\n\nWrapping ${amountDisplay} SOL to WSOL...\n\n<i>Please wait...</i>`,
              keyboard: new InlineKeyboard(),
            });
          },
          onInsufficientBalance: async (amountDisplay) => {
            await respondWithMenu(ctx, {
              text: `❌ <b>Wrap Failed</b>\n\nNot enough SOL to wrap ${amountDisplay}.\nKeep at least ${MIN_SOL_FOR_TX} SOL for fees and try again.`,
              keyboard: createBackToWalletKeyboard(),
            });
          },
          onSuccess: async ({ signature, formattedAmount: amountDisplay }) => {
            const amountLabel = escapeHtml(amountDisplay ?? "0");
            const { text, disablePreview } = buildSolscanSuccessMessage({
              title: "✅ <b>Wrap Completed</b>",
              bodyLines: [`Wrapped ${amountLabel} SOL to WSOL`],
              signature,
            });

            await respondWithMenu(ctx, {
              text,
              keyboard: createBackToWalletKeyboard(),
              disableLinkPreview: disablePreview,
            });
          },
          onError: async (error) => {
            console.error("Error in wrap confirmation:", error);
            const userFriendlyError = formatUserFriendlyError(error, wallet);
            await respondWithMenu(ctx, {
              text: userFriendlyError,
              keyboard: createBackToWalletKeyboard(),
            });
          },
        });

        if (result) {
          await safeAnswerCallbackQuery(
            ctx,
            `✅ Wrap ${formattedAmount} SOL submitted`
          );
        }
      } catch (error) {
        console.error("Error in wrap confirmation:", error);
        const userFriendlyError = formatUserFriendlyError(error, wallet);
        await respondWithMenu(ctx, {
          text: userFriendlyError,
          keyboard: createBackToWalletKeyboard(),
        });
        await safeAnswerCallbackQuery(ctx, "❌ Wrap failed");
      }
    });

    registerCallbackPrefixHandler("send_select_", async (ctx, { payload: token }) => {
      try {
        const { menu } = await buildWalletActionMenuForUser(
          defaultWalletActionMenuDeps,
          {
            ctx,
            title: `📤 <b>Send ${escapeHtml(token)}</b>`,
            bodyLines: ({ solBalance, tokenBalances }) => {
              let balanceDisplay = "0";
              if (token === "SOL") {
                balanceDisplay = wallet.formatSolBalance(solBalance);
              } else {
                const selectedToken = tokenBalances.find((t) => t.ticker === token);
                if (selectedToken) {
                  balanceDisplay = wallet.formatTokenBalance(
                    selectedToken.balance,
                    selectedToken.decimals
                  );
                }
              }

              return [
                `<b>From:</b> <code>{{WALLET_ADDRESS}}</code>`,
                `<b>Balance:</b> ${escapeHtml(balanceDisplay)} ${escapeHtml(token)}`,
                "",
                `<b>Quick Send Amounts:</b>`,
              ];
            },
            quickActions: {
              type: "prebuilt",
              keyboard: buildQuickAmountKeyboard({
                baseCallback: (value) =>
                  `send_amount_${token}_${value.toUpperCase()}`,
                customLabel: "✏️ Custom Amount",
                backCallback: "cmd_withdraw",
              }),
            },
          }
        );

        await respondWithMenu(ctx, menu);
        await safeAnswerCallbackQuery(ctx, `Selected ${token}`);
      } catch (error) {
        console.error("Error in send token selection:", error);
        await safeAnswerCallbackQuery(ctx, "❌ Error processing selection");
      }
    });

    registerCallbackPrefixHandler("send_amount_", async (ctx, { payload }) => {
      try {
        const segments = payload.split("_");
        const token = segments.shift() ?? "";
        const amountChoice = segments.join("_");
        if (!token || !amountChoice) {
          throw new Error("Invalid amount selection");
        }

        const userId = getTelegramIdString(ctx);
        if (!userId) return;

        if (amountChoice === "CUSTOM") {
          const examples =
            token === "SOL"
              ? ["• <code>0.5</code>", "• <code>1.25</code>"]
              : ["• <code>1000</code>", "• <code>250.5</code>"];

          await showCustomAmountPrompt({
            ctx,
            userId,
            title: `✏️ <b>Custom Amount - ${token}</b>`,
            instructions: [
              `Reply to this message with the amount you want to send.`,
            ],
            examples,
            cancelCallback: `send_select_${token}`,
            state: {
              type: "send_custom_amount",
              token,
            },
          });

          await safeAnswerCallbackQuery(ctx, "Send the amount as a message");
          return;
        }

        const telegramId = await resolveTelegramIdOrRespond(
          ctx,
          "send amount selection"
        );
        if (telegramId == null) {
          return;
        }
        const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

        const isSol = token === "SOL";
        const selectedToken = !isSol
          ? tokenBalances.find((t) => t.ticker === token)
          : undefined;

        if (!isSol && !selectedToken) {
          throw new Error(`Token ${token} not found in wallet`);
        }

        const exampleAddress = tryGetUserWalletAddress(wallet, telegramId);
        const amountResolution = resolveSendAmountSelection({
          token,
          rawAmount: amountChoice,
          decimals: isSol ? 9 : selectedToken!.decimals,
          solBalance,
          tokenBalance: selectedToken
            ? { balance: selectedToken.balance, decimals: selectedToken.decimals }
            : undefined,
          exampleAddress,
          formatSol: (lamports) => wallet.formatSolBalance(lamports),
          formatToken: (value, decimals) => wallet.formatTokenBalance(value, decimals),
          solFeeBufferLamports: getSolFeeBufferLamports(),
        });

        await persistInputPromptFromContext({
          ctx,
          text: amountResolution.messageText,
          keyboard: createCancelKeyboard(`send_select_${token}`),
          session: {
            type: "send_address",
            token,
            amount: amountResolution.storedAmount,
            amountDisplay: amountResolution.displayLabel,
          },
          logLabel: "send_amount_selection",
        });
      } catch (error) {
        console.error("Error in send amount selection:", error);
        const message =
          error instanceof Error ? error.message : "Error processing amount";
        await safeAnswerCallbackQuery(ctx, `❌ ${message}`);
      }
    });

    bot.callbackQuery(/^confirm_send_/, async (ctx) => {
      try {
        const callbackData = ctx.callbackQuery?.data || "";
        const txId = callbackData.replace("confirm_send_", "");

        const validation = validatePendingTransaction<PendingSendTransaction>(
          ctx,
          txId,
          "send"
        );

        if (validation.status === "expired") {
          await safeAnswerCallbackQuery(ctx, "❌ Transaction expired or not found");
          return;
        }

        if (validation.status === "unauthorized") {
          await safeAnswerCallbackQuery(ctx, "❌ Unauthorized transaction");
          return;
        }

        const transaction = validation.transaction;

        const amountSummary =
          transaction.amountDisplay ??
          (transaction.amount === "max"
            ? `MAX ${transaction.token}`
            : `${transaction.amount} ${transaction.token}`);

        await respondWithMenu(ctx, {
          text: `🔄 <b>Processing Transaction</b>\n\nSending ${escapeHtml(
            amountSummary
          )}...\n\n<i>Please wait...</i>`,
          keyboard: new InlineKeyboard(),
        });

        try {
          if (!transaction.address) {
            throw new Error("Invalid recipient address");
          }

          const toPublicKey = new PublicKey(transaction.address);
          const telegramId = BigInt(transaction.userId);
          let txSignature: string;
          let formattedAmount: string;
          let withdrawAllResult:
            | Awaited<ReturnType<typeof wallet.withdrawAllSol>>
            | null = null;

          if (transaction.token === "SOL") {
            const balanceLamports = await wallet.getBalance(telegramId, {
              forceFresh: true,
              allowStaleOnError: true,
            });
            if (transaction.amount === "max") {
              withdrawAllResult = await wallet.withdrawAllSol(
                telegramId,
                toPublicKey
              );

              if (withdrawAllResult.totalLamportsSent <= 0) {
                throw new Error(
                  "Unable to withdraw SOL. Ensure you have enough balance to cover fees."
                );
              }

              txSignature = withdrawAllResult.signature;
              formattedAmount = wallet.formatSolBalance(
                withdrawAllResult.totalLamportsSent
              );
            } else {
              const lamportsToSend = toRawAmount(transaction.amount, 9);
              if (
                lamportsToSend + getSolFeeBufferLamports() > balanceLamports
              ) {
                throw new Error("Insufficient SOL balance for this transfer");
              }
              formattedAmount = transaction.amount;

              txSignature = await wallet.transferSol(
                telegramId,
                toPublicKey,
                lamportsToSend
              );
            }
          } else {
            if (!transaction.token) {
              throw new Error("Token not specified in transaction");
            }

            const { tokenBalances } = await getCachedWalletData(telegramId);
            const tokenBalance = tokenBalances.find(
              (t) => t.ticker === transaction.token
            );

            if (!tokenBalance) {
              throw new Error(`Token ${transaction.token} not found in wallet`);
            }

            const tokenMint = tokenBalance.mint;
            if (!tokenMint) {
              throw new Error(`Token mint not found for ${transaction.token}`);
            }

            let rawAmount = 0;
            if (transaction.amount === "max") {
              rawAmount = Math.floor(tokenBalance.balance);
              if (rawAmount <= 0) {
                throw new Error(`No ${transaction.token} balance found`);
              }
              formattedAmount = wallet.formatTokenBalance(
                rawAmount,
                tokenBalance.decimals
              );
            } else {
              rawAmount = toRawAmount(
                transaction.amount,
                tokenBalance.decimals
              );
              if (rawAmount > tokenBalance.balance) {
                throw new Error("Insufficient token balance for this transfer");
              }
              formattedAmount = transaction.amount;
            }

            txSignature = await wallet.transferToken(
              telegramId,
              toPublicKey,
              rawAmount,
              tokenMint
            );
          }

          await wallet.confirmTransaction(txSignature);
          clearWalletCache(telegramId);

          const { text: successMessage, disablePreview } =
            renderSendSuccessMessage({
              formattedAmount,
              token: transaction.token,
              address: transaction.address,
              signature: txSignature,
            });

          await respondWithMenu(ctx, {
            text: successMessage,
            keyboard: createBackToWalletKeyboard(),
            disableLinkPreview: disablePreview,
          });
          await safeAnswerCallbackQuery(ctx, "✅ Transaction submitted");
        } catch (txError) {
          console.error("Transaction failed:", txError);
          const userFriendlyError = formatUserFriendlyError(txError, wallet);
          await respondWithMenu(ctx, {
            text: `❌ <b>Transaction Failed</b>\n\n${escapeHtml(
              userFriendlyError
            )}`,
            keyboard: createBackToWalletKeyboard(),
          });
          await safeAnswerCallbackQuery(ctx, "❌ Send failed");
        }
      } catch (error) {
        console.error("Error in send confirmation:", error);
        await safeAnswerCallbackQuery(ctx, "❌ Error processing transaction");
      }
    });
  };

  return {
    registerHandlers,
    executeWrapFlow,
    executeUnwrapFlow,
    validatePendingTransaction,
    presentSpendAmount,
    buildQuickAmountKeyboard,
    buildWrapConfirmation,
    handleCustomAmountInput,
    handleAddressInput,
    handleWrapAmountInput,
    renderSolConversionSuccess,
    buildSolscanSuccessMessage,
  };
};

export const __test_renderSendSuccessMessage = renderSendSuccessMessage;
