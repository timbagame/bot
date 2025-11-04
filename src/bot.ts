import "./utils/logging";
import { Bot, Context, InlineKeyboard } from "grammy";
import type { NextFunction } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { WalletManager } from "./utils/wallet";
import { TokenManager, formatParseAmountError } from "./utils/token-manager";
import * as anchor from "@coral-xyz/anchor";
import { EventParser } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { GameDatabase, type LeaderboardStatsRecord } from "./utils/game-database";
import { GameManager } from "./utils/game";
import { PDAManager } from "./utils/pda";
import { formatUserFriendlyError } from "./utils/errors";
import {
  handleTransactionError,
  handleCommandError as handleCommandErrorHelper,
} from "./utils/bot-helpers/error-response";
import { SwapManager, type SwapQuote } from "./utils/swap-manager";
import { createExpiringCache } from "./utils/expiring-cache";
import {
  LAMPORTS_PER_SOL,
  MIN_SOL_FOR_TX,
  GAME_TIMEOUT,
  EXPIRED_GAMES_CHECK_INTERVAL_MS,
  DEFAULT_NULL_ADDRESS,
  DEFAULT_TOKEN_MINT,
  DEFAULT_TOKEN_TICKER,
  TOKENS_LIST,
  WSOL_MINT,
  INPUT_TIMEOUT_HINT,
  SWAP_DEFAULT_SLIPPAGE_BPS,
  SWAP_SLIPPAGE_OPTIONS_BPS,
  applyOracleBufferTime,
} from "./utils/constants";
import { FeeBudgetManager } from "./utils/fee-budget";
import {
  setUserState,
  getUserState,
  storePendingTransaction,
  getPendingTransaction,
  upsertGameSetupSession,
  getGameSetupSession,
  clearGameSetupSession,
  setInputSession,
  getInputSession,
  clearInputSession,
  markInputSessionProcessing,
  clearInputSessionProcessing,
} from "./utils/user-state";
// import { createDmMessageAdapter } from "./utils/ctx-adapter";
import {
  createBackToWalletKeyboard,
  createCancelKeyboard,
  createTradeConfirmKeyboard,
  createAmountSelectionKeyboard,
  getSuggestedStakeAmounts,
} from "./utils/keyboards";
import { showCustomAmountPrompt, persistInputPromptFromContext } from "./utils/wallet-ui";
import {
  buildEmptyLeaderboardMessage,
  buildLeaderboardMessage,
  type LeaderboardPlayerDisplay,
} from "./utils/leaderboard-ui";
import { formatAmount, escapeHtml, formatRate } from "./utils/format-amount";
import { type PendingSwapTransaction } from "./bot/flows/sol-conversion";
import {
  onBalance,
  type BalanceDeps,
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
  getTelegramIdString,
  createMessageEditAdapter,
  handleCallbackErrorSafe,
  safeAnswerCallbackQuery,
  requireTelegramId,
  getRequiredTelegramIdForContext,
  resolveTelegramIdOrRespond,
} from "./utils/context-helpers";
import { recentUpdateGuard } from "./utils/recent-update";
import { resolveTokenPriceUSD } from "./utils/prices";
import { patchReplyBehavior } from "./utils/reply-patch";
import { buildTransactionLinkMessage } from "./utils/network-detector";
import { buildProcessingStatus } from "./utils/trade-ui";
import { respondWithMenu } from "./utils/menu-response";
import { parseDecimalAmount } from "./utils/amount";
import { handleCoinflipCommand } from "./handlers/game";
import {
  createGameSetupModule,
  GAME_SETUP_COPY,
} from "./handlers/game-setup";
import { createGameCommandsModule } from "./handlers/game-commands";
import { createGameCallbacksModule } from "./handlers/game-callbacks";
import {
  createWalletMenuModule,
  type WalletCacheSnapshot as WalletCacheSnapshotData,
} from "./handlers/wallet-menu";
import { createWalletTransactionsModule } from "./handlers/wallet-transactions";
import { generateTransactionId } from "./utils/transaction-id";
import type { TokenBalanceLike } from "./types/wallet";
import { refreshDynamicFeeBudgets } from "./utils/fee-budget-refresh";
export type { CreateGameViaCommandOptions } from "./handlers/game-commands";

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
    const { singleTransactionLamports } = await refreshDynamicFeeBudgets(feeBudget);
    SOL_FEE_BUFFER_LAMPORTS = singleTransactionLamports;
  } catch (error) {
    console.warn("Failed to refresh dynamic fee budgets during startup:", error);
  }
})();
let gameDb = GameDatabase.getInstance();
const pendingGameCreations = new Set<string>();

