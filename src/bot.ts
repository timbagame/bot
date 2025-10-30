import "./utils/logging";
import { Bot, Context, InlineKeyboard } from "grammy";
import type { NextFunction } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { WalletManager } from "./utils/wallet";
import { TokenManager, formatParseAmountError } from "./utils/token-manager";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { GameDatabase, type LeaderboardStatsRecord } from "./utils/game-database";
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
  SWAP_DEFAULT_SLIPPAGE_BPS,
  SWAP_SLIPPAGE_OPTIONS_BPS,
  applyDynamicFeeBudgets,
} from "./utils/constants";
import { FeeBudgetManager } from "./utils/fee-budget";
import { mergeWsolIntoSol } from "./utils/balance";
import { setUserState, getUserState, storePendingTransaction, getPendingTransaction } from "./utils/user-state";
// import { createDmMessageAdapter } from "./utils/ctx-adapter";
import {
  createWalletKeyboard,
  createWalletSettingsKeyboard,
  createBackToWalletKeyboard,
  createCancelKeyboard,
  createConfirmWrapKeyboard,
  createConfirmUnwrapKeyboard,
  createTradeConfirmKeyboard,
  createAmountSelectionKeyboard,
  createPlayerSelectionKeyboard,
  createGameConfirmKeyboard,
  getFeeWarningMessage,
  getSuggestedStakeAmounts,
} from "./utils/keyboards";
import {
  buildWalletCaption,
  buildWalletActionMenu,
  showCustomAmountPrompt,
  upsertWalletMenuMessage,
  type WalletActionQuickActions,
  type WalletActionMenuBalances,
} from "./utils/wallet-ui";
import {
  buildEmptyLeaderboardMessage,
  buildLeaderboardMessage,
  type LeaderboardPlayerDisplay,
} from "./utils/leaderboard-ui";
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
  respondMissingIdentity,
  requireTelegramId,
  getRequiredTelegramIdForContext,
} from "./utils/context-helpers";
import { recentUpdateGuard } from "./utils/recent-update";
import { getPriceUSD } from "./utils/prices";
import { patchReplyBehavior } from "./utils/reply-patch";
import { buildTransactionLinkMessage } from "./utils/network-detector";
import { buildProcessingStatus } from "./utils/trade-ui";
import { respondWithMenu } from "./utils/menu-response";
import { parseDecimalAmount, presentTradeAmount } from "./utils/amount";
import {
  handleCoinflipCommand,
  type CoinflipDeps,
  type GameTokenOverride,
} from "./handlers/game";
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
const feeBudget = FeeBudgetManager.getInstance(wallet.getConnection());
let SOL_FEE_BUFFER_LAMPORTS = feeBudget.getCachedSingleTransactionLamports();

void (async () => {
  try {
    const [singleLamports, gameLamports, jitLamports] = await Promise.all([
      feeBudget.getSingleTransactionLamports(),
      feeBudget.getGameSafetyBufferLamports(),
      feeBudget.getJitSwapFeeBufferLamports(),
    ]);
    SOL_FEE_BUFFER_LAMPORTS = singleLamports;
    applyDynamicFeeBudgets({
      singleTransactionLamports: singleLamports,
      gameSafetyBufferLamports: gameLamports,
      jitSwapBufferLamports: jitLamports,
    });
  } catch (error) {
    console.warn("Failed to refresh dynamic fee budgets during startup:", error);
  }
})();
const gameDb = GameDatabase.getInstance();
const pendingGameCreations = new Set<string>();

let oracleMaxTickets = 100;

const getOracleMaxPlayers = (): number => oracleMaxTickets;

const updateOracleMaxPlayers = (maybeMax: number) => {
  if (Number.isFinite(maybeMax) && maybeMax > 0) {
    oracleMaxTickets = maybeMax;
  }
};

const parseOracleNumeric = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "toNumber" in value &&
    typeof (value as { toNumber?: () => number }).toNumber === "function"
  ) {
    try {
      const converted = (value as { toNumber: () => number }).toNumber();
      return Number.isFinite(converted) ? converted : null;
    } catch (error) {
      console.warn("Failed to convert oracle numeric value:", error);
      return null;
    }
  }

  return null;
};

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
  maxPlayersLimit?: number;
};

const defaultGameSetupSession: Pick<GameSetupSession, "waitingFor" | "gameType" | "userBalance"> = {
  waitingFor: "setup",
  gameType: "",
  userBalance: 0,
};

const userSessions = new Map<string, GameSetupSession>();

