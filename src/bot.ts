import "./utils/logging";
import { Bot, Context, InlineKeyboard } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { WalletManager } from "./utils/wallet";
import { TokenManager, formatParseAmountError } from "./utils/token-manager";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";
import { createSyncNativeInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { GameDatabase } from "./utils/game-database";
import { GameManager } from "./utils/game";
import { PDAManager } from "./utils/pda";
import { formatUserFriendlyError } from "./utils/errors";
import { SwapManager, type SwapQuote } from "./utils/swap-manager";
import { createExpiringCache } from "./utils/expiring-cache";
import {
  LAMPORTS_PER_SOL,
  MIN_SOL_FOR_TX,
  GAME_TIMEOUT,
  EXPIRED_GAMES_CHECK_INTERVAL_MS,
  GAME_EXPIRATION_BUFFER_TIME,
  DEFAULT_NULL_ADDRESS,
  DEFAULT_TOKEN_MINT,
  DEFAULT_TOKEN_TICKER,
  TOKENS_LIST,
  WSOL_MINT,
  getStartVideoId,
  INPUT_TIMEOUT_HINT,
} from "./utils/constants";
import { mergeWsolIntoSol } from "./utils/balance";
import { setUserState, getUserState, storePendingTransaction, getPendingTransaction } from "./utils/user-state";
// import { createDmMessageAdapter } from "./utils/ctx-adapter";
import {
  createWalletKeyboard,
  createWalletSettingsKeyboard,
  createBackToWalletKeyboard,
  createConfirmWrapKeyboard,
  createTradeConfirmKeyboard,
  createAmountSelectionKeyboard,
  createPlayerSelectionKeyboard,
  createGameConfirmKeyboard,
  createSliderAmountKeyboard,
  getFeeWarningMessage,
  getSuggestedStakeAmounts,
} from "./utils/keyboards";
import {
  buildWalletCaption,
  buildWalletActionMenu,
  showCustomAmountPrompt,
  type WalletActionQuickActions,
  type WalletActionMenuBalances,
} from "./utils/wallet-ui";
import {
  formatAmount,
  escapeHtml,
  formatRate,
  formatTokenDisplay,
  formatUsdValue,
} from "./utils/format-amount";
import {
  showWalletUI as showWalletUIHandler,
  onMainWallet,
  onWalletRefresh,
  onWalletSettings,
  onBalance,
  type BalanceDeps,
  type WalletHandlersDeps,
} from "./handlers/wallet";
import { inferMaxPlayers } from "./utils/arg-parsing";
import type {
  PlayerData,
  GameCompletedEvent,
  PlayerJoinedEvent,
  PlayerUnjoinedEvent,
  PlayerEvent,
} from "./types";
import { TokenDatabase } from "./utils/token-database";
import {
  getTelegramId,
  createMessageEditAdapter,
  handleCallbackErrorSafe,
  safeAnswerCallbackQuery,
} from "./utils/context-helpers";
import { recentUpdateGuard } from "./utils/recent-update";
import { getPriceUSD } from "./utils/prices";
import { patchReplyBehavior } from "./utils/reply-patch";
import { NetworkDetector } from "./utils/network-detector";
import {
  buildBuyMenuUI,
  buildProcessingStatus,
  buildSellMenuUI,
  SELL_NOOP_CALLBACK,
} from "./utils/trade-ui";
import { respondWithMenu } from "./utils/menu-response";
import { parseDecimalAmount, parseTradeAmountInput } from "./utils/amount";
import { handleCoinflipCommand, type CoinflipDeps } from "./handlers/game";
import { isMessageMissing } from "./utils/telegram-errors";

// ================================
// GLOBAL INSTANCES
// ================================

// Module-level exports for use by utility modules
export const bot = new Bot(process.env.TELEGRAM_TOKEN!);
// Global error boundary for unhandled middleware errors
bot.catch((err) => {
  try {
    const ctx = err.ctx as Context | undefined;
    const path = ctx?.update?.callback_query ? 'callback_query' : ctx?.update?.message ? 'message' : 'update';
    console.error(`Bot error while handling ${path}:`, err.error || err);
  } catch (e) {
    console.error('Bot error (logging failed):', err);
  }
});

// Ensure all new messages are replies to the triggering message by default,
// and gracefully fall back if the reply target no longer exists.
bot.use(async (ctx, next) => {
  try { patchReplyBehavior(ctx); } catch {}
  await next();
});
export const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
const gameDb = GameDatabase.getInstance();
const pendingGameCreations = new Set<string>();

const CONTRACT_EXAMPLE_LINES = (() => {
  const uniqueMints = new Set<string>([
    ...TOKENS_LIST.map((token) => token.mint),
    DEFAULT_TOKEN_MINT,
    WSOL_MINT,
  ]);

  return Array.from(uniqueMints)
    .slice(0, 2)
    .map((mint) => `• <code>${mint}</code>`);
})();

// Network detection helpers available via utils/network-detector.ts

// Helper moved to utils/service-health.ts as checkServiceHealth

// User sessions for text input handling
type GameSetupSession = {
  waitingFor: string;
  gameType: string;
  userBalance: number;
  messageId?: number;
  chatId?: number;
  amount?: string;
  creatorId?: string;
  tokenMint?: string;
  tokenTicker?: string;
  tokenDecimals?: number;
  contractMinimum?: number;
};

const defaultGameSetupSession: Pick<GameSetupSession, "waitingFor" | "gameType" | "userBalance"> = {
  waitingFor: "setup",
  gameType: "",
  userBalance: 0,
};

const userSessions = new Map<number, GameSetupSession>();

const updateGameSetupSession = (
  userId: number,
  overrides: Partial<GameSetupSession>
): GameSetupSession => {
  const existing = userSessions.get(userId);
  const next: GameSetupSession = {
    ...defaultGameSetupSession,
    ...(existing ?? {}),
    ...overrides,
  } as GameSetupSession;

  userSessions.set(userId, next);
  return next;
};

// Test-only accessor for verifying session behavior in unit tests
export const __testSessions = userSessions;
// Test-only helpers to manipulate wallet cache in unit tests
export const __test_setWalletCache = (
  telegramId: bigint | number | string,
  data: {
    solBalance: number;
    tokenBalances: Array<{
      mint: string;
      ticker: string;
      balance: number;
      decimals: number;
      rawBalance: string;
    }>;
    approvedTokens?: any[];
  },
  _ts?: number
) => {
  const cacheKey = getWalletCacheKey(telegramId as any);
  walletDataCache.setWithTTL(cacheKey, {
    solBalance: data.solBalance,
    tokenBalances: data.tokenBalances,
    approvedTokens: data.approvedTokens ?? [],
  });
};

export const __test_setGameManager = (manager: GameManager): void => {
  gameManager = manager;
};

const ensureCreator = (
  ctx: Context,
  creatorId: string,
  failureText = "🚫 Only the game creator can modify this setup!"
): boolean => {
  const currentUserId = ctx.from?.id?.toString();

  if (currentUserId !== creatorId) {
    void safeAnswerCallbackQuery(ctx, failureText);
    return false;
  }

  return true;
};

const notifyConfirmUser = async (
  ctx: Context,
  message: string,
  confirmMessageMissing: boolean
): Promise<void> => {
  const payload = {
    text: message,
    parseMode: "HTML" as const,
  };

  if (!confirmMessageMissing) {
    try {
      await respondWithMenu(ctx, payload);
      return;
    } catch (error) {
      if (!isMessageMissing(error)) {
        throw error;
      }
    }
  }

  const replyToId =
    ctx.callbackQuery?.message?.reply_to_message?.message_id ??
    ctx.message?.message_id ??
    null;

  await respondWithMenu(ctx, payload, {
    replyToMessageId: replyToId,
    skipEdit: true,
  });
};

// Test-only proxies for user-state helpers
export const __test_setUserState = (userId: string, state: any) => setUserState(userId, state);
export const __test_getUserState = (userId: string) => getUserState(userId, false);
export const __test_clearUserState = (userId: string) => { getUserState(userId, true); };

// Main menu keyboard moved to utils/keyboards.ts

const SOL_FEE_BUFFER_LAMPORTS = Math.ceil(MIN_SOL_FOR_TX * LAMPORTS_PER_SOL);
const toRawAmount = (value: string, decimals: number): number =>
  parseDecimalAmount(value, decimals, { returnType: "number" });

const clampLamportsForFees = (lamports: number): number =>
  Math.max(0, lamports - SOL_FEE_BUFFER_LAMPORTS);

type TokenBalanceLike = {
  balance: number;
  decimals: number;
};

type ResolveSpendAmountParams = {
  amount: string;
  assetTicker: string;
  inputDecimals: number;
  solBalance: number;
  tokenBalance?: TokenBalanceLike;
  formatSol: (lamports: number) => string;
  formatToken: (amount: number, decimals: number) => string;
  applySolFeeBuffer?: boolean;
};

const resolveSpendAmount = ({
  amount,
  assetTicker,
  inputDecimals,
  solBalance,
  tokenBalance,
  formatSol,
  formatToken,
  applySolFeeBuffer = true,
}: ResolveSpendAmountParams) => {
  const parsed = parseTradeAmountInput(amount);
  const isSolAsset = assetTicker === "SOL";

  const ensureTokenBalance = () => {
    if (!tokenBalance) {
      throw new Error(`No ${assetTicker} balance found`);
    }

    if (tokenBalance.balance <= 0) {
      throw new Error(`No ${assetTicker} balance found`);
    }

    return tokenBalance;
  };

  const resolveSolSpendable = () => {
    const spendable = applySolFeeBuffer
      ? clampLamportsForFees(solBalance)
      : solBalance;

    if (spendable <= 0) {
      throw new Error("Not enough SOL to cover purchase and fees");
    }

    return spendable;
  };

  if (parsed.kind === "max") {
    if (isSolAsset) {
      const spendableLamports = resolveSolSpendable();
      return {
        rawAmount: spendableLamports,
        displayAmount: formatSol(spendableLamports),
      };
    }

    const balance = ensureTokenBalance();
    const rawAmount = Math.floor(balance.balance);

    if (rawAmount <= 0) {
      throw new Error(`No ${assetTicker} balance found`);
    }

    return {
      rawAmount,
      displayAmount: formatToken(rawAmount, balance.decimals),
    };
  }

  if (parsed.kind === "percentage") {
    const percentage = parsed.percentage / 100;

    if (isSolAsset) {
      const spendableLamports = resolveSolSpendable();
      const rawAmount = Math.floor(spendableLamports * percentage);

      if (rawAmount <= 0) {
        throw new Error("Percentage results in zero amount");
      }

      return {
        rawAmount,
        displayAmount: formatSol(rawAmount),
      };
    }

    const balance = ensureTokenBalance();
    const rawAmount = Math.floor(balance.balance * percentage);

    if (rawAmount <= 0) {
      throw new Error("Percentage results in zero amount");
    }

    return {
      rawAmount,
      displayAmount: formatToken(rawAmount, balance.decimals),
    };
  }

  const rawAmount = toRawAmount(parsed.normalized, inputDecimals);

  if (isSolAsset) {
    const feeBuffer = applySolFeeBuffer ? SOL_FEE_BUFFER_LAMPORTS : 0;
    if (rawAmount + feeBuffer > solBalance) {
      throw new Error(
        applySolFeeBuffer
          ? "Insufficient SOL balance for this purchase"
          : "Insufficient SOL balance"
      );
    }

    return {
      rawAmount,
      displayAmount: formatSol(rawAmount),
    };
  }

  const balance = ensureTokenBalance();
  if (rawAmount > balance.balance) {
    throw new Error("Insufficient token balance");
  }

  return {
    rawAmount,
    displayAmount: formatToken(rawAmount, inputDecimals),
  };
};

type NormalizeCustomTradeAmountOptions = {
  amount: string;
  assetTicker: string;
  solBalance: number;
  tokenBalance?: TokenBalanceLike;
  decimals: number;
};

type NormalizeCustomTradeAmountResult = {
  normalizedAmount: string;
  displayAmount: string;
};

const normalizeCustomTradeAmount = ({
  amount,
  assetTicker,
  solBalance,
  tokenBalance,
  decimals,
}: NormalizeCustomTradeAmountOptions): NormalizeCustomTradeAmountResult => {
  const parsed = parseTradeAmountInput(amount);

  if (parsed.kind === "max") {
    return { normalizedAmount: "max", displayAmount: "max" };
  }

  if (parsed.kind === "percentage") {
    const fraction = parsed.percentage / 100;

    if (assetTicker === "SOL") {
      const portion = Math.floor(solBalance * fraction);
      if (portion <= 0) {
        throw new Error("Percentage results in zero amount");
      }
      const formatted = formatAmount(portion, decimals, {
        maxFractionDigits: decimals,
        trim: true,
      });
      return { normalizedAmount: formatted, displayAmount: formatted };
    }

    if (!tokenBalance) {
      throw new Error(`Token ${assetTicker} not found in wallet`);
    }

    const portion = Math.floor(tokenBalance.balance * fraction);
    if (portion <= 0) {
      throw new Error("Percentage results in zero amount");
    }

    const formatted = formatAmount(portion, tokenBalance.decimals, {
      maxFractionDigits: tokenBalance.decimals,
      trim: true,
    });
    return { normalizedAmount: formatted, displayAmount: formatted };
  }

  const numeric = Number.parseFloat(parsed.normalized);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("Invalid amount format");
  }

  return { normalizedAmount: parsed.normalized, displayAmount: parsed.normalized };
};

type SwapQuoteWithDecimals = SwapQuote & {
  inputDecimals?: number;
  outputDecimals?: number;
};

type TradeSlippageConfig = {
  callbackPrefix: string;
  defaultOptions: number[];
  allowCustom?: boolean;
};

type TradeSlippageKeyboardConfig = TradeSlippageConfig & {
  kind: Extract<TradeKind, "buy" | "sell">;
  txId: string;
};

type TokenInfoCacheEntry = {
  token_mint: string;
  decimals: number;
};

interface TokenSelectionCacheEntry {
  targetToken: string;
  targetTokenAddress: string;
  paymentToken: string;
  tokenMetadata?: {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    verified: boolean;
  };
  timestamp?: number;
}

interface SellTransactionCacheEntry {
  kind: "sell";
  fromToken: string;
  toToken: string;
  amount: string;
  rawAmount: string;
  fromTokenInfo: TokenInfoCacheEntry;
  toTokenInfo: TokenInfoCacheEntry;
  quote: SwapQuoteWithDecimals;
  userKeypair: Keypair;
  timestamp?: number;
}

interface BuyTransactionCacheEntry {
  kind: "buy";
  fromToken: string;
  toToken: string;
  amount: string;
  rawAmount?: string;
  quote: SwapQuoteWithDecimals;
  retryAmount?: string;
  contractAddress?: string;
  inputDecimals?: number;
  outputDecimals?: number;
  type?: string;
  userId?: string;
  timestamp?: number;
}

type TransactionCacheEntry =
  | TokenSelectionCacheEntry
  | SellTransactionCacheEntry
  | BuyTransactionCacheEntry;

type TradeTransactionCacheEntry =
  | SellTransactionCacheEntry
  | BuyTransactionCacheEntry;

type TradeCacheEntryFactoryResult = {
  entry: TradeTransactionCacheEntry;
  storePending?: boolean;
};

type TradeCacheEntryFactory = (params: {
  txId: string;
  quote: SwapQuoteWithDecimals;
  context: PreparedTradeQuoteContext;
  telegramId: bigint;
}) => TradeCacheEntryFactoryResult;

const isTokenSelectionCacheEntry = (
  entry: TransactionCacheEntry | undefined
): entry is TokenSelectionCacheEntry =>
  Boolean(entry && "targetToken" in entry && "targetTokenAddress" in entry);

const isSellTransactionCacheEntry = (
  entry: TransactionCacheEntry | undefined
): entry is SellTransactionCacheEntry =>
  Boolean(
    entry &&
      "kind" in entry &&
      entry.kind === "sell" &&
      "fromTokenInfo" in entry &&
      "toTokenInfo" in entry
  );

const isBuyTransactionCacheEntry = (
  entry: TransactionCacheEntry | undefined
): entry is BuyTransactionCacheEntry =>
  Boolean(
    entry &&
      "kind" in entry &&
      entry.kind === "buy" &&
      "fromToken" in entry &&
      "toToken" in entry &&
      "quote" in entry &&
      !("fromTokenInfo" in entry)
  );

const isTradeTransactionCacheEntry = (
  entry: TransactionCacheEntry | undefined
): entry is TradeTransactionCacheEntry =>
  Boolean(
    entry &&
      "fromToken" in entry &&
      "toToken" in entry &&
      "quote" in entry &&
      "kind" in entry
  );

type QuickAmountButton = {
  label: string;
  value: string;
};

type QuickAmountOptions = {
  baseCallback: (value: string) => string;
  percentages?: string[];
  includeCustom?: boolean;
  customLabel?: string;
  extraRows?: QuickAmountButton[][];
};

const appendQuickAmountRows = (
  keyboard: InlineKeyboard,
  {
    baseCallback,
    percentages = ["25%", "50%", "75%", "MAX"],
    includeCustom = true,
    customLabel = "✏️ Custom",
    extraRows = [],
  }: QuickAmountOptions
) => {
  const addRow = (buttons: QuickAmountButton[]) => {
    if (buttons.length === 0) return;
    for (const button of buttons) {
      keyboard.text(button.label, baseCallback(button.value));
    }
    keyboard.row();
  };

  for (const row of extraRows) {
    addRow(row);
  }

  if (percentages.length > 0) {
    for (let i = 0; i < percentages.length; i += 2) {
      const left = percentages[i];
      if (!left) continue;
      const rowButtons: QuickAmountButton[] = [{ label: left, value: left }];
      const right = percentages[i + 1];
      if (right) {
        rowButtons.push({ label: right, value: right });
      }
      addRow(rowButtons);
    }
  }

  if (includeCustom) {
    keyboard.text(customLabel, baseCallback("CUSTOM")).row();
  }

  return keyboard;
};

type QuickAmountKeyboardConfig = QuickAmountOptions & {
  backCallback: string;
  backLabel?: string;
  showQuickRows?: boolean;
  insufficientLabel?: string;
};

const buildQuickAmountKeyboard = ({
  backCallback,
  backLabel = "← Back",
  showQuickRows = true,
  insufficientLabel,
  ...quickOptions
}: QuickAmountKeyboardConfig) => {
  const keyboard = new InlineKeyboard();

  if (showQuickRows) {
    appendQuickAmountRows(keyboard, quickOptions);
  } else if (insufficientLabel) {
    keyboard.text(insufficientLabel).row();
  }

  keyboard.text(backLabel, backCallback).row();
  return keyboard;
};

type TradeKind = "buy" | "sell" | "swap";

type TradeConfirmationParams = {
  kind: TradeKind;
  payToken: string;
  payDisplay: string;
  payRawAmount: number;
  payDecimals: number;
  receiveToken: string;
  receiveDecimals: number;
  quote: SwapQuote;
  contractAddress?: string;
};

const TRADE_ICONS: Record<TradeKind, string> = {
  buy: "🛒",
  sell: "🧾",
  swap: "🔄",
};

const TRADE_TITLES: Record<TradeKind, string> = {
  buy: "Buy Confirmation",
  sell: "Sell Confirmation",
  swap: "Swap Confirmation",
};

const TRADE_ACTION_LABEL: Record<TradeKind, string> = {
  buy: "purchase",
  sell: "sale",
  swap: "swap",
};

const formatTradeConfirmationSummary = ({
  kind,
  payToken,
  payDisplay,
  payRawAmount,
  payDecimals,
  receiveToken,
  receiveDecimals,
  quote,
  contractAddress,
}: TradeConfirmationParams) => {
  const receiveDisplay = formatAmount(quote.outputAmount ?? "0", receiveDecimals, {
    maxFractionDigits: 6,
    trim: true,
  });

  const payAmountDecimal = payRawAmount > 0 ? payRawAmount / Math.pow(10, payDecimals) : 0;
  const receiveAmountDecimal = Number(quote.outputAmount ?? "0") / Math.pow(10, receiveDecimals);
  const rateValue = payAmountDecimal > 0 ? receiveAmountDecimal / payAmountDecimal : 0;
  const rateDisplay = formatRate(rateValue);

  const providerLabel =
    quote.provider === "pump-fun"
      ? "pump-fun (ungraduated)"
      : `${quote.provider} (graduated)`;

  const slippageText = quote.slippage !== undefined
    ? `${quote.slippage.toFixed(1)}%`
    : "1.0%";

  const lines = [
    `${TRADE_ICONS[kind]} <b>${TRADE_TITLES[kind]}</b>`,
    "",
    `<b>You Pay:</b> ${payDisplay} ${payToken}`,
    `<b>You Receive:</b> ~${receiveDisplay} ${receiveToken}`,
    "",
    `<b>Rate:</b> ${rateDisplay} ${receiveToken}/${payToken}`,
    `<b>Provider:</b> ${providerLabel}`,
    `<b>Slippage:</b> ${slippageText}`,
  ];

  if (quote.provider === "pump-fun") {
    lines.push("🔥 <b>Pump.fun Token</b> (Not graduated)");
  }

  if (contractAddress) {
    lines.push("", `🔗 <b>Contract:</b> <code>${contractAddress}</code>`);
  }

  lines.push("", `⚠️ <b>Confirm this ${TRADE_ACTION_LABEL[kind]}?</b>`);

  return {
    message: lines.join("\n"),
    rateDisplay,
    providerLabel,
    slippageText,
    receiveDisplay,
  };
};

type TradeConfirmationSummary = ReturnType<typeof formatTradeConfirmationSummary>;

const DEFAULT_TRADE_SLIPPAGE_CONFIG: TradeSlippageConfig = {
  callbackPrefix: "trade_slip",
  defaultOptions: [0.5, 1, 2, 3, 5],
  allowCustom: true,
};

const TRADE_SLIPPAGE_RANGE = { min: 0.1, max: 10 } as const;

const TRADE_CONFIRMATION_CONFIG: Record<
  Extract<TradeKind, "buy" | "sell">,
  {
    confirmLabel: string;
    confirmCallback: (txId: string) => string;
    cancelLabel: string;
    cancelCallback: string;
  }
> = {
  buy: {
    confirmLabel: "✅ Confirm Buy",
    confirmCallback: (txId: string) => `confirm_buy_${txId}`,
    cancelLabel: "← Back to Buy",
    cancelCallback: "cmd_buy",
  },
  sell: {
    confirmLabel: "✅ Confirm Sell",
    confirmCallback: (txId: string) => `confirm_sell_${txId}`,
    cancelLabel: "❌ Cancel",
    cancelCallback: "cmd_sell",
  },
};

type TradeConfirmationKeyboardParams = {
  confirmLabel: string;
  confirmCallback: string;
  cancelLabel: string;
  cancelCallback: string;
  slippageConfig?: TradeSlippageKeyboardConfig;
};

const buildTradeConfirmationKeyboard = ({
  confirmLabel,
  confirmCallback,
  cancelLabel,
  cancelCallback,
  slippageConfig,
}: TradeConfirmationKeyboardParams) => {
  const keyboard = createTradeConfirmKeyboard({
    confirmLabel,
    confirmCallback,
    cancelLabel,
    cancelCallback,
  });

  if (slippageConfig) {
    keyboard.row().text("⚙️ Slippage", "noop");

    slippageConfig.defaultOptions.forEach((value, index) => {
      if (index % 3 === 0) {
        keyboard.row();
      }

      const label = Number.isInteger(value)
        ? `${value.toFixed(0)}%`
        : `${value.toFixed(1)}%`;

      const callbackValue = value.toString();
      keyboard.text(
        label,
        `${slippageConfig.callbackPrefix}_${slippageConfig.kind}_${slippageConfig.txId}_${callbackValue}`
      );
    });

    if (slippageConfig.allowCustom) {
      if (slippageConfig.defaultOptions.length % 3 === 0) {
        keyboard.row();
      }

      keyboard.text(
        "✏️",
        `${slippageConfig.callbackPrefix}_${slippageConfig.kind}_${slippageConfig.txId}_custom`
      );
    }

    keyboard.row();
  }

  return keyboard;
};

type TradeQuoteErrorKind = "swap" | TradeKind;

type TradeQuoteErrorParams = {
  error: unknown;
  retryCallback: string;
  amountLabel?: string;
  fromToken?: string;
  toToken?: string;
};

const renderTradeQuoteError = (
  kind: TradeQuoteErrorKind,
  { error, retryCallback, amountLabel, fromToken, toToken }: TradeQuoteErrorParams
) => {
  const keyboard = new InlineKeyboard().text("← Try Again", retryCallback).row();
  const asError = error instanceof Error ? error : new Error(String(error));

  if (kind === "swap") {
    const userFriendly = formatUserFriendlyError(error, wallet);
    return {
      text: `❌ <b>QUOTE ERROR</b>\n\n${userFriendly}`,
      keyboard,
    };
  }

  if (kind === "buy") {
    const lines = [
      "❌ <b>QUOTE ERROR</b>",
      "",
      `<b>Error:</b> ${asError.message}`,
      "",
      "Please try again.",
    ];

    if (fromToken && toToken) {
      lines.splice(2, 0, `<b>Pair:</b> ${fromToken} → ${toToken}`, "");
    }

    return {
      text: lines.join("\n"),
      keyboard,
    };
  }

  const details = [
    "❌ <b>SELL QUOTE FAILED</b>",
    "",
  ];

  if (fromToken) {
    details.push(`<b>Token:</b> ${fromToken}`);
  }
  if (amountLabel) {
    details.push(`<b>Amount:</b> ${amountLabel}`);
  }
  if (fromToken || amountLabel) {
    details.push("");
  }

  details.push(`<b>Error:</b> ${asError.message}`, "", "This could happen if:");
  details.push("• Token has no liquidity", "• Network issues", "• Token is not tradable");

  return {
    text: details.join("\n"),
    keyboard,
  };
};

type PrepareTradeQuoteParams = {
  ctx: Context;
  kind: TradeKind;
  spinnerText: string;
  summaryInput: Omit<TradeConfirmationParams, "quote" | "kind">;
  quoteFetcher: () => Promise<SwapQuote>;
  cacheQuote: (txId: string, quote: SwapQuote, summary: TradeConfirmationSummary) => void;
  buildConfirmationKeyboard: (
    txId: string,
    summary: TradeConfirmationSummary,
    quote: SwapQuote
  ) => InlineKeyboard;
  onError: (error: unknown) => Promise<void> | void;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
};

const prepareTradeQuote = async ({
  ctx,
  kind,
  spinnerText,
  summaryInput,
  quoteFetcher,
  cacheQuote,
  buildConfirmationKeyboard,
  onError,
  parseMode = "HTML",
}: PrepareTradeQuoteParams) => {
  await respondWithMenu(ctx, {
    text: spinnerText,
    parseMode,
    keyboard: new InlineKeyboard(),
  });

  try {
    const quote = await quoteFetcher();
    const summary = formatTradeConfirmationSummary({
      kind,
      ...summaryInput,
      quote,
    });
    const txId = generateTransactionId();
    cacheQuote(txId, quote, summary);
    const confirmKeyboard = buildConfirmationKeyboard(txId, summary, quote);

    await respondWithMenu(ctx, {
      text: summary.message,
      parseMode,
      keyboard: confirmKeyboard,
    });

    return { txId, quote, summary };
  } catch (error) {
    console.error(`Error getting ${kind} quote:`, error);
    await onError(error);
    return null;
  }
};

type WalletCacheSnapshot = Awaited<ReturnType<typeof getCachedWalletData>>;

type TradeAssetFactoryContext = WalletCacheSnapshot & {
  telegramId: bigint;
};

type ResolvedTradeAsset = {
  ticker: string;
  mint: string;
  decimals: number;
  tokenBalance?: TokenBalanceLike;
  applySolFeeBuffer?: boolean;
  metadata?: Record<string, unknown>;
};

type PreparedTradeQuoteContext = {
  input: ResolvedTradeAsset;
  output: ResolvedTradeAsset;
  rawAmount: number;
  displayAmount: string;
};

type PrepareTokenTradeQuoteParams = {
  ctx: Context;
  telegramId: bigint;
  amountInput: string;
  kind: TradeKind;
  inputFactory: (
    context: TradeAssetFactoryContext
  ) => Promise<ResolvedTradeAsset> | ResolvedTradeAsset;
  outputFactory: (
    context: TradeAssetFactoryContext
  ) => Promise<ResolvedTradeAsset> | ResolvedTradeAsset;
  spinnerText: (info: {
    displayAmount: string;
    amountInput: string;
    inputTicker: string;
    outputTicker: string;
  }) => string;
  cacheQuote: (
    txId: string,
    quote: SwapQuote,
    context: PreparedTradeQuoteContext
  ) => void;
  buildConfirmationKeyboard: (
    txId: string,
    summary: TradeConfirmationSummary,
    quote: SwapQuote,
    context: PreparedTradeQuoteContext
  ) => InlineKeyboard;
  onError: (error: unknown) => Promise<void> | void;
  summaryExtras?: (
    context: PreparedTradeQuoteContext
  ) => Partial<Omit<TradeConfirmationParams, "kind" | "quote">>;
  quoteOptions?: { slippageBps?: number };
  quoteErrorMessage?: string;
};

const prepareTokenTradeQuote = async ({
  ctx,
  telegramId,
  amountInput,
  kind,
  inputFactory,
  outputFactory,
  spinnerText,
  cacheQuote,
  buildConfirmationKeyboard,
  onError,
  summaryExtras,
  quoteOptions,
  quoteErrorMessage,
}: PrepareTokenTradeQuoteParams) => {
  const snapshot = await getCachedWalletData(telegramId);
  const factoryContext: TradeAssetFactoryContext = { telegramId, ...snapshot };

  const [inputAsset, outputAsset] = await Promise.all([
    Promise.resolve(inputFactory(factoryContext)),
    Promise.resolve(outputFactory(factoryContext)),
  ]);

  const amountResolution = resolveSpendAmount({
    amount: amountInput,
    assetTicker: inputAsset.ticker,
    inputDecimals: inputAsset.decimals,
    solBalance: snapshot.solBalance,
    tokenBalance: inputAsset.tokenBalance,
    formatSol: (lamports) => wallet.formatSolBalance(lamports),
    formatToken: (value, decimals) => wallet.formatTokenBalance(value, decimals),
    applySolFeeBuffer:
      inputAsset.applySolFeeBuffer ?? inputAsset.ticker === "SOL",
  });

  const preparedContext: PreparedTradeQuoteContext = {
    input: inputAsset,
    output: outputAsset,
    rawAmount: amountResolution.rawAmount,
    displayAmount: amountResolution.displayAmount,
  };

  const spinner = spinnerText({
    displayAmount: amountResolution.displayAmount,
    amountInput,
    inputTicker: inputAsset.ticker,
    outputTicker: outputAsset.ticker,
  });

  await prepareTradeQuote({
    ctx,
    kind,
    spinnerText: spinner,
    summaryInput: {
      payToken: inputAsset.ticker,
      payDisplay: amountResolution.displayAmount,
      payRawAmount: amountResolution.rawAmount,
      payDecimals: inputAsset.decimals,
      receiveToken: outputAsset.ticker,
      receiveDecimals: outputAsset.decimals,
      ...(summaryExtras?.(preparedContext) ?? {}),
    },
    quoteFetcher: async () => {
      const quote = await swapManager.getQuote({
        inputMint: inputAsset.mint,
        outputMint: outputAsset.mint,
        amount: amountResolution.rawAmount.toString(),
        slippageBps: quoteOptions?.slippageBps ?? 100,
        userKeypair: wallet.getKeyPair(telegramId),
        inputDecimals: inputAsset.decimals,
        outputDecimals: outputAsset.decimals,
        inputTicker: inputAsset.ticker.toUpperCase(),
        outputTicker: outputAsset.ticker.toUpperCase(),
      });
      if (!quote) {
        throw new Error(
          quoteErrorMessage ??
            `Cannot get quote for ${inputAsset.ticker} → ${outputAsset.ticker}`
        );
      }
      return quote;
    },
    cacheQuote: (txId, quote) => cacheQuote(txId, quote, preparedContext),
    buildConfirmationKeyboard: (txId, summary, quote) =>
      buildConfirmationKeyboard(txId, summary, quote, preparedContext),
    onError,
  });
};


/**
 * Check if the context is a private chat
 */
const isPrivateChat = (ctx: Context): boolean => {
  return ctx.chat?.type === "private";
};

/**
 * Check if the context is a group or supergroup chat
 */
const isGroupChat = (ctx: Context): boolean => {
  return ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
};

/**
 * Track chats that have had their first interaction
 */
const initiatedChats = new Set<number>();




// These will be initialized in setupAnchor
export let gameManager: GameManager;
export let program: anchor.Program<Timba>;
const tokenDb = TokenDatabase.getInstance();
let tokenManager: TokenManager;
let swapManager: SwapManager;

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Create a minimal context object for API operations
 */
const createApiContext = (chatId: number, api?: any): Context =>
  ({
    api: api || bot.api,
    chat: { id: chatId },
  } as unknown as Context);

/**
 * Validate that game data has required token information
 */
const validateGameTokenData = (
  gameData: any
): { isValid: boolean; error?: string } => {
  if (!gameData) return { isValid: false, error: "Game not found" };
  if (!gameData.token_mint || !gameData.token_ticker) {
    return { isValid: false, error: "Game missing token information" };
  }
  return { isValid: true };
};

// Test helpers to exercise internal utilities
export const __test_clampLamportsForFees = clampLamportsForFees;
export const __test_isPrivateChat = isPrivateChat;
export const __test_createApiContext = createApiContext;
export const __test_validateGameTokenData = validateGameTokenData;
export const __test_resetInitiatedChats = () => initiatedChats.clear();
export const __test_getInitiatedChats = () => new Set(initiatedChats);
export const __test_resolveSpendAmount = resolveSpendAmount;
export const __test_normalizeCustomTradeAmount = normalizeCustomTradeAmount;
export const __test_formatTradeConfirmationSummary = formatTradeConfirmationSummary;

/**
 * Update game message with proper error handling using simplified interface
 */
const updateGameMessageSafely = async (
  gameAddress: string,
  gameData: any,
  status: string = "Completed",
  winnerAddress?: string,
  totalPot?: number,
  winnerSignature?: string
): Promise<void> => {
  if (!gameData?.chat_id || !gameData?.message_id) return;

  try {
    const ctx = createApiContext(gameData.chat_id);
    await gameManager.updateGameMessageFromData(
      ctx,
      gameAddress,
      status,
      winnerAddress,
      totalPot,
      winnerSignature
    );
  } catch (error) {
    console.warn(`Could not update message for game ${gameAddress}:`, error);
  }
};

let prepareTokenTradeQuoteRunner: typeof prepareTokenTradeQuote =
  prepareTokenTradeQuote;