let oracleMaxTickets = 100;

const getOracleMaxPlayers = (): number => oracleMaxTickets;

const updateOracleMaxPlayers = (maybeMax: number) => {
  if (Number.isFinite(maybeMax) && maybeMax > 0) {
    oracleMaxTickets = maybeMax;
  }
};


type CallbackHandler<TCtx extends Context = any> = (
  ctx: TCtx,
  next: NextFunction
) => Promise<void> | void;

const wrapCallbackHandler = <TCtx extends Context>(
  handler: CallbackHandler<TCtx>,
  options: { action?: string; errorAck?: string } = {}
) => {
  return async (ctx: TCtx, next: NextFunction) => {
    try {
      await handler(ctx, next);
    } catch (error) {
      const fallbackAction = handler.name || "callback handler";
      const actionLabel =
        options.action ?? ctx.callbackQuery?.data ?? fallbackAction;
      if (options.errorAck) {
        console.error(`Error in ${actionLabel}:`, error);
        await safeAnswerCallbackQuery(ctx, options.errorAck);
      } else {
        await handleCallbackErrorSafe(ctx, error, actionLabel);
      }
    }
  };
};

const walletMenuModule = createWalletMenuModule({
  bot,
  wallet,
  getTokenManager: () => tokenManager,
  wrapCallbackHandler,
});

const {
  registerWalletMenuHandlers,
  registerCallbackPrefixHandler,
  registerWalletActionMenuHandler,
  getCachedWalletData,
  clearWalletCache,
  defaultWalletActionMenuDeps,
  showWalletUI,
  __test_setWalletCache: setWalletCacheForTests,
} = walletMenuModule;

registerWalletMenuHandlers();

export const __test_setWalletCache = setWalletCacheForTests;
export const __test_getCachedWalletData = getCachedWalletData;
export const __test_clearWalletCache = clearWalletCache;

const walletTransactionsModule = createWalletTransactionsModule({
  bot,
  wallet,
  registerWalletActionMenuHandler,
  registerCallbackPrefixHandler,
  defaultWalletActionMenuDeps,
  getCachedWalletData,
  clearWalletCache,
  wrapCallbackHandler,
  getSolFeeBufferLamports: () => SOL_FEE_BUFFER_LAMPORTS,
});

const {
  registerHandlers: registerWalletTransactionHandlers,
  executeWrapFlow,
  executeUnwrapFlow,
  validatePendingTransaction,
  presentSpendAmount,
  buildQuickAmountKeyboard,
  handleCustomAmountInput,
  handleAddressInput,
  handleWrapAmountInput,
  renderSolConversionSuccess,
} = walletTransactionsModule;

registerWalletTransactionHandlers();

const parseOracleNumeric = (value: unknown): number | null => {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }

    if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
      return null;
    }

    return value;
  }

  if (typeof value === "bigint") {
    const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
    const minSafe = BigInt(Number.MIN_SAFE_INTEGER);

    if (value > maxSafe || value < minSafe) {
      return null;
    }

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

      if (!Number.isFinite(converted)) {
        return null;
      }

      if (converted > Number.MAX_SAFE_INTEGER || converted < Number.MIN_SAFE_INTEGER) {
        return null;
      }

      return converted;
    } catch (error) {
      console.warn("Failed to convert oracle numeric value:", error);
      return null;
    }
  }

  return null;
};

export const __test_parseOracleNumeric = parseOracleNumeric;

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
export const __test_setGameManager = (manager: GameManager): void => {
  gameManager = manager;
};