const updateGameSetupSession = (
  sessionKey: string,
  overrides: Partial<GameSetupSession>
): GameSetupSession => {
  const existing = userSessions.get(sessionKey);
  const next: GameSetupSession = {
    ...defaultGameSetupSession,
    ...(existing ?? {}),
    ...overrides,
  } as GameSetupSession;

  userSessions.set(sessionKey, next);
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
    nativeSolBalance?: number;
    wsolBalance?: number;
  },
  _ts?: number
) => {
  const cacheKey = getWalletCacheKey(telegramId as any);
  walletDataCache.setWithTTL(cacheKey, {
    solBalance: data.solBalance,
    nativeSolBalance: data.nativeSolBalance ?? data.solBalance,
    wsolBalance: data.wsolBalance ?? 0,
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
  const currentUserId = getTelegramIdString(ctx);

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

const toRawAmount = (value: string, decimals: number): number =>
  parseDecimalAmount(value, decimals, { returnType: "number" });

const clampLamportsForFees = (lamports: number): number =>
  Math.max(0, lamports - SOL_FEE_BUFFER_LAMPORTS);

const tryGetUserWalletAddress = (telegramId: bigint): string | undefined => {
  if (telegramId === 0n) {
    return undefined;
  }

  try {
    return wallet.getKeyPair(telegramId).publicKey.toBase58();
  } catch {
    return undefined;
  }
};

const getTelegramIdString = (ctx: Context): string | undefined => {
  const id = getTelegramId(ctx);
  return id === 0n ? undefined : id.toString();
};

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
  const presentation = presentTradeAmount({
    amount,
    assetTicker,
    decimals: inputDecimals,
    solBalance,
    tokenBalance,
    applySolFeeBuffer,
    solFeeBufferLamports: SOL_FEE_BUFFER_LAMPORTS,
    insufficientSolForFeesMessage: "Not enough SOL to cover purchase and fees",
    insufficientSolBalanceMessage: applySolFeeBuffer
      ? "Insufficient SOL balance for this purchase"
      : "Insufficient SOL balance",
    formatSol,
    formatToken,
  });

  return {
    rawAmount: presentation.rawAmount,
    displayAmount: presentation.displayAmount,
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
  const presentation = presentTradeAmount({
    amount,
    assetTicker,
    decimals,
    solBalance,
    tokenBalance,
    applySolFeeBuffer: false,
  });

  return {
    normalizedAmount: presentation.normalizedAmount,
    displayAmount: presentation.displayAmount,
  };
};

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
    customLabel = "✏️ Custom Amount",
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

export const __test_buildQuickAmountKeyboard = buildQuickAmountKeyboard;

type WalletBalanceEntry = {
  ticker: string;
  balance: number;
  decimals: number;
};

const resolveFormattedBalance = (
  ticker: string,
  solBalance: number,
  tokenBalances: WalletBalanceEntry[]
): { decimalBalance: number; formattedBalance: string } => {
  if (ticker === "SOL") {
    return {
      decimalBalance: solBalance / LAMPORTS_PER_SOL,
      formattedBalance: wallet.formatSolBalance(solBalance),
    };
  }

  const entry = tokenBalances.find((token) => token?.ticker === ticker);
  if (!entry) {
    return { decimalBalance: 0, formattedBalance: "0" };
  }

  const decimalBalance = entry.balance / Math.pow(10, entry.decimals);
  return {
    decimalBalance,
    formattedBalance: wallet.formatTokenBalance(entry.balance, entry.decimals),
  };
};

interface TokenSelectionCacheEntry {
  targetToken: string;
  targetTokenAddress: string;
  paymentToken: string;
  tokenMetadata?: {
    symbol: string;
    decimals: number;
    verified: boolean;
  };
  timestamp?: number;
}

const createTokenLookupId = (): string =>
  Math.random().toString(36).substring(2, 15);

type TransactionCacheEntry = TokenSelectionCacheEntry;

const isTokenSelectionCacheEntry = (
  entry: TransactionCacheEntry | undefined
): entry is TokenSelectionCacheEntry =>
  Boolean(entry && "targetToken" in entry && "targetTokenAddress" in entry);

type TradeKind = "swap";

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

const formatSlippagePercent = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "0%";
  }

  if (value === 0) {
    return "0%";
  }

  const absolute = Math.abs(value);

  if (absolute >= 1) {
    return `${value.toFixed(1)}%`;
  }

  if (absolute >= 0.1) {
    return `${value.toFixed(1)}%`;
  }

  if (absolute >= 0.01) {
    return `${value.toFixed(2)}%`;
  }

  return `${value.toFixed(3)}%`;
};

const formatTradeConfirmationSummary = ({
  kind: _kind,
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

  const providerLabel = (() => {
    switch (quote.provider) {
      case "pump-fun":
        return "Pump.fun (Not graduated)";
      case "jupiter":
        return "Jupiter";
      case "pump-fun+jupiter":
        return "Pump.fun → Jupiter";
      default:
        return quote.provider;
    }
  })();

  const slippageText = formatSlippagePercent(
    quote.slippage !== undefined ? (quote.slippage as number) : 1
  );

const lines = [
    `🔄 <b>Swap Confirmation</b>`,
    "",
    `<b>You Pay:</b> ${payDisplay} ${payToken}`,
    `<b>You Receive:</b> ~${receiveDisplay} ${receiveToken}`,
    "",
    `<b>Rate:</b> ${rateDisplay} ${receiveToken}/${payToken}`,
    `<b>Provider:</b> ${providerLabel}`,
    `<b>Slippage:</b> ${slippageText}`,
  ];

  if (contractAddress) {
    lines.push("", `🔗 <b>Contract:</b> <code>${contractAddress}</code>`);
  }

  lines.push("", `⚠️ <b>Confirm this swap?</b>`);

  return {
    message: lines.join("\n"),
    rateDisplay,
    providerLabel,
    slippageText,
    receiveDisplay,
  };
};

type TradeConfirmationSummary = ReturnType<typeof formatTradeConfirmationSummary>;

const formatSlippageOptionLabel = (bps: number): string => {
  if (!Number.isFinite(bps)) {
    return "0%";
  }

  if (bps < 10) {
    return `${(bps / 100).toFixed(2)}%`;
  }

  if (bps < 100) {
    return `${(bps / 100).toFixed(1)}%`;
  }

  const decimals = bps % 100 === 0 ? 0 : 1;
  return `${(bps / 100).toFixed(decimals)}%`;
};

const getUserSwapSlippageBps = (userId: string): number => {
  const state = getUserState<{ swapSlippageBps?: number }>(userId, false);
  const candidate = state?.swapSlippageBps;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  return SWAP_DEFAULT_SLIPPAGE_BPS;
};

const setUserSwapSlippageBps = (userId: string, slippageBps: number): void => {
  const existing = getUserState(userId, false);
  const { timestamp: _timestamp, ...rest } = existing ?? {};
  setUserState(userId, { ...rest, swapSlippageBps: slippageBps });
};

const buildSwapConfirmationKeyboard = ({
  txId,
  cancelCallback,
  selectedSlippageBps,
}: {
  txId: string;
  cancelCallback: string;
  selectedSlippageBps: number;
}): InlineKeyboard => {
  const keyboard = createTradeConfirmKeyboard({
    confirmLabel: "✅ Confirm Swap",
    confirmCallback: `confirm_swap_${txId}`,
    cancelLabel: "❌ Cancel",
    cancelCallback,
  });

  for (const option of SWAP_SLIPPAGE_OPTIONS_BPS) {
    const optionLabel = formatSlippageOptionLabel(option);
    const displayLabel = option === selectedSlippageBps ? `• ${optionLabel}` : optionLabel;
    keyboard.text(displayLabel, `swap_slippage_${option}_${txId}`);
  }

  keyboard.row();
  return keyboard;
};

type TradeQuoteErrorKind = "swap";

type TradeQuoteErrorParams = {
  error: unknown;
  retryCallback: string;
};

const renderTradeQuoteError = (
  _kind: TradeQuoteErrorKind,
  { error, retryCallback }: TradeQuoteErrorParams
) => {
  const keyboard = new InlineKeyboard().text("← Try Again", retryCallback).row();
  const userFriendly = formatUserFriendlyError(error, wallet);
  return {
    text: `❌ <b>Quote Error</b>\n\n${userFriendly}`,
    keyboard,
  };
};

type SolscanSuccessMessageOptions = {
  title: string;
  bodyLines: string[];
  signature?: string;
  linkText?: string;
};

const buildSolscanSuccessMessage = ({
  title,
  bodyLines,
  signature,
  linkText = "View on Solscan",
}: SolscanSuccessMessageOptions): { text: string; disablePreview: boolean } => {
  const lines: string[] = [title];
  const normalizedBody = bodyLines.filter(
    (line) => typeof line === "string" && line.trim().length > 0
  );

  if (normalizedBody.length > 0) {
    lines.push("", ...normalizedBody);
  }

  const { message, previewDisabled } = buildTransactionLinkMessage({
    signature,
    networkOverride: process.env["RPC_URL"],
    label: "🔗 ",
    linkText,
    format: "html",
  });

  if (message) {
    lines.push("", message);
  }

  return { text: lines.join("\n"), disablePreview: previewDisabled };
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
        slippageBps: quoteOptions?.slippageBps ?? SWAP_DEFAULT_SLIPPAGE_BPS,
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

const NON_GAME_CALLBACK_NAMES = [
  "main_wallet",
  "wallet_refresh",
  "wallet_settings",
  "cmd_help",
  "cmd_balance",
  "cmd_withdraw",
  "cmd_swap",
  "cmd_wrap",
  "cmd_unwrap",
  "cmd_privatekey",
  "unwrap_confirm",
  "help_wallet",
  "help_games",
  "help_utility",
  "help_examples",
] as const;

const NON_GAME_CALLBACK_PREFIXES = [
  "send_",
  "swap_",
  "wrap_",
  "confirm_",
  "amount_",
  "players_",
  "cancel_game_",
  "custom_amount_",
  "custom_players_",
  "slider_",
  "back_to_amounts_",
  "type_amount_",
  "admin_",
  "info_",
] as const;

const shouldSkipGenericGameCallback = (callbackData: string): boolean => {
  if (!callbackData) return false;
  if (callbackData === "noop") return true;

  if (
    NON_GAME_CALLBACK_NAMES.includes(
      callbackData as (typeof NON_GAME_CALLBACK_NAMES)[number]
    )
  ) {
    return true;
  }

  return NON_GAME_CALLBACK_PREFIXES.some((prefix) =>
    callbackData.startsWith(prefix)
  );
};

export const __test_shouldSkipGenericGameCallback = shouldSkipGenericGameCallback;

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
      `Game manager not ready when resolving message target for ${gameAddress}`
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
      `Cannot find chat/message reference for game ${gameAddress}`
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
  const userId = getTelegramIdString(ctx);
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
  try {
    return await tokenManager.resolveTokenForChat(chatId);
  } catch (error) {
    console.warn(
      "⚠️ Could not resolve chat token configuration, using default token",
      error
    );
    const defaultMetadata = await getDefaultTokenMetadata();
    return {
      tokenMint: DEFAULT_TOKEN_MINT,
      tokenTicker: DEFAULT_TOKEN_TICKER,
      decimals: defaultMetadata.decimals,
    };
  }
};

const fetchTokenPriceUSD = async ({
  tokenMint,
  tokenTicker,
}: {
  tokenMint: string;
  tokenTicker: string;
}): Promise<number | null> => {
  let tokenPriceUSD = await getPriceUSD(tokenMint);
  if (!tokenPriceUSD) {
    tokenPriceUSD = await getPriceUSD(tokenTicker);
  }
  return tokenPriceUSD ?? null;
};

const toTitleCase = (value: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
};

type GameSetupCopy = {
  gameType: "coinflip" | "giveaway";
  heading: string;
  amountPrompt: string;
  suggestionLabel?: string;
  lowBalanceCopy?: {
    object: string;
  };
  logPrefix: string;
};

const GAME_SETUP_COPY: Record<"coinflip" | "giveaway", GameSetupCopy> = {
  coinflip: {
    gameType: "coinflip",
    heading: "🪙 <b>Create Coinflip</b>",
    amountPrompt: "Select stake per player:",
    lowBalanceCopy: {
      object: "stake per player",
    },
    logPrefix: "🪙",
  },
  giveaway: {
    gameType: "giveaway",
    heading: "🎁 <b>Create Giveaway</b>",
    amountPrompt: "Select prize amount:",
    lowBalanceCopy: {
      object: "prize amount",
    },
    logPrefix: "🎁",
  },
};

const startInteractiveGameSetup = async (
  ctx: Context & { message?: any },
  telegramId: bigint,
  copy: GameSetupCopy,
  tokenOverride?: GameTokenOverride
): Promise<void> => {
  console.log(`${copy.logPrefix} UI-based ${copy.gameType} creation`);

  const tokenInfo = tokenOverride
    ? {
        tokenMint: tokenOverride.tokenMint,
        tokenTicker: tokenOverride.tokenTicker,
        decimals: tokenOverride.tokenDecimals,
      }
    : await resolveChatTokenInfo(ctx.chat?.id);

  let userBalance = 0;

  try {
    const tokenBalance = await wallet.getTokenBalance(telegramId, tokenInfo.tokenMint, {
      createIfMissing: true,
    });
    userBalance = tokenBalance / Math.pow(10, tokenInfo.decimals);
  } catch (error) {
    console.error("Error getting token balance:", error);
  }

  const { formatted: contractMin } = await getContractMinimumAmount(
    tokenInfo.tokenMint,
    tokenInfo.decimals
  );

  const tokenPriceUSD = await fetchTokenPriceUSD({
    tokenMint: tokenInfo.tokenMint,
    tokenTicker: tokenInfo.tokenTicker,
  });

  const suggestedAmounts = getSuggestedStakeAmounts(contractMin, userBalance);

  let message = `${copy.heading}\n\n`;
  message += `Token: <b>${tokenInfo.tokenTicker}</b>\n`;
  message += "\n";

  if (copy.lowBalanceCopy && userBalance < contractMin) {
    const { object } = copy.lowBalanceCopy;
    const minDisplay = formatTokenDisplay(contractMin, {
      decimals: tokenInfo.decimals,
    });
    message += `⚠️ Minimum ${object}: ${minDisplay} ${tokenInfo.tokenTicker}.\n\n`;
  }

  message += copy.amountPrompt;

  if (copy.suggestionLabel && suggestedAmounts.length > 0) {
    message += `\n\n${copy.suggestionLabel}:\n`;
    for (const amount of suggestedAmounts) {
      const amountDisplay = formatTokenDisplay(amount, {
        decimals: tokenInfo.decimals,
      });
      message += `• ${amountDisplay} ${tokenInfo.tokenTicker}`;
      if (tokenPriceUSD) {
        const usdFormatted = formatUsdValue(amount * tokenPriceUSD, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
          fallback: "0.0",
        });
        message += ` ($${usdFormatted})`;
      }
      message += "\n";
    }
  }

  const setupMessage = await ctx.reply(message, {
    parse_mode: "HTML",
    reply_markup: createAmountSelectionKeyboard(
      copy.gameType,
      userBalance,
      getTelegramIdString(ctx),
      contractMin,
      {
        decimals: tokenInfo.decimals,
        tokenPriceUSD: tokenPriceUSD ?? undefined,
      }
    ),
    reply_to_message_id: ctx.message?.message_id,
  });

  updateGameSetupSession(`${ctx.chat?.id || 0}_${setupMessage.message_id}`, {
    waitingFor: "setup",
    gameType: copy.gameType,
    userBalance,
    messageId: setupMessage.message_id,
    chatId: ctx.chat?.id || 0,
    creatorId: getTelegramIdString(ctx),
    tokenMint: tokenInfo.tokenMint,
    tokenTicker: tokenInfo.tokenTicker,
    tokenDecimals: tokenInfo.decimals,
    contractMinimum: contractMin,
  });
};

export const __test_startInteractiveGameSetup = startInteractiveGameSetup;

const NUMERIC_TOKEN_CANDIDATE = /^[0-9]+(?:\.[0-9]+)?$/;

const resolveCommandTokenOverride = async (
  tokenInput: string
): Promise<GameTokenOverride | null> => {
  if (!tokenManager) {
    return null;
  }

  const candidate = tokenInput.trim();
  if (!candidate) {
    return null;
  }

  if (NUMERIC_TOKEN_CANDIDATE.test(candidate)) {
    return null;
  }

  try {
    const resolved = await tokenManager.resolveSwapToken(candidate);
    if (!resolved) {
      return null;
    }

    const decimals = resolved.decimals;
    if (!Number.isFinite(decimals) || decimals < 0) {
      console.warn(
        `⚠️ ResolveSwapToken returned invalid decimals for override ${candidate}`
      );
      return null;
    }

    const tokenTicker = resolved.isNativeSol ? "SOL" : resolved.token_ticker;

    return {
      tokenMint: resolved.token_mint,
      tokenTicker,
      tokenDecimals: decimals,
    };
  } catch (error) {
    console.warn(`⚠️ Could not resolve token override ${candidate}`, error);
    return null;
  }
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
    const currentUserId = getTelegramIdString(ctx);

    console.log(`🔔 ${options.name} callback triggered:`, ctx.callbackQuery?.data);
    console.log(
      `👤 Creator: ${creatorId ?? "unknown"}, Current user: ${currentUserId ?? "unknown"}`
    );

    if (!creatorId) {
      console.warn(`${options.name}: unable to resolve creator id from callback`);
      await safeAnswerCallbackQuery(ctx, "❌ Unable to process action");
      return;
    }

    if (!ensureCreator(ctx, creatorId, options.failureText)) {
      return;
    }

    const userIdBigInt = getTelegramId(ctx);
    if (userIdBigInt === 0n) {
      await safeAnswerCallbackQuery(ctx, "❌ Unable to identify user");
      return;
    }

    const userId = Number(userIdBigInt);
    const sessionKey = `${ctx.chat?.id ?? 0}_${ctx.callbackQuery?.message?.message_id ?? 0}`;

    let session = userSessions.get(sessionKey);
    const tokenContext = await buildTokenContext(session, ctx.chat?.id);

    const creatorContext: CreatorCallbackContext = {
      creatorId,
      userId,
      session,
      tokenContext,
      updateSession: (updates, keyOverride?: string) => {
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

        const keyToUse = keyOverride ?? sessionKey;
        userSessions.set(keyToUse, next);
        session = next;
        creatorContext.session = next;
        return next;
      },
      clearSession: () => {
        userSessions.delete(sessionKey);
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

    let disablePreview = false;
    // Add Solscan link if requested and we have a transaction signature
    if (showSolscanLink && txString) {
      const { message: linkMessage, solscanUrl } = buildTransactionLinkMessage({
        signature: txString,
        networkOverride: process.env["RPC_URL"],
        linkText: "View in Blockchain",
        format: "html",
      });

      if (solscanUrl) {
        console.log(`🔗 Generated Solscan URL: ${solscanUrl}`);
      }

      if (linkMessage) {
        successMessage += `\n\n${linkMessage}`;
        disablePreview = true;
      }
    }

    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      successMessage,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: disablePreview },
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

type SolConversionValidationResult =
  | { status: "ok"; formattedAmount?: string }
  | { status: "insufficient"; formattedAmount: string }
  | { status: "empty"; formattedAmount?: string };

type SolConversionFlowOutcome =
  | { status: "success"; signature: string; formattedAmount: string }
  | { status: "insufficient"; formattedAmount: string }
  | { status: "empty"; formattedAmount?: string }
  | { status: "error" };

interface SolConversionFlowConfig {
  telegramId: bigint;
  ensureProceed: () => Promise<SolConversionValidationResult>;
  perform: () => Promise<{ signature: string; amountLamports?: number }>;
  onProcessing: (formattedAmount?: string) => Promise<void>;
  onSuccess: (
    details: { signature: string; formattedAmount: string; solscanUrl?: string | null }
  ) => Promise<void>;
  onInsufficient?: (formattedAmount: string) => Promise<void>;
  onEmpty?: (formattedAmount?: string) => Promise<void>;
  onError?: (error: unknown, formattedAmount?: string) => Promise<void>;
  formatAmount: (lamports: number) => string;
  initialAmountLamports?: number;
  treatZeroAmountAsEmpty?: boolean;
  handleEmptyError?: (error: unknown) => boolean;
  networkOverride?: string | null;
}

const executeSolConversionFlow = async ({
  telegramId,
  ensureProceed,
  perform,
  onProcessing,
  onSuccess,
  onInsufficient,
  onEmpty,
  onError,
  formatAmount,
  initialAmountLamports,
  treatZeroAmountAsEmpty = false,
  handleEmptyError,
  networkOverride,
}: SolConversionFlowConfig): Promise<SolConversionFlowOutcome> => {
  const validation = await ensureProceed();

  if (validation.status === "insufficient") {
    await onInsufficient?.(validation.formattedAmount);
    return { status: "insufficient", formattedAmount: validation.formattedAmount };
  }

  if (validation.status === "empty") {
    await onEmpty?.(validation.formattedAmount);
    return { status: "empty", formattedAmount: validation.formattedAmount };
  }

  const processingAmount =
    validation.formattedAmount ??
    (initialAmountLamports !== undefined
      ? formatAmount(initialAmountLamports)
      : undefined);

  await onProcessing(processingAmount);

  let formattedAmountForError = processingAmount;

  try {
    const { signature, amountLamports } = await perform();
    let normalizedAmount =
      amountLamports !== undefined ? amountLamports : initialAmountLamports;

    if (normalizedAmount === undefined) {
      if (treatZeroAmountAsEmpty) {
        await onEmpty?.(validation.formattedAmount);
        return { status: "empty", formattedAmount: validation.formattedAmount };
      }
      throw new Error("Unable to determine transaction amount");
    }

    if (!Number.isFinite(normalizedAmount)) {
      throw new Error("Invalid transaction amount");
    }

    if (treatZeroAmountAsEmpty && normalizedAmount <= 0) {
      await onEmpty?.(validation.formattedAmount);
      return { status: "empty", formattedAmount: validation.formattedAmount };
    }

    const formattedAmount = formatAmount(normalizedAmount);
    formattedAmountForError = formattedAmount;

    await wallet.confirmTransaction(signature);
    clearWalletCache(telegramId);

    const { solscanUrl } = buildTransactionLinkMessage({
      signature,
      networkOverride: networkOverride ?? process.env["RPC_URL"],
    });

    await onSuccess({ signature, formattedAmount, solscanUrl });
    return { status: "success", signature, formattedAmount };
  } catch (error) {
    if (handleEmptyError?.(error)) {
      await onEmpty?.(validation.formattedAmount);
      return { status: "empty", formattedAmount: validation.formattedAmount };
    }

    if (onError) {
      await onError(error, formattedAmountForError ?? validation.formattedAmount);
      return { status: "error" };
    }
    throw error;
  }
};

type WrapFlowResult = {
  status: "success" | "insufficient" | "error";
  signature?: string;
};

type WrapFlowHandlers = {
  onProcessing: (formattedAmount: string) => Promise<void>;
  onSuccess: (
    details: { signature: string; formattedAmount: string; solscanUrl?: string | null }
  ) => Promise<void>;
  onInsufficientBalance: (formattedAmount: string) => Promise<void>;
  onError?: (error: unknown, formattedAmount: string) => Promise<void>;
};

const executeWrapFlow = async (
  telegramId: bigint,
  amountLamports: number,
  handlers: WrapFlowHandlers
): Promise<WrapFlowResult> => {
  if (!Number.isFinite(amountLamports) || amountLamports <= 0) {
    throw new Error("Wrap amount must be greater than zero");
  }

  const result = await executeSolConversionFlow({
    telegramId,
    initialAmountLamports: amountLamports,
    formatAmount: (lamports) => wallet.formatSolBalance(lamports),
    ensureProceed: async () => {
      const formattedAmount = wallet.formatSolBalance(amountLamports);
      const balanceLamports = await wallet.getBalance(telegramId);

      if (amountLamports + SOL_FEE_BUFFER_LAMPORTS > balanceLamports) {
        return { status: "insufficient", formattedAmount } as const;
      }

      return { status: "ok", formattedAmount } as const;
    },
    perform: async () => ({
      signature: await wallet.wrapSol(telegramId, amountLamports),
      amountLamports,
    }),
    onProcessing: async (amount) =>
      handlers.onProcessing(
        amount ?? wallet.formatSolBalance(amountLamports)
      ),
    onSuccess: handlers.onSuccess,
    onInsufficient: handlers.onInsufficientBalance,
    onError: handlers.onError
      ? (error, formattedAmount) =>
          handlers.onError!(
            error,
            formattedAmount ?? wallet.formatSolBalance(amountLamports)
          )
      : undefined,
  });

  if (result.status === "success") {
    return { status: "success", signature: result.signature };
  }

  if (result.status === "insufficient") {
    return { status: "insufficient" };
  }

  if (result.status === "error") {
    return { status: "error" };
  }

  return { status: "error" };
};

type UnwrapFlowResult = {
  status: "success" | "empty" | "error";
  signature?: string;
  formattedAmount?: string;
};

type UnwrapFlowHandlers = {
  expectedAmountLamports?: number;
  onProcessing: (formattedAmount?: string) => Promise<void>;
  onNoBalance: () => Promise<void>;
  onSuccess: (
    details: { signature: string; formattedAmount: string; solscanUrl?: string | null }
  ) => Promise<void>;
  onError?: (error: unknown) => Promise<void>;
};

const executeUnwrapFlow = async (
  telegramId: bigint,
  handlers: UnwrapFlowHandlers
): Promise<UnwrapFlowResult> => {
  const result = await executeSolConversionFlow({
    telegramId,
    formatAmount: (lamports) => wallet.formatSolBalance(lamports),
    ensureProceed: async () => {
      const expected = handlers.expectedAmountLamports;
      if (expected !== undefined) {
        if (!Number.isFinite(expected) || expected <= 0) {
          return { status: "empty" } as const;
        }

        return {
          status: "ok",
          formattedAmount: wallet.formatSolBalance(expected),
        } as const;
      }

      return { status: "ok" } as const;
    },
    perform: async () => wallet.unwrapSol(telegramId),
    onProcessing: handlers.onProcessing,
    onSuccess: handlers.onSuccess,
    onEmpty: handlers.onNoBalance,
    onError: handlers.onError ? (error) => handlers.onError!(error) : undefined,
    treatZeroAmountAsEmpty: true,
    handleEmptyError: (error) => {
      const message =
        error instanceof Error
          ? String(error.message ?? "")
          : String(error ?? "");
      return (
        message.includes("already empty") ||
        message.includes("No WSOL account") ||
        message.includes("WSOL account is already empty")
      );
    },
  });

  if (result.status === "success") {
    return {
      status: "success",
      signature: result.signature,
      formattedAmount: result.formattedAmount,
    };
  }

  if (result.status === "empty") {
    return { status: "empty", formattedAmount: result.formattedAmount };
  }

  if (result.status === "error") {
    return { status: "error" };
  }

  return { status: "error" };
};

type PendingTransactionValidationResult<T> =
  | { status: "success"; transaction: T }
  | { status: "expired" }
  | { status: "unauthorized" };

type PendingSendTransaction = {
  type: "send";
  userId: string;
  token: string;
  amount: string;
  address: string;
  amountDisplay?: string;
};

type PendingSwapTransaction = {
  type: "swap";
  userId: string;
  fromToken: string;
  toToken: string;
  amount: string;
  rawAmount: string;
  inputDecimals: number;
  outputDecimals: number;
  cancelCallback: string;
  slippageBps: number;
  quote: SwapQuote;
};

const validatePendingTransaction = <T extends { type: string; userId: string }>(
  ctx: Context,
  txId: string,
  expectedType: T["type"],
  options: { removeFromCache?: boolean } = {}
): PendingTransactionValidationResult<T> => {
  const { removeFromCache = true } = options;
  const transaction = getPendingTransaction(txId, removeFromCache) as
    | (T & { type: string; userId: string })
    | undefined;

  if (!transaction || transaction.type !== expectedType) {
    return { status: "expired" };
  }

  const currentUserId = getTelegramIdString(ctx);
  if (!currentUserId || transaction.userId !== currentUserId) {
    return { status: "unauthorized" };
  }

  return { status: "success", transaction };
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

    const maxTickets = parseOracleNumeric(oracleAccount.maxTickets);
    if (maxTickets !== null) {
      updateOracleMaxPlayers(maxTickets);
      console.log(`Oracle max tickets set to ${oracleMaxTickets}`);
    } else {
      console.warn(
        "Unable to determine oracle max tickets, keeping previous limit",
        oracleAccount.maxTickets
      );
    }
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
  getMaxPlayers: () => number;
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
  getMaxPlayers: () => getOracleMaxPlayers(),
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
  getMaxPlayers: () => getOracleMaxPlayers(),
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
    getBalance: (telegramId: bigint) => Promise<number>;
    formatSolBalance: (lamports: number) => string;
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
    getBalance: (telegramId) => wallet.getBalance(telegramId),
    formatSolBalance: (lamports) => wallet.formatSolBalance(lamports),
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
    const maxPlayersLimit = Math.max(
      options.minPlayers,
      options.getMaxPlayers()
    );
    const defaultMaxPlayers = Math.min(
      options.defaultMaxPlayers,
      maxPlayersLimit
    );
    const inferred = deps.inferMaxPlayers(
      args,
      1,
      parsedAmount.tokenWasSpecified,
      defaultMaxPlayers,
      options.minPlayers,
      maxPlayersLimit
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

    const needsNativeSolCheck =
      parsedAmount.requestedNativeSol === true ||
      parsedAmount.tokenMint === WSOL_MINT;
    let nativeSolBalance = 0;
    let userBalance: number;

    if (needsNativeSolCheck) {
      const [tokenBalance, solBalance] = await Promise.all([
        deps.wallet.getTokenBalance(telegramId, parsedAmount.tokenMint, {
          createIfMissing: true,
        }),
        deps.wallet.getBalance(telegramId),
      ]);
      userBalance = tokenBalance;
      nativeSolBalance = solBalance;
    } else {
      userBalance = await deps.wallet.getTokenBalance(
        telegramId,
        parsedAmount.tokenMint,
        { createIfMissing: true }
      );
    }

    if (!needsNativeSolCheck && userBalance < parsedAmount.amount) {
      const formatted = deps.wallet.formatTokenBalance(
        userBalance,
        tokenMetadata.decimals
      );
      await ctx.reply(
        `❌ Insufficient balance. You have ${formatted} ${parsedAmount.tokenTicker}, need ${parsedAmount.formattedAmount}.`
      );
      return;
    }

    if (needsNativeSolCheck) {
      const totalLamports = userBalance + nativeSolBalance;
      if (totalLamports < parsedAmount.amount) {
        const formattedSol = deps.wallet.formatSolBalance(nativeSolBalance);
        const formattedToken = deps.wallet.formatTokenBalance(
          userBalance,
          tokenMetadata.decimals
        );
        const wrappedLabel =
          parsedAmount.tokenMint === WSOL_MINT
            ? "wrapped SOL"
            : parsedAmount.tokenTicker;
        await ctx.reply(
          `❌ Insufficient balance. You have ${formattedSol} SOL available natively and ${formattedToken} ${wrappedLabel}, need ${parsedAmount.formattedAmount}.`
        );
        return;
      }
    }

    const tokenTickerForGame =
      parsedAmount.tokenMint === WSOL_MINT ? "WSOL" : parsedAmount.tokenTicker;

    const gameResult = await deps.gameManager.createGame(
      options.gameType,
      {
        amount: parsedAmount.amount,
        tokenMint: parsedAmount.tokenMint,
        tokenTicker: tokenTickerForGame,
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
      tokenTickerForGame,
      "Active"
    );
  } catch (error) {
    console.error(`Error in command-based ${options.gameType}:`, error);
    await ctx.reply(options.errorMessage);
  }
};

export const __test_createGameViaCommand = createGameViaCommand;

const createBalanceDeps = (): BalanceDeps => ({
  isPrivateChat,
  clearWalletCache,
  showWalletUI,
  handleCommandError,
});

const createCoinflipDeps = (): CoinflipDeps => ({
  isGroupChat,
  showInteractiveSetup: (ctxWithMessage, telegramId, tokenOverride) =>
    startInteractiveGameSetup(
      ctxWithMessage,
      telegramId,
      GAME_SETUP_COPY.coinflip,
      tokenOverride
    ),
  createGameViaCommand: (ctxWithMessage, args, telegramId) =>
    createGameViaCommand(
      ctxWithMessage,
      args,
      telegramId,
      COINFLIP_COMMAND_OPTIONS
    ),
  resolveTokenOverride: (tokenInput) =>
    resolveCommandTokenOverride(tokenInput),
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

    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "giveaway command"
    );
    if (telegramId == null) {
      return;
    }
    const args = ctx.message?.text?.split(" ");
    const tokenCandidate = args?.[1]?.trim();

    if (!args || args.length < 2) {
      await startInteractiveGameSetup(
        ctx as Context & { message?: any },
        telegramId,
        GAME_SETUP_COPY.giveaway
      );
      return;
    }

    if (args.length === 2 && tokenCandidate) {
      let tokenOverride: GameTokenOverride | null = null;
      if (!NUMERIC_TOKEN_CANDIDATE.test(tokenCandidate)) {
        tokenOverride = await resolveCommandTokenOverride(tokenCandidate);
      }

      if (tokenOverride) {
        await startInteractiveGameSetup(
          ctx as Context & { message?: any },
          telegramId,
          GAME_SETUP_COPY.giveaway,
          tokenOverride
        );
        return;
      }
    }

    await createGameViaCommand(
      ctx as Context & { message?: any },
      args,
      telegramId,
      GIVEAWAY_COMMAND_OPTIONS
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
  const telegramId = await getRequiredTelegramIdForContext(
    ctx,
    "withdraw command"
  );
  if (telegramId == null) {
    return;
  }
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
  const telegramId = await getRequiredTelegramIdForContext(
    ctx,
    "tip command"
  );
  if (telegramId == null) {
    return;
  }
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
  const telegramId = await getRequiredTelegramIdForContext(
    ctx,
    "wrap command"
  );
  if (telegramId == null) {
    return;
  }
  const args = ctx.message?.text?.split(" ");

  if (!args) return;

  const amountArg = args[1];
  if (!amountArg) {
    return replyUsageError(
      ctx,
      "Usage: /wrap &lt;amount&gt;\nExample: /wrap 0.1"
    );
  }

  let amount: number;
  try {
    amount = parseDecimalAmount(amountArg, 9, { returnType: "number" });
  } catch {
    return replyUsageError(
      ctx,
      "Usage: /wrap &lt;amount&gt;\nExample: /wrap 0.1"
    );
  }

  let processingMessageId: number | null = null;

  try {
    const result = await executeWrapFlow(telegramId, amount, {
      onProcessing: async (formattedAmount) => {
        const message = await ctx.reply(
          `Processing Wrapping ${formattedAmount} SOL to WSOL...`,
          {
            reply_to_message_id: ctx.message?.message_id,
          }
        );
        processingMessageId = message.message_id;
      },
      onInsufficientBalance: async (formattedAmount) => {
        await replyToMessage(
          ctx,
          `❌ <b>Wrap Failed</b>\n\nNot enough SOL to wrap ${formattedAmount}.\nKeep at least ${MIN_SOL_FOR_TX} SOL for fees and try again.`
        );
      },
      onSuccess: async ({ signature, formattedAmount }) => {
        if (processingMessageId == null) {
          return;
        }

        const { message: linkLine } = buildTransactionLinkMessage({
          signature,
          networkOverride: process.env["RPC_URL"],
          label: "🔗 ",
          linkText: "View on Solscan",
          format: "html",
        });
        const linkSuffix = linkLine ? `\n\n${linkLine}` : "";

        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMessageId,
          `✅ <b>Wrap Completed</b>\n\nWrapped ${formattedAmount} SOL to WSOL${linkSuffix}`,
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: Boolean(linkLine) },
          }
        );
      },
      onError: async (error) => {
        const userFriendlyError = formatUserFriendlyError(error, wallet);
        if (processingMessageId != null) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            processingMessageId,
            userFriendlyError,
            { parse_mode: "HTML" }
          );
        } else {
          await replyToMessage(ctx, userFriendlyError);
        }
        if (error && typeof error === "object") {
          (error as any).__alreadyNotified = true;
        }
      },
    });

    if (result.status === "insufficient" && processingMessageId != null) {
      try {
        await ctx.api.deleteMessage(ctx.chat!.id, processingMessageId);
      } catch {}
    }
  } catch (error: any) {
    await handleCommandError(ctx, error, "wrap");
  }
});