export const __test_setPrepareTokenTradeQuote = (
  fn: typeof prepareTokenTradeQuote
): void => {
  prepareTokenTradeQuoteRunner = fn;
};

export const __test_resetPrepareTokenTradeQuote = (): void => {
  prepareTokenTradeQuoteRunner = prepareTokenTradeQuote;
};

type GameMessageTarget = {
  chatId: number;
  messageId: number;
};

const getGameMessageTarget = (gameAddress: string): GameMessageTarget | null => {
  let chatId: number | undefined;
  let messageId: number | undefined;

  try {
    const activeMessage = gameManager.getActiveGameMessage(gameAddress);
    if (activeMessage) {
      chatId = activeMessage.chatId;
      messageId = activeMessage.messageId;
    }
  } catch (error) {
    // gameManager might not be initialized yet; fall back to database record
    console.warn(
      `Game manager not ready when resolving message target for ${gameAddress.slice(
        0,
        8
      )}...`
    );
  }

  if (chatId === undefined || messageId === undefined) {
    const gameRecord = gameDb.getGame(gameAddress);
    if (gameRecord) {
      if (chatId === undefined) {
        const rawChatId = gameRecord.chat_id;
        if (typeof rawChatId === "number") {
          chatId = rawChatId;
        } else if (typeof rawChatId === "string") {
          const parsedChatId = Number(rawChatId);
          if (!Number.isNaN(parsedChatId)) {
            chatId = parsedChatId;
          }
        }
      }
      if (messageId === undefined) {
        const rawMessageId = gameRecord.message_id;
        if (typeof rawMessageId === "number") {
          messageId = rawMessageId;
        } else if (typeof rawMessageId === "string") {
          const parsedMessageId = Number(rawMessageId);
          if (!Number.isNaN(parsedMessageId)) {
            messageId = parsedMessageId;
          }
        }
      }
    }
  }

  if (
    typeof chatId !== "number" ||
    typeof messageId !== "number" ||
    Number.isNaN(chatId) ||
    Number.isNaN(messageId)
  ) {
    console.warn(
      `Cannot find chat/message reference for game ${gameAddress.slice(
        0,
        8
      )}...`
    );
    return null;
  }

  return { chatId, messageId };
};

const sendReplyToGameMessage = async (
  target: GameMessageTarget,
  text: string
): Promise<void> => {
  try {
    await bot.api.sendMessage(target.chatId, text, {
      parse_mode: "HTML",
      reply_to_message_id: target.messageId,
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    console.error("Error sending reply to game message:", error);
  }
};

/**
 * Dynamic wallet UI that loads balances automatically
 */

const showWalletUI = async (ctx: any) => {
  await showWalletUIHandler(ctx, {
    wallet,
    getCachedWalletData,
    getPriceUSD,
    buildWalletCaption,
    createWalletKeyboard,
    WINNER_VIDEO_ID: getStartVideoId(),
  });
};

/**
 * Process game completion event with all related updates
 */
const processGameCompletion = async (
  gameAddress: string,
  winnerAddress: string,
  totalPot?: number,
  winnerTxSignature?: string
): Promise<void> => {
  // Update database
  const blockTime = await wallet.getBlockchainTime();
  gameDb.completeGame(gameAddress, winnerAddress, blockTime * 1000);

  // Update game message
  const gameData = gameDb.getGame(gameAddress);
  await updateGameMessageSafely(
    gameAddress,
    gameData,
    "Completed",
    winnerAddress,
    totalPot,
    winnerTxSignature
  );

  if (
    winnerAddress &&
    winnerAddress !== "cancelled" &&
    winnerAddress !== DEFAULT_NULL_ADDRESS
  ) {
    const target = getGameMessageTarget(gameAddress);
    if (target) {
      try {
        const apiCtx = createApiContext(target.chatId, bot.api);
        const winnerDisplay = await gameManager.getPlayerUsername(
          apiCtx,
          winnerAddress
        );
        let prizeDetails = "";
        const prizePot =
          typeof totalPot === "number"
            ? totalPot
            : typeof gameData?.amount === "number"
            ? gameData.amount
            : null;
        if (typeof prizePot === "number" && prizePot > 0) {
          const prizeInfo = await gameManager.getPrizeDisplay(
            gameAddress,
            prizePot,
            gameData?.token_ticker,
            gameData?.token_mint ?? undefined
          );
          if (prizeInfo) {
            const tickerSegment = prizeInfo.tokenTicker
              ? ` ${prizeInfo.tokenTicker}`
              : "";
            const usdSegment = prizeInfo.usdApproximation
              ? ` (${prizeInfo.usdApproximation})`
              : "";
            prizeDetails =
              ` Prize: ${escapeHtml(prizeInfo.formattedAmount)}` +
              `${escapeHtml(tickerSegment)}` +
              `${escapeHtml(usdSegment)}`;
          }
        }
        await sendReplyToGameMessage(
          target,
          `🏆 <b>${winnerDisplay}</b> won the game!${prizeDetails}`
        );
      } catch (winnerAnnouncementError) {
        console.error(
          `Error announcing winner for game ${gameAddress}:`,
          winnerAnnouncementError
        );
      }
    }
  }

  console.log(`✅ Processed game completion: ${gameAddress} with prize: ${totalPot}`);
};

/**
 * Clean up orphaned games (accounts closed but DB shows active)
 */
const cleanupOrphanedGame = async (gameAddress: string): Promise<void> => {
  const gameData = gameDb.getGame(gameAddress);
  if (!gameData || gameData.status === "completed") return;

  console.log(`🧹 Cleaning up orphaned game ${gameAddress}`);

  gameDb.completeGame(gameAddress, "cancelled", Date.now());
  await updateGameMessageSafely(
    gameAddress,
    gameData,
    "Completed",
    "cancelled"
  );

  console.log(`✅ Successfully cleaned up orphaned game ${gameAddress}`);
};

// ================================
// BOT SEQUENTIALIZATION
// ================================

const getSequentializationKey = (
  ctx: Context
): string | string[] | undefined => {
  const userId = ctx.from?.id?.toString();
  if (!userId) return undefined;

  if (ctx.callbackQuery?.data) {
    const callbackData = ctx.callbackQuery.data;
    if (
      callbackData.startsWith("join_") ||
      callbackData.startsWith("refresh_")
    ) {
      const gameAddress = callbackData.split("_")[1];
      return [userId, `game_${gameAddress}`];
    }
  }

  return userId;
};

bot.use(sequentialize(getSequentializationKey));
// Drop stale updates to avoid reacting to old messages/callbacks
bot.use(recentUpdateGuard);

// ================================
// UTILITY FUNCTIONS
// ================================

const getDefaultTokenMetadata = async () => {
  return await wallet.getTokenMetadata(DEFAULT_TOKEN_MINT);
};

type ChatTokenInfo = {
  tokenMint: string;
  tokenTicker: string;
  decimals: number;
};

const resolveChatTokenInfo = async (
  chatId?: number
): Promise<ChatTokenInfo> => {
  const defaultMetadata = await getDefaultTokenMetadata();
  const fallback: ChatTokenInfo = {
    tokenMint: DEFAULT_TOKEN_MINT,
    tokenTicker: DEFAULT_TOKEN_TICKER,
    decimals: defaultMetadata.decimals,
  };

  try {
    const { tokenMint, tokenTicker } = await tokenManager.resolveTokenForChat(
      chatId
    );

    try {
      const metadata = await wallet.getTokenMetadata(tokenMint);
      return {
        tokenMint,
        tokenTicker,
        decimals: metadata.decimals,
      };
    } catch (metadataError) {
      console.warn(
        `⚠️ Failed to load metadata for chat token ${tokenTicker} (${tokenMint}), falling back to default token`,
        metadataError
      );
      return fallback;
    }
  } catch (error) {
    console.warn(
      "⚠️ Could not resolve chat token configuration, using default token",
      error
    );
    return fallback;
  }
};

type GameSetupCopy = {
  gameType: "coinflip" | "giveaway";
  heading: string;
  introLines: string[];
  bulletPoints: string[];
  amountPrompt: string;
  suggestionLabel: string;
  lowBalanceCopy?: {
    object: string;
  };
  logPrefix: string;
};

const GAME_SETUP_COPY: Record<"coinflip" | "giveaway", GameSetupCopy> = {
  coinflip: {
    gameType: "coinflip",
    heading: "🪙 <b>CREATE COINFLIP</b>",
    introLines: ["Choose how much each player should stake:"],
    bulletPoints: [
      "• Two or more players enter with the same stake",
      "• Winner takes the full pot",
      "• Fair and transparent results",
    ],
    amountPrompt: "Select stake per player in <b>{TOKEN}</b>:",
    suggestionLabel: "Suggested stakes",
    lowBalanceCopy: {
      object: "stake per player",
    },
    logPrefix: "🪙",
  },
  giveaway: {
    gameType: "giveaway",
    heading: "🎁 <b>CREATE GIVEAWAY</b>",
    introLines: ["Choose the prize amount you want to give away:"],
    bulletPoints: [
      "• Free to join for all players",
      "• One lucky winner gets the prize",
      "• Fair and transparent results",
    ],
    amountPrompt: "Select prize amount in <b>{TOKEN}</b>:",
    suggestionLabel: "Suggested prizes",
    lowBalanceCopy: {
      object: "prize amount",
    },
    logPrefix: "🎁",
  },
};

const startInteractiveGameSetup = async (
  ctx: Context & { message?: any },
  telegramId: bigint,
  copy: GameSetupCopy
): Promise<void> => {
  console.log(`${copy.logPrefix} UI-based ${copy.gameType} creation`);

  const tokenInfo = await resolveChatTokenInfo(ctx.chat?.id);

  let balanceText = "";
  let userBalance = 0;

  try {
    const tokenBalance = await wallet.getTokenBalance(telegramId, tokenInfo.tokenMint, {
      createIfMissing: true,
    });
    const formattedBalance = wallet.formatTokenBalance(
      tokenBalance,
      tokenInfo.decimals
    );
    userBalance = tokenBalance / Math.pow(10, tokenInfo.decimals);
    balanceText = `\n💰 Your balance: <b>${formattedBalance} ${tokenInfo.tokenTicker}</b>\n`;
  } catch (error) {
    console.error("Error getting token balance:", error);
    balanceText = `\n⚠️ Could not load ${tokenInfo.tokenTicker} balance\n`;
  }

  const { formatted: contractMin } = await getContractMinimumAmount(
    tokenInfo.tokenMint,
    tokenInfo.decimals
  );

  let tokenPriceUSD = await getPriceUSD(tokenInfo.tokenMint);
  if (!tokenPriceUSD) {
    tokenPriceUSD = await getPriceUSD(tokenInfo.tokenTicker);
  }

  const suggestedAmounts = getSuggestedStakeAmounts(contractMin, userBalance);

  let message = `${copy.heading}\n\n`;
  message += `Token: <b>${tokenInfo.tokenTicker}</b>\n`;
  for (const line of copy.introLines) {
    message += line ? `${line}\n` : "\n";
  }
  message += balanceText;

  if (copy.lowBalanceCopy && userBalance < contractMin) {
    const { object } = copy.lowBalanceCopy;
    const minDisplay = formatTokenDisplay(contractMin, {
      decimals: tokenInfo.decimals,
    });
    message += `\n⚠️ Minimum ${object}: ${minDisplay} ${tokenInfo.tokenTicker}.\n`;
  }

  if (copy.bulletPoints.length > 0) {
    message += "\n";
    for (const bullet of copy.bulletPoints) {
      message += `${bullet}\n`;
    }
    message += "\n";
  }

  message += copy.amountPrompt.replace("{TOKEN}", tokenInfo.tokenTicker);

  if (suggestedAmounts.length > 0) {
    message += `\n\n${copy.suggestionLabel}:\n`;
    for (const amount of suggestedAmounts) {
      const amountDisplay = formatTokenDisplay(amount, {
        decimals: tokenInfo.decimals,
      });
      message += `• ${amountDisplay} ${tokenInfo.tokenTicker}`;
      if (tokenPriceUSD) {
        message += ` (~$${formatUsdValue(amount * tokenPriceUSD)})`;
      }
      message += "\n";
    }
  }

  const setupMessage = await ctx.reply(message, {
    parse_mode: "HTML",
    reply_markup: createAmountSelectionKeyboard(
      copy.gameType,
      userBalance,
      ctx.from?.id?.toString(),
      contractMin,
      tokenInfo.tokenTicker,
      {
        decimals: tokenInfo.decimals,
        tokenPriceUSD: tokenPriceUSD ?? undefined,
      }
    ),
    reply_to_message_id: ctx.message?.message_id,
  });

  updateGameSetupSession(ctx.from?.id || 0, {
    waitingFor: "setup",
    gameType: copy.gameType,
    userBalance,
    messageId: setupMessage.message_id,
    chatId: ctx.chat?.id || 0,
    creatorId: ctx.from?.id?.toString(),
    tokenMint: tokenInfo.tokenMint,
    tokenTicker: tokenInfo.tokenTicker,
    tokenDecimals: tokenInfo.decimals,
    contractMinimum: contractMin,
  });
};

type TokenContext = {
  tokenMint: string;
  tokenTicker: string;
  tokenDecimals: number;
  contractMinimum?: number;
};

const buildTokenContext = async (
  session: GameSetupSession | undefined,
  chatId?: number
): Promise<TokenContext> => {
  if (session?.tokenMint) {
    const decimals =
      typeof session.tokenDecimals === "number"
        ? session.tokenDecimals
        : (await getDefaultTokenMetadata()).decimals;
    return {
      tokenMint: session.tokenMint,
      tokenTicker: session.tokenTicker ?? DEFAULT_TOKEN_TICKER,
      tokenDecimals: decimals,
      contractMinimum: session.contractMinimum,
    };
  }

  const resolved = await resolveChatTokenInfo(chatId);
  return {
    tokenMint: resolved.tokenMint,
    tokenTicker: resolved.tokenTicker,
    tokenDecimals: resolved.decimals,
  };
};

type CreatorCallbackOptions = {
  name: string;
  resolveCreatorId: (ctx: Context) => string | undefined;
  failureText?: string;
};

type CreatorCallbackContext = {
  creatorId: string;
  userId: number;
  session?: GameSetupSession;
  tokenContext: TokenContext;
  updateSession: (updates: Partial<GameSetupSession>) => GameSetupSession;
  clearSession: () => void;
};

const withCreatorContext = (
  options: CreatorCallbackOptions,
  handler: (ctx: Context, creatorCtx: CreatorCallbackContext) => Promise<void> | void
) => {
  return async (ctx: Context) => {
    const creatorId = options.resolveCreatorId(ctx);
    const currentUserId = ctx.from?.id?.toString();

    console.log(`🔔 ${options.name} callback triggered:`, ctx.callbackQuery?.data);
    console.log(
      `👤 Creator: ${creatorId ?? "unknown"}, Current user: ${currentUserId ?? "unknown"}`
    );

    if (!creatorId) {
      console.warn(`${options.name}: unable to resolve creator id from callback`);
      await ctx.answerCallbackQuery("❌ Unable to process action");
      return;
    }

    if (!ensureCreator(ctx, creatorId, options.failureText)) {
      return;
    }

    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.answerCallbackQuery("❌ Unable to identify user");
      return;
    }

    let session = userSessions.get(userId);
    const tokenContext = await buildTokenContext(session, ctx.chat?.id);

    const creatorContext: CreatorCallbackContext = {
      creatorId,
      userId,
      session,
      tokenContext,
      updateSession: (updates) => {
        const base: Partial<GameSetupSession> = session ? { ...session } : {};
        const next = {
          ...base,
          ...updates,
          creatorId,
          tokenMint: tokenContext.tokenMint,
          tokenTicker: tokenContext.tokenTicker,
          tokenDecimals: tokenContext.tokenDecimals,
          contractMinimum:
            updates.contractMinimum ??
            (base.contractMinimum ?? tokenContext.contractMinimum),
        } as GameSetupSession;

        userSessions.set(userId, next);
        session = next;
        creatorContext.session = next;
        return next;
      },
      clearSession: () => {
        userSessions.delete(userId);
        session = undefined;
        creatorContext.session = undefined;
      },
    };

    await handler(ctx, creatorContext);
  };
};

const determineFractionDigits = (
  value: string,
  maxDecimals: number
): number => {
  const parts = value.split(".");
  const fraction = parts[1] ?? "";
  if (!fraction) {
    return Math.min(6, maxDecimals);
  }
  return Math.min(fraction.length, maxDecimals, 6);
};

const getPlayerData = async (
  telegramId: bigint,
  tokenMint?: string,
  options: { includeWsol?: boolean } = {}
): Promise<PlayerData> => {
  const keypair = wallet.getKeyPair(telegramId);
  const effectiveTokenMint = tokenMint || DEFAULT_TOKEN_MINT;
  const includeWsol = options.includeWsol === true;

  const balancePromises: Array<Promise<number>> = [
    wallet.getTokenBalance(
      telegramId,
      effectiveTokenMint,
      effectiveTokenMint === DEFAULT_TOKEN_MINT
        ? { createIfMissing: true }
        : undefined
    ),
    wallet.getBalance(telegramId),
  ];

  if (includeWsol) {
    balancePromises.push(wallet.getTokenBalance(telegramId, WSOL_MINT));
  }

  const results = await Promise.all(balancePromises);
  const tokenBalance = results[0]!;
  const solBalance = results[1]!;
  const wsolBalance = includeWsol ? results[2]! : 0;

  // Funds are handled per-game; no separate aggregate player balance account
  const gameBalance = 0;

  return { keypair, tokenBalance, solBalance, wsolBalance, gameBalance };
};

const isUserGroupAdmin = async (
  ctx: Context,
  userId: number
): Promise<boolean> => {
  try {
    if (!ctx.chat || ctx.chat.type === "private") return false;
    const member = await ctx.api.getChatMember(ctx.chat.id, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch (error) {
    console.warn(`Error checking admin status for user ${userId}:`, error);
    return false;
  }
};

// ================================
// TRANSACTION PROCESSING
// ================================

const validateAndProcessTransaction = async (
  ctx: Context,
  telegramId: bigint,
  amount: number,
  isSol: boolean,
  description: string,
  transactionFn: (
    playerData: PlayerData
  ) => Promise<string | { signature: string; message?: string }>,
  showSolscanLink: boolean = false
): Promise<void> => {
  const playerData = await getPlayerData(telegramId, undefined, {
    includeWsol: isSol,
  });
  const metadata = await getDefaultTokenMetadata();

  // Validate balance
  const totalBalance = isSol
    ? playerData.solBalance + playerData.wsolBalance
    : playerData.tokenBalance + playerData.gameBalance;
  if (totalBalance < amount) {
    const balanceStr = isSol
      ? `${wallet.formatSolBalance(
          playerData.solBalance + playerData.wsolBalance
        )} SOL`
      : `${wallet.formatTokenBalance(
          totalBalance,
          metadata.decimals
        )} ${DEFAULT_TOKEN_TICKER}`;
    const needStr = isSol
      ? `${wallet.formatSolBalance(amount)} SOL`
      : `${wallet.formatTokenBalance(
          amount,
          metadata.decimals
        )} ${DEFAULT_TOKEN_TICKER}`;

    await ctx.reply(
      `Insufficient balance. You have ${balanceStr} but need ${needStr}`,
      {
        reply_to_message_id: ctx.message?.message_id,
      }
    );
    return;
  }

  if (
    isSol &&
    playerData.solBalance < amount &&
    playerData.solBalance + playerData.wsolBalance >= amount
  ) {
    await ctx.reply(
      "You have enough WSOL to cover this amount. Use `/withdraw ADDRESS all` to withdraw everything at once, or unwrap WSOL with /unwrap before sending a partial SOL amount.",
      {
        reply_to_message_id: ctx.message?.message_id,
      }
    );
    return;
  }

  // Process transaction with loading state
  const processingMsg = await ctx.reply(`Processing ${description}...`, {
    reply_to_message_id: ctx.message?.message_id,
  });

  try {
    const txResult = await transactionFn(playerData);
    let txString = "";
    let overrideMessage: string | undefined;

    if (typeof txResult === "string") {
      txString = txResult.toString().trim();
    } else if (
      txResult &&
      typeof txResult === "object" &&
      typeof txResult.signature === "string"
    ) {
      txString = txResult.signature.trim();
      overrideMessage = txResult.message;
    }

    // Debug: Log transaction details when creating Solscan link
    if (showSolscanLink) {
      console.log(`🔗 Solscan link requested. txString: "${txString}", length: ${txString?.length || 0}`);
    }

    let successMessage: string;
    if (overrideMessage) {
      successMessage = overrideMessage;
    } else {
      successMessage = txString
        ? `${description} successful! 💸\n\n<code>${txString}</code>`
        : `${description} successful! 💸`;
    }

    // Add Solscan link if requested and we have a transaction signature
    if (showSolscanLink && txString) {
      // Determine the correct Solscan URL based on the RPC endpoint
      const rpcUrl = process.env['RPC_URL'] || "";
      const isDevnet = rpcUrl.includes("devnet") || rpcUrl.includes("dev") || rpcUrl.includes("localhost");
      const isTestnet = rpcUrl.includes("testnet") || rpcUrl.includes("test");

      let solscanUrl = `https://solscan.io/tx/${txString}`;
      if (isDevnet) {
        solscanUrl = `https://solscan.io/tx/${txString}?cluster=devnet`;
      } else if (isTestnet) {
        solscanUrl = `https://solscan.io/tx/${txString}?cluster=testnet`;
      }

      console.log(`🔗 Generated Solscan URL: ${solscanUrl} (isDevnet: ${isDevnet}, isTestnet: ${isTestnet})`);
      successMessage += `\n\n<a href="${solscanUrl}">View in Blockchain</a>`;
    }

    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      successMessage,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: showSolscanLink && !!txString }
      }
    );
  } catch (error: any) {
    const userFriendlyError = formatUserFriendlyError(error, wallet);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      userFriendlyError,
      { parse_mode: "HTML" }
    );
    if (error && typeof error === "object") {
      (error as any).__alreadyNotified = true;
    }
    throw error;
  }
};

// ================================
// RESPONSE HELPERS
// ================================

const handleCommandError = async (
  ctx: Context,
  error: any,
  commandName: string
): Promise<void> => {
  console.error(`Error in ${commandName} command:`, error);
  if (error && typeof error === "object" && (error as any).__alreadyNotified) {
    return;
  }
  const userFriendlyError = formatUserFriendlyError(error, wallet);
  await replyToMessage(ctx, userFriendlyError);
};

const replyToMessage = async (
  ctx: Context,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML"
): Promise<void> => {
  await ctx.reply(text, {
    parse_mode: parseMode,
    reply_to_message_id: ctx.message?.message_id,
  });
};

const replyUsageError = async (
  ctx: Context,
  message: string
): Promise<void> => {
  return replyToMessage(ctx, message);
};

const handleCallbackError = async (
  ctx: any,
  error: any,
  action: string
): Promise<void> => {
  await handleCallbackErrorSafe(ctx, error, action, {
    maxLength: 180,
  });
};

// ================================
// ANCHOR SETUP
// ================================

const initializeAnchorProvider = async () => {
  const adminKeypair = wallet.getAdminKeypair();
  const adminWallet = new anchor.Wallet(
    adminKeypair as unknown as anchor.web3.Keypair
  );
  const connection = wallet.getConnection();

  const provider = new anchor.AnchorProvider(
    connection as unknown as anchor.web3.Connection,
    adminWallet,
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      skipPreflight: false,
      maxRetries: 3,
    }
  );

  anchor.setProvider(provider);
  return new anchor.Program(
    idl as Timba,
    provider
  ) as anchor.Program<Timba>;
};

const setupAnchor = async () => {
  try {
    program = await initializeAnchorProvider();
    console.log(`Initialized Anchor program: ${program.programId}`);

    tokenManager = TokenManager.getInstance(
      wallet,
      DEFAULT_TOKEN_MINT,
      DEFAULT_TOKEN_TICKER
    );
    console.log(
      `Initialized TokenManager with default token: ${DEFAULT_TOKEN_TICKER}`
    );

    swapManager = new SwapManager(wallet.getConnection(), wallet);
    console.log("Initialized SwapManager with pump.fun integration");

    await initializeTokensList();
    gameManager = GameManager.getInstance(program, wallet, gameDb);

    await checkOracleStatus();
    await checkGameTokenStatus();
  } catch (error) {
    console.error("Error initializing Anchor program:", error);
    console.error(
      "Make sure admin-keypair.json exists in the project root directory."
    );
    throw error;
  }
};

const initializeTokensList = async () => {
  try {
    console.log("Initializing approved tokens...");

    await tokenManager.addToken(DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER);
    console.log(`Added default token: ${DEFAULT_TOKEN_TICKER}`);

    for (const token of TOKENS_LIST) {
      try {
        const success = await tokenManager.addToken(token.mint, token.ticker);
        if (success) {
          console.log(`Added approved token: ${token.ticker}`);
        }
      } catch (error) {
        console.warn(`Could not add approved token ${token.ticker}:`, error);
      }
    }

    console.log(
      `Initialized token database with ${tokenDb.getTokenCount()} tokens`
    );
  } catch (error) {
    console.warn("Error initializing approved tokens:", error);
  }
};

const checkOracleStatus = async () => {
  try {
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    const oracleAccount = await program.account.oracle.fetch(oraclePda);
    console.log(`Oracle found, operator: ${oracleAccount.operator.toString()}`);
  } catch (error) {
    console.log("Oracle not found, it might need to be initialized");
  }
};

/**
 * Get the actual minimum amount from the smart contract for a specific token.
 */
export const getContractMinimumAmount = async (
  tokenMint: string = DEFAULT_TOKEN_MINT,
  decimalsHint?: number
): Promise<{ formatted: number; raw: number; decimals: number }> => {
  let resolvedMint = tokenMint;
  let decimals =
    typeof decimalsHint === "number" ? decimalsHint : undefined;

  if (decimals === undefined) {
    try {
      const metadata = await wallet.getTokenMetadata(resolvedMint);
      decimals = metadata.decimals;
    } catch (metadataError) {
      console.warn(
        `⚠️ Could not fetch metadata for ${resolvedMint}, falling back to default token metadata`,
        metadataError
      );
      const fallbackMetadata = await getDefaultTokenMetadata();
      decimals = fallbackMetadata.decimals;
      resolvedMint = DEFAULT_TOKEN_MINT;
    }
  }

  try {
    const gameTokenPda = PDAManager.getGameTokenPDA(
      new PublicKey(resolvedMint),
      program.programId
    );
    const gameTokenAccount = await program.account.gameToken.fetch(
      gameTokenPda
    );

    const minAmountRaw = Number(gameTokenAccount.minAmount);
    const minAmountFormatted = minAmountRaw / Math.pow(10, decimals!);

    console.log(
      `✅ Contract minimum for ${resolvedMint}: ${minAmountFormatted}`
    );
    return {
      formatted: minAmountFormatted,
      raw: minAmountRaw,
      decimals: decimals!,
    };
  } catch (error) {
    console.warn(
      `⚠️ Could not fetch minimum from contract for ${resolvedMint}, using fallback`,
      error
    );
    const fallbackRaw = Math.round(20 * Math.pow(10, decimals!));
    return {
      formatted: 20,
      raw: fallbackRaw,
      decimals: decimals!,
    };
  }
};

const checkGameTokenStatus = async () => {
  try {
    const gameTokenPda = PDAManager.getGameTokenPDA(
      new PublicKey(DEFAULT_TOKEN_MINT),
      program.programId
    );
    const gameTokenAccount = await program.account.gameToken.fetch(
      gameTokenPda
    );

    const metadata = await getDefaultTokenMetadata();
    const formattedMinAmount = wallet.formatTokenBalance(
      Number(gameTokenAccount.minAmount),
      metadata.decimals
    );

    console.log(
      `Game token found with min amount: ${formattedMinAmount} ${DEFAULT_TOKEN_TICKER} (${gameTokenAccount.minAmount.toString()} raw units)`
    );
  } catch (error) {
    console.log("Game token not found, it might need to be initialized");
  }
};

// ================================
// BOT COMMANDS
// ================================

export type CreateGameViaCommandOptions = {
  gameType: "coinflip" | "giveaway";
  usageMessage: string;
  defaultMaxPlayers: number;
  minPlayers: number;
  maxPlayers: number;
  timeoutSeconds: number;
  gameLabel: string;
  inferErrorLabel: string;
  logPrefix: string;
  errorMessage: string;
};

const COINFLIP_COMMAND_OPTIONS: CreateGameViaCommandOptions = {
  gameType: "coinflip",
  usageMessage:
    "❌ Please provide a valid amount greater than 0.\n\nUsage: `/cf <amount>` or `/cf <amount> <maxPlayers>`",
  defaultMaxPlayers: 2,
  minPlayers: 2,
  maxPlayers: 100,
  timeoutSeconds: 60 * 60,
  gameLabel: "Coinflip",
  inferErrorLabel: "Coinflip",
  logPrefix: "🪙",
  errorMessage: "❌ Error creating coinflip game. Please try again.",
};

const GIVEAWAY_COMMAND_OPTIONS: CreateGameViaCommandOptions = {
  gameType: "giveaway",
  usageMessage:
    "❌ Please provide a valid amount greater than 0.\n\nUsage: `/ga <amount>` or `/ga <amount> <maxPlayers>`",
  defaultMaxPlayers: 10,
  minPlayers: 1,
  maxPlayers: 100,
  timeoutSeconds: 60 * 60,
  gameLabel: "Giveaway",
  inferErrorLabel: "Giveaway",
  logPrefix: "🎁",
  errorMessage: "❌ Error creating giveaway game. Please try again.",
};

type CreateGameViaCommandDeps = {
  parseAmount: (
    args: string[],
    amountArgIndex: number,
    chatId?: number
  ) => Promise<import("./types").ParseAmountResult>;
  inferMaxPlayers: typeof inferMaxPlayers;
  wallet: {
    getTokenBalance: (
      telegramId: bigint,
      mint: string,
      options?: { createIfMissing?: boolean }
    ) => Promise<number>;
    getTokenMetadata: (
      mint: string
    ) => Promise<{ decimals: number }>;
    formatTokenBalance: (amount: number, decimals: number) => string;
  };
  getContractMinimumAmount: typeof getContractMinimumAmount;
  gameManager: {
    createGame: (
      ...args: Parameters<GameManager["createGame"]>
    ) => ReturnType<GameManager["createGame"]>;
    createGameMessage: (
      ...args: Parameters<GameManager["createGameMessage"]>
    ) => ReturnType<GameManager["createGameMessage"]>;
  };
};

const defaultCreateGameViaCommandDeps = (): CreateGameViaCommandDeps => ({
  parseAmount: (args, index, chatId) =>
    tokenManager.parseAmount(args, index, chatId),
  inferMaxPlayers,
  wallet: {
    getTokenBalance: (telegramId, mint, options) =>
      wallet.getTokenBalance(telegramId, mint, options),
    getTokenMetadata: (mint) => wallet.getTokenMetadata(mint),
    formatTokenBalance: (amount, decimals) =>
      wallet.formatTokenBalance(amount, decimals),
  },
  getContractMinimumAmount,
  gameManager: {
    createGame: (...args) => gameManager.createGame(...args),
    createGameMessage: (...args) => gameManager.createGameMessage(...args),
  },
});

const createGameViaCommand = async (
  ctx: Context & { message?: any },
  args: string[],
  telegramId: bigint,
  options: CreateGameViaCommandOptions,
  deps: CreateGameViaCommandDeps = defaultCreateGameViaCommandDeps()
): Promise<void> => {
  console.log(`${options.logPrefix} Command-based ${options.gameType} creation:`, args);

  try {
    const parsed = await deps.parseAmount(args, 1, ctx.chat?.id);
    if (!parsed.success) {
      await ctx.reply(
        formatParseAmountError(parsed, options.usageMessage)
      );
      return;
    }

    const parsedAmount = parsed.data;
    const inferred = deps.inferMaxPlayers(
      args,
      1,
      parsedAmount.tokenWasSpecified,
      options.defaultMaxPlayers,
      options.minPlayers,
      options.maxPlayers
    );

    if (!inferred.ok) {
      await ctx.reply(`❌ ${options.inferErrorLabel} ${inferred.error}`);
      return;
    }

    const maxPlayers = inferred.value;
    const tokenMetadata = await deps.wallet.getTokenMetadata(
      parsedAmount.tokenMint
    );
    const { raw: minAmountRaw } = await deps.getContractMinimumAmount(
      parsedAmount.tokenMint,
      tokenMetadata.decimals
    );

    if (parsedAmount.amount < minAmountRaw) {
      const formattedMinimum = deps.wallet.formatTokenBalance(
        minAmountRaw,
        tokenMetadata.decimals
      );
      await ctx.reply(
        `❌ Amount below contract minimum of ${formattedMinimum} ${parsedAmount.tokenTicker}.`
      );
      return;
    }

    const userBalance = await deps.wallet.getTokenBalance(
      telegramId,
      parsedAmount.tokenMint,
      { createIfMissing: true }
    );

    if (userBalance < parsedAmount.amount) {
      const formatted = deps.wallet.formatTokenBalance(
        userBalance,
        tokenMetadata.decimals
      );
      await ctx.reply(
        `❌ Insufficient balance. You have ${formatted} ${parsedAmount.tokenTicker}, need ${parsedAmount.formattedAmount}.`
      );
      return;
    }

    const gameResult = await deps.gameManager.createGame(
      options.gameType,
      {
        amount: parsedAmount.amount,
        tokenMint: parsedAmount.tokenMint,
        tokenTicker: parsedAmount.tokenTicker,
        isSol: parsedAmount.isSol,
        requestedNativeSol: parsedAmount.requestedNativeSol,
      },
      maxPlayers,
      options.minPlayers,
      options.timeoutSeconds,
      telegramId,
      ctx.chat?.id || 0
    );

    if (!gameResult.success) {
      await ctx.reply(`❌ Failed to create game: ${gameResult.error}`);
      return;
    }

    if (gameResult.autoJoinResult && !gameResult.autoJoinResult.success) {
      await ctx.reply(
        gameResult.autoJoinResult.error || "Failed to auto-join game",
        { parse_mode: "HTML" }
      );
    }

    const creatorUsername = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name || "Unknown";

    await deps.gameManager.createGameMessage(
      ctx,
      gameResult.gameAddress!,
      options.gameLabel,
      parsedAmount.amount,
      creatorUsername,
      parsedAmount.tokenTicker,
      "Active"
    );
  } catch (error) {
    console.error(`Error in command-based ${options.gameType}:`, error);
    await ctx.reply(options.errorMessage);
  }
};

export const __test_createGameViaCommand = createGameViaCommand;

/**
 * Build token balances for display, including game balances
 */