export const __test_getGameDatabase = () => gameDb;

export const __test_setGameDatabase = (db: GameDatabase) => {
  gameDb = db;
};

export const __test_resetGameDatabase = () => {
  gameDb = GameDatabase.getInstance();
};

// Test-only proxies for user-state helpers
export const __test_setUserState = (userId: string, state: any) => setUserState(userId, state);
export const __test_getUserState = (userId: string) => getUserState(userId, false);
export const __test_clearUserState = (userId: string) => { getUserState(userId, true); };

// Main menu keyboard moved to utils/keyboards.ts

const clampLamportsForFees = (lamports: number): number =>
  Math.max(0, lamports - SOL_FEE_BUFFER_LAMPORTS);

type SwapAmountKeyboardOptions = {
  fromToken: string;
  toTokenIdentifier: string;
  canTrade: boolean;
};

const createSwapAmountKeyboard = ({
  fromToken,
  toTokenIdentifier,
  canTrade,
}: SwapAmountKeyboardOptions) =>
  buildQuickAmountKeyboard({
    baseCallback: (value) =>
      `swap_amount_${fromToken}_${toTokenIdentifier}_${value}`,
    backCallback: `swap_from_${fromToken}`,
    showQuickRows: canTrade,
    insufficientLabel: "❌ Insufficient balance",
  });

export const __test_createSwapAmountKeyboard = createSwapAmountKeyboard;

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

  const safePayDisplay = escapeHtml(payDisplay);
  const safePayToken = escapeHtml(payToken);
  const safeReceiveToken = escapeHtml(receiveToken);
  const safeReceiveDisplay = escapeHtml(receiveDisplay);
  const safeRateDisplay = escapeHtml(rateDisplay);
  const safeProviderLabel = escapeHtml(providerLabel);
  const safeContractAddress = contractAddress
    ? escapeHtml(contractAddress)
    : undefined;

  const lines = [
    `🔄 <b>Swap Confirmation</b>`,
    "",
    `<b>You Pay:</b> ${safePayDisplay} ${safePayToken}`,
    `<b>You Receive:</b> ~${safeReceiveDisplay} ${safeReceiveToken}`,
    "",
    `<b>Rate:</b> ${safeRateDisplay} ${safeReceiveToken}/${safePayToken}`,
    `<b>Provider:</b> ${safeProviderLabel}`,
    `<b>Slippage:</b> ${slippageText}`,
  ];

  if (safeContractAddress) {
    lines.push("", `🔗 <b>Contract:</b> <code>${safeContractAddress}</code>`);
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

type WalletCacheSnapshot = WalletCacheSnapshotData;

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

  const amountResolution = presentSpendAmount({
    amount: amountInput,
    assetTicker: inputAsset.ticker,
    decimals: inputAsset.decimals,
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

export const __test_setProgram = (
  nextProgram: anchor.Program<Timba> | undefined
) => {
  program = nextProgram as anchor.Program<Timba>;
};

export const __test_resetProgram = () => {
  program = undefined as any;
};

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
export const __test_presentSpendAmount = presentSpendAmount;
export const __test_buildQuickAmountKeyboard = buildQuickAmountKeyboard;
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

let processGameCompletionHandler = processGameCompletion;

export const __test_setProcessGameCompletionHandler = (
  handler: typeof processGameCompletion
) => {
  processGameCompletionHandler = handler;
};

export const __test_resetProcessGameCompletionHandler = () => {
  processGameCompletionHandler = processGameCompletion;
};

const COMPLETION_SIGNATURE_LOOKBACK = 25;

type CompletionDetails = {
  winnerAddress: string;
  totalPot?: number;
  signature?: string;
};

const toBase58String = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as {
      toBase58?: () => string;
      toString?: () => string;
    };

    if (typeof candidate.toBase58 === "function") {
      return candidate.toBase58();
    }

    if (typeof candidate.toString === "function") {
      return candidate.toString();
    }
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return String(value ?? "");
};

const bnLikeToNumber = (value: unknown): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "object") {
    const candidate = value as {
      toNumber?: () => number;
      toString?: () => string;
    };

    if (typeof candidate.toNumber === "function") {
      try {
        return candidate.toNumber();
      } catch {
        // Fall through to string parsing if the number is too large
      }
    }

    if (typeof candidate.toString === "function") {
      const numericValue = Number(candidate.toString());
      if (!Number.isNaN(numericValue)) {
        return numericValue;
      }
    }
  }

  return undefined;
};