bot.command("unwrap", async (ctx: Context) => {
  const telegramId = await getRequiredTelegramIdForContext(
    ctx,
    "unwrap command"
  );
  if (telegramId == null) {
    return;
  }

  const processingMsg = await ctx.reply("Processing unwrap...", {
    reply_to_message_id: ctx.message?.message_id,
  });

  try {
    await executeUnwrapFlow(telegramId, {
      onProcessing: async () => {},
      onNoBalance: async () => {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          `❌ <b>Unwrap Failed</b>\n\nYour WSOL account is already empty.`,
          { parse_mode: "HTML" }
        );
      },
      onSuccess: async ({ signature, formattedAmount }) => {
        const { message: linkLine } = buildTransactionLinkMessage({
          signature,
          networkOverride: process.env["RPC_URL"],
          label: "🔗 ",
          linkText: "View on Solscan",
          format: "html",
        });
        const linkSuffix = linkLine ? `\n\n${linkLine}` : "";

        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          `✅ <b>Unwrap Completed</b>\n\nUnwrapped ${formattedAmount} WSOL to SOL${linkSuffix}`,
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: Boolean(linkLine) },
          }
        );
      },
      onError: async (error) => {
        const userFriendlyError = formatUserFriendlyError(error, wallet);
        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          userFriendlyError,
          { parse_mode: "HTML" }
        );
      },
    });
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