const buildTokenBalances = async (
  telegramId: bigint,
  approvedTokens: any[]
) => {
  const allTokenBalances = await wallet.getAllApprovedTokenBalances(
    telegramId,
    approvedTokens
  );

  const tokenBalancesToShow = await Promise.all(
    allTokenBalances.map(async (token) => {
      try {
        const tokenPlayerData = await getPlayerData(telegramId, token.mint);
        return {
          ...token,
          balance: token.balance + tokenPlayerData.gameBalance,
        };
      } catch (error) {
        return token; // If error getting game balance, just show wallet balance
      }
    })
  );

  // Add tokens that have game balance but no wallet balance
  for (const approvedToken of approvedTokens) {
    const hasToken = allTokenBalances.some(
      (t) => t.mint === approvedToken.token_mint
    );
    if (!hasToken) {
      try {
        const tokenPlayerData = await getPlayerData(
          telegramId,
          approvedToken.token_mint
        );
        if (tokenPlayerData.gameBalance > 0) {
          tokenBalancesToShow.push({
            mint: approvedToken.token_mint,
            ticker: approvedToken.token_ticker,
            balance: tokenPlayerData.gameBalance,
            decimals: approvedToken.decimals,
            rawBalance: tokenPlayerData.gameBalance.toString(),
          });
        }
      } catch (error) {
        // Ignore if can't get game balance
      }
    }
  }

  return tokenBalancesToShow;
};

const createBalanceDeps = (): BalanceDeps => ({
  isPrivateChat,
  clearWalletCache,
  showWalletUI,
  getPlayerData,
  getApprovedTokens: () => tokenManager.getAllApprovedTokensWithMetadata(),
  buildTokenBalances,
  TOKENS_LIST,
  wallet,
  handleCommandError,
  getPriceUSD,
  buildWalletCaption,
  createWalletKeyboard,
  WINNER_VIDEO_ID: getStartVideoId(),
});

const createCoinflipDeps = (): CoinflipDeps => ({
  isGroupChat,
  showInteractiveSetup: (ctxWithMessage, telegramId) =>
    startInteractiveGameSetup(
      ctxWithMessage,
      telegramId,
      GAME_SETUP_COPY.coinflip
    ),
  createGameViaCommand: (ctxWithMessage, args, telegramId) =>
    createGameViaCommand(
      ctxWithMessage,
      args,
      telegramId,
      COINFLIP_COMMAND_OPTIONS
    ),
});

bot.command(["start", "balance"], async (ctx: Context) => {
  if (ctx.chat?.id) {
    initiatedChats.add(ctx.chat.id);
  }

  await onBalance(ctx as any, createBalanceDeps());
});


bot.command(["coinflip", "cf"], async (ctx) => {
  try {
    await handleCoinflipCommand(
      ctx as Context & { message?: any },
      createCoinflipDeps()
    );
  } catch (error) {
    console.error("Error in coinflip command:", error);
    await ctx.reply("❌ Error setting up coinflip game. Please try again.");
  }
});

bot.command(["giveaway", "ga"], async (ctx) => {
  try {
    if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
      return ctx.reply("❌ Giveaway games can only be created in groups!");
    }

    const telegramId = getTelegramId(ctx);
    const args = ctx.message?.text?.split(" ");

    if (args && args.length >= 2) {
      await createGameViaCommand(
        ctx as Context & { message?: any },
        args,
        telegramId,
        GIVEAWAY_COMMAND_OPTIONS
      );
      return;
    }

    await startInteractiveGameSetup(
      ctx as Context & { message?: any },
      telegramId,
      GAME_SETUP_COPY.giveaway
    );
  } catch (error) {
    console.error("Error in giveaway command:", error);
    await ctx.reply("❌ Error setting up giveaway game. Please try again.");
  }
});

// ================================
// WALLET COMMANDS
// ================================

bot.command(["withdraw", "wh"], async (ctx: Context) => {
  const telegramId = getTelegramId(ctx);
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 3) {
    return replyUsageError(
      ctx,
      "Usage: /withdraw &lt;address&gt; &lt;amount&gt; [TOKEN] or /withdraw &lt;address&gt; &lt;amount&gt; SOL"
    );
  }

  const addressArg = args[1];
  if (!addressArg) {
    return replyToMessage(
      ctx,
      "Invalid wallet address. Please provide a valid Solana address."
    );
  }

  let toAddress: PublicKey;
  try {
    toAddress = new PublicKey(addressArg);
  } catch {
    return replyToMessage(
      ctx,
      "Invalid wallet address. Please provide a valid Solana address."
    );
  }

  const amountArgRaw = args[2]?.trim();
  const tokenArgRaw = args[3]?.trim();
  const isAllRequest =
    amountArgRaw &&
    ["all", "max"].includes(amountArgRaw.toLowerCase());

  if (isAllRequest) {
    const wantsSol =
      !tokenArgRaw || tokenArgRaw.toUpperCase() === "SOL";
    if (!wantsSol) {
      return replyToMessage(
        ctx,
        "Use a numeric amount when withdrawing SPL tokens. `all` is only supported for SOL."
      );
    }

    try {
      const [nativeLamports, wsolLamports] = await Promise.all([
        wallet.getBalance(telegramId),
        wallet.getTokenBalance(telegramId, WSOL_MINT),
      ]);
      const totalLamports = nativeLamports + wsolLamports;

      if (totalLamports <= 0) {
        return replyToMessage(
          ctx,
          "Your wallet has no SOL or WSOL available to withdraw."
        );
      }

      await validateAndProcessTransaction(
        ctx,
        telegramId,
        totalLamports,
        true,
        "SOL withdrawal",
        async () => {
          const result = await wallet.withdrawAllSol(
            telegramId,
            toAddress
          );

          const totalText = wallet.formatSolBalance(
            result.totalLamportsSent
          );
          const nativeText =
            result.nativeLamportsSent > 0
              ? `\n• Native SOL: ${wallet.formatSolBalance(
                  result.nativeLamportsSent
                )} SOL`
              : "";
          const wsolText =
            result.wsolLamportsSent > 0
              ? `\n• WSOL (auto-unwrapped): ${wallet.formatSolBalance(
                  result.wsolLamportsSent
                )} SOL`
              : "";

          const message =
            `<b>Withdrawal completed</b> 💸\n\nSent ${totalText} SOL${nativeText}${wsolText}\n\n<code>${result.signature}</code>`;

          return { signature: result.signature, message };
        }
      );
    } catch (error: any) {
      await handleCommandError(ctx, error, "withdraw");
    }
    return;
  }

  // Allow SOL withdrawals by parsing in a non-game context
  const parsed = await tokenManager.parseAmount(args, 2, ctx.chat?.id, "tip");
  if (!parsed.success) {
    return replyToMessage(
      ctx,
      formatParseAmountError(parsed, "Please provide a valid amount greater than 0.")
    );
  }

  const parsedAmount = parsed.data;

  try {
    await validateAndProcessTransaction(
      ctx,
      telegramId,
      parsedAmount.amount,
      parsedAmount.isSol,
      `Withdrawal of ${parsedAmount.formattedAmount}`,
      async (playerData) => {
        if (parsedAmount.isSol) {
          const transferSolIx = SystemProgram.transfer({
            fromPubkey: playerData.keypair.publicKey,
            toPubkey: toAddress,
            lamports: parsedAmount.amount,
          });
          return await wallet.sendTransaction(
            [transferSolIx],
            [playerData.keypair]
          );
        } else {
          return await wallet.transferToken(
            telegramId,
            toAddress,
            parsedAmount.amount,
            parsedAmount.tokenMint
          );
        }
      }
    );
  } catch (error: any) {
    await handleCommandError(ctx, error, "withdraw");
  }
});

bot.command("tip", async (ctx: Context) => {
  const telegramId = getTelegramId(ctx);
  const repliedMessage = ctx.message?.reply_to_message;
  const args = ctx.message?.text?.split(" ");

  if (!repliedMessage || !repliedMessage.from || !args || args.length < 2) {
    return replyUsageError(
      ctx,
      "Usage: Reply to a user's message with /tip &lt;amount&gt; [TOKEN] or /tip &lt;amount&gt; SOL"
    );
  }

  if (repliedMessage.from.is_bot) {
    return replyToMessage(ctx, "You cannot tip bots!");
  }

  const recipientTelegramId = BigInt(repliedMessage.from.id);
  if (recipientTelegramId === telegramId) {
    return replyToMessage(ctx, "You can't tip yourself!");
  }

  const parsed = await tokenManager.parseAmount(args, 1, ctx.chat?.id, "tip");
  if (!parsed.success) {
    return replyToMessage(
      ctx,
      formatParseAmountError(parsed, "Please provide a valid amount greater than 0.")
    );
  }

  const parsedAmount = parsed.data;

  try {
    const recipientPubKey = wallet.getPublicKey(recipientTelegramId);
    const recipientName = repliedMessage.from.username
      ? `@${repliedMessage.from.username}`
      : repliedMessage.from.first_name || "User";

    await validateAndProcessTransaction(
      ctx,
      telegramId,
      parsedAmount.amount,
      parsedAmount.isSol,
      `Tip of ${parsedAmount.formattedAmount} to ${recipientName}`,
      async (playerData) => {
        if (parsedAmount.isSol) {
          const transferSolIx = SystemProgram.transfer({
            fromPubkey: playerData.keypair.publicKey,
            toPubkey: recipientPubKey,
            lamports: parsedAmount.amount,
          });
          return await wallet.sendTransaction(
            [transferSolIx],
            [playerData.keypair]
          );
        } else {
          return await wallet.transferToken(
            telegramId,
            recipientPubKey,
            parsedAmount.amount,
            parsedAmount.tokenMint
          );
        }
      },
      true // Show Solscan link for tips
    );
  } catch (error: any) {
    await handleCommandError(ctx, error, "tip");
  }
});

bot.command("wrap", async (ctx: Context) => {
  const telegramId = getTelegramId(ctx);
  const args = ctx.message?.text?.split(" ");

  if (!args) return;

  const amount = parseFloat(args?.[1] || "0") * LAMPORTS_PER_SOL;

  if (amount <= 0) {
    return replyUsageError(
      ctx,
      "Usage: /wrap &lt;amount&gt;\nExample: /wrap 0.1"
    );
  }

  try {
    await validateAndProcessTransaction(
      ctx,
      telegramId,
      amount,
      true, // isSol
      `Wrapping ${wallet.formatSolBalance(amount)} SOL to WSOL`,
      async (playerData) => {
        const wsolMint = new PublicKey(WSOL_MINT);
        const { address: wsolAccount, instructions: createAtaIx } =
          await wallet.findOrCreateAssociatedTokenAccount(
            playerData.keypair.publicKey,
            wsolMint,
            playerData.keypair
          );

        const transferSolIx = SystemProgram.transfer({
          fromPubkey: playerData.keypair.publicKey,
          toPubkey: wsolAccount,
          lamports: amount,
        });

        const syncNativeIx = createSyncNativeInstruction(wsolAccount);
        const allInstructions = [...createAtaIx, transferSolIx, syncNativeIx];

        return await wallet.sendTransaction(allInstructions, [
          playerData.keypair,
        ]);
      }
    );
  } catch (error: any) {
    await handleCommandError(ctx, error, "wrap");
  }
});

bot.command("unwrap", async (ctx: Context) => {
  const telegramId = getTelegramId(ctx);

  const processingMsg = await ctx.reply("Processing unwrap...", {
    reply_to_message_id: ctx.message?.message_id,
  });

  try {
    const { signature, amountLamports } = await wallet.unwrapSol(telegramId);
    await wallet.confirmTransaction(signature);
    clearWalletCache(telegramId);

    const formattedAmount = wallet.formatSolBalance(amountLamports);
    const solscanUrl = `https://solscan.io/tx/${signature}`;

    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      `✅ <b>UNWRAP COMPLETED</b>\n\nUnwrapped ${formattedAmount} WSOL to SOL\n\n🔗 <a href="${solscanUrl}">View on Solscan</a>`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }
    );
  } catch (error) {
    const userFriendlyError = formatUserFriendlyError(error, wallet);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      userFriendlyError,
      { parse_mode: "HTML" }
    );
  }
});

// ================================
// SWAP COMMAND
// ================================

bot.command(
  "swap",
  sequentialize((ctx) => [String(ctx.from?.id || 0), "swap"]),
  async (ctx: Context) => {
    const telegramId = getTelegramId(ctx);
    const args = ctx.message?.text?.split(" ").slice(1);

    if (!args || args.length < 3) {
      return replyUsageError(
        ctx,
        "Usage: /swap &lt;amount&gt; &lt;FROM&gt; &lt;TO&gt; [slippage%]\nExamples:\n• /swap 10 USDC SOL\n• /swap 100 USDT USDC 1.5"
      );
    }

    const [amountStr, fromToken, toToken, slippageStr] = args;
    const amount = parseFloat(amountStr || "0");
    const slippagePercent = slippageStr ? parseFloat(slippageStr) : 2.0; // Default 2% for better success rate

    if (amount <= 0) {
      return replyUsageError(ctx, "Amount must be greater than 0");
    }

    if (slippagePercent < 0.1 || slippagePercent > 5.0) {
      return replyUsageError(ctx, "Slippage must be between 0.1% and 5%");
    }

    if (!fromToken || !toToken) {
      return replyUsageError(ctx, "Please specify both FROM and TO tokens");
    }

    // Validate different tokens
    if (fromToken.toLowerCase() === toToken.toLowerCase()) {
      return replyUsageError(
        ctx,
        "Cannot swap the same token. Try different token pairs"
      );
    }

    // Handle SOL/WSOL special case - they're the same underlying token
    const isSolToWsol =
      (fromToken.toLowerCase() === "sol" && toToken.toLowerCase() === "wsol") ||
      (fromToken.toLowerCase() === "wsol" && toToken.toLowerCase() === "sol");

    if (isSolToWsol) {
      return replyUsageError(
        ctx,
        "SOL and WSOL are the same token for swapping purposes. Use /wrap to convert SOL to WSOL, or try different token pairs."
      );
    }

    // Warn about known non-tradable tokens
    const nonTradableTokens = ["TIMBA"];
    if (
      nonTradableTokens.includes(fromToken.toUpperCase()) ||
      nonTradableTokens.includes(toToken.toUpperCase())
    ) {
      return replyUsageError(
        ctx,
        "⚠️ TIMBA is not tradable on Jupiter. Try: /swap 10 USDC SOL"
      );
    }

    try {
      const processingMsg = await ctx.reply(`🔄 Processing swap request...`);

      // Get token information (handle SOL, common tokens, and mint addresses)
      const getTokenInfo = async (tickerOrMint: string) => {
        const upperTicker = tickerOrMint.toUpperCase();

        if (upperTicker === "SOL") {
          return {
            token_mint: "So11111111111111111111111111111111111111112", // WSOL mint for swaps
            token_ticker: "SOL",
            decimals: 9,
            added_at: 0,
          };
        }

        if (upperTicker === "USDC") {
          return {
            token_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            token_ticker: "USDC",
            decimals: 6,
            added_at: 0,
          };
        }

        // Check if it's a known token by ticker
        const knownToken = tokenManager.getKnownTokenByTicker(tickerOrMint);
        if (knownToken) {
          return knownToken;
        }

        // Check if it looks like a mint address (44 characters, base58)
        if (
          tickerOrMint.length === 44 &&
          /^[1-9A-HJ-NP-Za-km-z]+$/.test(tickerOrMint)
        ) {
          try {
            // Auto-discover token info including pump.fun detection
            const tokenInfo = await tokenManager.autoDiscoverTokenInfo(
              tickerOrMint
            );
            if (tokenInfo) {
              return {
                token_mint: tickerOrMint,
                token_ticker: tokenInfo.ticker,
                decimals: tokenInfo.decimals,
                added_at: Date.now(),
                isPumpFun: tokenInfo.isPumpFun,
              };
            }
          } catch (error) {
            console.log(
              `Failed to auto-discover token ${tickerOrMint}:`,
              error
            );
          }
        }

        return null;
      };

      const fromTokenInfo = await getTokenInfo(fromToken);
      const toTokenInfo = await getTokenInfo(toToken);

      if (!fromTokenInfo || !toTokenInfo) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          "❌ One or both tokens not found. Use token ticker (SOL, USDC) or valid mint address"
        );
        return;
      }

      // Check user balance
      const userKeypair = wallet.getKeyPair(telegramId);
      const rawAmount = Math.floor(
        amount * Math.pow(10, fromTokenInfo.decimals)
      );
      let userBalance: number;

      if (fromToken.toLowerCase() === "sol") {
        userBalance = await wallet.getBalance(telegramId);
        if (userBalance < rawAmount + 0.01 * LAMPORTS_PER_SOL) {
          // Reserve for fees
          await ctx.api.editMessageText(
            ctx.chat!.id,
            processingMsg.message_id,
            `❌ Insufficient SOL balance. You need at least ${
              amount + 0.01
            } SOL (including fees)`
          );
          return;
        }
      } else {
        userBalance = await wallet.getTokenBalance(
          telegramId,
          fromTokenInfo.token_mint ===
            "So11111111111111111111111111111111111111112"
            ? "SOL"
            : fromTokenInfo.token_mint
        );
        if (userBalance < rawAmount) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            processingMsg.message_id,
            `❌ Insufficient ${fromToken} balance. You have ${wallet.formatTokenBalance(
              userBalance,
              fromTokenInfo.decimals
            )} ${fromToken}`
          );
          return;
        }
      }

      // Use unified swap manager with pump.fun support
      const quote = await swapManager.getQuote({
        inputMint: fromTokenInfo.token_mint,
        outputMint: toTokenInfo.token_mint,
        amount: rawAmount.toString(),
        slippageBps: Math.floor(slippagePercent * 100),
        userKeypair,
        inputDecimals: fromTokenInfo.decimals,
        outputDecimals: toTokenInfo.decimals,
        inputTicker: fromToken.toUpperCase(),
        outputTicker: toToken.toUpperCase(),
      });

      // Format quote for display
      const quoteMessage = swapManager.formatQuoteForDisplay(
        quote,
        fromTokenInfo.decimals,
        toTokenInfo.decimals,
        fromToken.toUpperCase(),
        toToken.toUpperCase()
      );

      await ctx.api.editMessageText(
        ctx.chat!.id,
        processingMsg.message_id,
        quoteMessage,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Confirm Swap",
                  callback_data: `swap_confirm_${telegramId}`,
                },
                {
                  text: "❌ Cancel",
                  callback_data: `swap_cancel_${telegramId}`,
                },
              ],
            ],
          },
        }
      );

      // Store swap data temporarily for callback
      const swapData = {
        quote,
        fromTokenInfo,
        toTokenInfo,
        fromToken,
        toToken,
        userKeypair,
        telegramId,
        slippagePercent,
      };

      swapDataCache.setWithTTL(telegramId.toString(), swapData);
    } catch (error: any) {
      console.error("Swap error:", error);
      await handleCommandError(ctx, error, "swap");
    }
  }
);

// Temporary cache for swap data
// Transaction cache for buy/sell operations with TTL
const TRANSACTION_CACHE_TTL_MS = 5 * 60 * 1000;
const transactionCache = createExpiringCache<TransactionCacheEntry>(
  TRANSACTION_CACHE_TTL_MS
);

type SwapDataCacheEntry = {
  quote: SwapQuoteWithDecimals;
  fromTokenInfo: TokenInfoCacheEntry;
  toTokenInfo: TokenInfoCacheEntry;
  fromToken: string;
  toToken: string;
  userKeypair: Keypair;
  telegramId: bigint;
  slippagePercent: number;
};

const swapDataCache = createExpiringCache<SwapDataCacheEntry>(
  TRANSACTION_CACHE_TTL_MS
);

const getTradeTransactionCacheEntry = (
  txId: string
): { entry: TradeTransactionCacheEntry; source: "cache" | "pending" } | undefined => {
  const cachedEntry = transactionCache.get(txId);
  if (isTradeTransactionCacheEntry(cachedEntry)) {
    return { entry: cachedEntry, source: "cache" };
  }

  const pendingEntry = getPendingTransaction<TradeTransactionCacheEntry>(
    txId,
    false
  );

  if (pendingEntry && isTradeTransactionCacheEntry(pendingEntry)) {
    return { entry: pendingEntry, source: "pending" };
  }

  return undefined;
};

const getBuyTransactionCacheEntry = (
  txId: string
): { entry: BuyTransactionCacheEntry; source: "cache" | "pending" } | undefined => {
  const result = getTradeTransactionCacheEntry(txId);
  if (result?.entry.kind === "buy" && isBuyTransactionCacheEntry(result.entry)) {
    return { entry: result.entry, source: result.source };
  }

  return undefined;
};

const getSellTransactionCacheEntry = (
  txId: string
): { entry: SellTransactionCacheEntry; source: "cache" | "pending" } | undefined => {
  const result = getTradeTransactionCacheEntry(txId);
  if (result?.entry.kind === "sell" && isSellTransactionCacheEntry(result.entry)) {
    return { entry: result.entry, source: result.source };
  }

  return undefined;
};

// Swap confirmation callbacks
bot.callbackQuery(/^swap_(confirm|cancel)_(\d+)$/, async (ctx) => {
  const [, action, userId] = ctx.match!;
  const telegramId = getTelegramId(ctx);

  if (telegramId.toString() !== userId) {
    return safeAnswerCallbackQuery(ctx, "❌ This swap is not for you");
  }

  if (action === "cancel") {
    swapDataCache.delete(userId);
    await respondWithMenu(ctx, { text: "❌ Swap cancelled" });
    return safeAnswerCallbackQuery(ctx, "Swap cancelled");
  }

  // Handle confirmation
  const swapData = swapDataCache.get(userId);
  if (!swapData) {
    await respondWithMenu(ctx, { text: "❌ Swap expired. Please try again." });
    return safeAnswerCallbackQuery(ctx, "Swap expired");
  }

  try {
    await respondWithMenu(ctx, {
      text: `🔄 Executing swap via ${swapData.quote.provider}...`,
    });

    let signature: string;

    if (swapData.quote.provider === "jupiter") {
      // Use special Jupiter execution method
      signature = await swapManager.executeJupiterSwap(
        {
          inputMint: swapData.fromTokenInfo.token_mint,
          outputMint: swapData.toTokenInfo.token_mint,
          amount: swapData.quote.inputAmount,
          slippageBps: Math.floor(swapData.slippagePercent * 100),
          userKeypair: swapData.userKeypair,
          inputDecimals: swapData.fromTokenInfo.decimals,
          outputDecimals: swapData.toTokenInfo.decimals,
          inputTicker: swapData.fromToken.toUpperCase(),
          outputTicker: swapData.toToken.toUpperCase(),
        },
        swapData.quote
      );
    } else {
      // Use regular instruction-based approach for other providers
      const instructions = await swapManager.createSwapTransaction(
        {
          inputMint: swapData.fromTokenInfo.token_mint,
          outputMint: swapData.toTokenInfo.token_mint,
          amount: swapData.quote.inputAmount,
          slippageBps: Math.floor(swapData.slippagePercent * 100),
          userKeypair: swapData.userKeypair,
          inputDecimals: swapData.fromTokenInfo.decimals,
          outputDecimals: swapData.toTokenInfo.decimals,
          inputTicker: swapData.fromToken.toUpperCase(),
          outputTicker: swapData.toToken.toUpperCase(),
        },
        swapData.quote
      );

      // Execute transaction
      signature = await wallet.sendTransaction(instructions, [
        swapData.userKeypair,
      ]);

      // Wait for confirmation
      await wallet.confirmTransaction(signature);
    }

    // Auto-register tokens if they're not already known
    try {
      // Import SwapManager to access pumpFunClient
      const { pumpFunClient } = swapManager as any;

      // Register input token if not known
      const inputTokenMint = swapData.fromTokenInfo.token_mint;
      let inputTokenTicker = swapData.fromToken.toUpperCase();

      if (inputTokenTicker !== "SOL") {
        const existingInputToken =
          tokenManager.getKnownTokenByMint(inputTokenMint);
        if (!existingInputToken) {
          // Try to get real metadata for pump.fun tokens
          if (swapData.quote.provider === "pump-fun" && pumpFunClient) {
            try {
              const metadata = await pumpFunClient.getTokenMetadata(
                inputTokenMint
              );
              if (metadata && metadata.symbol) {
                inputTokenTicker = metadata.symbol.toUpperCase();
                console.log(
                  `🔍 Got pump.fun metadata for input token: ${inputTokenTicker}`
                );
              }
            } catch (metadataError) {
              console.log(
                `⚠️ Could not fetch pump.fun metadata for input token ${inputTokenMint}:`,
                (metadataError as Error).message
              );
            }
          }

          console.log(
            `🔄 Auto-registering input token from swap: ${inputTokenTicker} (${inputTokenMint})`
          );
          try {
            const registered = await tokenManager.addToken(
              inputTokenMint,
              inputTokenTicker
            );
            if (registered) {
              console.log(
                `✅ Successfully auto-registered input token: ${inputTokenTicker}`
              );
            } else {
              console.log(
                `❌ Failed to auto-register input token: ${inputTokenTicker} (${inputTokenMint})`
              );
            }
          } catch (regError) {
            console.error(
              `❌ Error auto-registering input token ${inputTokenTicker}:`,
              regError
            );
          }
        } else {
          console.log(
            `✅ Input token already registered: ${existingInputToken.token_ticker} (${inputTokenMint})`
          );
        }
      }

      // Register output token if not known
      const outputTokenMint = swapData.toTokenInfo.token_mint;
      let outputTokenTicker = swapData.toToken.toUpperCase();

      if (outputTokenTicker !== "SOL") {
        const existingOutputToken =
          tokenManager.getKnownTokenByMint(outputTokenMint);
        if (!existingOutputToken) {
          // Try to get real metadata for pump.fun tokens
          if (swapData.quote.provider === "pump-fun" && pumpFunClient) {
            try {
              const metadata = await pumpFunClient.getTokenMetadata(
                outputTokenMint
              );
              if (metadata && metadata.symbol) {
                outputTokenTicker = metadata.symbol.toUpperCase();
                console.log(
                  `🔍 Got pump.fun metadata for output token: ${outputTokenTicker}`
                );
              }
            } catch (metadataError) {
              console.log(
                `⚠️ Could not fetch pump.fun metadata for output token ${outputTokenMint}:`,
                (metadataError as Error).message
              );
            }
          }

          console.log(
            `🔄 Auto-registering output token from swap: ${outputTokenTicker} (${outputTokenMint})`
          );
          try {
            const registered = await tokenManager.addToken(
              outputTokenMint,
              outputTokenTicker
            );
            if (registered) {
              console.log(
                `✅ Successfully auto-registered output token: ${outputTokenTicker}`
              );
            } else {
              console.log(
                `❌ Failed to auto-register output token: ${outputTokenTicker} (${outputTokenMint})`
              );
            }
          } catch (regError) {
            console.error(
              `❌ Error auto-registering output token ${outputTokenTicker}:`,
              regError
            );
          }
        } else {
          console.log(
            `✅ Output token already registered: ${existingOutputToken.token_ticker} (${outputTokenMint})`
          );
        }
      }
    } catch (error) {
      console.warn("Failed to auto-register tokens:", error);
      // Don't fail the swap if auto-registration fails
    }

    const successMessage = [
      "✅ **Swap Completed Successfully!**",
      "",
      `🚀 **Provider:** ${swapData.quote.provider.toUpperCase()}`,
      `🔗 **Transaction:** [${signature.slice(
        0,
        8
      )}...](https://solscan.io/tx/${signature})`,
      `📥 **Input:** ${wallet.formatTokenBalance(
        parseInt(swapData.quote.inputAmount),
        swapData.fromTokenInfo.decimals
      )} ${swapData.fromToken}`,
      `📤 **Output:** ${wallet.formatTokenBalance(
        parseInt(swapData.quote.outputAmount),
        swapData.toTokenInfo.decimals
      )} ${swapData.toToken}`,
      "",
      swapData.quote.provider === "pump-fun"
        ? "🔥 **Pump.fun Token** - Non-graduated token swap"
        : `✅ **${NetworkDetector.getDisplayNameFromRpc(
            process.env.SOLANA_NETWORK || wallet.getConnection().rpcEndpoint
          )} Transaction** - Tokens transferred successfully`,
    ].join("\n");

    await respondWithMenu(ctx, { text: successMessage, parseMode: "Markdown" });
    await safeAnswerCallbackQuery(ctx, "Swap completed!");

    swapDataCache.delete(userId);
  } catch (error: any) {
    console.error("Swap execution error:", error);

    // Handle timeout specially - transaction might have succeeded
    if (
      (error as Error).message?.includes("Transaction confirmation timeout")
    ) {
      const signature = (error as Error).message.match(
        /signature ([A-Za-z0-9]{44,})/
      )?.[1];

      const timeoutMessage = [
        "⏳ **Swap Transaction Timeout**",
        "",
        "The swap transaction was sent but confirmation timed out.",
        "This often happens during network congestion.",
        "",
        signature
          ? `🔗 **Check Status:** [${signature.slice(
              0,
              8
            )}...](https://solscan.io/tx/${signature})`
          : "",
        "",
        "💡 **Next Steps:**",
        "• Transaction may still succeed - check your balance",
        "• Use `/checktx ${signature || 'SIGNATURE'}` to verify",
        "• Wait a few minutes before trying again",
      ]
        .filter(Boolean)
        .join("\n");

      await respondWithMenu(ctx, { text: timeoutMessage, parseMode: "Markdown" });
      await safeAnswerCallbackQuery(
        ctx,
        "Transaction timeout - may still succeed"
      );
    } else {
      const errorMessage = `❌ Swap failed: ${formatUserFriendlyError(error)}`;
      await respondWithMenu(ctx, { text: errorMessage });
      await safeAnswerCallbackQuery(ctx, "Swap failed");
    }

    swapDataCache.delete(userId);
  }
});

// ================================
// TOKEN MANAGEMENT COMMANDS
// ================================

bot.command("default", async (ctx: Context) => {
  if (!ctx.from) return;

  // Check if this is a private chat
  if (ctx.chat?.type === "private") {
    return replyToMessage(
      ctx,
      "🚫 Default tokens can only be set in groups or channels."
    );
  }

  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 2) {
    // Show current default token (anyone can view)
    const chatConfig = tokenManager.getChatDefaultToken(ctx.chat!.id);
    if (chatConfig) {
      const setBy = await gameManager.getUsernameFromTelegramId(
        ctx,
        chatConfig.set_by_telegram_id
      );
      return replyToMessage(
        ctx,
        `📄 Current default token: ${chatConfig.token_ticker}\n` +
          `🏷️ Token mint: <code>${chatConfig.token_mint}</code>\n` +
          `👤 Set by: @${setBy}\n` +
          `📅 Set at: ${new Date(chatConfig.set_at).toLocaleString()}\n\n` +
          `Use /default &lt;TOKEN_TICKER&gt; to change or /default clear to remove.`
      );
    } else {
      const defaultToken = tokenManager.getDefaultToken();
      return replyToMessage(
        ctx,
        `📄 No default token set for this chat.\n` +
          `🔄 Using bot default: ${defaultToken.tokenTicker}\n\n` +
          `Use /default &lt;TOKEN_TICKER&gt; to set a default token for this chat.`
      );
    }
  }

  // For changing the default token, check admin permissions
  const isAdmin = await isUserGroupAdmin(ctx, ctx.from.id);
  if (!isAdmin) {
    return replyToMessage(
      ctx,
      "🔒 Only group administrators can change the default token.\n\n" +
        "💡 Contact a group admin to set or change the default token for this chat."
    );
  }

  const tokenInput = args[1];
  if (!tokenInput) {
    return replyToMessage(ctx, "Please provide a token ticker.");
  }

  // Handle clear command
  if (
    tokenInput.toUpperCase() === "CLEAR" ||
    tokenInput.toUpperCase() === "REMOVE"
  ) {
    tokenManager.removeChatDefaultToken(ctx.chat!.id);
    return replyToMessage(
      ctx,
      "✅ Default token cleared for this chat. Using bot default token now."
    );
  }

  // Try to find the token
  const knownToken = tokenManager.getKnownTokenByTicker(tokenInput);
  if (!knownToken) {
    const allTokens = tokenManager.getAllKnownTokens();
    let response = `❌ Token "${tokenInput.toUpperCase()}" not found.\n\n`;

    if (allTokens.length > 0) {
      response += "📋 Known tokens:\n";
      for (const token of allTokens.slice(0, 10)) {
        // Show max 10 tokens
        response += `• ${token.token_ticker}\n`;
      }
      if (allTokens.length > 10) {
        response += `... and ${allTokens.length - 10} more.`;
      }
    } else {
      response += "💡 Contact the bot administrator to add new tokens.";
    }

    return replyToMessage(ctx, response);
  }

  // Set the default token
  tokenManager.setChatDefaultToken(
    ctx.chat!.id,
    knownToken.token_mint,
    knownToken.token_ticker,
    ctx.from.id.toString()
  );

  return replyToMessage(
    ctx,
    `✅ Default token set to ${knownToken.token_ticker}\n` +
      `🏷️ Token mint: <code>${knownToken.token_mint}</code>\n\n` +
      `All games and transactions will now use ${knownToken.token_ticker} by default unless specified otherwise.`
  );
});

// ================================
// INFORMATION COMMANDS
// ================================

bot.command("help", async (ctx: Context) => {
  const helpSections = [
    "<b>📝 Available Commands:</b>",
    "",
    "<b>💰 Wallet Commands:</b>",
    "/start, /balance - Show your wallet address and balances",
    "/wrap &lt;amount&gt; - Convert SOL to WSOL",
    "/unwrap - Convert your entire WSOL balance back to SOL",
    "/swap &lt;amount&gt; &lt;FROM&gt; &lt;TO&gt; [slippage%] - Swap tokens via Jupiter",
    "/withdraw &lt;address&gt; &lt;amount&gt; [TOKEN] - Withdraw tokens to external wallet",
    "/wh &lt;address&gt; &lt;amount&gt; [TOKEN] - Shorthand for withdraw command",
    "/tip &lt;amount&gt; [TOKEN] - Reply to a user's message to send them tokens",
    "",
    "<b>🎮 Game Commands:</b>",
    "/coinflip &lt;amount&gt; [TOKEN] &lt;maxTickets&gt; - Create a new coinflip game",
    "/cf &lt;amount&gt; [TOKEN] &lt;maxTickets&gt; - Shorthand for coinflip command",

    "/giveaway &lt;amount&gt; [TOKEN] &lt;maxTickets&gt; - Create a new giveaway",
    "/ga &lt;amount&gt; [TOKEN] &lt;maxTickets&gt; - Shorthand for giveaway command",

    "/active - Show your active games",
    "/games - Show your recent games",
    "/leaderboard - Show top 10 players in this group (groups only)",
    "",
    "<b>🪙 Token Management:</b>",
    "/default [TOKEN] - Show/set default token for this chat (admin only to set)",
    "",
    "<b>🔧 Utility Commands:</b>",
    "/debug - Show detailed wallet debug info (reply to user for their info too)",
    "/checktx &lt;signature&gt; - Check transaction details and status",
    "/oracle - Check Oracle configuration",
    "",
    "<b>ℹ️ Important:</b> ",
    "• Your player balance account will be automatically initialized when needed",
    "• Specify token after amount: /coinflip 100 TIMBA 2 or /tip 50 SOL",
    "• Swap examples: /swap 10 USDC SOL or /swap 100 USDT USDC 1.5",
    "• Group admins can set default tokens with /default &lt;TOKEN&gt;",

    "• Contact bot administrator to add support for new SPL tokens",
  ];

  await ctx.reply(helpSections.join("\n"), {
    parse_mode: "HTML",
    reply_to_message_id: ctx.message?.message_id,
  });
});