type EventParserLike = Pick<EventParser, "parseLogs">;

const parseCompletionEventFromLogs = (
  logs: readonly string[] | null | undefined,
  parser: EventParserLike,
  expectedGameAddress: string
): Omit<CompletionDetails, "signature"> | null => {
  if (!logs?.length) {
    return null;
  }

  const mutableLogs = [...logs];

  for (const event of parser.parseLogs(mutableLogs)) {
    if (!event || (event.name !== "gameCompleted" && event.name !== "GameCompleted")) {
      continue;
    }

    const data = event.data as Record<string, unknown> | undefined;
    if (!data) {
      continue;
    }

  const eventGameAddress = toBase58String(data["gameKey"]);
    if (!eventGameAddress || eventGameAddress !== expectedGameAddress) {
      continue;
    }

  const winnerAddress = toBase58String(data["winner"]);
    if (!winnerAddress) {
      continue;
    }

  const totalPot = bnLikeToNumber(data["winnerAmount"]);

    return {
      winnerAddress,
      totalPot,
    };
  }

  return null;
};

const fetchCompletionDetailsFromHistory = async (
  gameAddress: string
): Promise<CompletionDetails | null> => {
  if (!program) {
    return null;
  }

  try {
    const gamePda = new PublicKey(gameAddress);
    const connection = wallet.getConnection();
    const signatures = await connection.getSignaturesForAddress(gamePda, {
      limit: COMPLETION_SIGNATURE_LOOKBACK,
    });

    if (!signatures.length) {
      return null;
    }

    const parser = completionEventParserFactory();

    for (const { signature } of signatures) {
      if (!signature) {
        continue;
      }

      const transaction = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });

      const parsed = parseCompletionEventFromLogs(
        transaction?.meta?.logMessages ?? null,
        parser,
        gameAddress
      );

      if (parsed) {
        return {
          ...parsed,
          signature,
        };
      }
    }
  } catch (error) {
    console.error(
      `Error reconstructing completion history for ${gameAddress}:`,
      error
    );
  }

  return null;
};

let completionHistoryFetcher: (
  gameAddress: string
) => Promise<CompletionDetails | null> = fetchCompletionDetailsFromHistory;

const getDefaultCompletionEventParserFactory = () => () => {
  if (!program) {
    throw new Error("Program not initialized");
  }
  return new EventParser(program.programId, program.coder);
};

let completionEventParserFactory: () => EventParserLike =
  getDefaultCompletionEventParserFactory();

export const __test_setCompletionHistoryFetcher = (
  fetcher: typeof completionHistoryFetcher
) => {
  completionHistoryFetcher = fetcher;
};

export const __test_resetCompletionHistoryFetcher = () => {
  completionHistoryFetcher = fetchCompletionDetailsFromHistory;
};

export const __test_setCompletionEventParserFactory = (
  factory: typeof completionEventParserFactory
) => {
  completionEventParserFactory = factory;
};

export const __test_resetCompletionEventParserFactory = () => {
  completionEventParserFactory = getDefaultCompletionEventParserFactory();
};

export const __test_parseCompletionEventFromLogs = (
  logs: readonly string[] | null | undefined,
  parser: EventParserLike,
  expectedGameAddress: string
) => parseCompletionEventFromLogs(logs, parser, expectedGameAddress);

export const __test_fetchCompletionDetailsFromHistory = (
  gameAddress: string
) => fetchCompletionDetailsFromHistory(gameAddress);

export const __test_bnLikeToNumber = bnLikeToNumber;
export const __test_toBase58String = toBase58String;