// Transaction cache for trade operations with TTL
const TRANSACTION_CACHE_TTL_MS = 5 * 60 * 1000;
const transactionCache = createExpiringCache<TransactionCacheEntry>(
  TRANSACTION_CACHE_TTL_MS
);

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
  const telegramId = getTelegramId(ctx);
  if (telegramId === 0n) {
    return replyToMessage(
      ctx,
      "🔒 Unable to verify permissions for this user."
    );
  }

  const isAdmin = await isUserGroupAdmin(ctx, Number(telegramId));
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
    getTelegramId(ctx).toString()
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
    "/oracle - Check Oracle configuration",
    "",
    "<b>ℹ️ Important:</b> ",
    "• Your player balance account will be automatically initialized when needed",
    "• Specify token after amount: /coinflip 100 TIMBA 2 or /tip 50 SOL",
    "• Group admins can set default tokens with /default &lt;TOKEN&gt;",

    "• Contact bot administrator to add support for new SPL tokens",
  ];

  await ctx.reply(helpSections.join("\n"), {
    parse_mode: "HTML",
    reply_to_message_id: ctx.message?.message_id,
  });
});

bot.command("active", async (ctx: Context) => {
  const telegramId = await getRequiredTelegramIdForContext(
    ctx,
    "active command"
  );
  if (telegramId == null) {
    return;
  }

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
  const telegramId = await getRequiredTelegramIdForContext(
    ctx,
    "games command"
  );
  if (telegramId == null) {
    return;
  }

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

const LEADERBOARD_PLAYER_LIMIT = 10;

const resolveLeaderboardDisplayName = async (ctx: Context, telegramId: string): Promise<string> => {
  try {
    const username = await gameManager.getUsernameFromTelegramId(ctx, telegramId);
    if (username) {
      return username.startsWith("@") ? username : `@${username}`;
    }
  } catch (error) {
    console.warn(`Could not get username for ${telegramId}:`, error);
  }

  return `Player ${telegramId}`;
};

const resolveLeaderboardPlayers = async (
  ctx: Context,
  stats: LeaderboardStatsRecord[]
): Promise<LeaderboardPlayerDisplay[]> => {
  const players = await Promise.all(
    stats.map(async (row) => {
      const displayName = await resolveLeaderboardDisplayName(ctx, row.telegramId);
      const wins = Math.max(0, row.gamesWon);
      const totalGames = Math.max(0, row.totalGames);
      const losses = Math.max(totalGames - wins, 0);

      return {
        telegramId: row.telegramId,
        displayName,
        totalGames,
        wins,
        losses,
        winRate: Math.max(0, row.winRate),
        gamesCreated: Math.max(0, row.gamesCreated),
        gamesJoined: Math.max(0, row.gamesJoined),
        totalVolume: Math.max(0, row.totalVolume),
      } satisfies LeaderboardPlayerDisplay;
    })
  );

  return players.filter((player) => player.totalGames > 0);
};

bot.command(["leaderboard", "lb"], async (ctx: Context) => {
  if (!isGroupChat(ctx)) {
    return ctx.reply("❌ Leaderboard is only available in group chats.");
  }

  const chatId = ctx.chat?.id;
  if (!chatId) {
    return ctx.reply("❌ Could not load chat information.");
  }

  try {
    console.log(`🏆 Generating leaderboard for chat ${chatId}`);

    const leaderboardStats = gameDb.getLeaderboardStats(chatId, LEADERBOARD_PLAYER_LIMIT);

    if (leaderboardStats.length === 0) {
      return ctx.reply(buildEmptyLeaderboardMessage(), {
        parse_mode: "HTML",
        reply_to_message_id: ctx.message?.message_id,
      });
    }

    const players = await resolveLeaderboardPlayers(ctx, leaderboardStats);

    if (players.length === 0) {
      return ctx.reply(buildEmptyLeaderboardMessage(), {
        parse_mode: "HTML",
        reply_to_message_id: ctx.message?.message_id,
      });
    }

    const leaderboardText = buildLeaderboardMessage({
      chatTitle: ctx.chat?.title ?? null,
      players,
    });

    await ctx.reply(leaderboardText, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });

    console.log(`✅ Leaderboard generated for chat ${chatId} with ${players.length} players`);
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
  if (shouldSkipGenericGameCallback(callbackData)) {
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
    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "game callback"
    );
    if (telegramId == null) {
      await safeAnswerCallbackQuery(
        ctx,
        "Unable to identify user. Please try again."
      );
      return;
    }

    const gamePda = new PublicKey(gameAddress);
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
      await safeAnswerCallbackQuery(ctx, `Game ${statusMessage} - message updated!`);
    } else {
      // Game data not found in database - game may have been cleaned up
      console.warn(`Game data not found for ${game.game_address}`);
      await safeAnswerCallbackQuery(ctx,
        "Game data not found - game may have been completed"
      );
    }
  } catch (error) {
    console.error("Error updating completed game message:", error);
    await safeAnswerCallbackQuery(ctx, "Failed to update game message");
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
      const errorMessage = result.error || "Failed to join game";

      if (errorMessage.includes("already completed")) {
        try {
          await gameManager.updateGameMessageFromData(
            ctx,
            game.game_address,
            "Completed"
          );
        } catch (updateError) {
          console.error(
            `Error syncing completed game message for ${game.game_address}:`,
            updateError
          );
        }
      }

      await safeAnswerCallbackQuery(ctx, errorMessage);
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
      await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
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

        const formattedGameType = toTitleCase(gameType);

        const playerMessage = [
          `<b>${formattedGameType} - Choose Players</b>`,
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

    await safeAnswerCallbackQuery(ctx);
      } catch (error) {
        console.error("Error in amount callback:", error);
        await safeAnswerCallbackQuery(ctx, "❌ Error selecting amount");
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

        const formattedGameType = toTitleCase(gameType);

        const confirmMessage = [
          `<b>Confirm ${formattedGameType}</b>`,
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

        await safeAnswerCallbackQuery(ctx);
      } catch (error) {
        console.error("Error in players callback:", error);
        await safeAnswerCallbackQuery(ctx, "❌ Error selecting players");
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
        const maxPlayersLimit = Math.max(
          minPlayers,
          getOracleMaxPlayers()
        );
        if (
          isNaN(maxPlayers) ||
          maxPlayers < minPlayers ||
          maxPlayers > maxPlayersLimit
        ) {
          await safeAnswerCallbackQuery(ctx,
            `❌ Players must be between ${minPlayers} and ${maxPlayersLimit}`
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
          await safeAnswerCallbackQuery(ctx, "⏳ Already creating this game...");
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

          await safeAnswerCallbackQuery(ctx, "Creating game...");

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
          await safeAnswerCallbackQuery(ctx, "❌ Error creating game");
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


// Custom amount callback - prompts user to type amount (new format with creator ID)
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
        const telegramId = await getRequiredTelegramIdForContext(
          ctx,
          "type amount prompt"
        );
        if (telegramId == null) {
          await safeAnswerCallbackQuery(ctx, "Unable to identify user");
          return;
        }

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

        const formattedGameType = toTitleCase(gameType);

        const typeMessage = [
          `✏️ <b>Type Custom Amount - ${formattedGameType}</b>`,
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

        await safeAnswerCallbackQuery(ctx, "Type your amount...");

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
        console.error("Error in creator-protected custom_amount callback:", error);
        await safeAnswerCallbackQuery(ctx, "❌ Error setting up text input");
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
        const telegramId = await getRequiredTelegramIdForContext(
          ctx,
          "amount selection"
        );
        if (telegramId == null) {
          await safeAnswerCallbackQuery(ctx, "Unable to identify user");
          return;
        }

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

        const tokenPriceUSD = await fetchTokenPriceUSD({
          tokenMint: tokenContext.tokenMint,
          tokenTicker: tokenContext.tokenTicker,
        });

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

        const suggestionLabel =
          GAME_SETUP_COPY[gameType as "coinflip" | "giveaway"]?.suggestionLabel;

        if (suggestionLabel && suggestedAmounts.length > 0) {
          warningMessage += `\n\n${suggestionLabel}:\n`;
          for (const amount of suggestedAmounts) {
            const amountDisplay = formatTokenDisplay(amount, {
              decimals: tokenContext.tokenDecimals,
            });
            warningMessage += `• ${amountDisplay} ${tokenContext.tokenTicker}`;
            if (tokenPriceUSD) {
              const usdFormatted = formatUsdValue(amount * tokenPriceUSD, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
                fallback: "0.0",
              });
              warningMessage += ` ($${usdFormatted})`;
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

        await safeAnswerCallbackQuery(ctx);
      } catch (error) {
        console.error("Error in creator-protected back_to_amounts callback:", error);
        await safeAnswerCallbackQuery(ctx, "❌ Error going back");
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
        const telegramId = await getRequiredTelegramIdForContext(
          ctx,
          "type amount prompt"
        );
        if (telegramId == null) {
          await safeAnswerCallbackQuery(ctx, "Unable to identify user");
          return;
        }

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

        const formattedGameType = toTitleCase(gameType);

        const typeMessage = [
          `✏️ <b>Type Custom Amount - ${formattedGameType}</b>`,
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

        await safeAnswerCallbackQuery(ctx, "Type your amount...");

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
        await safeAnswerCallbackQuery(ctx, "❌ Error setting up text input");
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

        const formattedGameType = toTitleCase(gameType);
        const minPlayers = gameType === "coinflip" ? 2 : 1;
        const maxPlayers = Math.max(minPlayers, getOracleMaxPlayers());

        const playersMessage = [
          `👥 <b>Type Custom Players - ${formattedGameType}</b>`,
          "",
          `Amount: <b>${formattedAmount} ${tokenContext.tokenTicker}</b>`,
          "",
          "Please type the number of players for this game.",
          "",
          `Range: ${minPlayers}-${maxPlayers} players`
        ].join("\n");

        await respondWithMenu(ctx, {
          text: playersMessage,
          parseMode: "HTML",
          keyboard: new InlineKeyboard()
            .text("❌ Cancel", `cancel_game_setup_${creatorId}`)
            .row(),
        });

        await safeAnswerCallbackQuery(ctx, "Type the number of players...");

        updateSession({
          waitingFor: "players_input",
          gameType,
          userBalance: 0,
          amount,
          messageId: ctx.callbackQuery?.message?.message_id || 0,
          chatId: ctx.chat?.id || 0,
          contractMinimum: session?.contractMinimum,
          maxPlayersLimit: maxPlayers,
        });
      } catch (error) {
        console.error("Error in creator-protected custom_players callback:", error);
        await safeAnswerCallbackQuery(ctx, "❌ Error setting up players input");
      }
    }
  )
);

// No-op callback (for display-only buttons)
bot.callbackQuery("noop", async (ctx) => {
  await safeAnswerCallbackQuery(ctx);
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
        await safeAnswerCallbackQuery(ctx, "Cancelled");
      } catch (error) {
        console.error("Error in creator-protected cancel callback:", error);
        await safeAnswerCallbackQuery(ctx, "❌ Error cancelling");
      }
    }
  )
);

// Text input handler for custom amounts
const handleGameSetupTextInput = async (
  ctx: Context,
  next: NextFunction
) => {
  try {
    const telegramIdNumeric = Number(getTelegramId(ctx));
    if (telegramIdNumeric === 0) {
      return await next();
    }

    // Check if the message is a reply to a prompting message
    const replyToMessageId = ctx.message?.reply_to_message?.message_id;
    if (!replyToMessageId) {
      return await next();
    }

    // Construct session key from chat and message ID
    const sessionKey = `${ctx.chat?.id || 0}_${replyToMessageId}`;

    // Check if user is in a session waiting for input
    const userSession = userSessions.get(sessionKey);

    if (!userSession || (userSession.waitingFor !== "amount_input" && userSession.waitingFor !== "players_input")) {
      return await next(); // Not waiting for input, pass to other handlers
    }

    // Keep user's message (avoid deleting to preserve reply chain)

    // Clear the session temporarily while we process the input. We'll
    // restore it on validation errors so the flow keeps the original token
    // context instead of falling back to the (potentially changed) chat
    // default token.
    const sessionSnapshot = { ...userSession };
    const restoreSession = (overrides: Partial<GameSetupSession> = {}) => {
      userSessions.set(sessionKey, {
        ...sessionSnapshot,
        ...overrides,
      });
    };
    userSessions.delete(sessionKey);

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

    const messageText = ctx.message?.text;

    if (!messageText) {
      restoreSession();
      return await next();
    }

    const inputText = messageText.trim();

    // Handle players input
    if (userSession.waitingFor === "players_input") {
      const players = parseInt(inputText);
      const minPlayers =
        userSession.gameType === "coinflip" ? 2 : 1;
      const maxPlayers = Math.max(
        minPlayers,
        userSession.maxPlayersLimit ?? getOracleMaxPlayers()
      );

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
        restoreSession({ waitingFor: "players_input" });
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

      const formattedGameType = toTitleCase(userSession.gameType);

      const confirmMessage = [
        `<b>Confirm ${formattedGameType}</b>`,
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

      updateGameSetupSession(sessionKey, {
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
        maxPlayersLimit: maxPlayers,
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
      restoreSession({ waitingFor: "amount_input" });
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
      restoreSession({ waitingFor: "amount_input" });
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
      restoreSession({ waitingFor: "amount_input" });
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

      const formattedGameTypeForPlayers = toTitleCase(userSession.gameType);

      const playerMessage = [
        `<b>${formattedGameTypeForPlayers} - Choose Players</b>`,
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

    updateGameSetupSession(sessionKey, {
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
};

bot.on("message:text", handleGameSetupTextInput);

export const __test_handleGameSetupTextInput = handleGameSetupTextInput;


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

type CallbackPrefixHandlerOptions = {
  logLabel?: string;
  errorAck?: string;
};

type CallbackPrefixContext = {
  raw: string;
  payload: string;
};

const registerCallbackPrefixHandler = (
  prefix: string,
  handler: (
    ctx: any,
    data: CallbackPrefixContext,
    next: () => Promise<void>
  ) => Promise<void> | void,
  options: CallbackPrefixHandlerOptions = {}
) => {
  bot.on("callback_query", async (ctx, next) => {
    const callbackData = ctx.callbackQuery?.data;
    if (!callbackData?.startsWith(prefix)) {
      return await next();
    }

    const payload = callbackData.slice(prefix.length);

    try {
      await handler(ctx, { raw: callbackData, payload }, () => next());
    } catch (error) {
      console.error(
        `Error in ${options.logLabel ?? `${prefix} handler`}:`,
        error
      );
      if (options.errorAck) {
        await safeAnswerCallbackQuery(ctx, options.errorAck);
      }
    }
  });
};

// ================================
// WALLET ACTION HANDLERS
// ================================

type WalletActionMenuResolution = {
  menuOptions: Omit<BuildWalletActionMenuForUserOptions, "ctx">;
  successAck?: string;
};

type WalletActionMenuHandlerConfig = {
  callback: string;
  logLabel?: string;
  errorAck: string;
  resolve: (ctx: any) => Promise<WalletActionMenuResolution | null | undefined>;
};

const registerWalletActionMenuHandler = ({
  callback,
  logLabel,
  errorAck,
  resolve,
}: WalletActionMenuHandlerConfig) => {
  bot.callbackQuery(callback, async (ctx) => {
    try {
      const resolution = await resolve(ctx);
      if (!resolution) {
        return;
      }

      const { menu } = await buildWalletActionMenuForUser({
        ctx,
        ...resolution.menuOptions,
      });

      await respondWithMenu(ctx, menu);

      if (resolution.successAck) {
        await safeAnswerCallbackQuery(ctx, resolution.successAck);
      }
    } catch (error) {
      console.error(`Error in ${logLabel ?? callback}:`, error);
      await safeAnswerCallbackQuery(ctx, errorAck);
    }
  });
};

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

bot.callbackQuery("cmd_privatekey", async (ctx) => {
  try {
    // Only show private key in private chats for security
    if (ctx.chat?.type !== "private") {
      await safeAnswerCallbackQuery(ctx,
        "❌ Private key only available in private chat"
      );
      return;
    }

    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "show private key"
    );
    if (telegramId == null) {
      await respondMissingIdentity(ctx);
      return;
    }
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
    await safeAnswerCallbackQuery(ctx, "🔐 Private key shown");
  } catch (error) {
    console.error("Error in cmd_privatekey:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error showing private key");
  }
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
          tokenBalances.find((token) => token.mint === WSOL_MINT)?.balance ?? 0;
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
    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "unwrap menu"
    );
    if (telegramId == null) {
      await respondMissingIdentity(ctx);
      return null;
    }

    const balances = await getCachedWalletData(telegramId);
    const hasBalance = balances.wsolBalance > 0;

    return {
      menuOptions: {
        title: `🧼 <b>Unwrap WSOL</b>`,
        bodyLines: ({ solBalance, tokenBalances }) => {
          const wsolLamports =
            tokenBalances.find((token) => token.mint === WSOL_MINT)?.balance ?? 0;
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

// Handle custom wrap amount
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (callbackData !== "wrap_custom") {
    return await next();
  }

  try {
    const userId = getTelegramIdString(ctx);
    if (!userId) return;

    console.log("🔔 Custom wrap amount requested");

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
  } catch (error) {
    console.error("Error in wrap_custom:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error processing custom amount");
  }
});

registerCallbackPrefixHandler("wrap_amount_", async (ctx, { payload }) => {
  try {
    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "wrap amount selection"
    );
    if (telegramId == null) {
      await respondMissingIdentity(ctx);
      return;
    }

    const amountChoice = payload;
    const { nativeSolBalance, wsolBalance } = await getCachedWalletData(telegramId);
    const availableSolLamports = nativeSolBalance;

    const spend = resolveSpendAmount({
      amount: amountChoice,
      assetTicker: "SOL",
      inputDecimals: 9,
      solBalance: availableSolLamports,
      formatSol: (lamports) => wallet.formatSolBalance(lamports),
      formatToken: (value, decimals) =>
        wallet.formatTokenBalance(value, decimals),
    });

    const lamportsToWrap = spend.rawAmount;

    if (!Number.isFinite(lamportsToWrap) || lamportsToWrap <= 0) {
      throw new Error("Amount is too small to wrap");
    }

    const displayAmount = wallet.formatSolBalance(lamportsToWrap);
    console.log(`🔧 Wrap amount selected: ${displayAmount} SOL`);
    const availableSolDisplay = wallet.formatSolBalance(availableSolLamports);
    const currentWsolDisplay = wallet.formatSolBalance(wsolBalance);

    const selection = amountChoice.trim().toUpperCase();
    const response = [
      `✅ <b>Wrap Confirmation</b>`,
      "",
      `<b>Amount:</b> ${escapeHtml(displayAmount)} SOL → WSOL`,
      `<b>Available SOL:</b> ${escapeHtml(availableSolDisplay)}`,
      `<b>Current WSOL:</b> ${escapeHtml(currentWsolDisplay)}`,
      "",
    ];

    if (selection === "MAX" || selection.endsWith("%")) {
      response.push(
        `<b>Selection:</b> ${escapeHtml(selection)} of available SOL`,
        ""
      );
    }

    response.push(
      `⚠️ <b>Please confirm this transaction</b>`,
      `This will convert ${escapeHtml(displayAmount)} SOL to ${escapeHtml(
        displayAmount
      )} WSOL.`
    );

    await respondWithMenu(ctx, {
      text: response.join("\n"),
      keyboard: createConfirmWrapKeyboard(lamportsToWrap),
    });

    await safeAnswerCallbackQuery(ctx, `Wrap ${displayAmount} SOL`);
  } catch (error) {
    console.error("Error in wrap amount selection:", error);
    const message =
      error instanceof Error ? error.message : "Error processing wrap amount";
    await safeAnswerCallbackQuery(ctx, `❌ ${message}`);
  }
});

bot.callbackQuery("unwrap_confirm", async (ctx) => {
  try {
    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "unwrap confirmation"
    );
    if (telegramId == null) {
      await respondMissingIdentity(ctx);
      return;
    }
    const { wsolBalance } = await getCachedWalletData(telegramId);

    const result = await executeUnwrapFlow(telegramId, {
      expectedAmountLamports: wsolBalance,
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
        const amountLabel = escapeHtml(formattedAmount ?? "0");
        const { text, disablePreview } = buildSolscanSuccessMessage({
          title: "✅ <b>Unwrap Completed</b>",
          bodyLines: [`Unwrapped ${amountLabel} WSOL to SOL`],
          signature,
        });

        await respondWithMenu(ctx, {
          text,
          keyboard: createBackToWalletKeyboard(),
          disableLinkPreview: disablePreview,
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

// Handle send confirmation
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

    console.log(
      `✅ Confirmed send: ${amountSummary} to ${transaction.address}`
    );

    // Update message to show processing state
    await respondWithMenu(ctx, {
      text: `🔄 <b>Processing Transaction</b>\n\nSending ${escapeHtml(
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

      const { message: viewLine } = buildTransactionLinkMessage({
        signature: txSignature,
        networkOverride: process.env["RPC_URL"],
        label: "🔗 ",
        linkText: "View on Solscan",
        format: "html",
      });

      const successMessage = (() => {
        if (
          withdrawAllResult &&
          transaction.token === "SOL" &&
          transaction.amount === "max"
        ) {
          const details: string[] = [
            `✅ <b>Transaction Completed</b>`,
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
            ""
          );

          if (viewLine) {
            details.push(viewLine);
          }

          return details.join("\n");
        }

        const baseMessage = `✅ <b>Transaction Completed</b>\n\nSent ${formattedAmount} ${transaction.token}\nTo: <code>${transaction.address}</code>`;
        return viewLine ? `${baseMessage}\n\n${viewLine}` : baseMessage;
      })();

      await respondWithMenu(ctx, {
        text: successMessage,
        keyboard: createBackToWalletKeyboard(),
      });
    } catch (txError) {
      console.error("Transaction failed:", txError);
      await respondWithMenu(ctx, {
        text: `❌ <b>Transaction Failed</b>\n\n${
          (txError as Error).message
        }\n\nPlease try again.`,
        keyboard: createBackToWalletKeyboard(),
      });
    }

    await safeAnswerCallbackQuery(ctx, "✅ Transaction submitted");
  } catch (error) {
    console.error("Error in send confirmation:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error processing transaction");
  }
});

// Handle wrap confirmation
bot.callbackQuery(/^confirm_wrap_/, async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery?.data || "";
    const lamportsRaw = callbackData.replace("confirm_wrap_", "");
    const lamportsToWrap = Number.parseInt(lamportsRaw, 10);

    if (!Number.isFinite(lamportsToWrap) || lamportsToWrap <= 0) {
      throw new Error("Invalid wrap amount");
    }

    const formattedAmount = wallet.formatSolBalance(lamportsToWrap);
    console.log(`✅ Confirmed wrap: ${formattedAmount} SOL`);

    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "wrap confirmation"
    );
    if (telegramId == null) {
      await respondMissingIdentity(ctx);
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

    if (result.status === "success") {
      await safeAnswerCallbackQuery(ctx, "✅ Wrap transaction submitted");
    } else if (result.status === "insufficient") {
      await safeAnswerCallbackQuery(ctx, "❌ Insufficient SOL for wrap");
    } else {
      await safeAnswerCallbackQuery(ctx, "❌ Error processing wrap");
    }
  } catch (error) {
    console.error("Error in wrap confirmation:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error processing wrap");
  }
});

// Handle swap confirmation
bot.callbackQuery(/^confirm_swap_/, async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery?.data || "";
    const txId = callbackData.replace("confirm_swap_", "");

    const validation = validatePendingTransaction<PendingSwapTransaction>(
      ctx,
      txId,
      "swap"
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
      let pumpFunSignature: string | null = null;
      const keypair = wallet.getKeyPair(BigInt(transaction.userId));
      const parsedSlippageBps = Number((transaction as any).slippageBps);
      const slippageBps = Number.isFinite(parsedSlippageBps)
        ? parsedSlippageBps
        : SWAP_DEFAULT_SLIPPAGE_BPS;

      const rawInputDecimals =
        (transaction as any).inputDecimals ?? (quote as any).inputDecimals;
      const inferredInputDecimals = Number(rawInputDecimals);
      const inputDecimals = Number.isFinite(inferredInputDecimals)
        ? inferredInputDecimals
        : 9;

      const rawOutputDecimals =
        (transaction as any).outputDecimals ?? (quote as any).outputDecimals;
      const inferredOutputDecimals = Number(rawOutputDecimals);
      const outputDecimals = Number.isFinite(inferredOutputDecimals)
        ? inferredOutputDecimals
        : 9;

      if (quote.provider === "jupiter") {
        // Use Jupiter execution method (same as original implementation)
        txSignature = await swapManager.executeJupiterSwap(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            amount: quote.inputAmount, // Use inputAmount from quote like original
            slippageBps,
            userKeypair: keypair,
            inputDecimals,
            outputDecimals,
            inputTicker: transaction.fromToken?.toUpperCase() || "UNKNOWN",
            outputTicker: transaction.toToken?.toUpperCase() || "UNKNOWN",
          },
          quote
        );
      } else if (quote.provider === "pump-fun+jupiter") {
        const result = await swapManager.executeCompositePumpFunJupiterSwap(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            amount: quote.inputAmount,
            slippageBps,
            userKeypair: keypair,
            inputDecimals,
            outputDecimals,
            inputTicker: transaction.fromToken?.toUpperCase() || "UNKNOWN",
            outputTicker: transaction.toToken?.toUpperCase() || "UNKNOWN",
          },
          quote
        );
        console.log(`Pump.fun leg signature: ${result.pumpSignature}`);
        pumpFunSignature = result.pumpSignature;
        txSignature = result.jupiterSignature;
      } else {
        // Use instruction-based approach for other providers
        const instructions = await swapManager.createSwapTransaction(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            amount: quote.inputAmount, // Use inputAmount from quote like original
            slippageBps,
            userKeypair: keypair,
            inputDecimals,
            outputDecimals,
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

      const receivedDisplay = formatAmount(
        quote.outputAmount ?? "0",
        outputDecimals,
        {
          maxFractionDigits: Math.min(outputDecimals, 6),
          trim: true,
        }
      );

      const successLines = [
        `✅ <b>Swap Completed</b>`,
        "",
        `Swapped ${transaction.amount} ${transaction.fromToken}`,
        `Received ~${receivedDisplay} ${transaction.toToken}`,
      ];

      const linkLines: string[] = [];

      if (pumpFunSignature) {
        const { message: pumpLink } = buildTransactionLinkMessage({
          signature: pumpFunSignature,
          networkOverride: process.env["RPC_URL"],
          label: "🔗 Pump.fun: ",
          linkText: "View leg",
          format: "html",
        });
        if (pumpLink) {
          linkLines.push(pumpLink);
        }
      }

      const { message: jupiterLink } = buildTransactionLinkMessage({
        signature: txSignature,
        networkOverride: process.env["RPC_URL"],
        label: pumpFunSignature ? "🔗 Jupiter: " : "🔗 ",
        linkText: pumpFunSignature ? "View leg" : "View on Solscan",
        format: "html",
      });
      if (jupiterLink) {
        linkLines.push(jupiterLink);
      }

      if (linkLines.length > 0) {
        successLines.push("", ...linkLines);
      }

      const successText = successLines.join("\n");
      await respondWithMenu(ctx, {
        text: successText,
        parseMode: "HTML",
        keyboard: createBackToWalletKeyboard(),
      });
    } catch (swapError) {
      console.error("Swap transaction failed:", swapError);
      await respondWithMenu(ctx, {
        text: `❌ <b>Swap Failed</b>\n\n${
          (swapError as Error).message
        }\n\nPlease try again.`,
        parseMode: "HTML",
        keyboard: createBackToWalletKeyboard(),
      });
    }

    await safeAnswerCallbackQuery(ctx, "✅ Swap submitted");
  } catch (error) {
    console.error("Error in swap confirmation:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error processing swap");
  }
});

registerWalletActionMenuHandler({
  callback: "cmd_swap",
  logLabel: "cmd_swap",
  errorAck: "❌ Error loading swap menu",
  resolve: async () => ({
    menuOptions: {
      title: `💱 <b>Swap Tokens</b>`,
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
    },
    successAck: "💱 Select token to swap from",
  }),
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
  nativeSolBalance: number;
  wsolBalance: number;
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
    const nativeSolBalance = solBalance;
    const approvedTokens = tokenManager
      ? tokenManager.getAllApprovedTokensWithMetadata()
      : [];
    let tokenBalances = await wallet.getAllApprovedTokenBalances(
      telegramId,
      approvedTokens
    );

    const wsolToken = tokenBalances.find((token) => token.mint === WSOL_MINT);
    const wsolBalance = wsolToken?.balance ?? 0;

    // Merge WSOL into SOL using util
    const merged = mergeWsolIntoSol(solBalance, tokenBalances, WSOL_MINT);
    solBalance = merged.solLamports;
    tokenBalances = merged.tokenBalances;

    const data: CachedWalletData = {
      solBalance,
      nativeSolBalance,
      wsolBalance,
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
  const telegramId = requireTelegramId(ctx, "wallet action menu");
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
registerCallbackPrefixHandler("send_select_", async (ctx, { payload: token }) => {
  console.log("🔔 Token selected for send:", token);

  try {
    const { menu } = await buildWalletActionMenuForUser({
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
          baseCallback: (value) => `send_amount_${token}_${value.toUpperCase()}`,
          customLabel: "✏️ Custom Amount",
          backCallback: "cmd_withdraw",
        }),
      },
    });

    await respondWithMenu(ctx, menu);
    await safeAnswerCallbackQuery(ctx, `Selected ${token}`);
  } catch (error) {
    console.error("Error in send token selection:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error processing selection");
  }
});

// Handle amount selection for send
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
          ? [`• <code>0.5</code>`, `• <code>1.25</code>`]
          : [`• <code>1000</code>`, `• <code>250.5</code>`];

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

    const telegramId = await getRequiredTelegramIdForContext(
      ctx,
      "send amount selection"
    );
    if (telegramId == null) {
      await respondMissingIdentity(ctx);
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

    const exampleAddress = tryGetUserWalletAddress(telegramId);

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
      response.push(
        `<b>Example:</b> <code>${escapeHtml(exampleAddress)}</code>`
      );
    }

    response.push("", INPUT_TIMEOUT_HINT);

    await respondWithMenu(ctx, {
      text: response.join("\n"),
      keyboard: createCancelKeyboard(`send_select_${token}`),
    });

    setUserState(userId, {
      type: "send_address",
      token,
      amount: storedAmount,
      amountDisplay: displayLabel,
      messageId: ctx.callbackQuery?.message?.message_id,
      chatId: ctx.chat?.id,
    });

    await safeAnswerCallbackQuery(ctx, `Selected ${displayLabel}`);
  } catch (error) {
    console.error("Error in send amount selection:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error processing amount");
  }
});




// Handle "GET STARTED" button from bot info screen - triggers /start
bot.callbackQuery("start_bot", async (ctx) => {
  try {
    if (ctx.chat?.id) {
      initiatedChats.add(ctx.chat.id);
    }

    await onBalance(ctx as any, createBalanceDeps());
    await safeAnswerCallbackQuery(ctx, "🚀 Welcome to TIMBA!");
  } catch (error) {
    console.error("Error in start_bot:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error loading main menu");
  }
});


// ================================
// HELP MENU CALLBACKS
// ================================

bot.callbackQuery("cmd_help", async (ctx) => {
  try {
    const helpContent = "❓ <b>Help Center</b>\n\n" + "Choose a category to get detailed help:";
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
    await safeAnswerCallbackQuery(ctx, "❓ Help Center");
  } catch (error) {
    console.error("Error in cmd_help:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error loading help");
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
      "<code>/withdraw [address] 50 TIMBA</code>\n" +
      "<code>/wrap 1</code> (converts 1 SOL to WSOL)\n\n" +
      "<code>/unwrap</code> (convert your entire WSOL balance back to SOL)\n\n" +
      "<b>🎮 Game Examples:</b>\n" +
      "<code>/coinflip 100 TIMBA 2</code> (2-player, 100 TIMBA each)\n" +
      "<code>/giveaway 500 TIMBA 5</code> (5 players, 500 TIMBA prize)\n\n" +
      "<b>🔧 Utility Examples:</b>\n" +
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
  await safeAnswerCallbackQuery(ctx, config.ack);
};

const HELP_SECTION_CALLBACKS: Array<{
  callback: string;
  section: HelpSectionKey;
  errorAck: string;
}> = [
  {
    callback: "help_wallet",
    section: "wallet",
    errorAck: "❌ Error loading wallet help",
  },
  {
    callback: "help_games",
    section: "games",
    errorAck: "❌ Error loading games help",
  },
  {
    callback: "help_utility",
    section: "utility",
    errorAck: "❌ Error loading utility help",
  },
  {
    callback: "help_examples",
    section: "examples",
    errorAck: "❌ Error loading examples",
  },
];

for (const { callback, section, errorAck } of HELP_SECTION_CALLBACKS) {
  bot.callbackQuery(callback, async (ctx) => {
    try {
      await showHelpSection(ctx, section);
    } catch (error) {
      console.error(`Error in ${callback}:`, error);
      await safeAnswerCallbackQuery(ctx, errorAck);
    }
  });
}



// ================================
// ADMIN MENU CALLBACKS
// ================================




// (Removed admin placeholder handlers)

// Handle SELL token selection
// SWAP INTERFACE HANDLERS
// ================================

// Handle "FROM" token selection for swap
registerCallbackPrefixHandler(
  "swap_from_",
  async (ctx, { payload: fromToken }) => {
    console.log("🔔 Swap FROM token selected:", fromToken);

    try {
      const telegramId = await getRequiredTelegramIdForContext(
        ctx,
        "swap menu from token"
      );
      if (telegramId == null) {
        await respondMissingIdentity(ctx);
        return;
      }
      const keypair = wallet.getKeyPair(telegramId);
      const walletAddress = keypair.publicKey.toBase58();
      const walletAddressHtml = escapeHtml(walletAddress);

      await getCachedWalletData(telegramId);

      const response = [
        `💱 <b>Swap ${fromToken}</b>`,
        "",
        `<b>From:</b> <code>${walletAddressHtml}</code>`,
        "",
        `<b>Select token to swap TO:</b>`,
      ];

      const keyboard = new InlineKeyboard();

      if (fromToken !== "SOL") {
        keyboard.text(`SOL`, `swap_to_${fromToken}_SOL`).row();
      }

      const popularTokens = ["USDC", "WSOL", "TIMBA"];
      for (const token of popularTokens) {
        if (token !== fromToken) {
          keyboard.text(`${token}`, `swap_to_${fromToken}_${token}`).row();
        }
      }

      keyboard.text("🔍 Other Token", `swap_to_${fromToken}_OTHER`).row();
      keyboard.text("← Back to Swap", "cmd_swap").row();

      await respondWithMenu(ctx, {
        text: response.join("\n"),
        parseMode: "HTML",
        keyboard,
      });
      await safeAnswerCallbackQuery(ctx, `Select token to receive`);
    } catch (error) {
      console.error("Error in swap_from selection:", error);
      await safeAnswerCallbackQuery(ctx, "❌ Error processing swap selection");
    }
  },
  { logLabel: "swap_from" }
);

// Handle "TO" token selection for swap
registerCallbackPrefixHandler(
  "swap_to_",
  async (ctx, { payload }, next) => {
    const parts = payload.split("_");
    if (parts.length < 2) {
      await next();
      return;
    }

    const fromToken = parts[0];
    const toToken = parts.slice(1).join("_");

    if (!fromToken || !toToken) {
      await safeAnswerCallbackQuery(ctx, "❌ Invalid swap pair");
      return;
    }

    console.log(`🔔 Swap pair selected: ${fromToken} → ${toToken}`);

    try {
      if (toToken === "OTHER") {
        const userId = getTelegramIdString(ctx);
        if (!userId) return;

        const response = [
          `🔍 <b>Custom Token</b>`,
          "",
          `Swapping FROM: <b>${fromToken}</b>`,
          "",
          `Reply to this message with the token mint address or symbol.`,
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
          keyboard: createCancelKeyboard("cmd_swap"),
        });

        setUserState(userId, {
          type: "swap_to_token",
          fromToken: fromToken,
          messageId: ctx.callbackQuery?.message?.message_id,
          chatId: ctx.chat?.id,
        });

        await safeAnswerCallbackQuery(ctx, "Send token mint or symbol");
        return;
      }

      const cachedEntry = transactionCache.get(toToken);
      if (isTokenSelectionCacheEntry(cachedEntry)) {
        const displayToken = cachedEntry.tokenMetadata?.symbol ?? cachedEntry.targetToken;
        await showSwapAmountSelection(ctx, fromToken, displayToken, {
          toTokenIdentifier: toToken,
        });
        await safeAnswerCallbackQuery(ctx, `${fromToken} → ${displayToken}`);
        return;
      }

      const normalizedTarget = toToken.toUpperCase();
      await showSwapAmountSelection(ctx, fromToken, normalizedTarget, {
        toTokenIdentifier: normalizedTarget,
      });
      await safeAnswerCallbackQuery(ctx, `${fromToken} → ${normalizedTarget}`);
    } catch (error) {
      console.error("Error in swap_to selection:", error);
      await safeAnswerCallbackQuery(ctx, "❌ Error processing swap pair");
    }
  },
  { logLabel: "swap_to" }
);

// Handle swap amount selection
registerCallbackPrefixHandler(
  "swap_amount_",
  async (ctx, { payload }, next) => {
    const parts = payload.split("_");
    if (parts.length < 3) {
      await next();
      return;
    }

    const fromToken = parts[0];
    const toTokenIdentifier = parts[1];
    const amount = parts.slice(2).join("_");

    if (!fromToken || !toTokenIdentifier || !amount) {
      await safeAnswerCallbackQuery(ctx, "❌ Invalid swap parameters");
      return;
    }

    console.log(
      `🔔 Swap amount selected: ${amount} ${fromToken} → ${toTokenIdentifier}`
    );

    try {
      const cachedTarget = transactionCache.get(toTokenIdentifier);
      const isCachedSelection = isTokenSelectionCacheEntry(cachedTarget);
      const displayToToken = isCachedSelection
        ? cachedTarget.tokenMetadata?.symbol ?? cachedTarget.targetToken
        : toTokenIdentifier.toUpperCase();

      if (amount === "CUSTOM") {
        const userId = getTelegramIdString(ctx);
        if (!userId) return;

        await showCustomAmountPrompt({
          ctx,
          userId,
          title: "✏️ <b>Custom Amount</b>",
          tokenLines: [
            `<b>Swap:</b> ${escapeHtml(fromToken)} → ${escapeHtml(displayToToken)}`,
          ],
          instructions: [
            `Reply to this message with the amount of ${escapeHtml(
              fromToken
            )} to swap.`,
          ],
          examples: [
            "• <code>10</code>",
            "• <code>0.5</code>",
            "• <code>max</code> (all balance)",
          ],
          cancelCallback: `swap_to_${fromToken}_${toTokenIdentifier}`,
          state: {
            type: "swap_custom_amount",
            fromToken,
            toToken: toTokenIdentifier,
          },
        });

        await safeAnswerCallbackQuery(ctx, "Send amount as message");
        return;
      }

      const telegramId = await getRequiredTelegramIdForContext(
        ctx,
        "swap amount selection"
      );
      if (telegramId == null) {
        await respondMissingIdentity(ctx);
        return;
      }
      const quoteOverrides: {
        toMint?: string;
        toDecimals?: number;
      } = {};

      if (isCachedSelection && cachedTarget) {
        quoteOverrides.toMint = cachedTarget.targetTokenAddress;
        quoteOverrides.toDecimals = cachedTarget.tokenMetadata?.decimals;
      }

      await showSwapQuoteAndConfirmation(
        ctx,
        fromToken,
        displayToToken,
        amount,
        telegramId,
        {
          toMint: quoteOverrides.toMint,
          toDecimals: quoteOverrides.toDecimals,
        }
      );
      await safeAnswerCallbackQuery(ctx, "Getting swap quote...");
    } catch (error) {
      console.error("Error in swap amount selection:", error);
      await safeAnswerCallbackQuery(ctx, "❌ Error processing swap amount");
    }
  },
  { logLabel: "swap_amount" }
);

/**
 * Show swap amount selection interface
 */
const showSwapAmountSelection = async (
  ctx: any,
  fromToken: string,
  toToken: string,
  options: { toTokenIdentifier?: string } = {}
) => {
  const telegramId = requireTelegramId(ctx, "swap amount selection");

  // Get balance for the FROM token
  const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

  const { decimalBalance: balanceDecimal, formattedBalance } =
    resolveFormattedBalance(fromToken, solBalance, tokenBalances);

  const response = [
    `💱 <b>Swap Amount</b>`,
    "",
    `<b>From:</b> ${fromToken} (${formattedBalance})`,
    `<b>To:</b> ${toToken}`,
    "",
    `<b>Select amount to swap:</b>`,
  ];

  const canTrade = balanceDecimal > 0;

  const toTokenIdentifier = options.toTokenIdentifier ?? toToken;

  const keyboard = buildQuickAmountKeyboard({
    baseCallback: (value) =>
      `swap_amount_${fromToken}_${toTokenIdentifier}_${value}`,
    backCallback: `swap_to_${fromToken}_${toTokenIdentifier}`,
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
  telegramId?: bigint,
  overrides: {
    fromMint?: string;
    fromDecimals?: number;
    toMint?: string;
    toDecimals?: number;
  } = {}
) => {
  const userId = telegramId || getTelegramId(ctx);
  const cancelCallback = `swap_to_${fromToken}_${toToken}`;
  const selectedSlippageBps = getUserSwapSlippageBps(userId.toString());

  try {
    await prepareTokenTradeQuoteRunner({
      ctx,
      telegramId: userId,
      amountInput: amount,
      kind: "swap",
      inputFactory: async ({ tokenBalances }) => {
        const inputMint =
          overrides.fromMint ?? tokenManager.resolveMintForTicker(fromToken);
        if (!inputMint) {
          throw new Error(`Unsupported token pair: ${fromToken} → ${toToken}`);
        }

        const balanceEntry =
          fromToken === "SOL"
            ? undefined
            : tokenBalances.find((t) => t.ticker === fromToken);
        const decimals =
          overrides.fromDecimals ??
          (fromToken === "SOL"
            ? 9
            : balanceEntry?.decimals ??
              (await wallet.getTokenMetadata(inputMint)).decimals);

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
        const outputMint =
          overrides.toMint ?? tokenManager.resolveMintForTicker(toToken);
        if (!outputMint) {
          throw new Error(`Unsupported token pair: ${fromToken} → ${toToken}`);
        }
        const decimals =
          overrides.toDecimals ??
          (toToken === "SOL"
            ? 9
            : (await wallet.getTokenMetadata(outputMint)).decimals);

        return {
          ticker: toToken,
          mint: outputMint,
          decimals,
        };
      },
      spinnerText: ({ displayAmount }) =>
        `🔄 <b>Getting Quote</b>\n\n${displayAmount} ${fromToken} → ${toToken}\n\n<i>Please wait...</i>`,
      cacheQuote: (txId, quote, context) => {
        storePendingTransaction(txId, {
          type: "swap",
          fromToken,
          toToken,
          cancelCallback,
          amount: context.displayAmount,
          rawAmount: context.rawAmount.toString(),
          inputDecimals: context.input.decimals,
          outputDecimals: context.output.decimals,
          userId: userId.toString(),
          slippageBps: selectedSlippageBps,
          quote,
        });
      },
      buildConfirmationKeyboard: (txId) =>
        buildSwapConfirmationKeyboard({
          txId,
          cancelCallback,
          selectedSlippageBps,
        }),
      onError: async (error) => {
        const { text, keyboard } = renderTradeQuoteError("swap", {
          error,
          retryCallback: cancelCallback,
        });
        await respondWithMenu(ctx, { text, keyboard });
      },
      quoteOptions: { slippageBps: selectedSlippageBps },
      quoteErrorMessage: `Cannot get quote for ${fromToken} → ${toToken}`,
    });
  } catch (error) {
    console.error("Error getting swap quote:", error);
    const { text, keyboard } = renderTradeQuoteError("swap", {
      error,
      retryCallback: cancelCallback,
    });
    await respondWithMenu(ctx, { text, keyboard });
  }
};

bot.callbackQuery(/^swap_slippage_/, async (ctx) => {
  const data = ctx.callbackQuery?.data ?? "";
  const match = data.match(/^swap_slippage_(\d+)_([A-Za-z0-9_-]+)$/);

  if (!match) {
    await safeAnswerCallbackQuery(ctx, "❌ Invalid slippage option");
    return;
  }

  const slippageBps = Number(match[1]);
  const rawTxId = match[2];

  if (!rawTxId) {
    await safeAnswerCallbackQuery(ctx, "❌ Invalid transaction reference");
    return;
  }

  const txId = rawTxId;

  if (!SWAP_SLIPPAGE_OPTIONS_BPS.some((value) => value === slippageBps)) {
    await safeAnswerCallbackQuery(ctx, "❌ Unsupported slippage option");
    return;
  }

  const pendingEntry = getPendingTransaction<
    PendingSwapTransaction & { timestamp?: number }
  >(txId, false);

  if (!pendingEntry || pendingEntry.type !== "swap") {
    await safeAnswerCallbackQuery(ctx, "❌ Swap quote expired");
    return;
  }

  const currentUserId = getTelegramIdString(ctx);
  if (!currentUserId || pendingEntry.userId !== currentUserId) {
    await safeAnswerCallbackQuery(ctx, "❌ Unauthorized");
    return;
  }

  const pending = pendingEntry;

  const pendingUserId: string = pending.userId;
  const cancelCallback: string =
    pending.cancelCallback ??
    `swap_to_${pending.fromToken ?? "UNKNOWN"}_${pending.toToken ?? "UNKNOWN"}`;

  try {
    const previousQuote = pending.quote;
    if (!previousQuote) {
      await safeAnswerCallbackQuery(ctx, "❌ Quote unavailable");
      return;
    }

    setUserSwapSlippageBps(pendingUserId, slippageBps);

    const amountForQuote = pending.rawAmount ?? previousQuote.inputAmount;
    if (!amountForQuote) {
      await safeAnswerCallbackQuery(ctx, "❌ Invalid amount for quote");
      return;
    }

    const quote = await swapManager.getQuote({
      inputMint: previousQuote.inputMint,
      outputMint: previousQuote.outputMint,
      amount: amountForQuote,
      slippageBps,
      userKeypair: wallet.getKeyPair(BigInt(pendingUserId)),
      inputDecimals: pending.inputDecimals ?? 9,
      outputDecimals: pending.outputDecimals ?? 9,
      inputTicker: (pending.fromToken ?? "UNKNOWN").toUpperCase(),
      outputTicker: (pending.toToken ?? "UNKNOWN").toUpperCase(),
    });

    const summary = formatTradeConfirmationSummary({
      kind: "swap",
      payToken: pending.fromToken ?? quote.inputMint,
      payDisplay: pending.amount ?? "0",
      payRawAmount: Number(amountForQuote ?? 0),
      payDecimals: pending.inputDecimals ?? 9,
      receiveToken: pending.toToken ?? quote.outputMint,
      receiveDecimals: pending.outputDecimals ?? 9,
      quote,
    });

    const { timestamp: _timestamp, ...rest } = pending;

    storePendingTransaction(txId, {
      ...rest,
      userId: pendingUserId,
      slippageBps,
      quote,
    });

    const keyboard = buildSwapConfirmationKeyboard({
      txId,
      cancelCallback,
      selectedSlippageBps: slippageBps,
    });

    await respondWithMenu(ctx, {
      text: summary.message,
      parseMode: "HTML",
      keyboard,
    });

    await safeAnswerCallbackQuery(
      ctx,
      `Slippage set to ${formatSlippageOptionLabel(slippageBps)}`
    );
  } catch (error) {
    console.error("Error updating swap slippage:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Failed to update slippage");
  }
});

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
  const userId = getTelegramIdString(ctx);
  if (!userId) {
    return await next();
  }

  const userState = getUserState(userId, false); // Get state but DON'T clear it yet

  if (!userState) {
    return await next(); // Not waiting for input, continue to other handlers
  }

  // Only process input in the same chat where the state was created
  if (userState.chatId && ctx.chat?.id !== userState.chatId) {
    return await next();
  }

  // Check if the message is a reply to the prompting message
  if (!ctx.message?.reply_to_message || ctx.message.reply_to_message.message_id !== userState.messageId) {
    return await next(); // Not a reply to the prompting message, ignore
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
  const telegramId = requireTelegramId(ctx, "send custom amount");
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

  const exampleAddress = tryGetUserWalletAddress(telegramId);

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

  const messageText = response.join("\n");
  const keyboard = createCancelKeyboard(`send_select_${token}`);

  const targetChatId =
    typeof userState.chatId === "number"
      ? userState.chatId
      : typeof ctx.chat?.id === "number"
      ? ctx.chat.id
      : undefined;
  const targetMessageId =
    typeof userState.messageId === "number" ? userState.messageId : undefined;

  const menuResult = await upsertWalletMenuMessage({
    ctx,
    text: messageText,
    keyboard,
    parseMode: "HTML",
    targetChatId,
    targetMessageId,
    replyToMessageId: ctx.message?.message_id ?? undefined,
    logLabel: "handleCustomAmountInput",
  });

  if (telegramId === 0n) {
    return;
  }

  const resolvedMessageId = menuResult.messageId ?? targetMessageId;
  const resolvedChatId =
    menuResult.chatId ??
    targetChatId ??
    (typeof ctx.chat?.id === "number" ? ctx.chat.id : undefined);

  setUserState(telegramId.toString(), {
    type: "send_address",
    token,
    amount: storedAmount,
    amountDisplay: displayLabel,
    messageId: resolvedMessageId,
    chatId: resolvedChatId,
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

/**
 * Handle wrap amount input
 */
const handleWrapAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const trimmedAmount = amount.trim();
  const lamportsToWrap = toRawAmount(trimmedAmount, 9);

  if (!Number.isFinite(lamportsToWrap) || lamportsToWrap <= 0) {
    throw new Error("Invalid amount format");
  }

  const displayAmount = wallet.formatSolBalance(lamportsToWrap);

  console.log(`🔧 Wrap amount received: ${displayAmount} SOL`);

  const response = [
    `✅ <b>Wrap Confirmation</b>`,
    "",
    `<b>Amount:</b> ${escapeHtml(displayAmount)} SOL → WSOL`,
    "",
    `⚠️ <b>Please confirm this transaction</b>`,
    `This will convert ${escapeHtml(displayAmount)} SOL to ${escapeHtml(
      displayAmount
    )} WSOL.`,
  ];

  const messageText = response.join("\n");
  const keyboard = createConfirmWrapKeyboard(lamportsToWrap);
  const userId = getTelegramIdString(ctx);
  const targetChatId =
    typeof userState.chatId === "number"
      ? userState.chatId
      : typeof ctx.chat?.id === "number"
      ? ctx.chat.id
      : undefined;
  const targetMessageId =
    typeof userState.messageId === "number" ? userState.messageId : undefined;

  const menuResult = await upsertWalletMenuMessage({
    ctx,
    text: messageText,
    keyboard,
    parseMode: "HTML",
    targetChatId,
    targetMessageId,
    replyToMessageId: ctx.message?.message_id ?? undefined,
    logLabel: "handleWrapAmountInput",
  });

  if (userId) {
    const resolvedChatId =
      menuResult.chatId ??
      targetChatId ??
      (typeof ctx.chat?.id === "number" ? ctx.chat.id : undefined);
    const resolvedMessageId = menuResult.messageId ?? targetMessageId;

    setUserState(userId, {
      type: "wrap_custom_amount",
      chatId: resolvedChatId,
      messageId: resolvedMessageId,
    });
  }
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
  const telegramId = requireTelegramId(ctx, "swap token input");
  const userId = getTelegramId(ctx).toString();
  const trimmedInput = tokenInput.trim();

  console.log(
    `🔍 Token input received for swap from ${fromToken}: ${trimmedInput}`
  );

  if (!trimmedInput) {
    await respondWithMenu(ctx, {
      text: "❌ <b>Invalid input</b>\n\nPlease provide a token symbol or contract address.",
      parseMode: "HTML",
      keyboard: createCancelKeyboard(`swap_to_${fromToken}_OTHER`),
    });
    return;
  }

  const loadingLines = [
    "🔍 <b>Looking up token...</b>",
    "",
    `<b>Input:</b> ${escapeHtml(trimmedInput)}`,
    "",
    "<i>Please wait...</i>",
  ];

  await respondWithMenu(ctx, {
    text: loadingLines.join("\n"),
    parseMode: "HTML",
    keyboard: createCancelKeyboard(`swap_to_${fromToken}_OTHER`),
  });

  try {
    let metadata: SwapTokenMetadata | undefined;

    if (isProbableMintAddress(trimmedInput)) {
      metadata = await fetchSwapTokenMetadata(trimmedInput, telegramId);
    } else {
      const normalized = trimmedInput.toUpperCase();

      const mintFromTicker = tokenManager.resolveMintForTicker(normalized);
      if (mintFromTicker) {
        let decimals: number | undefined;
        try {
          const tokenMeta = await wallet.getTokenMetadata(mintFromTicker);
          if (tokenMeta && typeof tokenMeta === "object" && "decimals" in tokenMeta) {
            const value = Number((tokenMeta as any).decimals);
            if (Number.isFinite(value)) {
              decimals = value;
            }
          }
        } catch (error) {
          console.log("Metadata lookup failed for", normalized, error);
        }

        metadata = {
          symbol: normalized,
          address: mintFromTicker,
          decimals: decimals ?? 6,
          verified: true,
        };
      } else {
        const known = tokenManager
          .getAllKnownTokens()
          .find((token) => token.token_ticker?.toUpperCase() === normalized);

        if (known) {
          metadata = {
            symbol: known.token_ticker.toUpperCase(),
            address: known.token_mint,
            decimals: known.decimals ?? 6,
            verified: true,
          };
        }
      }

      if (!metadata) {
        throw new Error(
          `Token "${trimmedInput}" not found. Try using the contract address.`
        );
      }
    }

    if (!metadata) {
      throw new Error("Unable to resolve token metadata");
    }

    const tokenCacheId = createTokenLookupId();
    transactionCache.setWithTTL(tokenCacheId, {
      targetToken: metadata.symbol,
      targetTokenAddress: metadata.address,
      paymentToken: fromToken,
      tokenMetadata: metadata,
    });

    await showSwapAmountSelection(ctx, fromToken, metadata.symbol, {
      toTokenIdentifier: tokenCacheId,
    });

    getUserState(userId, true);
    await safeAnswerCallbackQuery(ctx, `Swap to ${metadata.symbol}`);
  } catch (error) {
    console.error("Error resolving swap token input:", error);

    const messageLines = [
      "❌ <b>Token Not Found</b>",
      "",
      `<b>Input:</b> ${escapeHtml(trimmedInput)}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid token symbol or paste a contract address.",
      "",
      `<b>Examples:</b>`,
      `• <code>USDC</code>`,
      `• <code>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code>`,
      "",
      `<b>Contract format:</b>\n${CONTRACT_EXAMPLE_LINES.join("\n")}`,
      "",
      INPUT_TIMEOUT_HINT,
    ];

  await respondWithMenu(ctx, {
    text: messageLines.join("\n"),
    parseMode: "HTML",
    keyboard: createCancelKeyboard(`swap_to_${fromToken}_OTHER`),
  });

    setUserState(userId, {
      type: "swap_to_token",
      fromToken,
      messageId: userState.messageId,
      chatId: userState.chatId,
    });
  }
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
  const telegramId = requireTelegramId(ctx, "swap custom amount");

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

const isProbableMintAddress = (value: string): boolean =>
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

type SwapTokenMetadata = {
  symbol: string;
  address: string;
  decimals: number;
  verified: boolean;
};

const fetchSwapTokenMetadata = async (
  contractAddress: string,
  telegramId?: bigint
): Promise<SwapTokenMetadata> => {
  if (!isProbableMintAddress(contractAddress)) {
    throw new Error("Invalid Solana contract address format");
  }

  if (telegramId) {
    try {
      const { tokenBalances } = await getCachedWalletData(telegramId);
      const owned = tokenBalances.find((token) => token.mint === contractAddress);
      if (owned) {
        return {
          symbol: owned.ticker,
          address: contractAddress,
          decimals: owned.decimals,
          verified: true,
        };
      }
    } catch (error) {
      console.log("Wallet balance lookup for metadata failed:", error);
    }
  }

  try {
    const metadata = await wallet.getTokenMetadata(contractAddress);
    if (metadata && typeof metadata === "object" && "symbol" in metadata) {
      const symbol = String((metadata as any).symbol ?? contractAddress).toUpperCase();
      const decimals = Number.isFinite((metadata as any).decimals)
        ? Number((metadata as any).decimals)
        : 6;
      return {
        symbol,
        address: contractAddress,
        decimals,
        verified: symbol !== contractAddress,
      };
    }
  } catch (error) {
    console.log("Token metadata fetch failed:", error);
  }

  return {
    symbol: contractAddress,
    address: contractAddress,
    decimals: 6,
    verified: false,
  };
};

export const __test_handleCustomAmountInput = handleCustomAmountInput;
export const __test_handleAddressInput = handleAddressInput;
export const __test_handleWrapAmountInput = handleWrapAmountInput;
export const __test_handleSwapCustomAmountInput = handleSwapCustomAmountInput;
export const __test_formatSlippageOptionLabel = formatSlippageOptionLabel;
export const __test_getUserSwapSlippageBps = getUserSwapSlippageBps;
export const __test_setUserSwapSlippageBps = setUserSwapSlippageBps;
export const __test_buildSwapConfirmationKeyboard = buildSwapConfirmationKeyboard;

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
    const logMediaDetails = (
      label: string,
      media: {
        file_id: string;
        file_name?: string | null;
        duration?: number | null;
        width?: number | null;
        height?: number | null;
      },
      fallbackName: string
    ) => {
      const fileId = media.file_id;
      const fileName = media.file_name || fallbackName;
      const duration = media.duration || 0;
      const width = media.width || 0;
      const height = media.height || 0;

      console.log(
        `${label} received:\n` +
          `   File ID: ${fileId}\n` +
          `   Name: ${fileName}\n` +
          `   Duration: ${duration}s\n` +
          `   Size: ${width}x${height}`
      );
    };

    const MEDIA_LOGGERS = [
      {
        kind: "video",
        label: "🎥 Video",
        fallbackName: "video",
      },
      {
        kind: "animation",
        label: "🎭 GIF/Animation",
        fallbackName: "animation.gif",
      },
    ] as const;

    for (const { kind, label, fallbackName } of MEDIA_LOGGERS) {
      bot.on(`message:${kind}` as const, async (ctx) => {
        if (ctx.chat?.type !== "private") {
          return;
        }

        const media = ctx.message[kind];
        if (!media) {
          return;
        }

        logMediaDetails(label, media, fallbackName);
      });
    }

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