bot.command("debug", async (ctx: Context) => {
  const telegramId = getTelegramId(ctx);
  const replyToMessage = ctx.message?.reply_to_message;

  try {
    const debugInfo = await buildDebugInfo(
      telegramId,
      ctx.from?.first_name || "You"
    );
    let response = debugInfo;

    // If replying to someone, show their info too
    if (replyToMessage && replyToMessage.from && !replyToMessage.from.is_bot) {
      const recipientTelegramId = BigInt(replyToMessage.from.id);
      const recipientDebugInfo = await buildDebugInfo(
        recipientTelegramId,
        replyToMessage.from.first_name || "User",
        true
      );
      response += "\n\n" + recipientDebugInfo;
    }

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "debug");
  }
});

const buildDebugInfo = async (
  telegramId: bigint,
  name: string,
  isReplyTarget: boolean = false
): Promise<string> => {
  const playerData = await getPlayerData(telegramId);
  const metadata = await getDefaultTokenMetadata();

  const tokenAccount = await getAssociatedTokenAddress(
    new PublicKey(DEFAULT_TOKEN_MINT),
    playerData.keypair.publicKey
  );

  const prefix = isReplyTarget
    ? `<b>Reply Target: ${name}</b>`
    : `🔍 <b>Debug Info for ${name}</b>`;

  return [
    prefix,
    "",
    `Telegram ID: <code>${telegramId}</code>`,
    `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>`,
    `SOL Balance: ${wallet.formatSolBalance(playerData.solBalance)} SOL`,
    `Token Balance: ${wallet.formatTokenBalance(
      playerData.tokenBalance,
      metadata.decimals
    )} ${DEFAULT_TOKEN_TICKER}`,
    `Game Balance: ${wallet.formatTokenBalance(
      playerData.gameBalance,
      metadata.decimals
    )} ${DEFAULT_TOKEN_TICKER}`,
    `Token Account: <code>${tokenAccount.toBase58()}</code>`,
  ].join("\n");
};

bot.command("checktx", async (ctx: Context) => {
  const args = ctx.message?.text?.split(" ");
  const signature = args?.[1];

  if (!signature) {
    return ctx.reply("Usage: /checktx <transaction_signature>", {
      reply_to_message_id: ctx.message?.message_id,
    });
  }

  try {
    console.log(`Checking transaction: ${signature}`);
    const connection = wallet.getConnection();
    const txDetails = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!txDetails) {
      return ctx.reply("Transaction not found or not confirmed yet.", {
        reply_to_message_id: ctx.message?.message_id,
      });
    }

    const response = [
      "🔍 <b>Transaction Details</b>",
      "",
      `Signature: <code>${signature}</code>`,
      `Slot: ${txDetails.slot}`,
      `Block Time: ${
        txDetails.blockTime
          ? new Date(txDetails.blockTime * 1000).toISOString()
          : "Unknown"
      }`,
      `Fee: ${txDetails.meta?.fee || 0} lamports`,
      `Status: ${txDetails.meta?.err ? "❌ Failed" : "✅ Success"}`,
    ];

    if (txDetails.meta?.err) {
      response.push(
        `Error: <code>${JSON.stringify(txDetails.meta.err)}</code>`
      );
    }

    await ctx.reply(response.join("\n"), {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error: any) {
    console.error("Error checking transaction:", error);
    await ctx.reply(`Error checking transaction: ${(error as Error).message}`, {
      reply_to_message_id: ctx.message?.message_id,
    });
  }
});

bot.command("active", async (ctx: Context) => {
  const telegramId = getTelegramId(ctx);

  try {
    const { activeGames } = await gameManager.getUserGames(ctx, telegramId);

    let response = activeGames || "You don't have any active games.";

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "active");
  }
});

bot.command("games", async (ctx: Context) => {
  const telegramId = getTelegramId(ctx);

  try {
    const { recentGames } = await gameManager.getUserGames(ctx, telegramId);
    const response = recentGames || "You don't have any recent games.";

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "games");
  }
});

bot.command(["leaderboard", "lb"], async (ctx: Context) => {
  // Check if it's a group/supergroup chat
  if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
    return ctx.reply("❌ Leaderboard can only be used in groups!");
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    return ctx.reply("❌ Could not get chat information.");
  }

  try {
    console.log(`🏆 Generating leaderboard for chat ${chatId}`);

    // Get leaderboard stats for this chat
    const leaderboardStats = gameDb.getLeaderboardStats(chatId, 10);

    if (leaderboardStats.length === 0) {
      return ctx.reply(
        "⚔️ <b>HALL OF LEGENDS</b> ⚔️\n\n" +
        "No statistics available for this group yet.\n" +
        "Play some coinflips to appear on the leaderboard!\n\n" +
        "🎮 <i>Be the first to claim your throne!</i>",
        { parse_mode: "HTML", reply_to_message_id: ctx.message?.message_id }
      );
    }

    // Build competitive leaderboard message
    let leaderboardText = "⚔️ <b>HALL OF LEGENDS</b> ⚔️\n\n";

    for (let i = 0; i < leaderboardStats.length; i++) {
      const stats = leaderboardStats[i];
      const rank = i + 1;

      // Try to get username, fallback to telegram ID
      let displayName: string;
      try {
        // Get username from context if available
        const username = await gameManager.getUsernameFromTelegramId(ctx, stats.telegram_id);
        displayName = username ? `@${username}` : `Usuario ${stats.telegram_id}`;
      } catch (error) {
        console.warn(`Could not get username for ${stats.telegram_id}:`, error);
        displayName = `Usuario ${stats.telegram_id}`;
      }

      // Format volume with token breakdown (limit to top 5 tokens to avoid huge messages)
      let volumeFormatted = "";
      if (stats.token_volumes) {
        const tokenVolumes = stats.token_volumes.split('|').filter((vol: string) => Boolean(vol));

        // Parse tokens and prioritize TIMBA
        const tokenData: Array<{ticker: string, volume: number, formatted: string}> = [];

        for (const tokenVol of tokenVolumes) {
          const [ticker, volume] = tokenVol.split(':');
          if (!ticker || !volume) continue;

          const decimals = ticker === 'WSOL' ? 9 :
                          ticker === 'USDC' ? 6 :
                          ticker === 'USDT' ? 6 :
                          ticker === 'TIMBA' ? 6 : 9; // TIMBA has 6 decimals

          tokenData.push({
            ticker: ticker || 'UNKNOWN',
            volume: parseInt(volume),
            formatted: `${formatAmount(parseInt(volume), decimals)} ${ticker || 'UNKNOWN'}`
          });
        }

        // Prioritize TIMBA first, then sort others by volume (descending)
        const timbaToken = tokenData.find(t => t.ticker === 'TIMBA');
        const otherTokens = tokenData.filter(t => t.ticker !== 'TIMBA');
        otherTokens.sort((a, b) => b.volume - a.volume);

        // Combine: TIMBA first, then top 4 other tokens
        const topTokens = [];
        if (timbaToken) topTokens.push(timbaToken);
        topTokens.push(...otherTokens.slice(0, 4));

        if (topTokens.length > 0) {
          volumeFormatted = topTokens.map(t => t.formatted).join(' + ');
          // Add indicator if there are more tokens
          if (tokenData.length > 5) {
            volumeFormatted += ` + ${tokenData.length - 5} more`;
          }
        }
      } else {
        // Fallback to old format if no token breakdown (assume TIMBA with 6 decimals)
        volumeFormatted = formatAmount(stats.total_volume, 6);
      }

      // Competitive ranking with tier system
      let tierEmoji = "";
      let rankDisplay = "";

      if (rank === 1) {
        tierEmoji = "👑";
        rankDisplay = `${tierEmoji} <b>LEGEND</b>`;
      } else if (rank === 2) {
        tierEmoji = "🥇";
        rankDisplay = `${tierEmoji} <b>CHAMPION</b>`;
      } else if (rank === 3) {
        tierEmoji = "🥈";
        rankDisplay = `${tierEmoji} <b>MASTER</b>`;
      } else if (rank <= 5) {
        tierEmoji = "🥉";
        rankDisplay = `${tierEmoji} <b>EXPERT</b> #${rank}`;
      } else if (rank <= 10) {
        tierEmoji = "⚡";
        rankDisplay = `${tierEmoji} <b>WARRIOR</b> #${rank}`;
      } else {
        tierEmoji = "🔥";
        rankDisplay = `${tierEmoji} <b>FIGHTER</b> #${rank}`;
      }

      // Win streak indicator
      const winStreakEmoji = stats.win_rate >= 80 ? "🔥🔥🔥" :
                             stats.win_rate >= 60 ? "🔥🔥" :
                             stats.win_rate >= 40 ? "🔥" : "💀";

      leaderboardText += `${rankDisplay}\n`;
      leaderboardText += `<b>${displayName}</b> ${winStreakEmoji}\n`;
      leaderboardText += `💯 <b>${stats.games_won}W</b> | 📊 ${stats.win_rate}% | 💰 ${volumeFormatted}\n`;
      leaderboardText += `🎮 ${stats.total_games} battles\n\n`;
    }


    await ctx.reply(leaderboardText, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });

    console.log(`✅ Leaderboard generated for chat ${chatId} with ${leaderboardStats.length} players`);
  } catch (error) {
    console.error("Error generating leaderboard:", error);
    await handleCommandError(ctx, error, "leaderboard");
  }
});

// ================================
// SECURE COMMANDS
// ================================

bot.command("oracle", async (ctx: Context) => {
  try {
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    const oracleAccount = await program.account.oracle.fetch(oraclePda);

    const response = [
      "🔮 <b>Oracle Configuration</b>",
      "",
      `Operator: <code>${oracleAccount.operator.toString()}</code>`,
      `Fee Percentage: ${oracleAccount.feePercentage}%`,
      `Min Timeout: ${oracleAccount.minTimeout} seconds (${
        oracleAccount.minTimeout.toNumber() / 60
      } minutes)`,
      `Max Timeout: ${oracleAccount.maxTimeout} seconds (${
        oracleAccount.maxTimeout.toNumber() / 60
      } minutes)`,
      `Max Tickets: ${oracleAccount.maxTickets}`,
      `Oracle Buffer Time: ${oracleAccount.oracleBufferTime} seconds`,
      "",
      `Current Game Timeout: ${GAME_TIMEOUT} seconds (${
        GAME_TIMEOUT / 60
      } minutes)`,
    ].join("\n");

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "oracle");
  }
});

// ================================
// CALLBACK QUERY HANDLING
// ================================

const handleRefreshGameCallback = async (
  ctx: any,
  gamePda: PublicKey,
  gameAddress: string
): Promise<void> => {
  const gameData = gameDb.getGame(gameAddress);
  const validation = validateGameTokenData(gameData);

  if (!validation.isValid) {
    await safeAnswerCallbackQuery(ctx, validation.error!);
    return;
  }

  if (gameData!.status === "completed") {
    await safeAnswerCallbackQuery(ctx, "This game has already been completed!");
    return;
  }

  try {
    // Verify game still exists on blockchain
    await program.account.game.fetch(gamePda);

    await gameManager.updateGameMessageFromData(ctx, gameAddress, "Active");

    await safeAnswerCallbackQuery(ctx, "Game status refreshed!");
  } catch (error: any) {
    if ((error as Error).message?.includes("Account does not exist")) {
      await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
    } else {
      console.error(`Error refreshing game ${gameAddress}:`, error);
      await safeAnswerCallbackQuery(ctx, "Error refreshing game status!");
    }
  }
};

const handlePlayerEvent = async (
  event: PlayerEvent,
  eventName: string,
  emoji: string,
  action: string
): Promise<void> => {
  try {
    const gameAddress = event.gameKey.toString();
    const playerAddress = event.player.toString();
    const lastSlot = event.lastSlot.toString();
    const totalPot = Number(event.totalAmount);
    const timestamp = Number(event.timestamp);

    console.log(
      `${emoji} ${eventName} event: ${playerAddress} ${action} game ${gameAddress} (lastSlot: ${lastSlot}, totalPot: ${totalPot}, timestamp: ${timestamp})`
    );

    const slotWasUpdated = gameDb.updateGameLastSlotWithTimestamp(
      gameAddress,
      lastSlot,
      timestamp
    );

    if (slotWasUpdated) {
      const gameData = gameDb.getGame(gameAddress);
      const target = getGameMessageTarget(gameAddress);
      const chatId = target?.chatId ?? gameData?.chat_id;

      if (chatId) {
        try {
          const apiCtx = createApiContext(chatId, bot.api);
          await gameManager.updateGameMessageFromData(
            apiCtx,
            gameAddress,
            "Active",
            undefined,
            totalPot
          );

          if (eventName === "PlayerJoined" && target) {
            try {
              const displayName = await gameManager.getPlayerUsername(
                apiCtx,
                event.player.toString()
              );
              const announcement = `👤 <b>${displayName}</b> joined the game!`;
              await sendReplyToGameMessage(target, announcement);
            } catch (announcementError) {
              console.error(
                `Error announcing player join for game ${gameAddress}:`,
                announcementError
              );
            }
          }

          // Game completion is handled autonomously by the oracle
          // The bot only processes GameCompleted events from Solana
        } catch (contextError) {
          console.error(
            `Error creating context for chat ${chatId}:`,
            contextError
          );
        }
      }
    }
  } catch (error) {
    console.error(`Error processing ${eventName} event:`, error);
  }
};

bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery.data;
  console.log("📢 Generic callback handler received:", callbackData);

  if (!callbackData || !ctx.from) return;

  // Skip non-game callbacks (let them be handled by specific handlers)
  const nonGameCallbacks = [
    "main_wallet",
    "wallet_refresh",
    "wallet_settings",
    "cmd_help",
    "cmd_balance",
    "cmd_withdraw",
    "cmd_swap",
    "cmd_wrap",
    "cmd_privatekey",
    "help_wallet",
    "help_games",
    "help_utility",
    "help_examples",
    "cmd_buy",
    "cmd_sell",
  ];

  // Also skip send/swap/wrap/game-setup interface callbacks
  if (
    callbackData.startsWith("send_") ||
    callbackData.startsWith("swap_") ||
    callbackData.startsWith("wrap_") ||
    callbackData.startsWith("buy_") ||
    callbackData.startsWith("sell_") ||
    callbackData.startsWith("confirm_") ||
    callbackData.startsWith("amount_") ||
    callbackData.startsWith("players_") ||
    callbackData.startsWith("cancel_game_") ||
    callbackData.startsWith("custom_amount_") ||
    callbackData.startsWith("custom_players_") ||
    callbackData.startsWith("slider_") ||
    callbackData.startsWith("back_to_amounts_") ||
    callbackData.startsWith("type_amount_") ||
    callbackData.startsWith("admin_") ||
    callbackData.startsWith("info_") ||
    callbackData === "noop" ||
    nonGameCallbacks.includes(callbackData)
  ) {
    console.log("🔄 Calling next() for non-game callback:", callbackData);
    return await next(); // Pass to specific handlers
  }

  const splitData = callbackData.split("_");
  if (splitData.length < 2) return;

  const [action, gameAddress] = splitData;
  if (!action || !gameAddress) return;

  const game = gameDb.getGame(gameAddress);
  if (!game) {
    await safeAnswerCallbackQuery(ctx, "Game not found!");
    return;
  }

  // Check if the game is completed before allowing any actions
  if (game.status === "completed") {
    await handleCompletedGameCallback(ctx, game);
    return;
  }

  try {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery(
        "Unable to identify user. Please try again."
      );
      return;
    }

    const gamePda = new PublicKey(gameAddress);
    const telegramId = getTelegramId(ctx);
    const playerKp = wallet.getKeyPair(telegramId);

    switch (action) {
      case "join":
        await handleJoinGame(ctx, gamePda, playerKp, telegramId, game);
        break;
      case "refresh":
        await handleRefreshGameCallback(ctx, gamePda, gameAddress);
        break;
    }
  } catch (error: any) {
    await handleCallbackError(ctx, error, action);
  }
});

const handleCompletedGameCallback = async (ctx: any, game: any) => {
  try {
    const gameData = gameDb.getGame(game.game_address);

    if (gameData) {
      await gameManager.updateGameMessageFromData(
        ctx,
        game.game_address,
        "Completed",
        gameData.winner_address || undefined
      );

      const statusMessage =
        gameData.winner_address === "cancelled" ? "cancelled" : "completed";
      await ctx.answerCallbackQuery(`Game ${statusMessage} - message updated!`);
    } else {
      // Game data not found in database - game may have been cleaned up
      console.warn(`Game data not found for ${game.game_address}`);
      await ctx.answerCallbackQuery(
        "Game data not found - game may have been completed"
      );
    }
  } catch (error) {
    console.error("Error updating completed game message:", error);
    await ctx.answerCallbackQuery("Failed to update game message");
  }
};

const handleJoinGame = async (
  ctx: any,
  gamePda: PublicKey,
  _playerKp: any,
  telegramId: bigint,
  game: any
) => {
  // Validate game status before attempting to join
  if (game.status !== "active") {
    await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
    return;
  }

  try {
    const result = await gameManager.joinGame(
      game.game_address,
      telegramId,
      ctx.chat?.id
    );

    if (!result.success) {
      await safeAnswerCallbackQuery(ctx, result.error || "Failed to join game");
      return;
    }

    // Update game message after successful join
    await gameManager.updateGameMessageFromData(
      ctx,
      game.game_address,
      "Active"
    );

    // Send join notification (commented out to prevent duplicate messages)
    // const joinerUsername =
    //   ctx.from?.username || ctx.from?.first_name || "Player";
    // const updatedGameAccount = await program.account.game.fetch(gamePda);
    // const ticketCount = updatedGameAccount.ticketsCount;
    // const maxTickets = updatedGameAccount.maxTickets;
    // const gameTypeKeys = Object.keys(updatedGameAccount.gameType);
    // const gameName = gameTypeKeys[0] || "game";

    // const gameMessage = gameManager.getActiveGameMessage(game.game_address);
    // await ctx.reply(
    //   `🎮 @${joinerUsername} joined the ${gameName}! (${ticketCount}/${maxTickets} tickets)`,
    //   {
    //     parse_mode: "HTML",
    //     reply_to_message_id: gameMessage?.messageId,
    //   }
    // );

    // Just show callback confirmation instead
    const updatedGameAccount = await program.account.game.fetch(gamePda);
    const ticketCount = updatedGameAccount.ticketsCount;
    const maxTickets = updatedGameAccount.maxTickets;
    await safeAnswerCallbackQuery(ctx, `✅ Joined! (${ticketCount}/${maxTickets})`);
  } catch (error: any) {
    // Handle specific case where account doesn't exist (game was completed/cancelled)
    if ((error as Error).message?.includes("Account does not exist")) {
      await ctx.answerCallbackQuery("This game is no longer active!");
    } else {
      // Re-throw the error to be handled by the outer catch block
      throw error;
    }
  }
};

// ================================
// GAME SETUP CALLBACK HANDLERS
// ================================



// Amount selection callbacks (new format with creatorId)
bot.callbackQuery(
  /^amount_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)$/,
  withCreatorContext(
    {
      name: "amount",
      resolveCreatorId: (ctx) => ctx.match?.[3],
      failureText: "🚫 Only the game creator can modify this game setup!",
    },
    async (ctx, { session, tokenContext, updateSession, creatorId }) => {
      try {
        const gameType = ctx.match![1] as string;
        const amount = ctx.match![2] as string;

        const amountNumber = Number(amount);
        const formattedAmount = amountNumber.toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: determineFractionDigits(
            amount,
            tokenContext.tokenDecimals
          ),
        });

        const playerMessage = [
          `<b>${gameType.toUpperCase()} - CHOOSE PLAYERS</b>`,
          "",
          `Amount: <b>${formattedAmount} ${tokenContext.tokenTicker}</b>`,
          "",
          "Select the number of players:",
          "",
          gameType === "coinflip"
            ? "• All players compete for the total stakes"
            : "• More players = higher chance for everyone",
          "",
          "Choose number of players:",
        ].join("\n");

        await respondWithMenu(ctx, {
          text: playerMessage,
          parseMode: "HTML",
          keyboard: createPlayerSelectionKeyboard(gameType, amount, creatorId),
        });

        updateSession({
          waitingFor: "setup",
          gameType,
          userBalance: session?.userBalance ?? 0,
          messageId:
            ctx.callbackQuery?.message?.message_id ?? session?.messageId,
          chatId: ctx.chat?.id ?? session?.chatId ?? 0,
          amount,
        });

        await ctx.answerCallbackQuery();
      } catch (error) {
        console.error("Error in amount callback:", error);
        await ctx.answerCallbackQuery("❌ Error selecting amount");
      }
    }
  )
);


// Player selection callbacks (new format with creatorId)
bot.callbackQuery(
  /^players_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)_(\d+)$/,
  withCreatorContext(
    {
      name: "players",
      resolveCreatorId: (ctx) => ctx.match?.[4],
      failureText: "🚫 Only the game creator can modify this game setup!",
    },
    async (ctx, { session, tokenContext, updateSession, creatorId }) => {
      try {
        const gameType = ctx.match![1] as string;
        const amount = ctx.match![2] as string;
        const players = ctx.match![3] as string;

        const amountNumber = Number(amount);
        const amountFormatted = amountNumber.toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: determineFractionDigits(
            amount,
            tokenContext.tokenDecimals
          ),
        });
        const playersCount = parseInt(players, 10);
        const totalPot = amountNumber * playersCount;
        const totalPotFormatted = totalPot.toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: Math.min(
            tokenContext.tokenDecimals,
            6
          ),
        });

        const confirmMessage = [
          `<b>CONFIRM ${gameType.toUpperCase()}</b>`,
          "",
          `Amount: <b>${amountFormatted} ${tokenContext.tokenTicker}</b>`,
          `Players: <b>${players}</b>`,
          "",
          gameType === "coinflip"
            ? `• Total prize pool: <b>${totalPotFormatted} ${tokenContext.tokenTicker}</b>`
            : `• Prize for winner: <b>${amountFormatted} ${tokenContext.tokenTicker}</b>`,
          "",
          `⚠️ Make sure you have enough ${tokenContext.tokenTicker} in your wallet!`,
          "",
          "Ready to create this game?"
        ].join("\n");

        await respondWithMenu(ctx, {
          text: confirmMessage,
          parseMode: "HTML",
          keyboard: createGameConfirmKeyboard(
            gameType,
            amount,
            players,
            creatorId
          ),
        });

        updateSession({
          waitingFor: "setup",
          gameType,
          userBalance: session?.userBalance ?? 0,
          messageId:
            ctx.callbackQuery?.message?.message_id ?? session?.messageId,
          chatId: ctx.chat?.id ?? session?.chatId ?? 0,
          amount,
        });

        await ctx.answerCallbackQuery();
      } catch (error) {
        console.error("Error in players callback:", error);
        await ctx.answerCallbackQuery("❌ Error selecting players");
      }
    }
  )
);


// Game creation confirmation (new format with creatorId)
bot.callbackQuery(
  /^confirm_game_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)_(\d+)$/,
  withCreatorContext(
    {
      name: "confirm_game",
      resolveCreatorId: (ctx) => ctx.match?.[4],
      failureText: "🚫 Only the game creator can create this game!",
    },
    async (ctx, { userId, tokenContext, clearSession }) => {
      let confirmMessageMissing = false;

      try {
        const gameType = ctx.match![1] as "coinflip" | "giveaway";
        const amount = parseFloat(ctx.match![2] as string);
        const maxPlayers = parseInt(ctx.match![3] as string);
        const minPlayers = gameType === "coinflip" ? 2 : 1;
        if (isNaN(maxPlayers) || maxPlayers < minPlayers || maxPlayers > 100) {
          await ctx.answerCallbackQuery(
            `❌ Players must be between ${minPlayers} and 100`
          );
          return;
        }

        const confirmMessage = ctx.callbackQuery?.message;
        const chatId = confirmMessage?.chat?.id;
        const messageId = confirmMessage?.message_id;
        const creationKey =
          chatId && messageId
            ? `${chatId}:${messageId}`
            : `${userId}:${gameType}:${amount}:${maxPlayers}`;

        if (pendingGameCreations.has(creationKey)) {
          await ctx.answerCallbackQuery("⏳ Already creating this game...");
          return;
        }

        pendingGameCreations.add(creationKey);

        try {
          if (chatId && messageId && !confirmMessageMissing) {
            try {
              await ctx.api.editMessageReplyMarkup(chatId, messageId);
            } catch (markError) {
              console.warn(
                "Failed to clear confirm keyboard before game creation:",
                markError
              );
              if (isMessageMissing(markError)) {
                confirmMessageMissing = true;
              }
            }

            if (!confirmMessageMissing) {
              try {
                await ctx.api.editMessageText(
                  chatId,
                  messageId,
                  "⏳ Creating game…",
                  {
                    parse_mode: "HTML",
                  }
                );
              } catch (textError) {
                console.warn(
                  "Failed to set progress text before game creation:",
                  textError
                );
                if (isMessageMissing(textError)) {
                  confirmMessageMissing = true;
                }
              }
            }
          }

          await ctx.answerCallbackQuery("Creating game...");

          const decimals = tokenContext.tokenDecimals;
          const amountRaw = Math.round(amount * Math.pow(10, decimals));
          const gameData = {
            amount: amountRaw,
            isSol: false,
            formattedAmount: amount.toString(),
            tokenMint: tokenContext.tokenMint,
            tokenTicker: tokenContext.tokenTicker,
            tokenWasSpecified: tokenContext.tokenMint !== DEFAULT_TOKEN_MINT,
          };

          const result = await gameManager.createGame(
            gameType,
            gameData,
            maxPlayers,
            gameType === "coinflip" ? 2 : 1,
            GAME_TIMEOUT,
            getTelegramId(ctx),
            ctx.chat?.id
          );

          if (!result.success) {
            await notifyConfirmUser(
              ctx,
              `❌ ${result.error || "Failed to create game"}`,
              confirmMessageMissing
            );
            return;
          }

          if (!result.gameAddress) {
            await notifyConfirmUser(
              ctx,
              "❌ Game created but address not returned",
              confirmMessageMissing
            );
            return;
          }

          const creatorUsername = ctx.from?.username
            ? `@${ctx.from.username}`
            : "Unknown";

          const replyToUserMessageId = (ctx.callbackQuery as any)?.message
            ?.reply_to_message?.message_id as number | undefined;

          if (chatId && messageId && !confirmMessageMissing) {
            try {
              await ctx.api.deleteMessage(chatId, messageId);
            } catch (e) {
              console.warn("Could not delete confirmation message:", e);
              if (isMessageMissing(e)) {
                confirmMessageMissing = true;
              } else {
                try {
                  await ctx.api.editMessageText(
                    chatId,
                    messageId,
                    `✅ Game created!\n\n<code>${result.gameAddress}</code>`,
                    {
                      parse_mode: "HTML",
                    }
                  );
                } catch (fallbackError) {
                  console.warn(
                    "Failed to mark confirmation message as processed:",
                    fallbackError
                  );
                  if (isMessageMissing(fallbackError)) {
                    confirmMessageMissing = true;
                  }
                }
              }
            }
          }

          await gameManager.createGameMessage(
            ctx,
            result.gameAddress,
            gameType.charAt(0).toUpperCase() + gameType.slice(1),
            gameData.amount,
            creatorUsername,
            gameData.tokenTicker,
            "Active",
            replyToUserMessageId
          );

          clearSession();

          if (result.autoJoinResult?.success) {
            try {
              await gameManager.updateGameMessageFromData(
                ctx,
                result.gameAddress,
                "Active"
              );
            } catch (error) {
              console.error(
                "Failed to update game message after auto-join:",
                error
              );
            }
          }

          if (result.autoJoinResult && !result.autoJoinResult.success) {
            await ctx.reply(
              result.autoJoinResult.error || "Failed to auto-join game",
              {
                parse_mode: "HTML",
              }
            );
          }
        } finally {
          pendingGameCreations.delete(creationKey);
        }
      } catch (error) {
        console.error("Error in confirm_game callback:", error);
        try {
          await ctx.answerCallbackQuery("❌ Error creating game");
        } catch (answerError) {
          console.error("Failed to answer callback after error:", answerError);
        }

        try {
          await notifyConfirmUser(
            ctx,
            "❌ Failed to create game. Please try again.",
            confirmMessageMissing
          );
        } catch (notifyError) {
          console.error(
            "Failed to update confirmation message after error:",
            notifyError
          );
        }
      }
    }
  )
);


// Custom amount callback - shows slider interface (new format with creator ID)
bot.callbackQuery(
  /^custom_amount_(coinflip|giveaway)_(\d+)$/,
  withCreatorContext(
    {
      name: "custom_amount",
      resolveCreatorId: (ctx) => ctx.match?.[2],
      failureText: "❌ Only the game creator can modify this setup!",
    },
    async (ctx, { session, tokenContext, updateSession, creatorId }) => {
      try {
        const gameType = ctx.match![1] as string;
        const telegramId = getTelegramId(ctx);

        let userBalance =
          session?.userBalance && session.userBalance > 0
            ? session.userBalance
            : 0;
        if (userBalance <= 0) {
          try {
            const tokenBalance = await wallet.getTokenBalance(
              telegramId,
              tokenContext.tokenMint,
              { createIfMissing: true }
            );
            userBalance =
              tokenBalance / Math.pow(10, tokenContext.tokenDecimals);
          } catch (error) {
            console.error("Error getting balance for slider:", error);
          }
        }

        const { formatted: contractMin } =
          tokenContext.contractMinimum !== undefined
            ? { formatted: tokenContext.contractMinimum }
            : await getContractMinimumAmount(
                tokenContext.tokenMint,
                tokenContext.tokenDecimals
              );

        const precisionFactor = Math.pow(10, tokenContext.tokenDecimals);
        const roundValue = (value: number) =>
          Math.round(value * precisionFactor) / precisionFactor;

        const defaultStart =
          userBalance > 0
            ? Math.min(
                userBalance,
                Math.max(contractMin, userBalance * 0.1)
              )
            : contractMin;
        const startAmount = roundValue(Math.max(contractMin, defaultStart));

        await respondWithMenu(ctx, {
          text: `🎯 <b>CUSTOM AMOUNT - ${gameType.toUpperCase()}</b>\n\n💰 Balance: <b>${userBalance.toFixed(
            Math.min(4, tokenContext.tokenDecimals)
          )} ${tokenContext.tokenTicker}</b>\n\nAdjust the amount using the controls below:`,
          parseMode: "HTML",
          keyboard: createSliderAmountKeyboard(
            gameType,
            startAmount,
            userBalance,
            creatorId,
            tokenContext.tokenTicker,
            tokenContext.tokenDecimals
          ),
        });

        updateSession({
          waitingFor: "setup",
          gameType,
          userBalance,
          messageId: session?.messageId ?? ctx.callbackQuery?.message?.message_id,
          chatId: session?.chatId ?? ctx.chat?.id ?? 0,
          contractMinimum: contractMin,
          amount: session?.amount,
        });

        await ctx.answerCallbackQuery();
      } catch (error) {
        console.error("Error in creator-protected custom_amount callback:", error);
        await ctx.answerCallbackQuery("❌ Error loading custom amount");
      }
    }
  )
);


// Slider controls callback (new format with creator ID)
bot.callbackQuery(
  /^slider_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)$/,
  withCreatorContext(
    {
      name: "slider",
      resolveCreatorId: (ctx) => ctx.match?.[3],
      failureText: "❌ Only the game creator can modify this setup!",
    },
    async (ctx, { session, tokenContext, updateSession, creatorId }) => {
      try {
        const gameType = ctx.match![1] as string;
        const newAmount = parseFloat(ctx.match![2] as string);
        const telegramId = getTelegramId(ctx);

        let userBalance =
          session?.userBalance && session.userBalance > 0
            ? session.userBalance
            : 0;
        if (userBalance <= 0) {
          try {
            const tokenBalance = await wallet.getTokenBalance(
              telegramId,
              tokenContext.tokenMint,
              { createIfMissing: true }
            );
            userBalance =
              tokenBalance / Math.pow(10, tokenContext.tokenDecimals);
          } catch (error) {
            console.error("Error getting balance for slider:", error);
          }
        }

        const precisionFactor = Math.pow(10, tokenContext.tokenDecimals);
        const roundValue = (value: number) =>
          Math.round(value * precisionFactor) / precisionFactor;
        const minValue =
          tokenContext.contractMinimum !== undefined
            ? tokenContext.contractMinimum
            : (await getContractMinimumAmount(
                tokenContext.tokenMint,
                tokenContext.tokenDecimals
              )).formatted;
        const validAmount = roundValue(
          Math.max(
            minValue,
            Math.min(
              userBalance > 0 ? userBalance : newAmount,
              newAmount
            )
          )
        );

        await respondWithMenu(ctx, {
          text: `🎯 <b>CUSTOM AMOUNT - ${gameType.toUpperCase()}</b>\n\n💰 Balance: <b>${userBalance.toFixed(
            Math.min(4, tokenContext.tokenDecimals)
          )} ${tokenContext.tokenTicker}</b>\n\nAdjust the amount using the controls below:`,
          parseMode: "HTML",
          keyboard: createSliderAmountKeyboard(
            gameType,
            validAmount,
            userBalance,
            creatorId,
            tokenContext.tokenTicker,
            tokenContext.tokenDecimals
          ),
        });

        updateSession({
          waitingFor: "setup",
          gameType,
          userBalance,
          messageId: session?.messageId ?? ctx.callbackQuery?.message?.message_id,
          chatId: session?.chatId ?? ctx.chat?.id ?? 0,
          amount: validAmount.toString(),
          contractMinimum: minValue,
        });

        await ctx.answerCallbackQuery();
      } catch (error) {
        console.error("Error in creator-protected slider callback:", error);
        await ctx.answerCallbackQuery("❌ Error adjusting amount");
      }
    }
  )
);