/**
 * Clean up orphaned games (accounts closed but DB shows active)
 */
const cleanupOrphanedGame = async (gameAddress: string): Promise<void> => {
  const gameData = gameDb.getGame(gameAddress);
  if (!gameData || gameData.status === "completed") return;

  console.log(`🧹 Cleaning up orphaned game ${gameAddress}`);

  const completionDetails = await completionHistoryFetcher(gameAddress);
  if (completionDetails) {
    console.log(
      `♻️ Reconstructed completion for ${gameAddress} from transaction history`
    );

    await processGameCompletionHandler(
      gameAddress,
      completionDetails.winnerAddress,
      completionDetails.totalPot,
      completionDetails.signature
    );

    return;
  }

  gameDb.completeGame(gameAddress, "cancelled", Date.now());
  await updateGameMessageSafely(
    gameAddress,
    gameData,
    "Completed",
    "cancelled"
  );

  console.log(`✅ Successfully cleaned up orphaned game ${gameAddress}`);
};

export const __test_cleanupOrphanedGame = cleanupOrphanedGame;

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

const fetchTokenPriceUSD = async ({
  tokenMint,
  tokenTicker,
}: {
  tokenMint: string;
  tokenTicker: string;
}): Promise<number | null> => {
  const lookup = await resolveTokenPriceUSD({
    tokenMint,
    tokenTicker,
  });
  return lookup?.price ?? null;
};

const gameSetupModule = createGameSetupModule({
  wallet,
  getTokenManager: () => tokenManager,
  getDefaultTokenMetadata,
  getContractMinimumAmount: (tokenMint, decimalsHint) =>
    getContractMinimumAmount(tokenMint, decimalsHint),
  fetchTokenPriceUSD: (params) => fetchTokenPriceUSD(params),
  createAmountSelectionKeyboard,
  getSuggestedStakeAmounts,
  getGameSetupSession,
  upsertGameSetupSession,
  clearGameSetupSession,
  safeAnswerCallbackQuery,
  getTelegramId,
  getTelegramIdString,
});

const {
  startInteractiveGameSetup,
  resolveCommandTokenOverride: resolveGameCommandTokenOverride,
  withCreatorContext,
  __test_startInteractiveGameSetup: startInteractiveGameSetupTest,
} = gameSetupModule;

export const __test_startInteractiveGameSetup = startInteractiveGameSetupTest;

const gameCommandsModule = createGameCommandsModule({
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
  getContractMinimumAmount: (tokenMint, decimalsHint) =>
    getContractMinimumAmount(tokenMint, decimalsHint),
  gameManager: {
    createGame: (...args) => gameManager.createGame(...args),
    createGameMessage: (...args) => gameManager.createGameMessage(...args),
  },
  getOracleMaxPlayers,
  isGroupChat,
  startInteractiveGameSetup: (ctx, telegramId, copy, tokenOverride) =>
    startInteractiveGameSetup(ctx, telegramId, copy, tokenOverride),
  resolveCommandTokenOverride: (tokenInput, _chatId) =>
    resolveGameCommandTokenOverride(tokenInput),
  getRequiredTelegramIdForContext: (ctx, label) =>
    getRequiredTelegramIdForContext(ctx, label),
  gameSetupCopy: GAME_SETUP_COPY,
});

const { createCoinflipDeps, handleGiveawayCommand, __test_createGameViaCommand } =
  gameCommandsModule;

export { __test_createGameViaCommand };

const gameCallbacksModule = createGameCallbacksModule({
  bot,
  wallet,
  getGameManager: () => gameManager,
  gameDb,
  wrapCallbackHandler,
  withCreatorContext,
  pendingGameCreations,
  getOracleMaxPlayers,
  getDefaultTokenMetadata: () => getDefaultTokenMetadata(),
  getContractMinimumAmount: (tokenMint, decimalsHint) =>
    getContractMinimumAmount(tokenMint, decimalsHint),
  fetchTokenPriceUSD: (params) => fetchTokenPriceUSD(params),
  getProgram: () => program,
  validateGameTokenData: (gameData) => validateGameTokenData(gameData),
  gameSetupCopy: GAME_SETUP_COPY,
});

const {
  registerHandlers: registerGameCallbackHandlers,
  createTextInputMiddleware: createGameSetupTextInputMiddleware,
  __test_handleGameSetupTextInput: handleGameSetupTextInputTest,
  __test_shouldSkipGenericGameCallback: shouldSkipGenericGameCallbackTest,
} = gameCallbacksModule;

registerGameCallbackHandlers();

bot.use(createGameSetupTextInputMiddleware());

export const __test_handleGameSetupTextInput = handleGameSetupTextInputTest;
export const __test_shouldSkipGenericGameCallback =
  shouldSkipGenericGameCallbackTest;

const getPlayerData = async (
  telegramId: bigint,
  tokenMint?: string,
  options: { includeWsol?: boolean } = {}
): Promise<PlayerData> => {
  const keypair = wallet.getKeyPair(telegramId);
  const effectiveTokenMint = tokenMint || DEFAULT_TOKEN_MINT;
  const includeWsol = options.includeWsol === true;

  const balancePromises: Array<Promise<number>> = [
    wallet.getTokenBalance(telegramId, effectiveTokenMint),
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
    totalBalance >= amount &&
    amount < totalBalance
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
    await handleTransactionError(ctx, error, processingMsg.message_id, wallet);
    throw error;
  }
};

export const __test_validateAndProcessTransaction = validateAndProcessTransaction;

// ================================
// RESPONSE HELPERS
// ================================

const handleCommandError = async (
  ctx: Context,
  error: any,
  commandName: string
): Promise<void> => {
  await handleCommandErrorHelper(ctx, error, commandName, wallet);
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

const formatDefaultTokenSetMessage = (
  tokenTicker: string,
  tokenMint: string
): string => {
  const safeTicker = escapeHtml(tokenTicker);
  const safeMint = escapeHtml(tokenMint);
  return (
    `✅ Default token set to ${safeTicker}\n` +
    `🏷️ Token mint: <code>${safeMint}</code>\n\n` +
    `All games and transactions will now use ${safeTicker} by default unless specified otherwise.`
  );
};

export const __test_formatDefaultTokenSetMessage = formatDefaultTokenSetMessage;

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

    const bufferSeconds = parseOracleNumeric(oracleAccount.oracleBufferTime);
    if (bufferSeconds !== null) {
      const appliedBuffer = applyOracleBufferTime(bufferSeconds);
      const hours = appliedBuffer / 3600;
      const hoursNote = hours >= 1 ? ` (~${hours.toFixed(hours >= 10 ? 1 : 2)} hours)` : "";
      console.log(`Oracle buffer time set to ${appliedBuffer} seconds${hoursNote}`);
    } else {
      console.warn(
        "Unable to determine oracle buffer time, keeping previous value",
        oracleAccount.oracleBufferTime
      );
    }
  } catch (error) {
    console.log("Oracle not found, it might need to be initialized");
  }
};

/**
 * Get the actual minimum amount from the smart contract for a specific token.
 */