// Back to amounts callback (new format with creator ID)
bot.callbackQuery(
  /^back_to_amounts_(coinflip|giveaway)_(\d+)$/,
  withCreatorContext(
    {
      name: "back_to_amounts",
      resolveCreatorId: (ctx) => ctx.match?.[2],
      failureText: "❌ Only the game creator can modify this setup!",
    },
    async (
      ctx,
      { session, tokenContext, updateSession, clearSession, creatorId }
    ) => {
      try {
        const gameType = ctx.match![1] as string;
        const telegramId = getTelegramId(ctx);

        let userBalance =
          session?.userBalance && session.userBalance > 0
            ? session.userBalance
            : 0;
        if (userBalance <= 0) {
          try {
            const tokenBalance = await wallet.getTokenBalance(
              telegramId,
              tokenContext.tokenMint,
              { createIfMissing: true }
            );
            userBalance =
              tokenBalance / Math.pow(10, tokenContext.tokenDecimals);
          } catch (error) {
            console.error("Error getting balance:", error);
          }
        }

        const { formatted: contractMin } =
          tokenContext.contractMinimum !== undefined
            ? { formatted: tokenContext.contractMinimum }
            : await getContractMinimumAmount(
                tokenContext.tokenMint,
                tokenContext.tokenDecimals
              );

        let tokenPriceUSD = await getPriceUSD(tokenContext.tokenMint);
        if (!tokenPriceUSD) {
          tokenPriceUSD = await getPriceUSD(tokenContext.tokenTicker);
        }

        const suggestedAmounts = getSuggestedStakeAmounts(
          contractMin,
          userBalance
        );

        clearSession();

        let warningMessage = getFeeWarningMessage(
          gameType,
          userBalance,
          contractMin,
          tokenContext.tokenTicker
        );

        if (suggestedAmounts.length > 0) {
          warningMessage += "\n\nSuggested stakes:\n";
          for (const amount of suggestedAmounts) {
            const amountDisplay = formatTokenDisplay(amount, {
              decimals: tokenContext.tokenDecimals,
            });
            warningMessage += `• ${amountDisplay} ${tokenContext.tokenTicker}`;
            if (tokenPriceUSD) {
              warningMessage += ` (~$${formatUsdValue(amount * tokenPriceUSD)})`;
            }
            warningMessage += "\n";
          }
        }

        await respondWithMenu(ctx, {
          text: warningMessage,
          parseMode: "HTML",
          keyboard: createAmountSelectionKeyboard(
            gameType,
            userBalance,
            creatorId,
            contractMin,
            tokenContext.tokenTicker,
            {
              decimals: tokenContext.tokenDecimals,
              tokenPriceUSD: tokenPriceUSD ?? undefined,
            }
          ),
        });

        updateSession({
          waitingFor: "setup",
          gameType,
          userBalance,
          messageId: ctx.callbackQuery?.message?.message_id ?? 0,
          chatId: ctx.chat?.id ?? 0,
          contractMinimum: contractMin,
        });

        await ctx.answerCallbackQuery();
      } catch (error) {
        console.error("Error in creator-protected back_to_amounts callback:", error);
        await ctx.answerCallbackQuery("❌ Error going back");
      }
    }
  )
);


// Type amount callback - prompts user to type amount (new format with creator ID)
bot.callbackQuery(
  /^type_amount_(coinflip|giveaway)_(\d+)$/,
  withCreatorContext(
    {
      name: "type_amount",
      resolveCreatorId: (ctx) => ctx.match?.[2],
      failureText: "❌ Only the game creator can modify this setup!",
    },
    async (ctx, { session, tokenContext, updateSession, creatorId }) => {
      try {
        const gameType = ctx.match![1] as string;
        const telegramId = getTelegramId(ctx);

        let userBalance =
          session?.userBalance && session.userBalance > 0
            ? session.userBalance
            : 0;
        if (userBalance <= 0) {
          try {
            const tokenBalance = await wallet.getTokenBalance(
              telegramId,
              tokenContext.tokenMint,
              { createIfMissing: true }
            );
            userBalance =
              tokenBalance / Math.pow(10, tokenContext.tokenDecimals);
          } catch (error) {
            console.error("Error getting balance:", error);
          }
        }

        const { formatted: contractMin } =
          tokenContext.contractMinimum !== undefined
            ? { formatted: tokenContext.contractMinimum }
            : await getContractMinimumAmount(
                tokenContext.tokenMint,
                tokenContext.tokenDecimals
              );

        const typeMessage = [
          `✏️ <b>TYPE CUSTOM AMOUNT - ${gameType.toUpperCase()}</b>`,
          "",
          `💰 Your balance: <b>${userBalance.toFixed(
            Math.min(4, tokenContext.tokenDecimals)
          )} ${tokenContext.tokenTicker}</b>`,
          "",
          "Please type the amount you want to use.",
          "",
          "<b>Example:</b>",
          `• Type: <code>75</code> for 75 ${tokenContext.tokenTicker}`,
          `• Type: <code>150.5</code> for 150.5 ${tokenContext.tokenTicker}`,
          "",
          `Min: ${contractMin} ${tokenContext.tokenTicker} • Max: ${userBalance.toFixed(
            Math.min(2, tokenContext.tokenDecimals)
          )} ${tokenContext.tokenTicker}`
        ].join("\n");

        await respondWithMenu(ctx, {
          text: typeMessage,
          parseMode: "HTML",
          keyboard: new InlineKeyboard()
            .text("❌ Cancel", `cancel_game_setup_${creatorId}`)
            .row(),
        });

        await ctx.answerCallbackQuery("Type your amount...");

        updateSession({
          waitingFor: "amount_input",
          gameType,
          userBalance,
          messageId: ctx.callbackQuery?.message?.message_id || 0,
          chatId: ctx.chat?.id || 0,
          contractMinimum: contractMin,
          amount: session?.amount,
        });
      } catch (error) {
        console.error("Error in creator-protected type_amount callback:", error);
        await ctx.answerCallbackQuery("❌ Error setting up text input");
      }
    }
  )
);


// Custom players callback - prompts user to type number of players (new format with creator ID)
bot.callbackQuery(
  /^custom_players_(coinflip|giveaway)_(.+)_(\d+)$/,
  withCreatorContext(
    {
      name: "custom_players",
      resolveCreatorId: (ctx) => ctx.match?.[3],
      failureText: "❌ Only the game creator can modify this setup!",
    },
    async (ctx, { session, tokenContext, updateSession, creatorId }) => {
      try {
        const gameType = ctx.match![1] as string;
        const amount = ctx.match![2] as string;

        const amountNumber = Number(amount);
        const formattedAmount = amountNumber.toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: determineFractionDigits(
            amount,
            tokenContext.tokenDecimals
          ),
        });

        const playersMessage = [
          `👥 <b>TYPE CUSTOM PLAYERS - ${gameType.toUpperCase()}</b>`,
          "",
          `Amount: <b>${formattedAmount} ${tokenContext.tokenTicker}</b>`,
          "",
          "Please type the number of players for this game.",
          "",
          "<b>Example:</b>",
          "• Type: <code>4</code> for 4 players",
          "• Type: <code>10</code> for 10 players",
          "",
          `Range: 2-${gameType === "coinflip" ? "8" : "20"} players`
        ].join("\n");

        await respondWithMenu(ctx, {
          text: playersMessage,
          parseMode: "HTML",
          keyboard: new InlineKeyboard()
            .text("❌ Cancel", `cancel_game_setup_${creatorId}`)
            .row(),
        });

        await ctx.answerCallbackQuery("Type the number of players...");

        updateSession({
          waitingFor: "players_input",
          gameType,
          userBalance: 0,
          amount,
          messageId: ctx.callbackQuery?.message?.message_id || 0,
          chatId: ctx.chat?.id || 0,
          contractMinimum: session?.contractMinimum,
        });
      } catch (error) {
        console.error("Error in creator-protected custom_players callback:", error);
        await ctx.answerCallbackQuery("❌ Error setting up players input");
      }
    }
  )
);

// No-op callback (for display-only buttons)
bot.callbackQuery("noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});


// Cancel game setup callback (new format with creator ID protection)
bot.callbackQuery(
  /^cancel_game_setup_(\d+)$/,
  withCreatorContext(
    {
      name: "cancel_game_setup",
      resolveCreatorId: (ctx) => ctx.match?.[1],
      failureText: "❌ Only the game creator can cancel this setup!",
    },
    async (ctx, { clearSession }) => {
      try {
        clearSession();

        await respondWithMenu(ctx, {
          text: "❌ Game creation cancelled.",
          parseMode: "HTML",
        });
        await ctx.answerCallbackQuery("Cancelled");
      } catch (error) {
        console.error("Error in creator-protected cancel callback:", error);
        await ctx.answerCallbackQuery("❌ Error cancelling");
      }
    }
  )
);

// Text input handler for custom amounts
bot.on("message:text", async (ctx, next) => {
  try {
    // Check if user is in a session waiting for input
    const userSession = userSessions.get(ctx.from?.id || 0);

    if (!userSession || (userSession.waitingFor !== "amount_input" && userSession.waitingFor !== "players_input")) {
      return await next(); // Not waiting for input, pass to other handlers
    }

    // Only handle messages from the same chat where session was created
    if (userSession.chatId && ctx.chat?.id !== userSession.chatId) {
      return await next();
    }

    // Keep user's message (avoid deleting to preserve reply chain)

    // Clear the session
    userSessions.delete(ctx.from?.id || 0);

    const defaultMetadata = await getDefaultTokenMetadata();
    const tokenTicker =
      userSession.tokenTicker ?? DEFAULT_TOKEN_TICKER;
    const tokenDecimals =
      userSession.tokenDecimals ?? defaultMetadata.decimals;
    const minAllowed =
      userSession.contractMinimum ??
      (
        await getContractMinimumAmount(
          userSession.tokenMint ?? DEFAULT_TOKEN_MINT,
          tokenDecimals
        )
      ).formatted;

    const inputText = ctx.message.text.trim();

    // Handle players input
    if (userSession.waitingFor === "players_input") {
      const players = parseInt(inputText);
      const maxPlayers = 100;
      const minPlayers = 2;

      console.log(`🔍 Custom players input: "${inputText}" -> ${players} (gameType: ${userSession.gameType}, min: ${minPlayers}, max: ${maxPlayers})`);

      // Validate players input
      if (isNaN(players) || players < minPlayers || players > maxPlayers) {
        const errorMessage = `❌ Invalid number of players. Please enter a number between ${minPlayers} and ${maxPlayers}.`;
        try {
          await ctx.api.editMessageText(
            userSession.chatId!,
            userSession.messageId!,
            errorMessage,
            { parse_mode: "HTML" }
          );
        } catch (error) {
          await ctx.reply(errorMessage, { parse_mode: "HTML" });
        }
        return;
      }

      // Show confirmation with custom players
      const amountNumber = Number(userSession.amount ?? "0");
      const amountFormatted = amountNumber.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: determineFractionDigits(
          userSession.amount ?? amountNumber.toString(),
          tokenDecimals
        ),
      });
      const totalPot = amountNumber * players;
      const totalPotFormatted = totalPot.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: Math.min(tokenDecimals, 6),
      });

      const confirmMessage = [
        `<b>CONFIRM ${userSession.gameType.toUpperCase()}</b>`,
        "",
        `Amount: <b>${amountFormatted} ${tokenTicker}</b>`,
        `Players: <b>${players}</b>`,
        "",
        userSession.gameType === "coinflip"
          ? `• Total prize pool: <b>${totalPotFormatted} ${tokenTicker}</b>`
          : `• Prize for winner: <b>${amountFormatted} ${tokenTicker}</b>`,
        "",
        "Ready to create the game?"
      ].join("\n");

      try {
        await ctx.api.editMessageText(
          userSession.chatId!,
          userSession.messageId!,
          confirmMessage,
          {
            parse_mode: "HTML",
            reply_markup: createGameConfirmKeyboard(userSession.gameType, userSession.amount!, players.toString(), userSession.creatorId)
          }
        );
      } catch (error) {
        await ctx.reply(confirmMessage, {
          parse_mode: "HTML",
          reply_markup: createGameConfirmKeyboard(userSession.gameType, userSession.amount!, players.toString(), userSession.creatorId)
        });
      }

      updateGameSetupSession(ctx.from?.id || 0, {
        waitingFor: "setup",
        gameType: userSession.gameType,
        userBalance: userSession.userBalance,
        messageId: userSession.messageId,
        chatId: userSession.chatId,
        amount: userSession.amount,
        creatorId: userSession.creatorId,
        tokenMint: userSession.tokenMint,
        tokenTicker,
        tokenDecimals,
        contractMinimum: minAllowed,
      });

      return;
    }

    // Handle amount input
    const amount = parseFloat(inputText);

    // Validate the input
    if (isNaN(amount) || amount <= 0) {
      // Update the original message with error
      try {
        await ctx.api.editMessageText(
          userSession.chatId!,
          userSession.messageId!,
          "❌ Invalid amount. Please use /coinflip or /giveaway to try again.",
          { parse_mode: "HTML" }
        );
      } catch (error) {
        await ctx.reply("❌ Invalid amount. Please use /coinflip or /giveaway to try again.", {
          parse_mode: "HTML"
        });
      }
      return;
    }

    if (amount > userSession.userBalance) {
      // Update the original message with error
      try {
        await ctx.api.editMessageText(
          userSession.chatId!,
          userSession.messageId!,
          `❌ Amount too high. Your balance is ${userSession.userBalance.toFixed(2)} ${tokenTicker}. Please use /coinflip or /giveaway to try again.`,
          { parse_mode: "HTML" }
        );
      } catch (error) {
        await ctx.reply(`❌ Amount too high. Your balance is ${userSession.userBalance.toFixed(2)} ${tokenTicker}. Please try again.`, {
          parse_mode: "HTML"
        });
      }
      return;
    }

    if (amount < minAllowed) {
      const errorMessage = `❌ Amount below contract minimum of ${minAllowed} ${tokenTicker}.`;
      try {
        await ctx.api.editMessageText(
          userSession.chatId!,
          userSession.messageId!,
          errorMessage,
          { parse_mode: "HTML" }
        );
      } catch (error) {
        await ctx.reply(errorMessage, { parse_mode: "HTML" });
      }
      return;
    }

    // Proceed to player selection with the custom amount
    const amountFormatted = amount.toLocaleString("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits: determineFractionDigits(
        inputText,
        tokenDecimals
      ),
    });

    const playerMessage = [
      `<b>${userSession.gameType.toUpperCase()} - CHOOSE PLAYERS</b>`,
      "",
      `Amount: <b>${amountFormatted} ${tokenTicker}</b>`,
      "",
      "Select the number of players:",
      "",
      userSession.gameType === "coinflip"
        ? "• All players compete for the total stakes"
        : "• More players = higher chance for everyone",
      "",
      "Choose number of players:"
    ].join("\n");

    // Update the original message with player selection
    try {
      await ctx.api.editMessageText(
        userSession.chatId!,
        userSession.messageId!,
        playerMessage,
        {
          parse_mode: "HTML",
          reply_markup: createPlayerSelectionKeyboard(userSession.gameType, amount.toString(), userSession.creatorId)
        }
      );
    } catch (error) {
      // Fallback to new message if edit fails
      await ctx.reply(playerMessage, {
        parse_mode: "HTML",
        reply_markup: createPlayerSelectionKeyboard(userSession.gameType, amount.toString(), userSession.creatorId)
      });
    }

    updateGameSetupSession(ctx.from?.id || 0, {
      waitingFor: "setup",
      gameType: userSession.gameType,
      userBalance: userSession.userBalance,
      messageId: userSession.messageId,
      chatId: userSession.chatId,
      amount: amount.toString(),
      creatorId: userSession.creatorId,
      tokenMint: userSession.tokenMint,
      tokenTicker,
      tokenDecimals,
      contractMinimum: minAllowed,
    });

  } catch (error) {
    console.error("Error in text input handler:", error);
    await next();
  }
});


// ================================
// MAIN MENU CALLBACK HANDLERS
// ================================

const createWalletHandlerDeps = (): WalletHandlersDeps =>
  Object.freeze({
    showWalletUI: (c: any) => showWalletUI(c),
    clearWalletCache: (id: bigint | string | number) => {
      const normalized =
        typeof id === "bigint" ? id : BigInt(id as string | number);
      clearWalletCache(normalized);
    },
    createSettingsKeyboard: () => createWalletSettingsKeyboard(),
  });

const walletHandlerDeps = createWalletHandlerDeps();

bot.callbackQuery("main_wallet", async (ctx) => {
  await onMainWallet(ctx as any, walletHandlerDeps);
});

bot.callbackQuery("wallet_refresh", async (ctx) => {
  await onWalletRefresh(ctx as any, walletHandlerDeps);
});

bot.callbackQuery("wallet_settings", async (ctx) => {
  await onWalletSettings(ctx as any, walletHandlerDeps);
});

// ================================
// WALLET ACTION HANDLERS
// ================================

bot.callbackQuery("cmd_withdraw", async (ctx) => {
  try {
    const { menu } = await buildWalletActionMenuForUser({
      ctx,
      title: `💸 <b>WITHDRAW</b>`,
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
    });

    await respondWithMenu(ctx, menu);
    await ctx.answerCallbackQuery("💸 Select Token to Withdraw");
  } catch (error) {
    console.error("Error in cmd_withdraw:", error);
    await ctx.answerCallbackQuery("❌ Error loading send menu");
  }
});

bot.callbackQuery("cmd_privatekey", async (ctx) => {
  try {
    // Only show private key in private chats for security
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery(
        "❌ Private key only available in private chat"
      );
      return;
    }

    const telegramId = getTelegramId(ctx);
    const keypair = wallet.getKeyPair(telegramId);
    const privateKeyBase64 = Buffer.from(keypair.secretKey).toString("base64");

    const response = [
      `🔐 <b>Private Key</b>`,
      "",
      `⚠️ <b>Keep This Secret!</b>`,
      `Never share your private key with anyone.`,
      `Store it securely offline.`,
      "",
      `Wallet Address: <code>${escapeHtml(keypair.publicKey.toBase58())}</code>`,
      "",
      `<b>Secret Key (Base64):</b>`,
      `<span class="tg-spoiler"><code>${escapeHtml(privateKeyBase64)}</code></span>`,
      "",
      `You can import this key into Phantom, Solflare, or other Solana wallets.`,
    ];

    await respondWithMenu(ctx, {
      text: response.join("\n"),
      keyboard: createBackToWalletKeyboard(),
    });
    await ctx.answerCallbackQuery("🔐 Private key shown");
  } catch (error) {
    console.error("Error in cmd_privatekey:", error);
    await ctx.answerCallbackQuery("❌ Error showing private key");
  }
});


bot.callbackQuery("cmd_wrap", async (ctx) => {
  try {
    const { menu } = await buildWalletActionMenuForUser({
      ctx,
      title: `🔧 <b>WRAP SOL</b>`,
      bodyLines: ({ solBalance }) => {
        const formattedSolBalance = wallet.formatSolBalance(solBalance);
        return [
          `<b>SOL Balance:</b> ${escapeHtml(formattedSolBalance)}`,
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
          { label: "0.01 SOL", value: "0.01" },
          { label: "0.1 SOL", value: "0.1" },
          { label: "0.5 SOL", value: "0.5" },
          { label: "1 SOL", value: "1" },
        ],
        customAction: { label: "✏️ Custom Amount", callback: "wrap_custom" },
        insufficientLabel: "❌ Insufficient SOL balance",
        minimumLamports: 10_000,
      },
      getBalances: async (telegramId) => ({
        solBalance: await wallet.getBalance(telegramId),
        tokenBalances: [],
      }),
    });

    await respondWithMenu(ctx, menu);
    await ctx.answerCallbackQuery("🔧 Select wrap amount");
  } catch (error) {
    console.error("Error in cmd_wrap:", error);
    await ctx.answerCallbackQuery("❌ Error loading wrap menu");
  }
});

// Handle custom wrap amount
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (callbackData !== "wrap_custom") {
    return await next();
  }

  try {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    console.log("🔔 Custom wrap amount requested");

    const response = [
      `✏️ <b>CUSTOM WRAP AMOUNT</b>`,
      "",
      `Please send a message with the amount of SOL you want to wrap.`,
      "",
      `<b>Examples:</b>`,
      `• <code>0.5</code>`,
      `• <code>1.25</code>`,
      "",
      INPUT_TIMEOUT_HINT,
    ];

    await respondWithMenu(ctx, {
      text: response.join("\n"),
      keyboard: new InlineKeyboard().text("❌ Cancel", "cmd_wrap").row(),
    });

    // Set user state to expect custom wrap amount
    setUserState(userId, {
      type: "wrap_custom_amount",
      messageId: ctx.callbackQuery?.message?.message_id,
      chatId: ctx.chat?.id,
    });

    await ctx.answerCallbackQuery("Send the amount as a message");
  } catch (error) {
    console.error("Error in wrap_custom:", error);
    await ctx.answerCallbackQuery("❌ Error processing custom amount");
  }
});

// Handle wrap amount buttons
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("wrap_amount_")) {
    return await next();
  }

  try {
    const amount = callbackData.replace("wrap_amount_", "");
    console.log(`🔧 Wrap amount selected: ${amount} SOL`);

    const response = [
      `✅ <b>WRAP CONFIRMATION</b>`,
      "",
      `<b>Amount:</b> ${amount} SOL → WSOL`,
      "",
      `⚠️ <b>Please confirm this transaction</b>`,
      `This will convert ${amount} SOL to ${amount} WSOL.`,
    ];

    await respondWithMenu(ctx, {
      text: response.join("\n"),
      keyboard: createConfirmWrapKeyboard(amount),
    });

    await ctx.answerCallbackQuery("Confirm wrap transaction");
  } catch (error) {
    console.error("Error in wrap amount selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing wrap amount");
  }
});

// Handle send confirmation
bot.callbackQuery(/^confirm_send_/, async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery?.data || "";
    const txId = callbackData.replace("confirm_send_", "");

    // Retrieve transaction details
    const transaction = getPendingTransaction(txId, true);
    if (!transaction || transaction.type !== "send") {
      await ctx.answerCallbackQuery("❌ Transaction expired or not found");
      return;
    }

    // Verify user owns this transaction
    if (transaction.userId !== ctx.from.id.toString()) {
      await ctx.answerCallbackQuery("❌ Unauthorized transaction");
      return;
    }

    const amountSummary =
      transaction.amountDisplay ??
      (transaction.amount === "max"
        ? `MAX ${transaction.token}`
        : `${transaction.amount} ${transaction.token}`);

    console.log(
      `✅ Confirmed send: ${amountSummary} to ${transaction.address}`
    );

    // Update message to show processing state
    await respondWithMenu(ctx, {
      text: `🔄 <b>PROCESSING TRANSACTION</b>\n\nSending ${escapeHtml(
        amountSummary
      )}...\n\n<i>Please wait...</i>`,
      keyboard: new InlineKeyboard(),
    });

    // Execute actual transaction
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
        const balanceLamports = await wallet.getBalance(telegramId);
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
          if (lamportsToSend + SOL_FEE_BUFFER_LAMPORTS > balanceLamports) {
            throw new Error("Insufficient SOL balance for this transfer");
          }
          formattedAmount = transaction.amount;

          const solAmount = lamportsToSend / LAMPORTS_PER_SOL;

          txSignature = await wallet.transferSol(
            telegramId,
            toPublicKey,
            solAmount
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

      console.log(`🚀 Transaction submitted: ${txSignature}`);

      await wallet.confirmTransaction(txSignature);
      clearWalletCache(telegramId);

      const solscanUrl = `https://solscan.io/tx/${txSignature}`;

      const successMessage = (() => {
        if (
          withdrawAllResult &&
          transaction.token === "SOL" &&
          transaction.amount === "max"
        ) {
          const details: string[] = [
            `✅ <b>TRANSACTION COMPLETED</b>`,
            "",
            `Sent ${formattedAmount} SOL`,
          ];

          if (withdrawAllResult.nativeLamportsSent > 0) {
            details.push(
              `• Native SOL: ${wallet.formatSolBalance(
                withdrawAllResult.nativeLamportsSent
              )} SOL`
            );
          }

          if (withdrawAllResult.wsolLamportsSent > 0) {
            details.push(
              `• WSOL (unwrapped): ${wallet.formatSolBalance(
                withdrawAllResult.wsolLamportsSent
              )} SOL`
            );
          }

          details.push(
            "",
            `To: <code>${transaction.address}</code>`,
            "",
            `🔗 <a href="${solscanUrl}">View on Solscan</a>`
          );

          return details.join("\n");
        }

        return `✅ <b>TRANSACTION COMPLETED</b>\n\nSent ${formattedAmount} ${transaction.token}\nTo: <code>${transaction.address}</code>\n\n🔗 <a href="${solscanUrl}">View on Solscan</a>`;
      })();

      await respondWithMenu(ctx, {
        text: successMessage,
        keyboard: createBackToWalletKeyboard(),
      });
    } catch (txError) {
      console.error("Transaction failed:", txError);
      await respondWithMenu(ctx, {
        text: `❌ <b>TRANSACTION FAILED</b>\n\n${
          (txError as Error).message
        }\n\nPlease try again.`,
        keyboard: createBackToWalletKeyboard(),
      });
    }

    await ctx.answerCallbackQuery("✅ Transaction submitted");
  } catch (error) {
    console.error("Error in send confirmation:", error);
    await ctx.answerCallbackQuery("❌ Error processing transaction");
  }
});

// Handle wrap confirmation
bot.callbackQuery(/^confirm_wrap_/, async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery?.data || "";
    const amount = callbackData.replace("confirm_wrap_", "");
    console.log(`✅ Confirmed wrap: ${amount} SOL`);

    const telegramId = getTelegramId(ctx);
    const balanceLamports = await wallet.getBalance(telegramId);
    const lamportsToWrap = toRawAmount(amount, 9);

    if (lamportsToWrap + SOL_FEE_BUFFER_LAMPORTS > balanceLamports) {
      await ctx.answerCallbackQuery("❌ Insufficient SOL for wrap");
      await respondWithMenu(ctx, {
        text: `❌ <b>WRAP FAILED</b>\n\nNot enough SOL to wrap ${amount}.\nKeep at least ${MIN_SOL_FOR_TX} SOL for fees and try again.`,
        keyboard: createBackToWalletKeyboard(),
      });
      return;
    }

    await respondWithMenu(ctx, {
      text: `🔄 <b>PROCESSING WRAP</b>\n\nWrapping ${wallet.formatSolBalance(
        lamportsToWrap
      )} SOL to WSOL...\n\n<i>Please wait...</i>`,
      keyboard: new InlineKeyboard(),
    });

    const signature = await wallet.wrapSol(telegramId, lamportsToWrap);
    await wallet.confirmTransaction(signature);
    clearWalletCache(telegramId);

    const formattedAmount = wallet.formatSolBalance(lamportsToWrap);
    const solscanUrl = `https://solscan.io/tx/${signature}`;

    await respondWithMenu(ctx, {
      text: `✅ <b>WRAP COMPLETED</b>\n\nWrapped ${formattedAmount} SOL to WSOL\n\n🔗 <a href="${solscanUrl}">View on Solscan</a>`,
      keyboard: createBackToWalletKeyboard(),
    });

    await ctx.answerCallbackQuery("✅ Wrap transaction submitted");
  } catch (error) {
    console.error("Error in wrap confirmation:", error);
    await ctx.answerCallbackQuery("❌ Error processing wrap");
  }
});

// Handle swap confirmation
bot.callbackQuery(/^confirm_swap_/, async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery?.data || "";
    const txId = callbackData.replace("confirm_swap_", "");

    // Retrieve transaction details
    const transaction = getPendingTransaction(txId, true);
    if (!transaction || transaction.type !== "swap") {
      await ctx.answerCallbackQuery("❌ Transaction expired or not found");
      return;
    }

    // Verify user owns this transaction
    if (transaction.userId !== ctx.from.id.toString()) {
      await ctx.answerCallbackQuery("❌ Unauthorized transaction");
      return;
    }

    console.log(
      `✅ Confirmed swap: ${transaction.amount} ${transaction.fromToken} → ${transaction.toToken}`
    );

    // Update message to show processing state
    const { message, keyboard } = buildProcessingStatus(
      "swap",
      transaction.amount,
      transaction.fromToken,
      transaction.toToken
    );

    await respondWithMenu(ctx, {
      text: message,
      parseMode: "HTML",
      keyboard,
    });

    // Execute actual swap transaction
    try {
      const quote = transaction.quote;
      if (!quote) {
        throw new Error("Quote not found for this transaction");
      }

      let txSignature: string;
      const keypair = wallet.getKeyPair(BigInt(transaction.userId));

      if (quote.provider === "jupiter") {
        // Use Jupiter execution method (same as original implementation)
        txSignature = await swapManager.executeJupiterSwap(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            amount: quote.inputAmount, // Use inputAmount from quote like original
            slippageBps: 100,
            userKeypair: keypair,
            inputDecimals: quote.inputDecimals || 9,
            outputDecimals: quote.outputDecimals || 9,
            inputTicker: transaction.fromToken?.toUpperCase() || "UNKNOWN",
            outputTicker: transaction.toToken?.toUpperCase() || "UNKNOWN",
          },
          quote
        );
      } else {
        // Use instruction-based approach for other providers
        const instructions = await swapManager.createSwapTransaction(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            amount: quote.inputAmount, // Use inputAmount from quote like original
            slippageBps: 100,
            userKeypair: keypair,
            inputDecimals: quote.inputDecimals || 9,
            outputDecimals: quote.outputDecimals || 9,
            inputTicker: transaction.fromToken?.toUpperCase() || "UNKNOWN",
            outputTicker: transaction.toToken?.toUpperCase() || "UNKNOWN",
          },
          quote
        );

        txSignature = await wallet.sendTransaction(instructions, [keypair]);
      }

      console.log(`🚀 Swap transaction submitted: ${txSignature}`);

      // Wait for confirmation
      await wallet.confirmTransaction(txSignature);

      // Show success with real Solscan link
      const solscanUrl = `https://solscan.io/tx/${txSignature}`;
      await respondWithMenu(ctx, {
        text: `✅ <b>SWAP COMPLETED</b>\n\nSwapped ${transaction.amount} ${transaction.fromToken}\nReceived ~${quote.outputAmount} ${transaction.toToken}\n\n🔗 <a href="${solscanUrl}">View on Solscan</a>`,
        parseMode: "HTML",
        keyboard: createBackToWalletKeyboard(),
      });
    } catch (swapError) {
      console.error("Swap transaction failed:", swapError);
      await respondWithMenu(ctx, {
        text: `❌ <b>SWAP FAILED</b>\n\n${
          (swapError as Error).message
        }\n\nPlease try again.`,
        parseMode: "HTML",
        keyboard: createBackToWalletKeyboard(),
      });
    }

    await ctx.answerCallbackQuery("✅ Swap submitted");
  } catch (error) {
    console.error("Error in swap confirmation:", error);
    await ctx.answerCallbackQuery("❌ Error processing swap");
  }
});

bot.callbackQuery("cmd_swap", async (ctx) => {
  try {
    const { menu } = await buildWalletActionMenuForUser({
      ctx,
      title: `💱 <b>SWAP TOKENS</b>`,
      bodyLines: [
        `<b>From Wallet:</b> <code>{{WALLET_ADDRESS}}</code>`,
        "",
        `<b>Select token to swap FROM:</b>`,
      ],
      quickActions: {
        type: "token-select",
        actionPrefix: "swap_from_",
        includeSol: {
          includeIf: (lamports) => lamports > 0,
        },
        limit: 6,
        filter: (token) => {
          const rawValue =
            token.rawBalance !== undefined
              ? Number.parseFloat(String(token.rawBalance))
              : token.balance > 0
              ? token.balance
              : 0;
          return Number.isFinite(rawValue) && rawValue > 0;
        },
        emptyLabel: "❌ No tokens available to swap",
      },
    });

    await respondWithMenu(ctx, menu);
    await ctx.answerCallbackQuery("💱 Select token to swap from");
  } catch (error) {
    console.error("Error in cmd_swap:", error);
    await ctx.answerCallbackQuery("❌ Error loading swap menu");
  }
});