export let getContractMinimumAmount = async (
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

const createBalanceDeps = (): BalanceDeps => ({
  isPrivateChat,
  clearWalletCache,
  showWalletUI,
  handleCommandError,
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
  await handleGiveawayCommand(ctx as Context & { message?: any });
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

        const successView = renderSolConversionSuccess({
          kind: "wrap",
          formattedAmount,
          signature,
        });

        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMessageId,
          successView.text,
          {
            parse_mode: "HTML",
            link_preview_options: { is_disabled: successView.disablePreview },
          }
        );
      },
      onError: async (error) => {
        if (processingMessageId != null) {
          await handleTransactionError(ctx, error, processingMessageId, wallet);
        } else {
          const userFriendlyError = formatUserFriendlyError(error, wallet);
          await replyToMessage(ctx, userFriendlyError);
          if (error && typeof error === "object") {
            (error as any).__alreadyNotified = true;
          }
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
        await handleTransactionError(ctx, error, processingMsg.message_id, wallet);
      },
    });
  } catch (error) {
    await handleTransactionError(ctx, error, processingMsg.message_id, wallet);
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
      const setByDisplay = setBy
        ? `@${escapeHtml(setBy)}`
        : "Unknown user";
      return replyToMessage(
        ctx,
        `📄 Current default token: ${escapeHtml(chatConfig.token_ticker)}\n` +
          `🏷️ Token mint: <code>${escapeHtml(chatConfig.token_mint)}</code>\n` +
          `👤 Set by: ${setByDisplay}\n` +
          `📅 Set at: ${new Date(chatConfig.set_at).toLocaleString()}\n\n` +
          `Use /default &lt;TOKEN_TICKER&gt; to change or /default clear to remove.`
      );
    } else {
      const defaultToken = tokenManager.getDefaultToken();
      return replyToMessage(
        ctx,
        `📄 No default token set for this chat.\n` +
          `🔄 Using bot default: ${escapeHtml(defaultToken.tokenTicker)}\n\n` +
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
    const escapedTokenInput = escapeHtml(tokenInput.toUpperCase());
    let response = `❌ Token "${escapedTokenInput}" not found.\n\n`;

    if (allTokens.length > 0) {
      response += "📋 Known tokens:\n";
      for (const token of allTokens.slice(0, 10)) {
        // Show max 10 tokens
          response += `• ${escapeHtml(token.token_ticker)}\n`;
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
    formatDefaultTokenSetMessage(knownToken.token_ticker, knownToken.token_mint)
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


// ================================
// MAIN MENU CALLBACK HANDLERS
// ================================


bot.callbackQuery(
  "cmd_privatekey",
  wrapCallbackHandler(
    async (ctx) => {
      // Only show private key in private chats for security
      if (ctx.chat?.type !== "private") {
        await safeAnswerCallbackQuery(
          ctx,
          "❌ Private key only available in private chat"
        );
        return;
      }

      const telegramId = await resolveTelegramIdOrRespond(
        ctx,
        "show private key"
      );
      if (telegramId == null) {
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
    },
    { action: "cmd_privatekey", errorAck: "❌ Error showing private key" }
  )
);
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
            amount: quote.inputAmountRaw,
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
            amount: quote.inputAmountRaw,
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
            amount: quote.inputAmountRaw,
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
      const userFriendlyError = formatUserFriendlyError(swapError, wallet);
      await respondWithMenu(ctx, {
        text: `❌ <b>Swap Failed</b>\n\n${escapeHtml(userFriendlyError)}`,
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
// WALLET DATA CACHE
// ================================

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
      const telegramId = await resolveTelegramIdOrRespond(
        ctx,
        "swap menu from token"
      );
      if (telegramId == null) {
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

        await persistInputPromptFromContext({
          ctx,
          text: response.join("\n"),
          keyboard: createCancelKeyboard("cmd_swap"),
          session: {
            type: "swap_to_token",
            fromToken,
          },
          logLabel: "swap_custom_token_prompt",
          persistSession: Boolean(userId),
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

      const telegramId = await resolveTelegramIdOrRespond(
        ctx,
        "swap amount selection"
      );
      if (telegramId == null) {
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

  const keyboard = createSwapAmountKeyboard({
    fromToken,
    toTokenIdentifier,
    canTrade,
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
          overrides.fromMint ??
          (await tokenManager.resolveMintForTicker(fromToken));
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
          overrides.toMint ?? (await tokenManager.resolveMintForTicker(toToken));
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

  // Check if the message is a reply to a prompting message
  const replyToMessageId = ctx.message?.reply_to_message?.message_id;
  if (!replyToMessageId) {
    return await next();
  }

  // Construct session key from chat and message ID
  const sessionKey = `${ctx.chat?.id || 0}_${replyToMessageId}`;

  // Check for input session
  const inputSession = getInputSession(sessionKey);
  if (!inputSession) {
    return await next(); // Not waiting for input, continue to other handlers
  }

  if (
    typeof inputSession.initiatorId === "string" &&
    inputSession.initiatorId.length > 0 &&
    inputSession.initiatorId !== userId
  ) {
    await ctx.reply(
      "❌ <b>This prompt is no longer active for you.</b>\n\nOpen the wallet menu again to continue.",
      {
        parse_mode: "HTML",
        reply_markup: createBackToWalletKeyboard(),
      }
    );
    return;
  }

  const lockerSuffix = ctx.message?.message_id ?? ctx.update?.update_id ?? Date.now();
  const lockerId = `${userId}:${lockerSuffix}`;
  const locked = markInputSessionProcessing(sessionKey, lockerId);

  if (!locked) {
    return;
  }

  const userMessage = ctx.message.text.trim();

  const previousSessionType = inputSession.type;

  try {
    if (inputSession.type === "send_custom_amount") {
      await handleCustomAmountInput(ctx, inputSession, userMessage);
    } else if (inputSession.type === "send_address") {
      await handleAddressInput(ctx, inputSession, userMessage);
    } else if (inputSession.type === "wrap_custom_amount") {
      await handleWrapAmountInput(ctx, inputSession, userMessage);
    } else if (inputSession.type === "swap_to_token") {
      await handleSwapToTokenInput(ctx, inputSession, userMessage);
    } else if (inputSession.type === "swap_custom_amount") {
      await handleSwapCustomAmountInput(ctx, inputSession, userMessage);
    }

    const updatedSession = getInputSession(sessionKey);
    const sessionTransitioned =
      updatedSession && updatedSession.type !== previousSessionType;

    // Clear session after successful processing unless a new session replaced it
    if (!sessionTransitioned) {
      clearInputSession(sessionKey);
    }
  } catch (error) {
    // Clear session even on error to prevent stuck states
    clearInputSession(sessionKey);
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
  } finally {
    clearInputSessionProcessing(sessionKey);
  }
});

/**
 * Handle swap token input (when user sends token mint or symbol)
 */
const handleSwapToTokenInput = async (
  ctx: any,
  userState: any,
  tokenInput: string
) => {
  const fromToken = userState.fromToken;
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
    const resolved = await tokenManager.resolveSwapToken(trimmedInput);
    if (!resolved) {
      throw new Error(
        `Token "${trimmedInput}" not found. Try using the contract address.`
      );
    }

    const decimals = Number(resolved.decimals);
    if (!Number.isFinite(decimals) || decimals < 0) {
      throw new Error(
        `Token metadata missing decimals for ${resolved.token_ticker}`
      );
    }

    const tokenSymbol = resolved.isNativeSol
      ? "SOL"
      : resolved.token_ticker.toUpperCase();

    const metadata: SwapTokenMetadata = {
      symbol: tokenSymbol,
      address: resolved.token_mint,
      decimals,
      verified: !resolved.newlyDiscovered,
    };

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

    clearInputSession(`${userState.chatId}_${userState.messageId}`);
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

    setInputSession(`${userState.chatId}_${userState.messageId}`, {
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

type SwapTokenMetadata = {
  symbol: string;
  address: string;
  decimals: number;
  verified: boolean;
};

export const __test_handleCustomAmountInput = handleCustomAmountInput;
export const __test_handleAddressInput = handleAddressInput;
export const __test_handleWrapAmountInput = handleWrapAmountInput;
export const __test_handleSwapCustomAmountInput = handleSwapCustomAmountInput;
export const __test_formatSlippageOptionLabel = formatSlippageOptionLabel;
export const __test_getUserSwapSlippageBps = getUserSwapSlippageBps;
export const __test_setUserSwapSlippageBps = setUserSwapSlippageBps;
export const __test_buildSwapConfirmationKeyboard = buildSwapConfirmationKeyboard;
export const __test_renderSolConversionSuccess = renderSolConversionSuccess;

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
          await processGameCompletionHandler(
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
      if (typeof blockTime === "number" && Number.isFinite(blockTime)) {
        return GameManager.isExpiredWithBuffer(gameAccount, blockTime);
      }
      return GameManager.isExpiredWithBuffer(gameAccount);
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