// ================================
// Generate unique transaction ID
const generateTransactionId = (): string => {
  return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

// ================================
// WALLET DATA CACHE
// ================================

const WALLET_CACHE_DURATION = 30 * 1000; // 30 seconds

type CachedWalletData = {
  solBalance: number;
  tokenBalances: Array<{
    mint: string;
    ticker: string;
    balance: number;
    decimals: number;
    rawBalance: string;
  }>;
  approvedTokens: any[];
};

const walletDataCache = createExpiringCache<CachedWalletData>(
  WALLET_CACHE_DURATION
);

// Consistent cache key generator
const getWalletCacheKey = (telegramId: bigint | number | string): string =>
  String(telegramId);

/**
 * Get cached wallet data or fetch fresh data
 */
const getCachedWalletData = async (telegramId: bigint) => {
  const cacheKey = getWalletCacheKey(telegramId);
  const stale = walletDataCache.peek(cacheKey);
  const cached = walletDataCache.get(cacheKey);

  if (cached) {
    console.log("📦 Using cached wallet data for user:", telegramId.toString());
    return cached;
  }

  console.log("🔄 Fetching fresh wallet data for user:", telegramId.toString());

  try {
    // Fetch fresh data
    let solBalance = await wallet.getBalance(telegramId);
    const approvedTokens = tokenManager
      ? tokenManager.getAllApprovedTokensWithMetadata()
      : [];
    let tokenBalances = await wallet.getAllApprovedTokenBalances(
      telegramId,
      approvedTokens
    );

    // Merge WSOL into SOL using util
    const merged = mergeWsolIntoSol(solBalance, tokenBalances, WSOL_MINT);
    solBalance = merged.solLamports;
    tokenBalances = merged.tokenBalances;

    const data: CachedWalletData = {
      solBalance,
      tokenBalances,
      approvedTokens,
    };

    // Cache the data
    walletDataCache.setWithTTL(cacheKey, data);

    return data;
  } catch (error) {
    console.error("Error fetching wallet data:", error);
    // Return cached data if available, even if expired
    if (stale) {
      console.log("⚠️ Using expired cache due to RPC error");
      return stale;
    }
    throw error;
  }
};

// Function to clear wallet cache (useful after token registration)
const clearWalletCache = (telegramId: bigint) => {
  const cacheKey = getWalletCacheKey(telegramId);
  walletDataCache.delete(cacheKey);
  console.log(`🗑️ Cleared wallet cache for user: ${telegramId}`);
};

type WalletOverview = {
  walletAddress: string;
  solBalance: number;
  formattedSolBalance: string;
  totalUsd: number;
  tokenBalances: Array<{
    mint: string;
    ticker: string;
    balance: number;
    decimals: number;
    rawBalance: string;
  }>;
  ownedTokens: Array<{
    mint: string;
    ticker: string;
    balance: number;
    decimals: number;
    rawBalance: string;
  }>;
};

const getWalletOverview = async (telegramId: bigint): Promise<WalletOverview> => {
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
  const formattedSolBalance = wallet.formatSolBalance(solBalance);
  const solPriceUSD = await getPriceUSD("SOL");
  const solDecimalBalance = solBalance / LAMPORTS_PER_SOL;
  const totalUsd = solDecimalBalance * solPriceUSD;
  const ownedTokens = tokenBalances.filter((token) => {
    const raw = Number.parseFloat(token.rawBalance);
    return Number.isFinite(raw) && raw > 0;
  });

  return {
    walletAddress,
    solBalance,
    formattedSolBalance,
    totalUsd,
    tokenBalances,
    ownedTokens,
  };
};

type WalletMenuBalances = Pick<CachedWalletData, "solBalance" | "tokenBalances">;

type WalletActionMenuContext = WalletMenuBalances & {
  walletAddress: string;
};

type BuildWalletActionMenuForUserOptions = {
  ctx: any;
  title: string;
  bodyLines: string[] | ((context: WalletActionMenuContext) => string[]);
  quickActions: WalletActionQuickActions;
  backButton?: { label?: string; callback: string };
  getBalances?: (telegramId: bigint) => Promise<WalletMenuBalances>;
  prepareBalances?: (
    balances: WalletMenuBalances
  ) => WalletActionMenuBalances;
};

const buildWalletActionMenuForUser = async ({
  ctx,
  title,
  bodyLines,
  quickActions,
  backButton,
  getBalances,
  prepareBalances,
}: BuildWalletActionMenuForUserOptions) => {
  const telegramId = getTelegramId(ctx);
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();

  const resolveBalances =
    getBalances ??
    (async (id: bigint): Promise<WalletMenuBalances> => {
      const { solBalance, tokenBalances } = await getCachedWalletData(id);
      return { solBalance, tokenBalances };
    });

  const { solBalance, tokenBalances } = await resolveBalances(telegramId);

  const context: WalletActionMenuContext = {
    walletAddress,
    solBalance,
    tokenBalances,
  };

  const resolvedBodyLines =
    typeof bodyLines === "function" ? bodyLines(context) : bodyLines;

  const balancesForMenu = prepareBalances
    ? prepareBalances({ solBalance, tokenBalances })
    : ({
        solBalanceLamports: solBalance,
        tokenBalances,
      } satisfies WalletActionMenuBalances);

  const menu = buildWalletActionMenu({
    title,
    walletAddress,
    bodyLines: resolvedBodyLines,
    balances: balancesForMenu,
    formatters: {
      formatSolBalance: (lamports) => wallet.formatSolBalance(lamports),
      formatTokenBalance: (balance, decimals) =>
        wallet.formatTokenBalance(balance, decimals),
    },
    quickActions,
    backButton: backButton ?? { label: "← Back to Wallet", callback: "main_wallet" },
  });

  return {
    menu,
    walletAddress,
    solBalance,
    tokenBalances,
  };
};

// ================================
// SEND TOKEN INTERFACE HANDLERS
// ================================

// Handle token selection for send
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("send_select_")) {
    return await next();
  }

  const token = callbackData.replace("send_select_", "");
  console.log("🔔 Token selected for send:", token);

  try {
    const { menu } = await buildWalletActionMenuForUser({
      ctx,
      title: `📤 <b>SEND ${escapeHtml(token)}</b>`,
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
          baseCallback: (value) => `send_amount_${token}_${value.toUpperCase()}`,
          customLabel: "✏️ Custom Amount",
          backCallback: "cmd_withdraw",
        }),
      },
    });

    await respondWithMenu(ctx, menu);
    await ctx.answerCallbackQuery(`Selected ${token}`);
  } catch (error) {
    console.error("Error in send token selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing selection");
  }
});

// Handle amount selection for send
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("send_amount_")) {
    return await next();
  }

  try {
    const segments = callbackData.replace("send_amount_", "").split("_");
    const token = segments.shift() ?? "";
    const amountChoice = segments.join("_");
    if (!token || !amountChoice) {
      throw new Error("Invalid amount selection");
    }

    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    if (amountChoice === "CUSTOM") {
      const examples =
        token === "SOL"
          ? [`• <code>0.5</code>`, `• <code>1.25</code>`]
          : [`• <code>1000</code>`, `• <code>250.5</code>`];

      await showCustomAmountPrompt({
        ctx,
        userId,
        title: `✏️ <b>CUSTOM AMOUNT - ${token}</b>`,
        instructions: [
          `Please send a message with the amount you want to send.`,
        ],
        examples,
        cancelCallback: `send_select_${token}`,
        state: {
          type: "send_custom_amount",
          token,
        },
      });

      await ctx.answerCallbackQuery("Send the amount as a message");
      return;
    }

    const telegramId = getTelegramId(ctx);
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

    const isSol = token === "SOL";
    const selectedToken = !isSol
      ? tokenBalances.find((t) => t.ticker === token)
      : undefined;

    if (!isSol && !selectedToken) {
      throw new Error(`Token ${token} not found in wallet`);
    }

    const spend = resolveSpendAmount({
      amount: amountChoice,
      assetTicker: token,
      inputDecimals: isSol ? 9 : selectedToken!.decimals,
      solBalance,
      tokenBalance: selectedToken
        ? { balance: selectedToken.balance, decimals: selectedToken.decimals }
        : undefined,
      formatSol: (lamports) => wallet.formatSolBalance(lamports),
      formatToken: (value, decimals) => wallet.formatTokenBalance(value, decimals),
      applySolFeeBuffer: true,
    });

    const displayLabel = (() => {
      const lower = amountChoice.toLowerCase();
      if (lower === "max") {
        return `MAX (~${spend.displayAmount} ${token})`;
      }
      if (amountChoice.endsWith("%")) {
        return `${amountChoice} (~${spend.displayAmount} ${token})`;
      }
      return `${spend.displayAmount} ${token}`;
    })();

    const storedAmount = amountChoice.toLowerCase() === "max"
      ? "max"
      : spend.displayAmount;

    const response = [
      `📤 <b>SEND ${escapeHtml(displayLabel)}</b>`,
      "",
      `<b>Step 2:</b> Enter destination address`,
      "",
      `Please send a message with the Solana wallet address.`,
      "",
      `<b>Format:</b> Public key (44 characters)`,
      `<b>Example:</b> <code>Ge6tnNaEY6kEznY795RSUHS5Wbm3DxMMcroLZcU3dB1Z</code>`,
      "",
      INPUT_TIMEOUT_HINT,
    ];

    await respondWithMenu(ctx, {
      text: response.join("\n"),
      keyboard: new InlineKeyboard()
        .text("❌ Cancel", `send_select_${token}`)
        .row(),
    });

    setUserState(userId, {
      type: "send_address",
      token,
      amount: storedAmount,
      amountDisplay: displayLabel,
      messageId: ctx.callbackQuery?.message?.message_id,
      chatId: ctx.chat?.id,
    });

    await ctx.answerCallbackQuery(`Selected ${displayLabel}`);
  } catch (error) {
    console.error("Error in send amount selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing amount");
  }
});




// Handle "GET STARTED" button from bot info screen - triggers /start
bot.callbackQuery("start_bot", async (ctx) => {
  try {
    if (ctx.chat?.id) {
      initiatedChats.add(ctx.chat.id);
    }

    await onBalance(ctx as any, createBalanceDeps());
    await ctx.answerCallbackQuery("🚀 Welcome to TIMBA!");
  } catch (error) {
    console.error("Error in start_bot:", error);
    await ctx.answerCallbackQuery("❌ Error loading main menu");
  }
});


// ================================
// HELP MENU CALLBACKS
// ================================

bot.callbackQuery("cmd_help", async (ctx) => {
  try {
    const helpContent = "❓ <b>HELP CENTER</b>\n\n" + "Choose a category to get detailed help:";
    const helpKeyboard = new InlineKeyboard()
      .text("💰 Wallet Commands", "help_wallet")
      .row()
      .text("🎮 Game Commands", "help_games")
      .row()
      .text("🔧 Utility Commands", "help_utility")
      .row()
      .text("📋 Examples", "help_examples")
      .row();

    await respondWithMenu(ctx, {
      text: helpContent,
      keyboard: helpKeyboard,
    });
    await ctx.answerCallbackQuery("❓ Help Center");
  } catch (error) {
    console.error("Error in cmd_help:", error);
    await ctx.answerCallbackQuery("❌ Error loading help");
  }
});

type HelpSectionKey = "wallet" | "games" | "utility" | "examples";

type HelpSectionConfig = {
  text: string;
  ack: string;
  buttons: Array<Array<{ label: string; callback: string }>>;
};

const HELP_SECTIONS: Record<HelpSectionKey, HelpSectionConfig> = {
  wallet: {
    text:
      "💰 <b>Wallet Commands</b>\n\n" +
      "<code>/start</code> - Show your wallet info\n" +
      "<code>/balance</code> - Show detailed balances\n" +
      "<code>/wrap &lt;amount&gt;</code> - Convert SOL to WSOL\n" +
      "<code>/unwrap</code> - Convert WSOL back to SOL\n" +
      "<code>/swap &lt;amount&gt; &lt;FROM&gt; &lt;TO&gt;</code> - Swap tokens\n" +
      "<code>/withdraw &lt;address&gt; &lt;amount&gt;</code> - Send tokens\n" +
      "<code>/tip &lt;amount&gt;</code> - Tip a user (reply to their message)\n\n" +
      "💡 <i>All wallet commands work with different tokens</i>",
    ack: "💰 Wallet Commands",
    buttons: [
      [
        { label: "🎮 Games", callback: "help_games" },
        { label: "🔧 Utility", callback: "help_utility" },
      ],
      [{ label: "📋 Examples", callback: "help_examples" }],
      [{ label: "⬅️ Help Menu", callback: "cmd_help" }],
    ],
  },
  games: {
    text:
      "🎮 <b>Game Commands</b>\n\n" +
      "<code>/coinflip &lt;amount&gt; [TOKEN] &lt;players&gt;</code> - Create coinflip\n" +
      "<code>/giveaway &lt;amount&gt; [TOKEN] &lt;players&gt;</code> - Create giveaway\n" +
      "<code>/active</code> - Show active games\n" +
      "<code>/games</code> - Show your game history\n" +
      "<code>/leaderboard</code> - Show top 10 players (groups only)\n\n" +
      "🪙 <b>Game Types:</b>\n" +
      "• <b>Coinflip:</b> Players pay to join, winner takes all\n" +
      "• <b>Giveaway:</b> Free to join, you fund the prize\n\n" +
      "⏱️ <i>Games expire after 1 hour if not filled</i>",
    ack: "🎮 Game Commands",
    buttons: [
      [
        { label: "💰 Wallet", callback: "help_wallet" },
        { label: "🔧 Utility", callback: "help_utility" },
      ],
      [{ label: "📋 Examples", callback: "help_examples" }],
      [{ label: "⬅️ Help Menu", callback: "cmd_help" }],
    ],
  },
  utility: {
    text:
      "🔧 <b>Utility Commands</b>\n\n" +
      "<code>/debug</code> - Show wallet debug info\n" +
      "<code>/checktx &lt;signature&gt;</code> - Check transaction status\n" +
      "<code>/oracle</code> - Check oracle status\n" +
      "<code>/default [TOKEN]</code> - Show/set chat default token\n\n" +
      "🔐 <b>Security:</b>\n" +
      "• Some commands are private-chat only\n" +
      "• Admin commands require permissions\n" +
      "• Your keys never leave your wallet",
    ack: "🔧 Utility Commands",
    buttons: [
      [
        { label: "💰 Wallet", callback: "help_wallet" },
        { label: "🎮 Games", callback: "help_games" },
      ],
      [{ label: "📋 Examples", callback: "help_examples" }],
      [{ label: "⬅️ Help Menu", callback: "cmd_help" }],
    ],
  },
  examples: {
    text:
      "📋 <b>Command Examples</b>\n\n" +
      "<b>💰 Wallet Examples:</b>\n" +
      "<code>/swap 100 USDC SOL</code>\n" +
      "<code>/withdraw [address] 50 TIMBA</code>\n" +
      "<code>/wrap 1</code> (converts 1 SOL to WSOL)\n\n" +
      "<code>/unwrap</code> (convert your entire WSOL balance back to SOL)\n\n" +
      "<b>🎮 Game Examples:</b>\n" +
      "<code>/coinflip 100 TIMBA 2</code> (2-player, 100 TIMBA each)\n" +
      "<code>/giveaway 500 TIMBA 5</code> (5 players, 500 TIMBA prize)\n\n" +
      "<b>🔧 Utility Examples:</b>\n" +
      "<code>/checktx 3x7k2m...</code> (check transaction)\n" +
      "<code>/default USDC</code> (set chat default token)",
    ack: "📋 Command Examples",
    buttons: [
      [
        { label: "💰 Wallet", callback: "help_wallet" },
        { label: "🎮 Games", callback: "help_games" },
      ],
      [{ label: "🔧 Utility", callback: "help_utility" }],
      [{ label: "⬅️ Help Menu", callback: "cmd_help" }],
    ],
  },
};

const showHelpSection = async (
  ctx: any,
  section: HelpSectionKey
) => {
  const config = HELP_SECTIONS[section];
  const keyboard = new InlineKeyboard();
  for (const row of config.buttons) {
    for (const button of row) {
      keyboard.text(button.label, button.callback);
    }
    keyboard.row();
  }

  await respondWithMenu(ctx, {
    text: config.text,
    parseMode: "HTML",
    keyboard,
  });
  await ctx.answerCallbackQuery(config.ack);
};

bot.callbackQuery("help_wallet", async (ctx) => {
  try {
    await showHelpSection(ctx, "wallet");
  } catch (error) {
    console.error("Error in help_wallet:", error);
    await ctx.answerCallbackQuery("❌ Error loading wallet help");
  }
});

bot.callbackQuery("help_games", async (ctx) => {
  try {
    await showHelpSection(ctx, "games");
  } catch (error) {
    console.error("Error in help_games:", error);
    await ctx.answerCallbackQuery("❌ Error loading games help");
  }
});

bot.callbackQuery("help_utility", async (ctx) => {
  try {
    await showHelpSection(ctx, "utility");
  } catch (error) {
    console.error("Error in help_utility:", error);
    await ctx.answerCallbackQuery("❌ Error loading utility help");
  }
});

bot.callbackQuery("help_examples", async (ctx) => {
  try {
    await showHelpSection(ctx, "examples");
  } catch (error) {
    console.error("Error in help_examples:", error);
    await ctx.answerCallbackQuery("❌ Error loading examples");
  }
});



// ================================
// ADMIN MENU CALLBACKS
// ================================




// (Removed admin placeholder handlers)

// ================================
// BUY/SELL INTERFACE HANDLERS
// ================================

bot.callbackQuery("cmd_buy", async (ctx) => {
  try {
    if (!ctx.from?.id) {
      return;
    }

    const telegramId = getTelegramId(ctx);
    const overview = await getWalletOverview(telegramId);
    const ownedTickers = new Set(
      overview.ownedTokens
        .map((token) => token.ticker?.toUpperCase())
        .filter((ticker): ticker is string => Boolean(ticker))
    );

    const tokenButtons: { label: string; callbackData: string }[] = [];

    const featuredTokens = [{ ticker: "TIMBA", label: "🎲 TIMBA" }];

    for (const featured of featuredTokens) {
      if (!ownedTickers.has(featured.ticker)) {
        tokenButtons.push({
          label: featured.label,
          callbackData: `buy_popular_SOL_${featured.ticker}`,
        });
      }
    }

    const ownedTokenButtons = overview.ownedTokens.slice(0, 6).map((token) => {
      const formattedBalance = wallet.formatTokenBalance(
        token.balance,
        token.decimals
      );
      const tokenTxId = Math.random().toString(36).substring(2, 15);
      transactionCache.setWithTTL(tokenTxId, {
        targetToken: token.ticker,
        targetTokenAddress: token.mint,
        paymentToken: "SOL",
      });
      return {
        label: `${token.ticker} (${formattedBalance})`,
        callbackData: `buy_dynamic_SOL_${tokenTxId}`,
      };
    });
    tokenButtons.push(...ownedTokenButtons);

    const { message, keyboard } = buildBuyMenuUI({
      walletAddress: overview.walletAddress,
      formattedSolBalance: overview.formattedSolBalance,
      totalUsd: overview.totalUsd,
      tokenButtons,
    });

    await respondWithMenu(ctx, { text: message, keyboard });

    const userId = ctx.from.id.toString();
    setUserState(userId, {
      type: "buy_menu_idle",
      paymentToken: "SOL",
      chatId: ctx.chat?.id,
      messageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.answerCallbackQuery("Select a token to buy");
  } catch (error) {
    console.error("Error in cmd_buy:", error);
    await ctx.answerCallbackQuery("❌ Error loading buy interface");
  }
});

bot.callbackQuery("cmd_sell", async (ctx) => {
  try {
    if (!ctx.from?.id) {
      return;
    }

    const telegramId = getTelegramId(ctx);
    const overview = await getWalletOverview(telegramId);
    const userKeypair = wallet.getKeyPair(telegramId);

    const sellTokenButtons: { label: string; callbackData: string }[] = [];
    for (const token of overview.ownedTokens.slice(0, 6)) {
      const formatted = wallet.formatTokenBalance(
        token.balance,
        token.decimals
      );

      let solEstimate = "";
      try {
        if (
          token.mint &&
          token.mint !== "undefined" &&
          token.mint !== "So11111111111111111111111111111111111111112" &&
          token.ticker &&
          token.ticker !== "undefined" &&
          typeof token.mint === "string" &&
          token.mint.length > 30 &&
          token.rawBalance &&
          token.decimals !== undefined
        ) {
          const quote = await swapManager.getQuote({
            inputMint: token.mint,
            outputMint: "So11111111111111111111111111111111111111112",
            amount: token.rawBalance,
            slippageBps: 500,
            userKeypair,
            inputDecimals: token.decimals,
            outputDecimals: 9,
            inputTicker: token.ticker.toUpperCase(),
            outputTicker: "SOL",
          });

          const solAmount = parseFloat(quote.outputAmount) / LAMPORTS_PER_SOL;
          if (solAmount > 0.001) {
            solEstimate = ` → ${solAmount.toFixed(4)} SOL`;
          } else if (solAmount > 0) {
            solEstimate = ` → ${solAmount.toFixed(6)} SOL`;
          }
        }
      } catch (error) {
        console.log(
          `Could not get quote for ${token.ticker || "unknown token"}: ${
            (error as Error).message
          }`
        );
      }

      sellTokenButtons.push({
        label: `${token.ticker} (${formatted}${solEstimate})`,
        callbackData: `sell_token_${token.ticker}`,
      });
    }

    const { message, keyboard } = buildSellMenuUI({
      walletAddress: overview.walletAddress,
      tokenButtons: sellTokenButtons,
    });

    await respondWithMenu(ctx, { text: message, keyboard });
    await ctx.answerCallbackQuery("Select what you want to sell");
  } catch (error) {
    console.error("Error in cmd_sell:", error);
    await ctx.answerCallbackQuery("❌ Error loading sell interface");
  }
});

bot.callbackQuery(SELL_NOOP_CALLBACK, async (ctx) => {
  await ctx.answerCallbackQuery("No tokens available to sell");
});

bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("trade_slip_")) {
    return await next();
  }

  const parts = callbackData.replace("trade_slip_", "").split("_");
  if (parts.length < 3) {
    return await next();
  }

  const [kind, ...restParts] = parts;
  const tradeKind = kind === "buy" || kind === "sell" ? kind : undefined;

  if (!tradeKind || restParts.length < 2) {
    return await ctx.answerCallbackQuery("❌ Invalid slippage request");
  }

  const slippageValue = restParts.pop();
  const txId = restParts.join("_");

  if (!txId || !slippageValue) {
    return await ctx.answerCallbackQuery("❌ Invalid slippage request");
  }

  console.log(
    `⚙️ ${tradeKind.toUpperCase()} slippage change: ${slippageValue} for txId: ${txId}`
  );

  try {
    const tradeResult = getTradeTransactionCacheEntry(txId);
    const tradeData = tradeResult?.entry;

    if (!tradeData || tradeData.kind !== tradeKind) {
      await ctx.answerCallbackQuery("❌ Transaction expired. Please try again.");
      return;
    }

    if (slippageValue === "custom") {
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      const currentSlippage = Number.isFinite(tradeData.quote.slippage)
        ? (tradeData.quote.slippage as number)
        : 1.0;

      const response = [
        `⚙️ <b>CUSTOM SLIPPAGE</b>`,
        "",
        `<b>Current:</b> ${currentSlippage.toFixed(1)}%`,
        "",
        `Please send a message with your desired slippage percentage.`,
        "",
        `<b>Examples:</b>`,
        `• <code>0.5</code> (0.5% slippage)`,
        `• <code>1.5</code> (1.5% slippage)`,
        `• <code>3</code> (3% slippage)`,
        "",
        `<b>Range:</b> ${TRADE_SLIPPAGE_RANGE.min}% - ${TRADE_SLIPPAGE_RANGE.max}%`,
        INPUT_TIMEOUT_HINT,
      ];

      await respondWithMenu(ctx, {
        text: response.join("\n"),
        parseMode: "HTML",
        keyboard: new InlineKeyboard()
          .text("❌ Cancel", `trade_slip_back_${tradeKind}_${txId}`)
          .row(),
      });

      setUserState(userId, {
        type: "trade_custom_slippage",
        txId,
        tradeKind,
        messageId: ctx.callbackQuery?.message?.message_id,
        chatId: ctx.chat?.id,
      });

      await ctx.answerCallbackQuery("Send custom slippage as message");
      return;
    }

    const newSlippage = parseFloat(slippageValue);
    if (
      Number.isNaN(newSlippage) ||
      newSlippage < TRADE_SLIPPAGE_RANGE.min ||
      newSlippage > TRADE_SLIPPAGE_RANGE.max
    ) {
      await ctx.answerCallbackQuery("❌ Invalid slippage value");
      return;
    }

    await regenerateTradeQuoteWithSlippage(ctx, {
      txId,
      tradeKind,
      slippage: newSlippage,
    });
    await ctx.answerCallbackQuery(`✅ Slippage set to ${newSlippage}%`);
  } catch (error: any) {
    console.error("Error updating slippage:", error);
    await ctx.answerCallbackQuery("❌ Error updating slippage");
  }
});

bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("trade_slip_back_")) {
    return await next();
  }

  const parts = callbackData.replace("trade_slip_back_", "").split("_");
  if (parts.length < 2) {
    return await next();
  }

  const [kind, ...txParts] = parts;
  const tradeKind = kind === "buy" || kind === "sell" ? kind : undefined;
  const txId = txParts.join("_");

  if (!tradeKind || !txId) {
    return await ctx.answerCallbackQuery("❌ Invalid slippage request");
  }

  try {
    await regenerateTradeQuoteWithSlippage(ctx, { txId, tradeKind });
    await ctx.answerCallbackQuery("⚙️ Back to confirmation");
  } catch (error) {
    console.error("Error restoring trade confirmation:", error);
    await ctx.answerCallbackQuery("❌ Error loading confirmation");
  }
});

// Handle SELL token selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("sell_token_")) {
    return await next();
  }

  const tokenToSell = callbackData.replace("sell_token_", "");
  console.log(`🔴 SELL token selected: ${tokenToSell}`);

  try {
    // Show sell amount selection for this token
    await showSellAmountSelection(ctx, tokenToSell);
    await ctx.answerCallbackQuery(`Sell ${tokenToSell}`);
  } catch (error) {
    console.error("Error in sell_token selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing token selection");
  }
});

// Handle SELL amount selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("sell_amount_")) {
    return await next();
  }

  // Parse callback data: sell_amount_TOKEN_AMOUNT
  const parts = callbackData.replace("sell_amount_", "").split("_");
  if (parts.length < 2) {
    return await next();
  }

  const tokenToSell = parts[0];
  const amount = parts.slice(1).join("_"); // Handle cases where amount might contain underscores

  if (!tokenToSell || !amount) {
    console.error("Invalid sell callback data");
    return await next();
  }

  console.log(`🔴 SELL amount selected: ${amount} ${tokenToSell}`);

  try {
    const telegramId = getTelegramId(ctx);

    if (amount === "CUSTOM") {
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      await showCustomAmountPrompt({
        ctx,
        userId,
        title: `🔴 <b>SELL ${tokenToSell} - CUSTOM AMOUNT</b>`,
        instructions: [
          `Please send a message with the amount of ${tokenToSell} you want to sell.`,
        ],
        examples: [
          `• <code>100</code> (sell 100 ${tokenToSell})`,
          `• <code>50%</code> (sell 50% of balance)`,
          `• <code>max</code> (sell all ${tokenToSell})`,
        ],
        cancelCallback: "cmd_sell",
        state: {
          type: "sell_custom_amount",
          tokenToSell,
        },
      });

      await ctx.answerCallbackQuery("Send custom amount as message");
      return;
    }

    // Handle predefined amounts or percentages
    await runSellTradeQuote({
      ctx,
      tokenToSell,
      amount,
      telegramId,
    });
  } catch (error: any) {
    console.error("Error in sell_amount:", error);

    const errorMessage = [
      "❌ <b>Error Processing Sell Request</b>",
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please try again or contact support if the issue persists.",
    ];

    await respondWithMenu(ctx, {
      text: errorMessage.join("\n"),
      keyboard: new InlineKeyboard().text("← Try Again", "cmd_sell").row(),
    });

    await ctx.answerCallbackQuery("❌ Error processing sell request");
  }
});

// Handle SELL confirmation
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("confirm_sell_")) {
    return await next();
  }

  const txId = callbackData.replace("confirm_sell_", "");
  const sellResult = getSellTransactionCacheEntry(txId);
  const sellData = sellResult?.entry;

  if (!sellData) {
    await ctx.answerCallbackQuery("❌ Transaction expired. Please try again.");
    return;
  }

  console.log(
    `✅ SELL confirmation for: ${sellData.amount} ${sellData.fromToken} → ${sellData.toToken}`
  );

  try {
    // Show processing state
    const { message } = buildProcessingStatus(
      "sell",
      sellData.amount,
      sellData.fromToken,
      sellData.toToken
    );

    await respondWithMenu(ctx, {
      text: message,
    });

    await safeAnswerCallbackQuery(ctx, "Processing sell...");

    const userId = ctx.from?.id?.toString();
    if (!userId) {
      throw new Error("User ID not found");
    }

    const telegramId = getTelegramId(ctx);
    const userKeypair = wallet.getKeyPair(telegramId);

    // Use the existing global swapManager instance

    const slippagePercent = Number.isFinite(sellData.quote.slippage)
      ? (sellData.quote.slippage as number)
      : 1;
    const slippageBps = Math.max(0, Math.round(slippagePercent * 100));

    const quote = await swapManager.getQuote({
      inputMint: sellData.fromTokenInfo.token_mint,
      outputMint: sellData.toTokenInfo.token_mint,
      amount: sellData.rawAmount, // Use raw amount - swapManager will convert for pump.fun if needed
      slippageBps,
      userKeypair: userKeypair,
      inputDecimals: sellData.fromTokenInfo.decimals || 6,
      outputDecimals: 9, // SOL decimals
      inputTicker: sellData.fromToken.toUpperCase(),
      outputTicker: sellData.toToken.toUpperCase(),
    });

    if (!quote) {
      throw new Error("Unable to get swap quote for sell");
    }

    // Use the same successful approach as BUY command
    let signature: string;

    if (quote.provider === "jupiter") {
      // Use Jupiter execution method
      signature = await swapManager.executeJupiterSwap(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount, // Use quote amount like successful BUY/SWAP
          slippageBps,
          userKeypair: userKeypair,
          inputDecimals: sellData.fromTokenInfo.decimals,
          outputDecimals: 9,
          inputTicker: sellData.fromToken.toUpperCase(),
          outputTicker: sellData.toToken.toUpperCase(),
        },
        quote
      );
    } else {
      // Use instruction-based approach for other providers (pump.fun)
      const instructions = await swapManager.createSwapTransaction(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount, // Use quote amount like successful BUY/SWAP
          slippageBps,
          userKeypair: userKeypair,
          inputDecimals: sellData.fromTokenInfo.decimals,
          outputDecimals: 9,
          inputTicker: sellData.fromToken.toUpperCase(),
          outputTicker: sellData.toToken.toUpperCase(),
        },
        quote
      );

      // Execute transaction
      signature = await wallet.sendTransaction(instructions, [userKeypair]);
    }

    console.log(`🚀 Sell transaction submitted: ${signature}`);

    // Wait for confirmation
    await wallet.confirmTransaction(signature);

    const successMessage = [
      "✅ <b>SELL COMPLETED!</b>",
      "",
      `💰 <b>Sold:</b> ${sellData.amount} ${sellData.fromToken}`,
      `🎯 <b>Received:</b> ${sellData.toToken}`,
      "",
      `🔗 <b>Transaction:</b> <code>${signature.slice(
        0,
        8
      )}...${signature.slice(-8)}</code>`,
      "",
      "🎉 <b>Sale successful!</b>",
    ].join("\n");

    await respondWithMenu(ctx, {
      text: successMessage,
      keyboard: new InlineKeyboard()
        .webApp("🔍 VIEW TX", `https://solscan.io/tx/${signature}`)
        .row()
        .text("💰 Wallet", "main_wallet")
        .text("🔴 Sell More", "cmd_sell")
        .row(),
    });
    await safeAnswerCallbackQuery(ctx, "Sell completed!");

    // Clear wallet cache to force fresh balance on next wallet access
    const cacheKey = getWalletCacheKey(ctx.from?.id || "");
    if (cacheKey) {
      walletDataCache.delete(cacheKey);
      console.log(`🧹 Cleared wallet cache for user ${cacheKey} after SELL`);
    }

    transactionCache.delete(txId);
  } catch (error: any) {
    console.error("Sell execution error:", error);

    const errorMessage = [
      "❌ <b>Sell Transaction Failed</b>",
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "The transaction could not be completed. Please check your balance and try again.",
    ].join("\n");

    await respondWithMenu(ctx, {
      text: errorMessage,
      keyboard: new InlineKeyboard()
        .text("← Try Again", "cmd_sell")
        .text("💰 Wallet", "main_wallet")
        .row(),
    });

    await safeAnswerCallbackQuery(ctx, "❌ Sell failed");
    transactionCache.delete(txId);
  }
});

// Handle popular token selection for buy
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_popular_")) {
    return await next();
  }

  const parts = callbackData.replace("buy_popular_", "").split("_");
  if (parts.length < 2) return await next();

  const paymentToken = parts[0];
  const targetToken = parts[1];

  if (!paymentToken || !targetToken) {
    console.error("Invalid buy popular callback data");
    return await next();
  }

  console.log(`🟢 Popular token buy: ${paymentToken} → ${targetToken}`);

  try {
    await showBuyAmountSelection(ctx, paymentToken, targetToken);
    await ctx.answerCallbackQuery(`Buy ${targetToken} with ${paymentToken}`);
  } catch (error) {
    console.error("Error in buy_popular selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing token selection");
  }
});

// Handle dynamic token selection (from CA or symbol search)
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_dynamic_")) {
    return await next();
  }

  const parts = callbackData.replace("buy_dynamic_", "").split("_");
  if (parts.length < 2) return await next();

  const paymentToken = parts[0];
  const tokenTxId = parts[1];

  if (!paymentToken || !tokenTxId) {
    console.error("Invalid buy dynamic callback data");
    return await next();
  }

  // Get the cached token info
  const tokenEntry = transactionCache.get(tokenTxId);
  if (!isTokenSelectionCacheEntry(tokenEntry)) {
    await ctx.answerCallbackQuery("❌ Token data expired. Please try again.");
    return;
  }

  const tokenData = tokenEntry;

  const targetToken = tokenData.targetToken;
  const contractAddress = tokenData.targetTokenAddress;

  console.log(
    `🟢 Dynamic token buy: ${paymentToken} → ${targetToken} (${contractAddress})`
  );

  try {
    // Store the contract address for later use in transactions
    const userId = ctx.from?.id?.toString();
    if (userId) {
      setUserState(userId, {
        type: "dynamic_token_buy",
        paymentToken: paymentToken,
        targetToken: targetToken,
        contractAddress: contractAddress,
        messageId: ctx.callbackQuery?.message?.message_id,
        chatId: ctx.chat?.id,
      });
    }

    // For dynamic tokens, pass contract address to amount selection
    await showBuyAmountSelection(
      ctx,
      paymentToken,
      targetToken,
      contractAddress,
      tokenTxId
    );
    await ctx.answerCallbackQuery(`Buy ${targetToken} with ${paymentToken}`);
  } catch (error) {
    console.error("Error in dynamic token selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing token selection");
  }
});

// Handle BUY amount selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_amount_")) {
    return await next();
  }

  // Parse callback data: buy_amount_PAYMENTTOKEN_TARGETTOKEN_AMOUNT or buy_amount_PAYMENTTOKEN_TOKENTXID_AMOUNT
  const parts = callbackData.replace("buy_amount_", "").split("_");
  if (parts.length < 3) {
    return await next();
  }

  const paymentToken = parts[0];
  const secondPart = parts[1];
  const amount = parts.slice(2).join("_"); // Handle cases where amount might contain underscores

  if (!paymentToken || !secondPart || !amount) {
    return await ctx.answerCallbackQuery("❌ Invalid buy parameters");
  }

  // Check if second part is a transaction ID (from contract address flow) or target token
  let targetToken = secondPart;
  let contractAddress: string | undefined;

  // If it looks like a transaction ID (short alphanumeric), look it up in cache
  if (secondPart.length < 20 && /^[a-z0-9]+$/.test(secondPart)) {
    const cachedInfo = transactionCache.get(secondPart);
    if (isTokenSelectionCacheEntry(cachedInfo)) {
      targetToken = cachedInfo.targetToken;
      contractAddress = cachedInfo.targetTokenAddress;
    }
  }

  if (!targetToken) {
    return await ctx.answerCallbackQuery("❌ Invalid target token");
  }

  console.log(
    `💰 BUY amount selected: ${amount} ${paymentToken} → ${targetToken}`
  );

  try {
    const userId = ctx.from?.id?.toString();

    // Get existing user state to check for dynamic token info
    const existingState = getUserState(userId, false); // Don't clear it yet
    // Use contractAddress from transaction cache if available, otherwise from user state
    if (!contractAddress) {
      contractAddress = existingState?.contractAddress;
    }

    if (amount === "CUSTOM") {
      if (!userId) return;

      await showCustomAmountPrompt({
        ctx,
        userId,
        title: `💰 <b>BUY ${targetToken} - CUSTOM AMOUNT</b>`,
        tokenLines: [
          `<b>Paying with:</b> ${paymentToken}`,
          `<b>Target token:</b> ${targetToken}`,
        ],
        instructions: [
          `Please send a message with the amount of ${paymentToken} you want to spend.`,
        ],
        examples: [
          `• <code>0.1</code> (spend 0.1 ${paymentToken})`,
          `• <code>5</code> (spend 5 ${paymentToken})`,
          `• <code>50%</code> (spend 50% of balance)`,
          `• <code>max</code> (spend all available ${paymentToken})`,
        ],
        cancelCallback: "cmd_buy",
        state: {
          type: "buy_custom_amount",
          paymentToken,
          targetToken,
          contractAddress,
        },
      });

      await ctx.answerCallbackQuery("Send custom amount as message");
      return;
    }

    // Handle predefined amounts or percentages
    await runBuyTradeQuote({
      ctx,
      paymentToken,
      targetToken,
      amount,
      contractAddress,
    });
  } catch (error: any) {
    console.error("Error in buy_amount:", error);

    const errorMessage = [
      "❌ <b>Error Processing Buy Request</b>",
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please try again or contact support if the issue persists.",
    ];

    await respondWithMenu(ctx, {
      text: errorMessage.join("\n"),
      keyboard: new InlineKeyboard().text("← Try Again", "cmd_buy").row(),
    });

    await ctx.answerCallbackQuery("❌ Error processing buy request");
  }
});

// Handle BUY confirmation
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("confirm_buy_")) {
    return await next();
  }

  const txId = callbackData.replace("confirm_buy_", "");
  const buyResult = getBuyTransactionCacheEntry(txId);
  const buyData = buyResult?.entry;

  if (!buyData) {
    await ctx.answerCallbackQuery("❌ Transaction expired. Please try again.");
    return;
  }

  console.log(
    `✅ BUY confirmation for: ${buyData.amount} ${buyData.fromToken} → ${buyData.toToken}`
  );

  try {
    // Show processing state
    const { message } = buildProcessingStatus(
      "buy",
      buyData.amount,
      buyData.fromToken,
      buyData.toToken
    );

    await respondWithMenu(ctx, {
      text: message,
    });

    await safeAnswerCallbackQuery(ctx, "Processing buy...");

    const userId = ctx.from?.id?.toString();
    if (!userId) {
      throw new Error("User ID not found");
    }

    const telegramId = getTelegramId(ctx);
    const userKeypair = wallet.getKeyPair(telegramId);

    // Use the existing global swapManager instance

    let signature: string;
    let instructions: any[];

    // Use the existing quote that was already generated and stored
    if (!buyData.quote) {
      throw new Error("No quote data available for this transaction");
    }

    // Execute the swap using the stored quote (same logic as confirm_swap)
    const quote = buyData.quote;

    // Use the same successful approach as the working /swap command

    if (quote.provider === "jupiter") {
      // Use Jupiter execution method
      signature = await swapManager.executeJupiterSwap(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount, // Use quote amount like successful swap does
          slippageBps: 100, // Use same 1% slippage as successful swap
          userKeypair: userKeypair,
          inputDecimals: quote.inputDecimals || 9,
          outputDecimals: quote.outputDecimals || 9,
          inputTicker: buyData.fromToken.toUpperCase(),
          outputTicker: buyData.toToken.toUpperCase(),
        },
        quote
      );
    } else {
      // Use instruction-based approach for other providers (pump.fun)
      instructions = await swapManager.createSwapTransaction(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount, // Use quote amount like successful swap does
          slippageBps: 100, // Use same 1% slippage as successful swap
          userKeypair: userKeypair,
          inputDecimals: quote.inputDecimals || 9,
          outputDecimals: quote.outputDecimals || 6,
          inputTicker: buyData.fromToken.toUpperCase(),
          outputTicker: buyData.toToken.toUpperCase(),
        },
        quote
      );

      // Execute transaction
      signature = await wallet.sendTransaction(instructions, [userKeypair]);
    }

    console.log(`🚀 Buy transaction submitted: ${signature}`);

    // Wait for confirmation
    await wallet.confirmTransaction(signature);

    const successMessage = [
      "✅ <b>BUY COMPLETED!</b>",
      "",
      `💰 <b>Spent:</b> ${buyData.amount} ${buyData.fromToken}`,
      `🎯 <b>Received:</b> ${buyData.toToken} tokens`,
      "",
      `🔗 <b>Transaction:</b> <code>${signature.slice(
        0,
        8
      )}...${signature.slice(-8)}</code>`,
      "",
      "🎉 <b>Purchase successful!</b>",
    ].join("\n");

    await respondWithMenu(ctx, {
      text: successMessage,
      keyboard: new InlineKeyboard()
        .webApp("🔍 VIEW TX", `https://solscan.io/tx/${signature}`)
        .row()
        .text("💰 Wallet", "main_wallet")
        .text("🔄 Buy More", "cmd_buy")
        .row(),
    });
    await safeAnswerCallbackQuery(ctx, "Buy completed!");

    // Clear wallet cache to force fresh balance on next wallet access
    const cacheKey = getWalletCacheKey(ctx.from?.id || "");
    if (cacheKey) {
      walletDataCache.delete(cacheKey);
      console.log(`🧹 Cleared wallet cache for user ${cacheKey} after BUY`);
    }

    transactionCache.delete(txId);
  } catch (error: any) {
    console.error("Buy execution error:", error);

    let errorMessage: string;
    let keyboard = new InlineKeyboard();

    // Handle specific error types
    if (
      (error as Error).message?.includes("TooMuchSolRequired") ||
      (error as Error).message?.includes("slippage") ||
      error.transactionLogs?.some((log: string) =>
        log.includes("TooMuchSolRequired")
      )
    ) {
      // Extract the actual amounts needed from logs if available
      let requiredAmount = null;
      let yourAmount = null;

      if (error.transactionLogs) {
        for (const log of error.transactionLogs) {
          if (log.includes("Left:") && log.includes("Right:")) {
            const leftMatch = log.match(/Left: (\d+)/);
            const rightMatch = log.match(/Right: (\d+)/);
            if (leftMatch && rightMatch) {
              yourAmount = parseInt(leftMatch[1]) / 1000000000; // Convert lamports to SOL
              requiredAmount = parseInt(rightMatch[1]) / 1000000000;
              break;
            }
          }
        }
      }

      let suggestionText = "• Try a slightly higher amount";
      let buttonText = "💡 TRY HIGHER";

      if (requiredAmount && yourAmount) {
        const difference = requiredAmount - yourAmount;
        const suggestedAmount = requiredAmount + difference * 0.1; // Add 10% buffer
        const isDifferenceSmall = difference < 0.001;

        const suggestedLamports = Math.round(suggestedAmount * 1_000_000_000);
        const suggestedStr = wallet.formatSolBalance(suggestedLamports);
        suggestionText = isDifferenceSmall
          ? `• Try with ${suggestedStr} SOL (includes fees/buffer)`
          : `• Try with ${suggestedStr} SOL (price moved)`;
        buttonText = `💡 ${suggestedStr} SOL`;
      }

      // Get difference amount for better messaging
      const difference =
        requiredAmount && yourAmount ? requiredAmount - yourAmount : 0;
      const isDifferenceSmall = difference > 0 && difference < 0.001; // Less than 0.001 SOL

      // Slippage error - offer specific solutions
      errorMessage = [
        isDifferenceSmall
          ? "⚠️ <b>Small Amount Missing</b>"
          : "⚠️ <b>Amount Adjustment Needed</b>",
        "",
        `You tried: ${buyData.amount} ${buyData.fromToken}`,
        requiredAmount
          ? `Need: ${wallet.formatSolBalance(Math.round(requiredAmount * 1_000_000_000))} ${buyData.fromToken}`
          : "But need slightly more",
        isDifferenceSmall
          ? `Difference: ${wallet.formatSolBalance(Math.round(difference * 1_000_000_000))} SOL (likely fees/precision)`
          : "",
        "",
        "<b>Why this happens:</b>",
        isDifferenceSmall
          ? "• Transaction fees not included in quote"
          : "• Price moved or slippage protection",
        isDifferenceSmall
          ? "• Small calculation differences in SDK"
          : "• Market volatility",
        "",
        "<b>Solutions:</b>",
        suggestionText,
        "• Wait and retry",
        "",
        "🛡️ <i>This protects you from failed transactions!</i>",
      ]
        .filter((line) => line !== "")
        .join("\n");

      keyboard
        .text(buttonText, `buy_retry_exact_${txId}`)
        .text("🔄 Retry Same", `confirm_buy_${txId}`)
        .row()
        .text("← Back to Buy", "cmd_buy")
        .text("💰 Wallet", "main_wallet")
        .row();

      // Store the exact amount needed for the retry button
      if (requiredAmount && yourAmount !== null) {
        const retryAmount =
          requiredAmount + (requiredAmount - yourAmount) * 0.1;
        buyData.retryAmount = retryAmount.toFixed(4);
      }
    } else if (
      (error as Error).message?.includes("Insufficient funds") ||
      (error as Error).message?.includes("insufficient")
    ) {
      // Insufficient funds error
      errorMessage = [
        "❌ <b>Insufficient Funds</b>",
        "",
        `You don't have enough ${buyData.fromToken} to complete this purchase.`,
        `Needed: ${buyData.amount} ${buyData.fromToken}`,
        "",
        "Please check your balance and try a smaller amount.",
      ].join("\n");

      keyboard
        .text("💰 Check Balance", "main_wallet")
        .text("← Try Smaller", "cmd_buy")
        .row();
    } else {
      // Generic error
      errorMessage = [
        "❌ <b>Buy Transaction Failed</b>",
        "",
        `<b>Error:</b> ${(error as Error).message || "Unknown error"}`,
        "",
        "The transaction could not be completed. Please try again.",
      ].join("\n");

      keyboard
        .text("🔄 Try Again", "cmd_buy")
        .text("💰 Wallet", "main_wallet")
        .row();
    }

    await respondWithMenu(ctx, {
      text: errorMessage,
      keyboard,
    });

    await safeAnswerCallbackQuery(ctx, "❌ Buy failed");
    transactionCache.delete(txId);
  }
});

// Handle BUY retry with exact amount needed
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_retry_exact_")) {
    return await next();
  }

  const txId = callbackData.replace("buy_retry_exact_", "");
  const buyResult = getBuyTransactionCacheEntry(txId);
  const buyData = buyResult?.entry;

  if (!buyData) {
    await ctx.answerCallbackQuery("❌ Transaction expired. Please try again.");
    return;
  }

  try {
    // Use the exact retry amount calculated from the error, or add small buffer
    let newAmount =
      buyData.retryAmount || (parseFloat(buyData.amount) * 1.01).toString();

    console.log(
      `💡 Retrying buy with exact amount needed: ${newAmount} ${buyData.fromToken} → ${buyData.toToken}`
    );

    // Update the stored transaction with new amount
    buyData.amount = newAmount;
    transactionCache.setWithTTL(txId, buyData);
    if (buyResult?.source === "pending") {
      storePendingTransaction(txId, buyData);
    }

    // Show updated confirmation with new amount
    const confirmKeyboard = createTradeConfirmKeyboard({
      confirmLabel: "✅ Confirm Buy",
      confirmCallback: `confirm_buy_${txId}`,
      cancelLabel: "← Back to Buy",
      cancelCallback: "cmd_buy",
    });

    await respondWithMenu(ctx, {
      text: [
        "💡 <b>Using Exact Amount Needed</b>",
        "",
        `📈 <b>Original:</b> ${buyData.amount} ${buyData.fromToken}`,
        `✅ <b>New Amount:</b> ${newAmount} ${buyData.fromToken}`,
        `🎯 <b>Buying:</b> ${buyData.toToken}`,
        "",
        "This matches the current price. Ready to proceed?",
      ].join("\n"),
      keyboard: confirmKeyboard,
    });

    await ctx.answerCallbackQuery("💡 Amount increased slightly");
  } catch (error) {
    console.error("Error in buy retry higher:", error);
    await ctx.answerCallbackQuery("❌ Error processing retry");
  }
});

// SWAP INTERFACE HANDLERS
// ================================

// Handle "FROM" token selection for swap
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("swap_from_")) {
    return await next();
  }

  const fromToken = callbackData.replace("swap_from_", "");
  console.log("🔔 Swap FROM token selected:", fromToken);

  try {
    const telegramId = getTelegramId(ctx);
    const keypair = wallet.getKeyPair(telegramId);
    const walletAddress = keypair.publicKey.toBase58();
    const walletAddressHtml = escapeHtml(walletAddress);

    // Get available tokens to swap TO (exclude the FROM token)
    await getCachedWalletData(telegramId);

    const response = [
      `💱 <b>SWAP ${fromToken}</b>`,
      "",
      `<b>From:</b> <code>${walletAddressHtml}</code>`,
      "",
      `<b>Select token to swap TO:</b>`,
    ];

    const keyboard = new InlineKeyboard();

    // Add SOL option if not swapping from SOL
    if (fromToken !== "SOL") {
      keyboard.text(`SOL`, `swap_to_${fromToken}_SOL`).row();
    }

    // Add popular tokens (USDC, WSOL, TIMBA)
    const popularTokens = ["USDC", "WSOL", "TIMBA"];
    for (const token of popularTokens) {
      if (token !== fromToken) {
        keyboard.text(`${token}`, `swap_to_${fromToken}_${token}`).row();
      }
    }

    // Add "Other Token" option
    keyboard.text("🔍 Other Token", `swap_to_${fromToken}_OTHER`).row();
    keyboard.text("← Back to Swap", "cmd_swap").row();

    await respondWithMenu(ctx, {
      text: response.join("\n"),
      parseMode: "HTML",
      keyboard,
    });
    await ctx.answerCallbackQuery(`Select token to receive`);
  } catch (error) {
    console.error("Error in swap_from selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing swap selection");
  }
});

// Handle "TO" token selection for swap
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("swap_to_")) {
    return await next();
  }

  const parts = callbackData.replace("swap_to_", "").split("_");
  if (parts.length < 2) return await next();

  const fromToken = parts[0];
  const toToken = parts.slice(1).join("_");

  if (!fromToken || !toToken) {
    return await ctx.answerCallbackQuery("❌ Invalid swap pair");
  }

  console.log(`🔔 Swap pair selected: ${fromToken} → ${toToken}`);

  try {
    if (toToken === "OTHER") {
      // Handle custom token input
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      const response = [
        `🔍 <b>CUSTOM TOKEN</b>`,
        "",
        `Swapping FROM: <b>${fromToken}</b>`,
        "",
        `Please send a message with the token mint address or symbol.`,
        "",
        `<b>Examples:</b>`,
        `• <code>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code> (USDC)`,
        `• <code>BONK</code>`,
        "",
        INPUT_TIMEOUT_HINT,
      ];

      await respondWithMenu(ctx, {
        text: response.join("\n"),
        parseMode: "HTML",
        keyboard: new InlineKeyboard().text("❌ Cancel", "cmd_swap").row(),
      });

      setUserState(userId, {
        type: "swap_to_token",
        fromToken: fromToken,
        messageId: ctx.callbackQuery?.message?.message_id,
        chatId: ctx.chat?.id,
      });

      await ctx.answerCallbackQuery("Send token mint or symbol");
      return;
    }

    // Show amount selection for the swap pair
    await showSwapAmountSelection(ctx, fromToken, toToken);
    await ctx.answerCallbackQuery(`${fromToken} → ${toToken}`);
  } catch (error) {
    console.error("Error in swap_to selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing swap pair");
  }
});

// Handle swap amount selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("swap_amount_")) {
    return await next();
  }

  const parts = callbackData.replace("swap_amount_", "").split("_");
  if (parts.length < 3) return await next();

  const fromToken = parts[0];
  const toToken = parts[1];
  const amount = parts.slice(2).join("_");

  if (!fromToken || !toToken || !amount) {
    return await ctx.answerCallbackQuery("❌ Invalid swap parameters");
  }

  console.log(`🔔 Swap amount selected: ${amount} ${fromToken} → ${toToken}`);

  try {
    if (amount === "CUSTOM") {
      // Handle custom amount input
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      const response = [
        `✏️ <b>CUSTOM AMOUNT</b>`,
        "",
        `<b>Swap:</b> ${fromToken} → ${toToken}`,
        "",
        `Please send a message with the amount of ${fromToken} to swap.`,
        "",
        `<b>Examples:</b>`,
        `• <code>10</code>`,
        `• <code>0.5</code>`,
        `• <code>max</code> (all balance)`,
        "",
        INPUT_TIMEOUT_HINT,
      ];

      await respondWithMenu(ctx, {
        text: response.join("\n"),
        parseMode: "HTML",
        keyboard: new InlineKeyboard()
          .text("❌ Cancel", `swap_to_${fromToken}_${toToken}`)
          .row(),
      });

      setUserState(userId, {
        type: "swap_custom_amount",
        fromToken: fromToken,
        toToken: toToken,
        messageId: ctx.callbackQuery?.message?.message_id,
        chatId: ctx.chat?.id,
      });

      await ctx.answerCallbackQuery("Send amount as message");
      return;
    }

    // Get quote and show confirmation
    const telegramId = getTelegramId(ctx);
    await showSwapQuoteAndConfirmation(
      ctx,
      fromToken,
      toToken,
      amount,
      telegramId
    );
    await ctx.answerCallbackQuery("Getting swap quote...");
  } catch (error) {
    console.error("Error in swap amount selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing swap amount");
  }
});

/**
 * Show swap amount selection interface
 */
const showSwapAmountSelection = async (
  ctx: any,
  fromToken: string,
  toToken: string
) => {
  const telegramId = getTelegramId(ctx);

  // Get balance for the FROM token
  const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

  let balanceDecimal = 0;
  let formattedBalance = "0";

  if (fromToken === "SOL") {
    balanceDecimal = solBalance / LAMPORTS_PER_SOL;
    formattedBalance = wallet.formatSolBalance(solBalance);
  } else {
    const tokenBalance = tokenBalances.find((t) => t.ticker === fromToken);
    if (tokenBalance) {
      balanceDecimal =
        tokenBalance.balance / Math.pow(10, tokenBalance.decimals);
      formattedBalance = wallet.formatTokenBalance(
        tokenBalance.balance,
        tokenBalance.decimals
      );
    }
  }

  const response = [
    `💱 <b>SWAP AMOUNT</b>`,
    "",
    `<b>From:</b> ${fromToken} (${formattedBalance})`,
    `<b>To:</b> ${toToken}`,
    "",
    `<b>Select amount to swap:</b>`,
  ];

  const canTrade = balanceDecimal > 0;
  let extraRows: QuickAmountButton[][] | undefined;

  if (canTrade) {
    const maxBalance = balanceDecimal;
    extraRows = [];

    if (maxBalance >= 100) {
      extraRows.push(
        [
          { label: "10", value: "10" },
          { label: "50", value: "50" },
        ],
        [
          { label: "100", value: "100" },
        ]
      );
    } else if (maxBalance >= 10) {
      extraRows.push(
        [
          { label: "1", value: "1" },
          { label: "5", value: "5" },
        ],
        [
          { label: "10", value: "10" },
        ]
      );
    } else {
      extraRows.push(
        [
          { label: "0.1", value: "0.1" },
          { label: "0.5", value: "0.5" },
        ],
        [
          { label: "1", value: "1" },
        ]
      );
    }
  }

  const keyboard = buildQuickAmountKeyboard({
    baseCallback: (value) => `swap_amount_${fromToken}_${toToken}_${value}`,
    percentages: ["25%", "50%", "75%", "MAX"],
    extraRows,
    backCallback: `swap_to_${fromToken}_${toToken}`,
    showQuickRows: canTrade,
    insufficientLabel: "❌ Insufficient balance",
  });

  await respondWithMenu(ctx, {
    text: response.join("\n"),
    keyboard,
  });
};

/**
 * Show swap quote and confirmation
 */
const showSwapQuoteAndConfirmation = async (
  ctx: any,
  fromToken: string,
  toToken: string,
  amount: string,
  telegramId?: bigint
) => {
  const userId = telegramId || getTelegramId(ctx);

  try {
    await prepareTokenTradeQuoteRunner({
      ctx,
      telegramId: userId,
      amountInput: amount,
      kind: "swap",
      inputFactory: async ({ tokenBalances }) => {
        const inputMint = tokenManager.resolveMintForTicker(fromToken);
        if (!inputMint) {
          throw new Error(`Unsupported token pair: ${fromToken} → ${toToken}`);
        }

        const balanceEntry =
          fromToken === "SOL"
            ? undefined
            : tokenBalances.find((t) => t.ticker === fromToken);
        const decimals =
          fromToken === "SOL"
            ? 9
            : balanceEntry?.decimals ??
              (await wallet.getTokenMetadata(inputMint)).decimals;

        return {
          ticker: fromToken,
          mint: inputMint,
          decimals,
          tokenBalance: balanceEntry
            ? { balance: balanceEntry.balance, decimals: balanceEntry.decimals }
            : undefined,
          applySolFeeBuffer: fromToken === "SOL",
        };
      },
      outputFactory: async () => {
        const outputMint = tokenManager.resolveMintForTicker(toToken);
        if (!outputMint) {
          throw new Error(`Unsupported token pair: ${fromToken} → ${toToken}`);
        }
        const decimals =
          toToken === "SOL"
            ? 9
            : (await wallet.getTokenMetadata(outputMint)).decimals;

        return {
          ticker: toToken,
          mint: outputMint,
          decimals,
        };
      },
      spinnerText: ({ displayAmount }) =>
        `🔄 <b>GETTING QUOTE</b>\n\n${displayAmount} ${fromToken} → ${toToken}\n\n<i>Please wait...</i>`,
      cacheQuote: (txId, quote, context) => {
        storePendingTransaction(txId, {
          type: "swap",
          fromToken,
          toToken,
          amount: context.displayAmount,
          rawAmount: context.rawAmount.toString(),
          inputDecimals: context.input.decimals,
          outputDecimals: context.output.decimals,
          userId: userId.toString(),
          quote,
        });
      },
      buildConfirmationKeyboard: (txId) =>
        createTradeConfirmKeyboard({
          confirmLabel: "✅ Confirm Swap",
          confirmCallback: `confirm_swap_${txId}`,
          cancelLabel: "❌ Cancel",
          cancelCallback: `swap_to_${fromToken}_${toToken}`,
        }),
      onError: async (error) => {
        const { text, keyboard } = renderTradeQuoteError("swap", {
          error,
          retryCallback: `swap_to_${fromToken}_${toToken}`,
          fromToken,
          toToken,
        });
        await respondWithMenu(ctx, { text, keyboard });
      },
      quoteErrorMessage: `Cannot get quote for ${fromToken} → ${toToken}`,
    });
  } catch (error) {
    console.error("Error getting swap quote:", error);
    const { text, keyboard } = renderTradeQuoteError("swap", {
      error,
      retryCallback: `swap_to_${fromToken}_${toToken}`,
      fromToken,
      toToken,
    });
    await respondWithMenu(ctx, { text, keyboard });
  }
};

// ================================
// TRADE HELPER FUNCTIONS
// ================================

type ShowTradeQuoteParams = {
  ctx: Context;
  kind: Extract<TradeKind, "buy" | "sell">;
  amount: string;
  inputFactory: PrepareTokenTradeQuoteParams["inputFactory"];
  outputFactory: PrepareTokenTradeQuoteParams["outputFactory"];
  spinnerText: PrepareTokenTradeQuoteParams["spinnerText"];
  summaryExtras?: PrepareTokenTradeQuoteParams["summaryExtras"];
  cacheEntryFactory: TradeCacheEntryFactory;
  retryCallback: string;
  confirmationBuilder: (txId: string) => {
    confirmLabel: string;
    confirmCallback: string;
    cancelLabel: string;
    cancelCallback: string;
  };
  slippageConfig?: TradeSlippageConfig;
  quoteErrorMessage?: string;
  quoteOptions?: PrepareTokenTradeQuoteParams["quoteOptions"];
  telegramId?: bigint;
  onError?: (error: unknown) => Promise<void> | void;
};

const showTradeQuoteAndConfirmation = async ({
  ctx,
  kind,
  amount,
  inputFactory,
  outputFactory,
  spinnerText,
  summaryExtras,
  cacheEntryFactory,
  retryCallback,
  confirmationBuilder,
  slippageConfig,
  quoteErrorMessage,
  quoteOptions,
  telegramId: telegramIdOverride,
  onError,
}: ShowTradeQuoteParams) => {
  const telegramId = telegramIdOverride ?? getTelegramId(ctx);

  const handleError = async (error: unknown) => {
    if (onError) {
      await onError(error);
      return;
    }

    const { text, keyboard } = renderTradeQuoteError(kind, {
      error,
      retryCallback,
    });
    await respondWithMenu(ctx, { text, keyboard });
  };

  try {
    await prepareTokenTradeQuoteRunner({
      ctx,
      telegramId,
      amountInput: amount,
      kind,
      inputFactory,
      outputFactory,
      spinnerText,
      summaryExtras,
      cacheQuote: (txId, quote, context) => {
        const quoteWithDecimals: SwapQuoteWithDecimals = {
          ...quote,
          inputDecimals: context.input.decimals,
          outputDecimals: context.output.decimals,
        };

        const result = cacheEntryFactory({
          txId,
          quote: quoteWithDecimals,
          context,
          telegramId,
        });

        transactionCache.setWithTTL(txId, result.entry);
        if (result.storePending) {
          storePendingTransaction(txId, result.entry);
        }
      },
      buildConfirmationKeyboard: (txId) => {
        const confirmation = confirmationBuilder(txId);

        return buildTradeConfirmationKeyboard({
          ...confirmation,
          slippageConfig: slippageConfig
            ? { ...slippageConfig, kind, txId }
            : undefined,
        });
      },
      onError: handleError,
      quoteOptions,
      quoteErrorMessage,
    });
  } catch (error) {
    await handleError(error);
  }
};

// ================================
// BUY HELPER FUNCTIONS
// ================================

const runBuyTradeQuote = async ({
  ctx,
  paymentToken,
  targetToken,
  amount,
  contractAddress,
  telegramIdOverride,
}: {
  ctx: any;
  paymentToken: string;
  targetToken: string;
  amount: string;
  contractAddress?: string;
  telegramIdOverride?: bigint;
}) =>
  showTradeQuoteAndConfirmation({
    ctx,
    kind: "buy",
    amount,
    telegramId: telegramIdOverride,
    inputFactory: async ({ tokenBalances }) => {
      const inputMint = tokenManager.resolveMintForTicker(paymentToken);
      if (!inputMint) {
        throw new Error(`Unsupported payment token: ${paymentToken}`);
      }

      const balanceEntry =
        paymentToken === "SOL"
          ? undefined
          : tokenBalances.find((t) => t.ticker === paymentToken);
      const decimals =
        paymentToken === "SOL"
          ? 9
          : balanceEntry?.decimals ??
            (await wallet.getTokenMetadata(inputMint)).decimals;

      return {
        ticker: paymentToken,
        mint: inputMint,
        decimals,
        tokenBalance: balanceEntry
          ? { balance: balanceEntry.balance, decimals: balanceEntry.decimals }
          : undefined,
      };
    },
    outputFactory: async () => {
      const resolvedMint =
        contractAddress || tokenManager.resolveMintForTicker(targetToken);
      if (!resolvedMint) {
        throw new Error(`Token not found: ${targetToken}`);
      }

      const decimals = contractAddress
        ? (await wallet.getTokenMetadata(resolvedMint)).decimals
        : 9;

      return {
        ticker: targetToken,
        mint: resolvedMint,
        decimals,
      };
    },
    spinnerText: ({ displayAmount }) =>
      `🔄 <b>GETTING QUOTE</b>\n\nBuy ${targetToken} with ${displayAmount} ${paymentToken}\n\n<i>Detecting best provider...</i>`,
    summaryExtras: (context) => ({
      contractAddress: contractAddress ?? context.output.mint,
    }),
    cacheEntryFactory: ({ quote, context, telegramId }) => {
      const entry: BuyTransactionCacheEntry = {
        kind: "buy",
        type: "swap",
        fromToken: paymentToken,
        toToken: targetToken,
        amount: context.displayAmount,
        rawAmount: context.rawAmount.toString(),
        userId: telegramId.toString(),
        quote,
        contractAddress: contractAddress ?? context.output.mint,
        inputDecimals: context.input.decimals,
        outputDecimals: context.output.decimals,
      };

      return { entry, storePending: true };
    },
    retryCallback: "cmd_buy",
    confirmationBuilder: (txId) => ({
      confirmLabel: TRADE_CONFIRMATION_CONFIG.buy.confirmLabel,
      confirmCallback: TRADE_CONFIRMATION_CONFIG.buy.confirmCallback(txId),
      cancelLabel: TRADE_CONFIRMATION_CONFIG.buy.cancelLabel,
      cancelCallback: TRADE_CONFIRMATION_CONFIG.buy.cancelCallback,
    }),
    slippageConfig: DEFAULT_TRADE_SLIPPAGE_CONFIG,
    quoteErrorMessage: `Cannot get quote for buying ${targetToken}`,
    onError: async (error) => {
      const { text, keyboard } = renderTradeQuoteError("buy", {
        error,
        retryCallback: "cmd_buy",
        fromToken: paymentToken,
        toToken: targetToken,
      });
      await respondWithMenu(ctx, { text, keyboard });
    },
  });

/**
 * Show buy amount selection interface
 */
const buildBuyAmountSelectionUI = async (
  telegramId: bigint,
  paymentToken: string,
  targetToken: string,
  contractAddress?: string,
  tokenTxId?: string
) => {
  const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

  let balanceDecimal = 0;
  let formattedBalance = "0";

  if (paymentToken === "SOL") {
    balanceDecimal = solBalance / LAMPORTS_PER_SOL;
    formattedBalance = wallet.formatSolBalance(solBalance);
  } else {
    const tokenBalance = tokenBalances.find((t) => t.ticker === paymentToken);
    if (tokenBalance) {
      balanceDecimal =
        tokenBalance.balance / Math.pow(10, tokenBalance.decimals);
      formattedBalance = wallet.formatTokenBalance(
        tokenBalance.balance,
        tokenBalance.decimals
      );
    }
  }

  const response = [
    `🟢 <b>BUY ${targetToken}</b>`,
    "",
    `<b>Paying with:</b> ${paymentToken} (${formattedBalance})`,
    `<b>Target:</b> ${targetToken}`,
  ];

  if (contractAddress) {
    response.push(`<b>Contract:</b> <code>${contractAddress}</code>`);
  }

  response.push("", `<b>How much ${paymentToken} to spend?</b>`);

  const callbackToken = tokenTxId ?? targetToken;
  const keyboard = buildQuickAmountKeyboard({
    baseCallback: (value) => `buy_amount_${paymentToken}_${callbackToken}_${value}`,
    backCallback: "cmd_buy",
    showQuickRows: balanceDecimal > 0.01,
    insufficientLabel: "❌ Insufficient balance",
  });

  return {
    message: response.join("\n"),
    keyboard,
  };
};

const showBuyAmountSelection = async (
  ctx: any,
  paymentToken: string,
  targetToken: string,
  contractAddress?: string,
  tokenTxId?: string
) => {
  const telegramId = getTelegramId(ctx);
  const { message, keyboard } = await buildBuyAmountSelectionUI(
    telegramId,
    paymentToken,
    targetToken,
    contractAddress,
    tokenTxId
  );

  await respondWithMenu(ctx, {
    text: message,
    keyboard,
  });
};

/**
 * Fetch and validate token metadata by contract address
 */
const fetchTokenMetadata = async (
  contractAddress: string,
  telegramId?: bigint
) => {
  try {
    // Validate contract address format
    if (contractAddress.length !== 44) {
      throw new Error(
        "Invalid contract address format (must be 44 characters)"
      );
    }

    // Use the same method as wallet balance: check if token exists in wallet
    if (telegramId) {
      console.log("🔍 Checking wallet balances for token metadata...");
      try {
        const { tokenBalances } = await getCachedWalletData(telegramId);
        const existingToken = tokenBalances.find(
          (token) => token.mint === contractAddress
        );

        if (existingToken) {
          console.log("✅ Found token in wallet balance:", existingToken);
          return {
            address: contractAddress,
            symbol: existingToken.ticker,
            name: existingToken.ticker,
            decimals: existingToken.decimals,
            verified: true,
          };
        }
      } catch (walletError) {
        console.log(
          "Wallet balance check failed:",
          (walletError as Error).message
        );
      }
    }

    // Try to get metadata using wallet's metadata function
    try {
      const metadata = await wallet.getTokenMetadata(contractAddress);
      if (
        metadata &&
        typeof metadata === "object" &&
        "symbol" in metadata &&
        metadata.symbol &&
        metadata.symbol !== "UNKNOWN"
      ) {
        return {
          address: contractAddress,
          symbol: (metadata as any).symbol,
          name: (metadata as any).name || (metadata as any).symbol,
          decimals: metadata.decimals || 6,
          verified: true,
        };
      }
    } catch (metadataError) {
      console.log("Wallet metadata failed:", (metadataError as Error).message);
    }

    // Fallback: return truncated address as symbol
    return {
      address: contractAddress,
      symbol: `${contractAddress.slice(0, 4)}...${contractAddress.slice(-4)}`,
      name: "Unknown Token",
      decimals: 6,
      verified: false,
    };
  } catch (error) {
    console.error("Error fetching token metadata:", error);
    throw new Error(
      `Failed to fetch token information: ${(error as Error).message}`
    );
  }
};

type BuyTokenMetadata = Awaited<ReturnType<typeof fetchTokenMetadata>>;

const createTokenLookupId = (): string =>
  Math.random().toString(36).substring(2, 15);

type BuyTokenLookupOptions = {
  ctx: Context;
  userState: any;
  telegramId: bigint;
  paymentToken: string;
  loadingLines: string[];
  fetchTokenInfo: () => Promise<BuyTokenMetadata>;
  retryState: Record<string, unknown> & { type: string };
  errorLines: (error: Error) => string[];
  logContext: string;
};

const handleBuyTokenLookup = async ({
  ctx,
  userState,
  telegramId,
  paymentToken,
  loadingLines,
  fetchTokenInfo,
  retryState,
  errorLines,
  logContext,
}: BuyTokenLookupOptions) => {
  const cancelKeyboard = new InlineKeyboard().text("❌ Cancel", "cmd_buy").row();

  try {
    await respondWithMenu(ctx, {
      text: loadingLines.join("\n"),
      keyboard: cancelKeyboard,
    });

    const tokenInfo = await fetchTokenInfo();

    const tokenTxId = createTokenLookupId();

    transactionCache.setWithTTL(tokenTxId, {
      targetToken: tokenInfo.symbol,
      targetTokenAddress: tokenInfo.address,
      tokenMetadata: tokenInfo,
      paymentToken,
    });

    const { message, keyboard } = await buildBuyAmountSelectionUI(
      telegramId,
      paymentToken,
      tokenInfo.symbol,
      tokenInfo.address,
      tokenTxId
    );

    await respondWithMenu(ctx, {
      text: message,
      keyboard,
    });

    getUserState(ctx.from!.id.toString(), true);
  } catch (error) {
    console.error(logContext, error);

    const messageLines = errorLines(
      error instanceof Error ? error : new Error(String(error))
    );

    await respondWithMenu(ctx, {
      text: messageLines.join("\n"),
      keyboard: cancelKeyboard,
    });

    setUserState(ctx.from!.id.toString(), {
      ...retryState,
      messageId: userState.messageId,
      chatId: userState.chatId,
    });
  }
};


// ================================
// ERROR HANDLING & BOT STARTUP
// ================================

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

// ================================
// MESSAGE HANDLER FOR USER INPUT
// ================================

// Handle text messages when user is in input state
bot.on("message:text", async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  const userState = getUserState(userId, false); // Get state but DON'T clear it yet

  if (!userState) {
    return await next(); // Not waiting for input, continue to other handlers
  }

  // Only process input in the same chat where the state was created
  if (userState.chatId && ctx.chat?.id !== userState.chatId) {
    return await next();
  }

  const userMessage = ctx.message.text.trim();

  try {

    if (userState.type === "send_custom_amount") {
      await handleCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "send_address") {
      await handleAddressInput(ctx, userState, userMessage);
    } else if (userState.type === "wrap_custom_amount") {
      await handleWrapAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "swap_to_token") {
      await handleSwapToTokenInput(ctx, userState, userMessage);
    } else if (userState.type === "swap_custom_amount") {
      await handleSwapCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "buy_contract_address") {
      await handleBuyContractAddressInput(ctx, userState, userMessage);
    } else if (userState.type === "buy_token_symbol") {
      await handleBuyTokenSymbolInput(ctx, userState, userMessage);
    } else if (userState.type === "buy_menu_idle") {
      const trimmed = userMessage.trim();
      const userIdStr = ctx.from.id.toString();
      const isContractLike = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);

      if (isContractLike) {
        const contractState = {
          type: "buy_contract_address",
          fromToken: userState.paymentToken ?? "SOL",
          messageId: userState.messageId,
          chatId: userState.chatId,
        };
        setUserState(userIdStr, contractState);
        await handleBuyContractAddressInput(ctx, contractState, trimmed);
        getUserState(userIdStr, true);
      } else if (/^[a-z0-9]{1,10}$/i.test(trimmed)) {
        const symbolState = {
          type: "buy_token_symbol",
          messageId: userState.messageId,
          chatId: userState.chatId,
        };
        setUserState(userIdStr, symbolState);
        await handleBuyTokenSymbolInput(ctx, symbolState, trimmed);
        getUserState(userIdStr, true);
      } else {
        setUserState(userIdStr, {
          type: "buy_menu_idle",
          paymentToken: userState.paymentToken ?? "SOL",
          chatId: userState.chatId,
          messageId: userState.messageId,
        });

        await ctx.reply(
          [
            "❔ <b>Unrecognized Input</b>",
            "",
            "Send a token ticker (e.g. <code>TIMBA</code>) or paste the contract address.",
            "",
            `<b>Contract format:</b>\n${CONTRACT_EXAMPLE_LINES.join("\n")}`,
          ].join("\n"),
          { parse_mode: "HTML" }
        );
        return;
      }

      return;
    } else if (userState.type === "buy_custom_amount") {
      await handleBuyCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "sell_custom_amount") {
      await handleSellCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "trade_custom_slippage") {
      await handleTradeCustomSlippageInput(ctx, userState, userMessage);
    }

    // Clear state after successful processing
    getUserState(userId, true);
  } catch (error) {
    // Clear state even on error to prevent stuck states
    getUserState(userId, true);
    console.error("Error handling user input:", error);

    // Try to update the original message with error
    try {
      await ctx.editMessageText(
        "❌ <b>Error processing input</b>\n\nPlease try again.",
        {
          parse_mode: "HTML",
          reply_markup: createBackToWalletKeyboard(),
        }
      );
    } catch (editError) {
      await ctx.reply("❌ <b>Error processing input</b>\n\nPlease try again.", {
        parse_mode: "HTML",
        reply_markup: createBackToWalletKeyboard(),
      });
    }
  }
});

/**
 * Handle custom amount input for send
 */
const handleCustomAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const token = userState.token;
  const telegramId = getTelegramId(ctx);
  const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

  const isSol = token === "SOL";
  const selectedToken = !isSol
    ? tokenBalances.find((t) => t.ticker === token)
    : undefined;

  if (!isSol && !selectedToken) {
    throw new Error(`Token ${token} not found in wallet`);
  }

  const spend = resolveSpendAmount({
    amount,
    assetTicker: token,
    inputDecimals: isSol ? 9 : selectedToken!.decimals,
    solBalance,
    tokenBalance: selectedToken
      ? { balance: selectedToken.balance, decimals: selectedToken.decimals }
      : undefined,
    formatSol: (lamports) => wallet.formatSolBalance(lamports),
    formatToken: (value, decimals) => wallet.formatTokenBalance(value, decimals),
    applySolFeeBuffer: true,
  });

  const normalized = amount.trim();
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

  console.log(`💰 Custom amount received: ${displayLabel}`);

  const response = [
    `📤 <b>SEND ${escapeHtml(displayLabel)}</b>`,
    "",
    `<b>Step 2:</b> Enter destination address`,
    "",
    `Please send a message with the Solana wallet address.`,
    "",
    `<b>Format:</b> Public key (44 characters)`,
    `<b>Example:</b> <code>Ge6tnNaEY6kEznY795RSUHS5Wbm3DxMMcroLZcU3dB1Z</code>`,
    "",
    INPUT_TIMEOUT_HINT,
  ];

  await ctx.api.editMessageText(
    ctx.chat.id,
    userState.messageId,
    response.join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("❌ Cancel", `send_select_${token}`)
        .row(),
    }
  );

  setUserState(ctx.from.id.toString(), {
    type: "send_address",
    token,
    amount: storedAmount,
    amountDisplay: displayLabel,
    messageId: userState.messageId,
    chatId: ctx.chat?.id,
  });
};

/**
 * Handle wallet address input for send
 */
const handleAddressInput = async (
  ctx: any,
  userState: any,
  address: string
) => {
  const token = userState.token;
  const amount = userState.amount;
  const amountDisplay =
    userState.amountDisplay ??
    (amount === "max" ? `MAX ${token}` : `${amount} ${token}`);

  // Basic Solana address validation (should be ~44 characters)
  if (address.length < 30 || address.length > 50) {
    throw new Error("Invalid wallet address format");
  }

  console.log(`📍 Address received for ${amountDisplay}: ${address}`);

  // Generate unique transaction ID and store transaction details
  const txId = generateTransactionId();
  storePendingTransaction(txId, {
    type: "send",
    token: token,
    amount: amount,
    address: address,
    userId: ctx.from.id.toString(),
    amountDisplay,
  });

  const response = [
    `✅ <b>SEND CONFIRMATION</b>`,
    "",
    `<b>Amount:</b> ${escapeHtml(amountDisplay)}`,
    `<b>To:</b> <code>${escapeHtml(address)}</code>`,
    "",
    `⚠️ <b>Please confirm this transaction</b>`,
    `This action cannot be undone.`,
  ];

  await ctx.api.editMessageText(
    ctx.chat.id,
    userState.messageId,
    response.join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ Confirm Send", `confirm_send_${txId}`)
        .row()
        .text("❌ Cancel", `send_select_${token}`)
        .row(),
    }
  );
};

/**
 * Handle wrap amount input
 */
const handleWrapAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const numAmount = parseFloat(amount);

  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error("Invalid amount format");
  }

  console.log(`🔧 Wrap amount received: ${amount} SOL`);

  const response = [
    `✅ <b>WRAP CONFIRMATION</b>`,
    "",
    `<b>Amount:</b> ${amount} SOL → WSOL`,
    "",
    `⚠️ <b>Please confirm this transaction</b>`,
    `This will convert ${amount} SOL to ${amount} WSOL.`,
  ];

  await ctx.api.editMessageText(
    ctx.chat.id,
    userState.messageId,
    response.join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: createConfirmWrapKeyboard(amount),
    }
  );
};

/**
 * Handle swap token input (when user sends token mint or symbol)
 */
const handleSwapToTokenInput = async (
  ctx: any,
  userState: any,
  tokenInput: string
) => {
  const fromToken = userState.fromToken;

  console.log(
    `🔍 Token input received for swap from ${fromToken}: ${tokenInput}`
  );

  // For now, treat any input as a valid token
  // TODO: Add proper token validation and mint address resolution
  const toToken = tokenInput.toUpperCase();

  // Show amount selection for the swap pair
  const walletCtx = createMessageEditAdapter(
    ctx,
    userState.messageId,
    userState.chatId ?? ctx.chat?.id
  );

  await showSwapAmountSelection(walletCtx, fromToken, toToken);
};

/**
 * Handle swap custom amount input
 */
const handleSwapCustomAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const fromToken = userState.fromToken;
  const toToken = userState.toToken;
  const telegramId = getTelegramId(ctx);

  const normalizedAmount = amount.trim();

  console.log(
    `💱 Custom swap amount received: ${normalizedAmount} ${fromToken} → ${toToken}`
  );

  // Show quote and confirmation
  const walletCtx = createMessageEditAdapter(
    ctx,
    userState.messageId,
    userState.chatId ?? ctx.chat?.id
  );

  await showSwapQuoteAndConfirmation(
    walletCtx,
    fromToken,
    toToken,
    normalizedAmount,
    telegramId
  );
};

/**
 * Handle BUY contract address input
 */
const handleBuyContractAddressInput = async (
  ctx: any,
  userState: any,
  contractAddress: string
) => {
  const telegramId = getTelegramId(ctx);
  const paymentToken = userState.fromToken;
  if (!paymentToken) {
    throw new Error("Payment token not found in user state");
  }

  console.log(`🔍 Validating contract address: ${contractAddress}`);

  await handleBuyTokenLookup({
    ctx,
    userState,
    telegramId,
    paymentToken,
    loadingLines: [
      "🔍 <b>Fetching Token Information...</b>",
      "",
      `<b>Contract Address:</b>`,
      `<code>${contractAddress}</code>`,
      "",
      "🔄 <i>Please wait while we validate and fetch token metadata...</i>",
    ],
    fetchTokenInfo: async () => {
      if (contractAddress.length < 30 || contractAddress.length > 50) {
        throw new Error("Invalid Solana contract address format");
      }
      const tokenInfo = await fetchTokenMetadata(contractAddress, telegramId);
      if (!tokenInfo) {
        throw new Error(
          "Unable to fetch token metadata. Please check the contract address."
        );
      }
      console.log(`✅ Token found: ${tokenInfo.symbol} (${contractAddress})`);
      return tokenInfo;
    },
    retryState: { type: "buy_contract_address", fromToken: paymentToken },
    errorLines: (error) => [
      "❌ <b>Invalid Contract Address</b>",
      "",
      `<b>Address:</b> <code>${contractAddress}</code>`,
      "",
      `<b>Error:</b> ${error.message}`,
      "",
      "Please enter a valid Solana contract address (SPL Token mint):",
      "",
      `<b>Format:</b> Base58 string (~44 characters)`,
      `<b>Example:</b> <code>So11111111111111111111111111111111111111112</code>`,
      "",
      INPUT_TIMEOUT_HINT,
    ],
    logContext: "Error processing contract address:",
  });
};

/**
 * Handle BUY token symbol input
 */
const handleBuyTokenSymbolInput = async (
  ctx: any,
  userState: any,
  tokenSymbol: string
) => {
  const telegramId = getTelegramId(ctx);
  console.log(`🔍 Searching for token: ${tokenSymbol}`);

  const cleanSymbol = tokenSymbol.trim().toUpperCase();
  if (cleanSymbol.length === 0 || cleanSymbol.length > 10) {
    throw new Error("Token symbol must be 1-10 characters");
  }

  await handleBuyTokenLookup({
    ctx,
    userState,
    telegramId,
    paymentToken: "SOL",
    loadingLines: [
      "🔍 <b>Searching for Token...</b>",
      "",
      `<b>Symbol:</b> ${cleanSymbol}`,
      "",
      "🔄 <i>Looking up token metadata...</i>",
    ],
    fetchTokenInfo: async () => {
      const knownTokens = tokenManager.getAllKnownTokens();
      const knownToken = knownTokens.find(
        (t: any) => t.ticker.toUpperCase() === cleanSymbol
      );

      if (knownToken) {
        const tokenInfo = await fetchTokenMetadata(
          knownToken.token_mint,
          telegramId
        );
        if (tokenInfo) {
          console.log(
            `✅ Token found: ${tokenInfo.symbol} (${tokenInfo.address})`
          );
          return tokenInfo;
        }
      }

      throw new Error(
        `Token "${cleanSymbol}" not found. Try using the contract address instead.`
      );
    },
    retryState: { type: "buy_token_symbol" },
    errorLines: (error) => [
      "❌ <b>Token Not Found</b>",
      "",
      `<b>Symbol:</b> ${tokenSymbol}`,
      "",
      `<b>Error:</b> ${error.message}`,
      "",
      "Please enter a valid token symbol:",
      "",
      `<b>Examples:</b> SOL, USDC, TIMBA`,
      `<b>Or use:</b> Contract address for any token`,
      "",
      INPUT_TIMEOUT_HINT,
    ],
    logContext: "Error searching for token:",
  });
};

/**
 * Handle BUY custom amount input
 */
const handleBuyCustomAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const paymentToken = userState.paymentToken;
  const targetToken = userState.targetToken;
  const contractAddress = userState.contractAddress;
  const telegramId = getTelegramId(ctx);

  console.log(`📝 Custom amount debug:`, {
    amount,
    paymentToken,
    targetToken,
    contractAddress,
  });

  try {
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    const balanceEntry =
      paymentToken === "SOL"
        ? undefined
        : tokenBalances.find((t) => t.ticker === paymentToken);

    const normalized = normalizeCustomTradeAmount({
      amount,
      assetTicker: paymentToken,
      solBalance,
      tokenBalance: balanceEntry
        ? { balance: balanceEntry.balance, decimals: balanceEntry.decimals }
        : undefined,
      decimals: paymentToken === "SOL" ? 9 : balanceEntry?.decimals ?? 0,
    });

    console.log(
      `💰 Custom BUY amount received: ${normalized.displayAmount} ${paymentToken} → ${targetToken}`
    );

    const walletCtx = createMessageEditAdapter(
      ctx,
      userState.messageId,
      userState.chatId ?? ctx.chat?.id
    );

    await runBuyTradeQuote({
      ctx: walletCtx,
      paymentToken,
      targetToken,
      amount: normalized.normalizedAmount,
      contractAddress,
      telegramIdOverride: telegramId,
    });
  } catch (error: any) {
    console.error("Error processing custom buy amount:", error);

    const errorMessage = [
      "❌ <b>Invalid Amount</b>",
      "",
      `<b>Payment Token:</b> ${paymentToken}`,
      `<b>Target Token:</b> ${targetToken}`,
      `<b>Amount:</b> ${amount}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid amount:",
      "",
      `<b>Examples:</b>`,
      `• <code>0.1</code> (spend 0.1 ${paymentToken})`,
      `• <code>5</code> (spend 5 ${paymentToken})`,
      `• <code>50%</code> (spend 50% of balance)`,
      `• <code>max</code> (spend all available ${paymentToken})`,
      "",
      INPUT_TIMEOUT_HINT,
    ];

    await ctx.api.editMessageText(
      ctx.chat.id,
      userState.messageId,
      errorMessage.join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel", "cmd_buy")
          .row(),
      }
    );

    // Keep the same state for retry
    setUserState(ctx.from.id.toString(), {
      type: "buy_custom_amount",
      paymentToken: paymentToken,
      targetToken: targetToken,
      messageId: userState.messageId,
    });
  }
};

export const __test_handleBuyCustomAmountInput = handleBuyCustomAmountInput;

/**
 * Handle SELL custom amount input
 */
const handleSellCustomAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const tokenToSell = userState.tokenToSell;
  const telegramId = getTelegramId(ctx);

  try {
    const { tokenBalances, solBalance } = await getCachedWalletData(telegramId);
    const tokenBalance = tokenBalances.find((t) => t.ticker === tokenToSell);

    const normalized = normalizeCustomTradeAmount({
      amount,
      assetTicker: tokenToSell,
      solBalance,
      tokenBalance: tokenBalance
        ? { balance: tokenBalance.balance, decimals: tokenBalance.decimals }
        : undefined,
      decimals: tokenBalance?.decimals ?? 0,
    });

    console.log(
      `🔴 Custom SELL amount received: ${normalized.displayAmount} ${tokenToSell}`
    );

    const walletCtx = createMessageEditAdapter(
      ctx,
      userState.messageId,
      userState.chatId ?? ctx.chat?.id
    );

    await runSellTradeQuote({
      ctx: walletCtx,
      tokenToSell,
      amount: normalized.normalizedAmount,
      telegramId,
    });
  } catch (error: any) {
    console.error("Error processing custom sell amount:", error);

    const errorMessage = [
      "❌ <b>Invalid Amount</b>",
      "",
      `<b>Token:</b> ${tokenToSell}`,
      `<b>Amount:</b> ${amount}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid amount:",
      "",
      `<b>Examples:</b>`,
      `• <code>100</code> (sell 100 ${tokenToSell})`,
      `• <code>50%</code> (sell 50% of balance)`,
      `• <code>max</code> (sell all ${tokenToSell})`,
      "",
      INPUT_TIMEOUT_HINT,
    ];

    await ctx.api.editMessageText(
      ctx.chat.id,
      userState.messageId,
      errorMessage.join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_sell").row(),
      }
    );

    // Keep the same state for retry
    setUserState(ctx.from.id.toString(), {
      type: "sell_custom_amount",
      tokenToSell: tokenToSell,
      messageId: userState.messageId,
    });
  }
};

// ================================
// SELL HELPER FUNCTIONS
// ================================

const runSellTradeQuote = async ({
  ctx,
  tokenToSell,
  amount,
  telegramId,
}: {
  ctx: any;
  tokenToSell: string;
  amount: string;
  telegramId: bigint;
}) =>
  showTradeQuoteAndConfirmation({
    ctx,
    kind: "sell",
    amount,
    telegramId,
    inputFactory: async ({ tokenBalances }) => {
      const tokenBalance = tokenBalances.find((t) => t.ticker === tokenToSell);

      if (!tokenBalance) {
        throw new Error(`Token ${tokenToSell} not found in wallet`);
      }

      const approvedTokens = tokenManager.getAllApprovedTokensWithMetadata();
      let tokenInfo:
        | { token_mint: string; decimals?: number; token_ticker?: string }
        | undefined = approvedTokens.find(
        (t) => t.token_ticker === tokenToSell && t.token_mint === tokenBalance.mint
      );

      if (!tokenInfo) {
        tokenInfo = approvedTokens.find((t) => t.token_ticker === tokenToSell);
      }

      if (!tokenInfo) {
        tokenInfo = {
          token_mint: tokenBalance.mint,
          token_ticker: tokenBalance.ticker,
          decimals: tokenBalance.decimals,
        };
        console.log(
          `🔍 Using dynamic token info for ${tokenToSell}: mint=${tokenBalance.mint}, decimals=${tokenBalance.decimals}`
        );
      } else {
        console.log(
          `🔍 Using approved token info for ${tokenToSell}: mint=${tokenInfo.token_mint}, decimals=${tokenInfo.decimals}`
        );
      }

      if (!tokenInfo) {
        throw new Error(`Unable to resolve metadata for ${tokenToSell}`);
      }

      const sellDecimals = tokenInfo.decimals ?? tokenBalance.decimals;
      const balanceRaw = Math.floor(tokenBalance.balance);

      return {
        ticker: tokenToSell,
        mint: tokenInfo.token_mint ?? tokenBalance.mint,
        decimals: sellDecimals,
        tokenBalance: { balance: balanceRaw, decimals: sellDecimals },
        applySolFeeBuffer: false,
        metadata: { tokenInfo, balanceRaw },
      };
    },
    outputFactory: async () => ({
      ticker: "SOL",
      mint: WSOL_MINT,
      decimals: 9,
    }),
    spinnerText: ({ displayAmount }) =>
      `🔄 <b>GETTING SELL QUOTE</b>\n\n${displayAmount} ${tokenToSell} → SOL\n\n<i>Finding best price...</i>`,
    summaryExtras: (context) => ({
      contractAddress:
        ((context.input.metadata as { tokenInfo?: { token_mint?: string } })
          ?.tokenInfo?.token_mint ?? context.input.mint),
    }),
    cacheEntryFactory: ({ quote, context }) => {
      const tokenInfo = (context.input.metadata as {
        tokenInfo?: { token_mint: string; decimals?: number };
      })?.tokenInfo;

      const entry: SellTransactionCacheEntry = {
        kind: "sell",
        fromToken: tokenToSell,
        toToken: "SOL",
        amount: context.displayAmount,
        rawAmount: context.rawAmount.toString(),
        fromTokenInfo: {
          token_mint: tokenInfo?.token_mint ?? context.input.mint,
          decimals: context.input.decimals,
        },
        toTokenInfo: {
          token_mint: WSOL_MINT,
          decimals: context.output.decimals,
        },
        quote,
        userKeypair: wallet.getKeyPair(telegramId),
      };

      return { entry };
    },
    retryCallback: "cmd_sell",
    confirmationBuilder: (txId) => ({
      confirmLabel: TRADE_CONFIRMATION_CONFIG.sell.confirmLabel,
      confirmCallback: TRADE_CONFIRMATION_CONFIG.sell.confirmCallback(txId),
      cancelLabel: TRADE_CONFIRMATION_CONFIG.sell.cancelLabel,
      cancelCallback: TRADE_CONFIRMATION_CONFIG.sell.cancelCallback,
    }),
    slippageConfig: DEFAULT_TRADE_SLIPPAGE_CONFIG,
    quoteErrorMessage: `Cannot get quote for selling ${tokenToSell}`,
    onError: async (error) => {
      const { text, keyboard } = renderTradeQuoteError("sell", {
        error,
        retryCallback: "cmd_sell",
        fromToken: tokenToSell,
        amountLabel: amount,
      });
      await respondWithMenu(ctx, { text, keyboard });
    },
    quoteOptions: { slippageBps: 100 },
  });

const regenerateTradeQuoteWithSlippage = async (
  ctx: any,
  {
    txId,
    tradeKind,
    slippage,
  }: {
    txId: string;
    tradeKind: Extract<TradeKind, "buy" | "sell">;
    slippage?: number;
  }
) => {
  const tradeResult = getTradeTransactionCacheEntry(txId);
  const tradeData = tradeResult?.entry;

  if (!tradeData || tradeData.kind !== tradeKind) {
    throw new Error("Transaction expired");
  }

  if (slippage !== undefined) {
    tradeData.quote.slippage = slippage;
    transactionCache.setWithTTL(txId, tradeData);
    if (tradeResult?.source === "pending") {
      storePendingTransaction(txId, tradeData);
    }
  }

  const confirmation = TRADE_CONFIRMATION_CONFIG[tradeKind];

  const summary =
    tradeKind === "buy"
      ? (() => {
          const buyData = tradeData as BuyTransactionCacheEntry;
          return formatTradeConfirmationSummary({
            kind: "buy",
            payToken: buyData.fromToken,
            payDisplay: buyData.amount,
            payRawAmount: Number(buyData.rawAmount ?? 0),
            payDecimals:
              buyData.inputDecimals ?? (buyData.fromToken === "SOL" ? 9 : 0),
            receiveToken: buyData.toToken,
            receiveDecimals: buyData.outputDecimals ?? 6,
            quote: buyData.quote,
            contractAddress: buyData.contractAddress,
          });
        })()
      : (() => {
          const sellData = tradeData as SellTransactionCacheEntry;
          return formatTradeConfirmationSummary({
            kind: "sell",
            payToken: sellData.fromToken,
            payDisplay: sellData.amount,
            payRawAmount: Number(sellData.rawAmount ?? 0),
            payDecimals: sellData.fromTokenInfo.decimals,
            receiveToken: sellData.toToken,
            receiveDecimals: sellData.toTokenInfo.decimals,
            quote: sellData.quote,
            contractAddress: sellData.fromTokenInfo.token_mint,
          });
        })();

  const keyboard = buildTradeConfirmationKeyboard({
    confirmLabel: confirmation.confirmLabel,
    confirmCallback: confirmation.confirmCallback(txId),
    cancelLabel: confirmation.cancelLabel,
    cancelCallback: confirmation.cancelCallback,
    slippageConfig: {
      ...DEFAULT_TRADE_SLIPPAGE_CONFIG,
      kind: tradeKind,
      txId,
    },
  });

  await respondWithMenu(ctx, {
    text: summary.message,
    keyboard,
  });
};

const handleTradeCustomSlippageInput = async (
  ctx: any,
  userState: any,
  slippageInput: string
) => {
  const txId: string | undefined = userState.txId;
  const tradeKind: Extract<TradeKind, "buy" | "sell"> | undefined =
    userState.tradeKind;

  if (!txId || (tradeKind !== "buy" && tradeKind !== "sell")) {
    throw new Error("Invalid trade slippage context");
  }

  console.log(
    `⚙️ Custom slippage input: ${slippageInput} for ${tradeKind} txId: ${txId}`
  );

  try {
    const slippage = parseFloat(slippageInput);
    if (
      Number.isNaN(slippage) ||
      slippage < TRADE_SLIPPAGE_RANGE.min ||
      slippage > TRADE_SLIPPAGE_RANGE.max
    ) {
      throw new Error(
        `Slippage must be between ${TRADE_SLIPPAGE_RANGE.min}% and ${TRADE_SLIPPAGE_RANGE.max}%`
      );
    }

    const walletCtx = createMessageEditAdapter(
      ctx,
      userState.messageId,
      userState.chatId ?? ctx.chat?.id
    );

    await regenerateTradeQuoteWithSlippage(walletCtx, {
      txId,
      tradeKind,
      slippage,
    });
  } catch (error: any) {
    console.error("Error processing custom slippage:", error);

    const errorMessage = [
      "❌ <b>Invalid Slippage</b>",
      "",
      `<b>Input:</b> ${slippageInput}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid slippage percentage:",
      "",
      `<b>Examples:</b>`,
      `• <code>0.5</code> (0.5% slippage)`,
      `• <code>1</code> (1% slippage)`,
      `• <code>2.5</code> (2.5% slippage)`,
      "",
      `<b>Range:</b> ${TRADE_SLIPPAGE_RANGE.min}% - ${TRADE_SLIPPAGE_RANGE.max}%`,
      INPUT_TIMEOUT_HINT,
    ];

    await ctx.api.editMessageText(
      ctx.chat.id,
      userState.messageId,
      errorMessage.join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text(
            "❌ Cancel",
            `trade_slip_back_${tradeKind}_${txId}`
          )
          .row(),
      }
    );

    setUserState(ctx.from.id.toString(), {
      type: "trade_custom_slippage",
      txId,
      tradeKind,
      messageId: userState.messageId,
    });
  }
};

/**
 * Show sell amount selection for a specific token
 */
const showSellAmountSelection = async (ctx: any, tokenToSell: string) => {
  const telegramId = getTelegramId(ctx);

  // Get balance for the token being sold
  const { tokenBalances } = await getCachedWalletData(telegramId);
  const tokenBalance = tokenBalances.find((t) => t.ticker === tokenToSell);

  if (!tokenBalance) {
    throw new Error(`Token ${tokenToSell} not found in wallet`);
  }

  const formattedBalance = wallet.formatTokenBalance(
    tokenBalance.balance,
    tokenBalance.decimals
  );

  const response = [
    `🔴 <b>SELL ${tokenToSell}</b>`,
    "",
    `<b>Available:</b> ${formattedBalance} ${tokenToSell}`,
    "",
    `<b>Select amount to sell:</b>`,
    `<i>Use a quick percentage or enter a custom amount.</i>`,
  ];

  const keyboard = buildQuickAmountKeyboard({
    baseCallback: (value) => `sell_amount_${tokenToSell}_${value}`,
    backCallback: "cmd_sell",
  });

  await respondWithMenu(ctx, {
    text: response.join("\n"),
    keyboard,
  });
};


// Start the bot and setup Anchor (skip during tests)
if (process.env.NODE_ENV !== "test") {
setupAnchor()
  .then(async () => {
    console.log("Starting bot...");

    // Reload game message mappings from database
    await gameManager.reloadGameMessages();
    console.log(`Reloaded game message mappings from database`);


    // Set up global event listener for GameCompleted events
    console.log("Setting up GameCompleted event listener...");
    program.addEventListener(
      "gameCompleted",
      async (
        event: GameCompletedEvent,
        _slot: number,
        signature?: string
      ) => {
        try {
          const gameAddress = event.gameKey.toString();
          const winnerAddress = event.winner.toString();

          console.log(
            `🎉 GameCompleted event received for game: ${gameAddress}`
          );
          if (signature) {
            console.log(`🔗 Completion signature: ${signature}`);
          }

          // Process game completion with total pot from event
          const totalPot = Number(event.winnerAmount);
          await processGameCompletion(
            gameAddress,
            winnerAddress,
            totalPot,
            signature
          );

          console.log(
            `✅ Successfully processed GameCompleted event for game ${gameAddress}`
          );
        } catch (error) {
          console.error("Error processing GameCompleted event:", error);
        }
      }
    );

    console.log("GameCompleted event listener set up successfully");

    // Set up PlayerJoined event listener to track lastSlot for winner calculation
    console.log("Setting up PlayerJoined event listener...");
    program.addEventListener(
      "playerJoined",
      async (event: PlayerJoinedEvent) => {
        await handlePlayerEvent(event, "PlayerJoined", "👤", "joined");
      }
    );

    // Set up PlayerUnjoined event listener to track lastSlot for winner calculation
    console.log("Setting up PlayerUnjoined event listener...");
    program.addEventListener(
      "playerUnjoined",
      async (event: PlayerUnjoinedEvent) => {
        await handlePlayerEvent(event, "PlayerUnjoined", "👤", "left");
      }
    );

    console.log("Player event listeners set up successfully");

    /**
     * Process expired game with cancellation
     */
    const processExpiredGame = async (game: any): Promise<void> => {
      let gamePda: PublicKey;
      try {
        gamePda = new PublicKey(game.game_address);
      } catch (error) {
        console.error(`❌ Invalid game address in processExpiredGame: ${game.game_address}`);
        return;
      }
      const gameAccount = await program.account.game.fetch(gamePda);

      console.log(
        `Processing expired game ${game.game_address} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`
      );

      const result = await gameManager.handleExpiredGame(gamePda, gameAccount);
      if (result) {
        console.log(
          `✅ Successfully processed expired game ${game.game_address}`
        );
        gameDb.completeGame(game.game_address, "cancelled", Date.now());
        await updateGameMessageSafely(
          game.game_address,
          game,
          "Completed",
          "cancelled"
        );
      } else {
        console.error(`⚠️ Failed to process expired game ${game.game_address}`);
      }
    };

    /**
     * Check if game is expired
     */
    const isGameExpired = async (gameAccount: any): Promise<boolean> => {
      const blockTime = await wallet.getBlockchainTime();
      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      return blockTime > expiresAt + GAME_EXPIRATION_BUFFER_TIME;
    };

    // Start periodic check for expired games
    setInterval(async () => {
      try {
        const allGames = gameDb.getAllGames();
        for (const game of allGames) {
          if (game.status === "completed") continue;

          try {
            // Validate game address before creating PublicKey
            if (!game.game_address) {
              console.log(`🗑️ Skipping game with null address`);
              continue;
            }
            // Skip placeholder/null address and clean it up
            if (game.game_address === DEFAULT_NULL_ADDRESS) {
              console.log(`🗑️ Skipping placeholder game address ${game.game_address}`);
              await cleanupOrphanedGame(game.game_address);
              continue;
            }

            let gamePda: PublicKey;
            try {
              gamePda = new PublicKey(game.game_address);
            } catch (pkError) {
              console.log(`🗑️ Skipping game with invalid address format: ${game.game_address}`);
              continue;
            }
            const gameAccount = await program.account.game.fetch(gamePda);

            if (await isGameExpired(gameAccount)) {
              await processExpiredGame(game);
            }
          } catch (error: any) {
            const msg = (error as Error).message || "";
            if (msg.includes("Account does not exist") || msg.includes("Invalid account discriminator")) {
              await cleanupOrphanedGame(game.game_address);
            } else {
              console.error(
                `Error processing game ${game.game_address}:`,
                error
              );
            }
          }
        }
      } catch (error) {
        console.error("Error in periodic game check:", error);
      }
    }, EXPIRED_GAMES_CHECK_INTERVAL_MS);

    // Start the bot with concurrent processing
    console.log("Starting bot with concurrent processing...");
    const handle = run(bot, {
      runner: {
        fetch: {
          // Only handle updates we actually process
          allowed_updates: ["message", "callback_query"],
        },
      },
    });

    // ================================
    // TEMPORARY: VIDEO/GIF ID GETTER (Private chats only)
    // ================================
    bot.on("message:video", async (ctx) => {
      if (ctx.chat?.type === "private") {
        const fileId = ctx.message.video.file_id;
        const fileName = ctx.message.video.file_name || "video";
        const duration = ctx.message.video.duration || 0;
        const width = ctx.message.video.width || 0;
        const height = ctx.message.video.height || 0;

        // Only log to console, don't reply to user
        console.log(
          `🎥 Video received:\n` +
          `   File ID: ${fileId}\n` +
          `   Name: ${fileName}\n` +
          `   Duration: ${duration}s\n` +
          `   Size: ${width}x${height}`
        );
      }
    });

    bot.on("message:animation", async (ctx) => {
      if (ctx.chat?.type === "private") {
        const fileId = ctx.message.animation.file_id;
        const fileName = ctx.message.animation.file_name || "animation.gif";
        const duration = ctx.message.animation.duration || 0;
        const width = ctx.message.animation.width || 0;
        const height = ctx.message.animation.height || 0;

        // Only log to console, don't reply to user
        console.log(
          `🎭 GIF/Animation received:\n` +
          `   File ID: ${fileId}\n` +
          `   Name: ${fileName}\n` +
          `   Duration: ${duration}s\n` +
          `   Size: ${width}x${height}`
        );
      }
    });

    // Set up graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
      try {
        await handle?.stop();
        console.log("✅ Bot stopped successfully");
        process.exit(0);
      } catch (error) {
        console.error("❌ Error during shutdown:", error);
        process.exit(1);
      }
    };

    // Handle different shutdown signals
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));

    // Handle the runner task completion
    handle
      ?.task()
      ?.then(() => {
        console.log("🏁 Bot runner task completed");
      })
      .catch((error) => {
        console.error("❌ Bot runner task failed:", error);
      });
  })
  .catch((error) => {
    console.error("Failed to setup Anchor:", error);
  });
}
