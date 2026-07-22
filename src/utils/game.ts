import {
  PublicKey,
  Keypair,
  Connection,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Context } from "grammy";
import * as anchor from "@anchor-lang/core";

import { WalletManager } from "./wallet";
import { GameDatabase } from "./game-database";
import { OracleClient } from "./oracle";
import { PDAManager } from "./pda";
import { buildFriendlyShortfallMessage, formatUserFriendlyError } from "./errors";
import {
  formatUsdValue as formatUsdValueText,
  formatCompactTokenDisplay,
  formatAmount,
  escapeHtml,
} from "./format-amount";
import { formatDuration } from "./format-time";
import {
  DEFAULT_NULL_ADDRESS,
  GAME_CREATION_RATE_LIMIT_WINDOW_MS,
  GAME_INFO_LIMIT,
  GAME_EXPIRATION_BUFFER_TIME,
  MAX_ACTIVE_GAMES_PER_CREATOR,
  MAX_GAMES_PER_CREATOR_WINDOW,
  WSOL_MINT,
  DEFAULT_TOKEN_TICKER,
  TOKEN_PRICE_CACHE_TTL_MS,
  getCoinflipVideoId,
  getGiveawayVideoId,
  TELEGRAM_USERNAME_CACHE_TTL_MS,
  CHAT_MEDIA_DISABLED_SENTINEL,
  GAME_MESSAGE_PARTICIPANTS_PREVIEW_LIMIT,
  GAME_MESSAGE_USERNAME_LOOKUP_CONCURRENCY,
  GAME_MESSAGE_NETWORK_LOOKUP_MAX_PARTICIPANTS,
  GAMES_HISTORY_LIMIT,
  GAMES_PER_PAGE,
} from "./constants";
import { ChatDatabase } from "./chat-database";
import {
  editMediaWithFallback,
  enqueueMessageMediaEdit,
  isRecoverableMediaError,
  sendMediaWithFallback,
} from "./media";
import { isMessageMissing } from "./telegram-errors";
import { FeeBudgetManager } from "./fee-budget";
import type { FeeBudgetProvider } from "./fee-budget";
import type {
  GameData,
  GameMessage,
  GameCancellationResult,
  GameMessageFormat,
  GameCategory,
  GameType,
  ParsedAmount,
} from "../types";
import type { Timba } from "../../idl/idlType";
import {
  buildPlayerProfileLink,
  formatPlayerAddress,
  type ParticipantDisplay,
  buildGameStatus,
  buildGameHeader,
  buildPrizeLine,
  buildParticipantsList,
  buildExpirationText,
} from "./game-ui";
import {
  sanitizeTelegramDisplayName,
  sanitizeTelegramDisplayNameWithoutMention,
} from "./telegram-display";
import { getUsdPrice, rememberPriceLookup, type CachedPriceLookup } from "./price-service";
import { NetworkDetector } from "./network-detector";
import { SwapManager } from "./swap-manager";
import { confirmTransactionWithRecovery, type TransactionProbe } from "./transaction-runner";
import { createExpiringCache } from "./expiring-cache";
import { refreshDynamicFeeBudgets } from "./fee-budget-refresh";
import { DEFAULT_MAINNET_ENDPOINT, resolvePrimaryRpcEndpoint } from "./rpc-endpoints";

const resolveGameMedia = (
  gameType: string,
  chatId?: number,
): { fileId: string; mediaType: "photo" | "video" | "animation" } | undefined => {
  const lower = gameType.toLowerCase();

  // Check for chat-specific media first.
  // CHAT_MEDIA_DISABLED_SENTINEL = explicitly disabled (text-only)
  // null/undefined = not set (use bot default)
  // "" = cleared (use bot default)
  // otherwise = custom Telegram file_id
  if (chatId != null) {
    const chatDb = ChatDatabase.getInstance();
    const chatSettings = chatDb.getChatGameSettings(chatId);

    if (chatSettings && (lower === "coinflip" || lower === "giveaway")) {
      const { videoId, mediaType } =
        lower === "coinflip"
          ? {
              videoId: chatSettings.coinflip_video_id,
              mediaType: chatSettings.coinflip_media_type,
            }
          : {
              videoId: chatSettings.giveaway_video_id,
              mediaType: chatSettings.giveaway_media_type,
            };

      if (videoId === CHAT_MEDIA_DISABLED_SENTINEL) {
        return undefined;
      }

      if (videoId && videoId.length > 0) {
        const effectiveType = (mediaType as "photo" | "video" | "animation") || "video";
        return { fileId: videoId, mediaType: effectiveType };
      }
    }
  }

  // Fall back to global defaults (always video)
  if (lower === "coinflip") {
    const id = getCoinflipVideoId();
    if (id && id.length > 0) {
      return { fileId: id, mediaType: "video" };
    }
  }
  if (lower === "giveaway") {
    const id = getGiveawayVideoId();
    if (id && id.length > 0) {
      return { fileId: id, mediaType: "video" };
    }
  }
  return undefined;
};

const WRAP_BALANCE_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000]; // Polling intervals to wait for WSOL balance propagation

const getWrapBalanceRetryDelays = (): number[] => {
  if (process.env.NODE_ENV === "test") {
    return new Array(WRAP_BALANCE_RETRY_DELAYS_MS.length).fill(0);
  }
  return WRAP_BALANCE_RETRY_DELAYS_MS;
};

const TELEGRAM_MESSAGE_CHAR_LIMIT = 4096;

// Must match contracts/programs/timba/src/state.rs::GAME_BASE_SIZE.
const GAME_BASE_ACCOUNT_SIZE =
  8 + // discriminator
  32 + // creator
  1 + // game_type
  8 + // ticket_amount
  4 + // max_tickets
  4 + // min_tickets
  4 + // tickets_count
  32 + // token_mint
  8 + // created_at
  8 + // timeout
  8 + // last_slot
  1 + // is_private
  8; // total_amount
const PARTICIPANTS_VECTOR_PREFIX_SIZE = 4;
const PARTICIPANT_PUBLIC_KEY_SIZE = 32;

interface GameFundingPlan {
  currentSolLamports: number;
  gameDepositLamports: number;
  feeSafetyReserveLamports: number;
  retainedWalletReserveLamports: number;
  requiredSolLamports: number;
  shortfallLamports: number;
  stakeRaw: number;
  spareTokenRaw: number;
}

const PLAYER_TELEGRAM_ID_POLL_INTERVAL_MS = process.env.NODE_ENV === "test" ? 1 : 40;
const PLAYER_TELEGRAM_ID_POLL_ATTEMPTS = 5;

const isDebugLoggingEnabled = (process.env["TIMBA_DEBUG"] ?? "").toLowerCase() === "true";

const debugLog = (...args: unknown[]): void => {
  if (!isDebugLoggingEnabled) {
    return;
  }
  console.debug(...args);
};

const formatRateLimitWindow = (windowMs: number): string => {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    return "recent window";
  }

  if (windowMs < 1_000) {
    const rounded = Math.ceil(windowMs);
    return `${rounded}ms`;
  }

  return formatDuration(windowMs / 1000);
};

type GameTokenContextAccounts = {
  tokenMint: PublicKey;
  gameToken: PublicKey;
  gameVault: PublicKey;
  gameTokenAccount: PublicKey;
  tokenProgram: PublicKey;
  associatedTokenProgram: PublicKey;
};

// ================================
// UTILITY FUNCTIONS
// ================================

const DEFAULT_FRIENDLY_ERROR_MESSAGE = "❌ Something went wrong. Please try again in a moment.";

const INTEGER_PATTERN = /^-?\d+$/;

const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

const coerceLamportValue = (value: unknown): bigint | null => {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return BigInt(Math.trunc(value));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!INTEGER_PATTERN.test(trimmed)) {
      return null;
    }
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as {
      toString?: () => string;
      toNumber?: () => number;
    };
    if (typeof candidate.toString === "function") {
      const stringified = candidate.toString();
      if (INTEGER_PATTERN.test(stringified.trim())) {
        try {
          return BigInt(stringified.trim());
        } catch {
          // fall through
        }
      }
    }

    if (typeof candidate.toNumber === "function") {
      try {
        const asNumber = candidate.toNumber();
        if (Number.isFinite(asNumber)) {
          return BigInt(Math.trunc(asNumber));
        }
      } catch {
        // swallow and fall through to null return
      }
    }
  }

  return null;
};

const mapWithConcurrency = async <TItem, TResult>(
  items: TItem[],
  limit: number,
  mapper: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> => {
  if (items.length === 0) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) ? Math.trunc(limit) : 0;
  const workerCount = Math.max(1, Math.min(items.length, safeLimit || 1));
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index]!, index);
    }
  });

  await Promise.all(workers);
  return results;
};

const logAndFormatError = async (
  error: unknown,
  operation: string,
  walletManager?: WalletManager,
): Promise<string> => {
  console.error(`Error in ${operation}:`, error);
  try {
    return await formatUserFriendlyError(error, walletManager);
  } catch (formatError) {
    console.error(`Failed to format user-friendly error for ${operation}:`, formatError);
    return DEFAULT_FRIENDLY_ERROR_MESSAGE;
  }
};

const formatGameTypeWithEmoji = (gameType: string): string => {
  switch (gameType.toLowerCase()) {
    case "coinflip":
      return "🪙 Coinflip";
    case "giveaway":
      return "🎁 Giveaway";

    default:
      return `${gameType.charAt(0).toUpperCase() + gameType.slice(1)}`;
  }
};

const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

const formatExpirationTime = async (
  expiresAt: number,
  walletManager?: WalletManager,
  prefix: string = "⏰ ",
): Promise<string> => {
  const blockTime = walletManager
    ? await walletManager.getBlockchainTime()
    : Math.floor(Date.now() / 1000);
  const timeRemaining = Math.max(0, expiresAt - blockTime);
  return buildExpirationText(timeRemaining, prefix);
};

const categorizeGame = (
  gameData: any,
  telegramIdStr: string,
  playerPublicKey: string,
): "cancelled" | "won" | "lost" | "created" => {
  const winnerAddress = gameData.winner_address;
  const isCreator = gameData.creator_telegram_id === telegramIdStr;
  const isWinner = winnerAddress === playerPublicKey;

  if (winnerAddress === "cancelled") return "cancelled";
  if (isWinner) return "won";
  if (winnerAddress && winnerAddress !== playerPublicKey) return "lost";
  if (isCreator) return "created";
  return "lost";
};

// ================================
// GAME HISTORY TYPES (for /games command)
// ================================

/**
 * A single game entry for the /games command history view.
 */
export interface GameHistoryEntry {
  gameAddress: string;
  amount: number;
  tokenTicker: string;
  tokenMint: string;
  tokenDecimals: number;
  ticketCount: number;
  maxTickets: number;
  /** Creator username (formatted with @) or fallback display */
  creatorDisplay: string;
  /** Opponent username for losses, or empty */
  opponentDisplay: string;
  completedAt: number;
  explorerUrl: string | null;
  category: "won" | "lost" | "cancelled";
}

/**
 * Structured result from getUserGamesHistory for the /games command.
 */
export interface GameHistoryResult {
  won: { games: GameHistoryEntry[]; totalAmount: number; totalUsd: number };
  lost: { games: GameHistoryEntry[]; totalAmount: number; totalUsd: number };
  cancelled: { games: GameHistoryEntry[]; count: number };
  /** Primary token ticker for display (most common token or first encountered) */
  primaryTicker: string;
  /** Primary token decimals */
  primaryDecimals: number;
}

/**
 * Tab identifier for /games pagination.
 */
export type GamesTab = "won" | "lost" | "cancelled" | "all";

/**
 * Format a timestamp as a compact date: "19 Dec 00:02"
 */
const formatCompactDate = (timestamp: number): string => {
  return new Date(timestamp)
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(",", "");
};

/**
 * Format an amount with k/M suffix for compact display.
 * e.g., 151100 -> "151.1k", 14000 -> "14.0k"
 */
const formatCompactAmount = (amount: number, decimals: number = 0): string => {
  const value = decimals > 0 ? amount / Math.pow(10, decimals) : amount;

  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const k = value / 1_000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return value >= 10 ? `${Math.round(value)}` : value.toFixed(1);
};

// ================================
// GAME MANAGER CLASS
// ================================

export class GameManager {
  private static instance: GameManager;
  private static instanceDeps?: {
    program: anchor.Program<Timba>;
    wallet: WalletManager;
    gameDb: GameDatabase;
  };
  private activeGameMessages = new Map<string, Map<number, GameMessage>>();
  private cachedConnection?: Connection;
  private inFlightGameCreations = new Map<string, number>();
  private pendingCreationRequests = new Map<string, number[]>();
  private readonly completedGameErrorMessage =
    "This game has already completed. Refresh to see the result.";
  private readonly usernameCacheTtlMs = TELEGRAM_USERNAME_CACHE_TTL_MS;
  private readonly usernameCacheMaxEntries = 500;
  private readonly usernameCache = createExpiringCache<string | null>(
    TELEGRAM_USERNAME_CACHE_TTL_MS,
  );
  private readonly usernameCacheKeys: string[] = [];
  private readonly usernameHints = new Map<string, string>();
  private readonly normalizedUsernameToIdCache = createExpiringCache<string>(
    TELEGRAM_USERNAME_CACHE_TTL_MS,
  );
  private readonly usernameToIdCacheKeys: string[] = [];
  private readonly messageRecreationLocks = new Set<string>();
  private readonly gamePriceCache =
    createExpiringCache<CachedPriceLookup>(TOKEN_PRICE_CACHE_TTL_MS);
  private usernameLookupPromises = new Map<string, Promise<string | null>>();
  private gameMessageReadyListener?: (gameAddress: string) => void;

  private constructor(
    private program: anchor.Program<Timba>,
    private wallet: WalletManager,
    private gameDb: GameDatabase,
    private oracleClient: OracleClient,
    private swapManager: SwapManager,
    private feeBudget: FeeBudgetProvider,
  ) {}

  private getInFlightCreations(telegramId: string): number {
    return this.inFlightGameCreations.get(telegramId) ?? 0;
  }

  private incrementInFlightCreations(telegramId: string): void {
    const current = this.getInFlightCreations(telegramId);
    this.inFlightGameCreations.set(telegramId, current + 1);
  }

  private decrementInFlightCreations(telegramId: string): void {
    const current = this.getInFlightCreations(telegramId);
    if (current <= 1) {
      this.inFlightGameCreations.delete(telegramId);
      return;
    }

    this.inFlightGameCreations.set(telegramId, current - 1);
  }

  private prunePendingCreationRequests(telegramId: string, windowStartMs: number): number {
    const existing = this.pendingCreationRequests.get(telegramId);
    if (!existing || existing.length === 0) {
      return 0;
    }

    const filtered = existing.filter((ts) => ts >= windowStartMs);

    if (filtered.length === 0) {
      this.pendingCreationRequests.delete(telegramId);
      return 0;
    }

    if (filtered.length !== existing.length) {
      this.pendingCreationRequests.set(telegramId, filtered);
    }

    return filtered.length;
  }

  private trackPendingCreationRequest(telegramId: string, timestampMs: number): void {
    const existing = this.pendingCreationRequests.get(telegramId);
    if (existing) {
      existing.push(timestampMs);
      return;
    }

    this.pendingCreationRequests.set(telegramId, [timestampMs]);
  }

  private clearPendingCreationRequest(telegramId: string, timestampMs: number): void {
    const existing = this.pendingCreationRequests.get(telegramId);
    if (!existing || existing.length === 0) {
      return;
    }

    const index = existing.findIndex((ts) => ts === timestampMs);
    if (index !== -1) {
      existing.splice(index, 1);
    }

    if (existing.length === 0) {
      this.pendingCreationRequests.delete(telegramId);
    }
  }

  public static getInstance(
    program: anchor.Program<Timba>,
    wallet: WalletManager,
    gameDb: GameDatabase,
  ): GameManager {
    const depsChanged = (() => {
      const current = GameManager.instanceDeps;
      if (!current) {
        return true;
      }
      return current.program !== program || current.wallet !== wallet || current.gameDb !== gameDb;
    })();

    if (!GameManager.instance || depsChanged) {
      const oracleClient = OracleClient.getInstance(wallet);
      const maybeGetConnection = (wallet as any).getConnection;
      const connection =
        typeof maybeGetConnection === "function"
          ? maybeGetConnection.call(wallet)
          : ((wallet as any).connection ??
            new Connection(
              resolvePrimaryRpcEndpoint(process.env.SOLANA_NETWORK, DEFAULT_MAINNET_ENDPOINT),
              "confirmed",
            ));
      const feeBudget = FeeBudgetManager.getInstance(connection);
      const swapManager = new SwapManager(connection, wallet, feeBudget);
      GameManager.instance = new GameManager(
        program,
        wallet,
        gameDb,
        oracleClient,
        swapManager,
        feeBudget,
      );
      GameManager.instanceDeps = { program, wallet, gameDb };
      void (async () => {
        try {
          await refreshDynamicFeeBudgets(feeBudget);
        } catch (error) {
          console.warn("Failed to prime dynamic fee budgets:", error);
        }
      })();
      GameManager.instance.cachedConnection = connection;
    }
    return GameManager.instance;
  }

  public static resetForTest(): void {
    GameManager.instance = undefined as any;
    GameManager.instanceDeps = undefined;
  }

  public setGameMessageReadyListener(listener: ((gameAddress: string) => void) | undefined): void {
    this.gameMessageReadyListener = listener ?? undefined;
  }

  private getConnection(): Connection {
    if (this.cachedConnection) {
      return this.cachedConnection;
    }

    const providerConnection = (this.program.provider as any)?.connection as Connection | undefined;
    if (providerConnection) {
      this.cachedConnection = providerConnection;
      return providerConnection;
    }

    const maybeGetConnection = (this.wallet as any).getConnection;
    if (typeof maybeGetConnection === "function") {
      const resolved = maybeGetConnection.call(this.wallet);
      if (resolved) {
        this.cachedConnection = resolved as Connection;
        return this.cachedConnection;
      }
    }

    const fallback = (this.wallet as any).connection as Connection | undefined;
    if (fallback) {
      this.cachedConnection = fallback;
      return fallback;
    }

    throw new Error("Unable to resolve Solana connection");
  }

  private buildUsernameCacheKey(ctx: Context, telegramId: string): string {
    const chatId = ctx.chat?.id ?? ctx.from?.id ?? "global";
    return `${String(chatId)}:${telegramId}`;
  }

  private removeUsernameCacheKey(key: string): void {
    const index = this.usernameCacheKeys.indexOf(key);
    if (index !== -1) {
      this.usernameCacheKeys.splice(index, 1);
    }
  }

  private trackUsernameCacheKey(key: string): void {
    this.removeUsernameCacheKey(key);
    this.usernameCacheKeys.push(key);

    while (this.usernameCacheKeys.length > this.usernameCacheMaxEntries) {
      const oldestKey = this.usernameCacheKeys.shift();
      if (oldestKey) {
        this.usernameCache.delete(oldestKey);
      }
    }
  }

  private setCachedUsername(key: string, value: string | null): void {
    const ttl =
      value === null ? Math.min(this.usernameCacheTtlMs, 30_000) : this.usernameCacheTtlMs;

    this.usernameCache.setWithTTL(key, value, ttl);
    this.trackUsernameCacheKey(key);
  }

  private removeUsernameToIdCacheKey(key: string): void {
    const index = this.usernameToIdCacheKeys.indexOf(key);
    if (index !== -1) {
      this.usernameToIdCacheKeys.splice(index, 1);
    }
  }

  private trackUsernameToIdCacheKey(key: string): void {
    this.removeUsernameToIdCacheKey(key);
    this.usernameToIdCacheKeys.push(key);

    while (this.usernameToIdCacheKeys.length > this.usernameCacheMaxEntries) {
      const oldestKey = this.usernameToIdCacheKeys.shift();
      if (oldestKey) {
        this.normalizedUsernameToIdCache.delete(oldestKey);
      }
    }
  }

  private setCachedTelegramIdForUsername(key: string, telegramId: string): void {
    this.normalizedUsernameToIdCache.setWithTTL(key, telegramId, this.usernameCacheTtlMs);
    this.trackUsernameToIdCacheKey(key);
  }

  private normalizeUsernameForLookup(username: string): string | null {
    if (typeof username !== "string") {
      return null;
    }

    const trimmed = username.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    const normalized = withoutAt.trim().toLowerCase();
    if (normalized.length === 0) {
      return null;
    }

    return normalized;
  }

  private cacheTelegramIdForUsername(telegramId: string, username: string): void {
    const normalized = this.normalizeUsernameForLookup(username);
    const trimmedId = telegramId.trim();

    if (!normalized || !/^\d+$/.test(trimmedId)) {
      return;
    }

    this.setCachedTelegramIdForUsername(normalized, trimmedId);
  }

  private rememberTelegramUsername(telegramId: string, username: string): void {
    const trimmedId = telegramId.trim();
    const trimmedUsername = username.trim();
    if (!/^\d+$/.test(trimmedId) || trimmedUsername.length === 0) {
      return;
    }

    const normalized = this.normalizeUsernameForLookup(trimmedUsername);
    if (!normalized) {
      return;
    }

    this.cacheTelegramIdForUsername(trimmedId, trimmedUsername);
    this.usernameHints.set(trimmedId, trimmedUsername);
    this.gameDb.saveUsernameMapping(normalized, trimmedId, trimmedUsername);
  }

  public primeUsernameCache(ctx: Context, telegramId: string, username: string | null): void {
    if (!username) {
      return;
    }

    const trimmedId = telegramId.trim();
    const trimmedUsername = username.trim();
    if (!/^\d+$/.test(trimmedId) || trimmedUsername.length === 0) {
      return;
    }

    this.rememberTelegramUsername(trimmedId, trimmedUsername);
    const cacheKey = this.buildUsernameCacheKey(ctx, trimmedId);
    this.setCachedUsername(cacheKey, trimmedUsername);
  }

  public findTelegramIdByUsername(username: string): string | null {
    const normalized = this.normalizeUsernameForLookup(username);
    if (!normalized) {
      return null;
    }

    const cached = this.normalizedUsernameToIdCache.get(normalized);
    if (cached) {
      return cached;
    }

    const fromDb = this.gameDb.findTelegramIdByUsername(username);
    if (fromDb) {
      this.setCachedTelegramIdForUsername(normalized, fromDb);
      this.rememberTelegramUsername(fromDb, username);
      return fromDb;
    }

    return null;
  }

  private async recreateMissingGameMessage(
    ctx: Context,
    gameAddress: string,
    options: {
      chatId?: number;
      messageText: string;
      inlineKeyboard?: any;
      gameType?: string;
      replyToMessageId?: number;
    },
  ): Promise<void> {
    const fallbackChatId =
      options.chatId ?? ctx.chat?.id ?? this.gameDb.getGame(gameAddress)?.chat_id ?? null;

    if (typeof fallbackChatId !== "number" || Number.isNaN(fallbackChatId)) {
      console.warn(`Unable to recreate Telegram message for ${gameAddress}: missing chat id`);
      return;
    }

    // Get the reply_to ID from callback context if not provided
    const replyToMessageId =
      options.replyToMessageId ?? (ctx as any).callbackQuery?.message?.message_id ?? undefined;

    try {
      const media = options.gameType
        ? resolveGameMedia(options.gameType, fallbackChatId)
        : undefined;

      const replyMarkup = options.inlineKeyboard;

      const sendResult = await sendMediaWithFallback<any, any>({
        videoFileId: media?.fileId ?? null,
        logLabel: "recreate game message",
        sendText: () =>
          ctx.api.sendMessage(fallbackChatId, options.messageText, {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
            reply_to_message_id: replyToMessageId,
            link_preview_options: { is_disabled: true },
          }),
        sendVideo:
          media && typeof ctx.api.sendVideo === "function"
            ? () => {
                if (media.mediaType === "photo") {
                  return ctx.api.sendPhoto(fallbackChatId, media.fileId, {
                    caption: options.messageText,
                    parse_mode: "HTML",
                    reply_markup: replyMarkup,
                    reply_to_message_id: replyToMessageId,
                  }) as any;
                } else if (media.mediaType === "animation") {
                  return ctx.api.sendAnimation(fallbackChatId, media.fileId, {
                    caption: options.messageText,
                    parse_mode: "HTML",
                    reply_markup: replyMarkup,
                    reply_to_message_id: replyToMessageId,
                  }) as any;
                } else {
                  return ctx.api.sendVideo(fallbackChatId, media.fileId, {
                    caption: options.messageText,
                    parse_mode: "HTML",
                    reply_markup: replyMarkup,
                    reply_to_message_id: replyToMessageId,
                  }) as any;
                }
              }
            : undefined,
      });

      const sentMessage: any = sendResult.result;
      const usesVideo = sendResult.usedVideo;

      this.gameDb.saveGameMessage(gameAddress, sentMessage.message_id, sentMessage.chat.id);

      const existing = this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
      existing.set(sentMessage.chat.id, {
        messageId: sentMessage.message_id,
        chatId: sentMessage.chat.id,
        usesVideo,
      });
      this.activeGameMessages.set(gameAddress, existing);

      this.gameMessageReadyListener?.(gameAddress);
    } catch (sendError) {
      console.error(`Failed to recreate Telegram message for game ${gameAddress}:`, sendError);
    }
  }

  private getOraclePda(): PublicKey {
    return PDAManager.getOraclePDA(this.program.programId);
  }

  private getGameVaultPda(tokenMint: PublicKey): PublicKey {
    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), tokenMint.toBuffer()],
      this.program.programId,
    );
    return gameVaultPda;
  }

  private async resolveTokenProgramId(tokenMint: PublicKey): Promise<PublicKey> {
    const accountInfo = await this.getConnection().getAccountInfo(tokenMint);
    if (!accountInfo) {
      throw new Error(`Token mint ${tokenMint.toBase58()} not found`);
    }
    if (!accountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new Error(`Timba only supports legacy SPL Token mints`);
    }
    return TOKEN_PROGRAM_ID;
  }

  private async deriveAta(
    tokenMint: PublicKey,
    owner: PublicKey,
    tokenProgram: PublicKey,
    allowOwnerOffCurve = false,
  ): Promise<PublicKey> {
    return getAssociatedTokenAddress(tokenMint, owner, allowOwnerOffCurve, tokenProgram);
  }

  private async resolveGameTokenAccounts(tokenMint: PublicKey): Promise<{
    tokenProgram: PublicKey;
    gameToken: PublicKey;
    gameVault: PublicKey;
    gameTokenAccount: PublicKey;
  }> {
    const tokenProgram = await this.resolveTokenProgramId(tokenMint);
    const gameToken = PDAManager.getGameTokenPDA(tokenMint, this.program.programId);
    const gameVault = this.getGameVaultPda(tokenMint);
    const gameTokenAccount = await this.deriveAta(tokenMint, gameVault, tokenProgram, true);

    return {
      tokenProgram,
      gameToken,
      gameVault,
      gameTokenAccount,
    };
  }

  private buildGameTokenContext(
    tokenMint: PublicKey,
    accounts: {
      tokenProgram: PublicKey;
      gameToken: PublicKey;
      gameVault: PublicKey;
      gameTokenAccount: PublicKey;
    },
  ): GameTokenContextAccounts {
    return {
      tokenMint,
      gameToken: accounts.gameToken,
      gameVault: accounts.gameVault,
      gameTokenAccount: accounts.gameTokenAccount,
      tokenProgram: accounts.tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    };
  }

  private async buildJoinAccounts(
    gamePda: PublicKey,
    gameAccount: any,
    player: PublicKey,
    oracleOperator?: PublicKey,
  ): Promise<{
    accounts: Record<string, unknown>;
    setupInstructions: TransactionInstruction[];
  }> {
    const tokenMint = new PublicKey(gameAccount.tokenMint);
    const tokenAccounts = await this.resolveGameTokenAccounts(tokenMint);
    const gameTokenCtx = this.buildGameTokenContext(tokenMint, tokenAccounts);
    const playerTokenAccount = await this.deriveAta(tokenMint, player, tokenAccounts.tokenProgram);

    const setupInstructions: TransactionInstruction[] = [];
    try {
      const accountInfo = await this.getConnection().getAccountInfo(playerTokenAccount);
      if (!accountInfo) {
        setupInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            player,
            playerTokenAccount,
            player,
            tokenMint,
            tokenAccounts.tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID,
          ),
        );
      }
    } catch (error) {
      console.warn("Failed to check player ATA existence, defaulting to creation:", error);
      setupInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          player,
          playerTokenAccount,
          player,
          tokenMint,
          tokenAccounts.tokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }

    const accounts: Record<string, unknown> = {
      game: gamePda,
      player,
      gameTokenCtx,
      playerTokenAccount,
      oracle: this.getOraclePda(),
    };

    if (oracleOperator) {
      accounts["oracleOperator"] = oracleOperator;
    }

    return { accounts, setupInstructions };
  }

  private async buildUnjoinAccounts(
    gamePda: PublicKey,
    gameAccount: any,
    player: PublicKey,
    authority: PublicKey,
  ): Promise<Record<string, unknown>> {
    const { accounts } = await this.buildJoinAccounts(gamePda, gameAccount, player);
    accounts["authority"] = authority;
    return accounts;
  }

  private async buildCloseGameAccounts(
    gamePda: PublicKey,
    gameAccount: any,
  ): Promise<Record<string, unknown>> {
    const tokenMint = new PublicKey(gameAccount.tokenMint);
    const tokenAccounts = await this.resolveGameTokenAccounts(tokenMint);
    const gameTokenCtx = this.buildGameTokenContext(tokenMint, tokenAccounts);
    const creatorPubkey = new PublicKey(gameAccount.creator);
    const creatorTokenAccount = await this.deriveAta(
      tokenMint,
      creatorPubkey,
      tokenAccounts.tokenProgram,
    );

    return {
      game: gamePda,
      creator: creatorPubkey,
      oracle: this.getOraclePda(),
      gameTokenCtx,
      creatorTokenAccount,
      systemProgram: SystemProgram.programId,
    };
  }

  // ================================
  // PLAYER UTILITIES
  // ================================

  /** Check if a player is in a game via database records */
  private async isPlayerInGame(gamePda: PublicKey, playerPubkey: PublicKey): Promise<boolean> {
    const gameAddress = gamePda.toBase58();
    const playerPubkeyStr = playerPubkey.toBase58();

    try {
      const playerTelegramId = this.gameDb.getPlayerTelegramId?.(playerPubkeyStr);

      if (playerTelegramId) {
        const hasParticipant = (this.gameDb as any).isGameParticipant?.bind(this.gameDb) as
          ((game: string, telegramId: string) => boolean) | undefined;

        if (typeof hasParticipant === "function") {
          if (hasParticipant(gameAddress, playerTelegramId)) {
            return true;
          }
        } else {
          const participants = this.gameDb.getGameParticipants(gameAddress);
          if (participants.includes(playerTelegramId)) {
            return true;
          }
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to check local participant records for ${gameAddress}:`, error);
    }

    try {
      const accountInterface = this.program.account.game as any;
      const fetchNullable = accountInterface?.fetchNullable?.bind(accountInterface);

      const gameAccount = fetchNullable
        ? await fetchNullable(gamePda)
        : await accountInterface.fetch(gamePda);

      if (!gameAccount) {
        return false;
      }

      const participants = (gameAccount as any)?.participants;
      if (!Array.isArray(participants) || participants.length === 0) return false;

      return participants.some((value: any) => {
        try {
          return new PublicKey(value).equals(playerPubkey);
        } catch {
          return false;
        }
      });
    } catch (error) {
      console.warn(`⚠️ Failed to verify on-chain participants for ${gameAddress}:`, error);
      return false;
    }
  }

  private async verifyParticipantJoin(
    gamePda: PublicKey,
    playerPubkey: PublicKey,
    telegramId: string,
    options: { joinSignature?: string | null; maxAttempts?: number } = {},
  ): Promise<boolean> {
    const maxAttempts = options.maxAttempts ?? 5;
    const delays = [0, 500, 1_000, 2_000, 4_000];
    const gameAddress = gamePda.toBase58();
    const playerPubkeyStr = playerPubkey.toBase58();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delayMs = delays[Math.min(attempt, delays.length - 1)];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const isOnChain = await this.isPlayerInGame(gamePda, playerPubkey);
      if (isOnChain) {
        this.gameDb.saveGameParticipant(gameAddress, telegramId, playerPubkeyStr, {
          status: "confirmed",
          joinSignature: options.joinSignature,
          lastVerifiedAt: Date.now(),
        });
        return true;
      }
    }

    console.warn(
      `⚠️ Player ${playerPubkeyStr} not yet recorded on-chain for ${gameAddress} after ${maxAttempts} verification attempt(s)`,
    );
    return false;
  }

  private async reconcilePendingParticipants(gamePda: PublicKey): Promise<void> {
    const getPending = (this.gameDb as any).getPendingParticipants?.bind(this.gameDb);
    if (typeof getPending !== "function") {
      return;
    }

    const gameAddress = gamePda.toBase58();
    const pendingParticipants = getPending(gameAddress) as Array<{
      telegram_id?: string;
      telegramId?: string;
      public_key?: string | null;
      publicKey?: string | null;
      join_signature?: string | null;
      joinSignature?: string | null;
      joined_at?: number;
      joinedAt?: number;
    }>;

    if (!Array.isArray(pendingParticipants) || pendingParticipants.length === 0) {
      return;
    }

    const now = Date.now();
    const staleThresholdMs = 5 * 60 * 1000; // 5 minutes

    for (const participant of pendingParticipants) {
      const telegramId = participant.telegram_id ?? participant.telegramId ?? null;
      if (!telegramId) {
        continue;
      }

      let playerKeyStr = participant.public_key ?? participant.publicKey ?? null;
      if (!playerKeyStr) {
        playerKeyStr = this.gameDb.getPlayerPublicKey?.(telegramId) ?? null;
      }
      if (!playerKeyStr) {
        continue;
      }

      let playerPubkey: PublicKey;
      try {
        playerPubkey = new PublicKey(playerKeyStr);
      } catch (_) {
        continue;
      }

      const joinSignature = participant.join_signature ?? participant.joinSignature ?? null;

      const verified = await this.verifyParticipantJoin(gamePda, playerPubkey, telegramId, {
        joinSignature,
        maxAttempts: 2,
      });

      if (!verified) {
        const joinedAt = participant.joined_at ?? participant.joinedAt ?? 0;
        if (joinedAt > 0 && now - joinedAt > staleThresholdMs) {
          console.warn(
            `⚠️ Removing stale pending participant ${telegramId} from ${gameAddress}; no on-chain record after ${Math.round(
              (now - joinedAt) / 1000,
            )}s`,
          );
          this.gameDb.removeGameParticipant(gameAddress, telegramId);
        }
      }
    }
  }

  /** Get all players in a game from the database */
  private getGamePlayers(gameAddress: string): string[] {
    return this.gameDb.getGameParticipants(gameAddress);
  }

  private recoverParticipantsFromChain(
    gamePda: PublicKey,
    gameAccount: any,
    knownTelegramIds: Set<string>,
  ): {
    recovered: Array<{ telegramId: string; publicKey: string }>;
    unmatchedParticipants: string[];
  } {
    const rawParticipants = gameAccount.participants;
    if (!Array.isArray(rawParticipants) || rawParticipants.length === 0) {
      return { recovered: [], unmatchedParticipants: [] };
    }

    const onChainParticipants = new Set(
      rawParticipants.flatMap((participant: any) => {
        try {
          return [new PublicKey(participant).toBase58()];
        } catch (_) {
          return [];
        }
      }),
    );

    if (onChainParticipants.size === 0) {
      return { recovered: [], unmatchedParticipants: [] };
    }

    const unmatchedParticipants = new Set(onChainParticipants);

    for (const telegramId of knownTelegramIds) {
      const publicKey = this.gameDb.getPlayerPublicKey(telegramId);
      if (!publicKey) {
        continue;
      }

      try {
        unmatchedParticipants.delete(new PublicKey(publicKey).toBase58());
      } catch (_) {
        // Ignore invalid stale mappings and continue recovery.
      }
    }

    const initialUnmatched = unmatchedParticipants.size;
    if (initialUnmatched === 0) {
      return { recovered: [], unmatchedParticipants: [] };
    }

    const recovered: Array<{ telegramId: string; publicKey: string }> = [];
    const allMappings = (this.gameDb.getAllPlayerMappings?.() ?? []) as any[];

    for (const mapping of allMappings) {
      const telegramId = mapping?.telegram_id ?? mapping?.telegramId;
      const publicKey = mapping?.public_key ?? mapping?.publicKey;
      if (!telegramId || !publicKey || knownTelegramIds.has(telegramId)) {
        continue;
      }

      let identifier: string;
      try {
        identifier = new PublicKey(publicKey).toBase58();
      } catch (_) {
        continue;
      }

      if (unmatchedParticipants.has(identifier)) {
        recovered.push({ telegramId, publicKey });
        unmatchedParticipants.delete(identifier);
      }

      if (unmatchedParticipants.size === 0) {
        break;
      }
    }

    for (const participant of recovered) {
      try {
        this.gameDb.saveGameParticipant?.(
          gamePda.toBase58(),
          participant.telegramId,
          participant.publicKey,
          {
            status: "confirmed",
            joinSignature: null,
            lastVerifiedAt: Date.now(),
          },
        );
        knownTelegramIds.add(participant.telegramId);
      } catch (error) {
        console.warn(
          `⚠️ Failed to persist recovered participant ${participant.telegramId} for ${gamePda.toBase58()}:`,
          error,
        );
      }
    }

    if (recovered.length > 0) {
      debugLog(
        `🔄 Recovered ${recovered.length} participant(s) for ${gamePda.toBase58()} from on-chain data`,
      );
    }

    if (unmatchedParticipants.size > 0 && initialUnmatched === unmatchedParticipants.size) {
      console.warn(`⚠️ Unable to match any on-chain participants for ${gamePda.toBase58()}`);
    } else if (unmatchedParticipants.size > 0) {
      console.warn(
        `⚠️ Unable to map ${unmatchedParticipants.size} participant(s) for ${gamePda.toBase58()}`,
      );
    }

    return {
      recovered,
      unmatchedParticipants: Array.from(unmatchedParticipants),
    };
  }

  private getOnChainParticipantCount(gameAccount: any): number {
    const participants = gameAccount.participants;
    return Array.isArray(participants) ? participants.length : 0;
  }

  private async resolveTokenFormattingInfo(
    gamePda: PublicKey,
    tokenTicker: string,
    tokenMintHint?: string | null,
  ): Promise<{
    formatBalance: (value: number | bigint | string) => string;
    decimals: number;
    tokenMint?: string;
    isSol: boolean;
  }> {
    const normalizedTicker = typeof tokenTicker === "string" ? tokenTicker.toUpperCase() : "";
    const gameAddress = gamePda.toBase58();
    const storedGame =
      typeof this.gameDb.getGame === "function" ? this.gameDb.getGame(gameAddress) : undefined;
    let tokenMint = tokenMintHint ?? storedGame?.token_mint ?? undefined;

    let isSolToken = normalizedTicker === "SOL" || tokenMint === "SOL";

    if (!tokenMint && !isSolToken) {
      try {
        const gameAccount = await this.program.account.game.fetch(gamePda);
        const mint = (gameAccount as any)?.tokenMint as PublicKey | undefined;
        if (mint) {
          tokenMint = mint.toBase58();
          isSolToken = tokenMint === "SOL";
        }
      } catch (error) {
        console.warn(`Unable to fetch game account ${gameAddress} for token info:`, error);
      }
    }

    const buildFormatter = (options: { decimals: number; useSolFormatter: boolean }) => {
      const { decimals, useSolFormatter } = options;
      const formatWithWallet = (value: number): string => {
        if (useSolFormatter) {
          return this.wallet.formatSolBalance(value);
        }
        return this.wallet.formatTokenBalance(value, decimals);
      };

      return (value: number | bigint | string): string => {
        const lamports = coerceLamportValue(value);
        if (lamports !== null) {
          if (lamports > MAX_SAFE_LAMPORTS) {
            return formatAmount(lamports, decimals, { trim: true });
          }
          return formatWithWallet(Number(lamports));
        }

        if (typeof value === "number" && Number.isFinite(value)) {
          return formatWithWallet(value);
        }

        if (typeof value === "string") {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) {
            return formatWithWallet(parsed);
          }
        }

        return formatAmount(0, decimals, { trim: true });
      };
    };

    if (isSolToken) {
      return {
        formatBalance: buildFormatter({ decimals: 9, useSolFormatter: true }),
        decimals: 9,
        tokenMint,
        isSol: true,
      };
    }

    if (tokenMint) {
      try {
        const metadata = await this.wallet.getTokenMetadata(tokenMint);
        const decimals = typeof metadata?.decimals === "number" ? metadata.decimals : 6;
        return {
          formatBalance: buildFormatter({ decimals, useSolFormatter: false }),
          decimals,
          tokenMint,
          isSol: false,
        };
      } catch (error) {
        console.warn(
          `Unable to load metadata for token ${tokenMint}, using fallback decimals`,
          error,
        );
      }
    }

    const fallbackDecimals = 6;
    return {
      formatBalance: buildFormatter({
        decimals: fallbackDecimals,
        useSolFormatter: false,
      }),
      decimals: fallbackDecimals,
      tokenMint,
      isSol: false,
    };
  }

  private formatUsdValue(
    amount: number | bigint | string,
    decimals: number,
    price: number,
  ): string | null {
    const lamports = coerceLamportValue(amount);
    if (lamports === null || lamports <= 0n) return null;
    if (!Number.isFinite(price) || price <= 0) return null;

    if (lamports > MAX_SAFE_LAMPORTS) {
      return null;
    }

    const normalizedAmount = Number(lamports) / Math.pow(10, decimals);
    const usdValue = normalizedAmount * price;
    if (!Number.isFinite(usdValue) || usdValue <= 0) {
      return null;
    }

    const formatted = formatUsdValueText(usdValue, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
      fallback: "0",
    });

    return `$${formatted}`;
  }

  private async getUsdApproximation(
    amount: number | bigint | string,
    decimals: number,
    tokenMint?: string,
    isSol?: boolean,
    priceHint?: CachedPriceLookup | null,
    priceCacheKey?: string,
  ): Promise<{ text: string; price: number } | null> {
    const reference = isSol ? WSOL_MINT : tokenMint;
    if (!reference) return null;
    const lamports = coerceLamportValue(amount);
    if (lamports === null || lamports <= 0n) return null;
    if (lamports > MAX_SAFE_LAMPORTS) return null;
    if (process.env.NODE_ENV === "test") return null;

    try {
      const hintToUse =
        priceHint ?? (priceCacheKey ? (this.gamePriceCache.get(priceCacheKey) ?? null) : null);
      const lookup = await getUsdPrice({
        tokenMint: reference,
        hint: hintToUse,
      });
      if (!lookup) {
        return null;
      }

      const usdText = this.formatUsdValue(lamports, decimals, lookup.price);
      if (!usdText) {
        return null;
      }

      if (priceCacheKey) {
        this.gamePriceCache.setWithTTL(priceCacheKey, lookup);
      }

      return { text: usdText, price: lookup.price };
    } catch (error) {
      console.warn(`Failed to compute USD pricing for ${reference}:`, error);
      return null;
    }
  }

  private buildSolShortfallMessage(options: {
    currentLamports: number;
    requiredLamports: number;
    reason?: string;
    nextSteps?: string;
  }): string {
    const { currentLamports, requiredLamports, reason, nextSteps } = options;
    const missingLamports = Math.max(requiredLamports - currentLamports, 0);

    return buildFriendlyShortfallMessage({
      missingLamports,
      walletManager: this.wallet,
      reason,
      action: nextSteps,
    });
  }

  private buildGameFundingPlan(options: {
    currentSolLamports: number;
    gameDepositLamports: number;
    feeSafetyReserveLamports: number;
    retainedWalletReserveLamports: number;
    stakeRaw: number;
    tokenBalanceRaw: number;
  }): GameFundingPlan {
    const requiredSolLamports =
      options.gameDepositLamports +
      options.feeSafetyReserveLamports +
      options.retainedWalletReserveLamports;

    return {
      currentSolLamports: options.currentSolLamports,
      gameDepositLamports: options.gameDepositLamports,
      feeSafetyReserveLamports: options.feeSafetyReserveLamports,
      retainedWalletReserveLamports: options.retainedWalletReserveLamports,
      requiredSolLamports,
      shortfallLamports: Math.max(requiredSolLamports - options.currentSolLamports, 0),
      stakeRaw: options.stakeRaw,
      spareTokenRaw: Math.max(options.tokenBalanceRaw - options.stakeRaw, 0),
    };
  }

  private formatRoundedSol(lamports: number): string {
    const roundedUp = Math.ceil(Math.max(lamports, 0) / 1_000) * 1_000;
    return `${this.wallet.formatSolBalance(roundedUp)} SOL`;
  }

  private buildGameSolShortfallMessage(options: {
    currentLamports: number;
    requiredLamports: number;
    action: "create this game" | "join this game";
    explanation?: string;
    nextSteps?: string;
  }): string {
    const shortfallLamports = Math.max(options.requiredLamports - options.currentLamports, 0);
    const explanation = options.explanation ? `\n\n${options.explanation}` : "";

    return (
      `💰 You need about ${this.formatRoundedSol(shortfallLamports)} more to ${options.action}.` +
      explanation +
      `\n\n${options.nextSteps ?? "Add SOL and try again."}`
    );
  }

  private buildGameCreationShortfallMessage(
    plan: GameFundingPlan,
    formattedStake: string,
    tokenTicker: string,
  ): string {
    return this.buildGameSolShortfallMessage({
      currentLamports: plan.currentSolLamports,
      requiredLamports: plan.requiredSolLamports,
      action: "create this game",
      explanation: `Your ${formattedStake} ${tokenTicker} balance only covers the stake, so the bot cannot swap extra ${tokenTicker} for SOL.`,
      nextSteps: "Add SOL or create a smaller game.",
    });
  }

  private buildGameJoinShortfallMessage(
    currentLamports: number,
    requiredLamports: number,
    stake?: { amount: string; ticker: string },
  ): string {
    return this.buildGameSolShortfallMessage({
      currentLamports,
      requiredLamports,
      action: "join this game",
      explanation: stake
        ? `Your ${stake.amount} ${stake.ticker} balance only covers the stake, so the bot cannot swap extra ${stake.ticker} for SOL.`
        : undefined,
    });
  }

  private async confirmTransactionWithRecovery(
    signature: string,
    gamePda: PublicKey,
    operationType: "Game creation" | "Player join" | "Game close" | "Player unjoin",
    playerPubkey?: PublicKey,
    resubmit?: (attempt: number, previousSignature: string) => Promise<string>,
    options?: { retryDelays?: number[] },
  ): Promise<string> {
    const probes: TransactionProbe[] = [];
    const fetchGameAccountNullable = async (): Promise<any | null> => {
      try {
        const accountInterface = this.program.account.game as any;
        const fetchNullable = accountInterface?.fetchNullable?.bind(accountInterface);
        if (fetchNullable) {
          return await fetchNullable(gamePda);
        }
        return await accountInterface.fetch(gamePda);
      } catch (error: any) {
        const message = error?.message?.toLowerCase?.() ?? "";
        if (message.includes("account does not exist")) {
          return null;
        }
        throw error;
      }
    };

    if (operationType === "Game creation") {
      probes.push({
        label: "Game account exists",
        check: async () => {
          try {
            const gameAccount = await fetchGameAccountNullable();
            return Boolean(gameAccount);
          } catch {
            return false;
          }
        },
      });
    } else if (operationType === "Game close") {
      probes.push({
        label: "Game account closed",
        check: async () => {
          try {
            const gameAccount = await fetchGameAccountNullable();
            return !gameAccount;
          } catch {
            return false;
          }
        },
      });
    } else if (
      (operationType === "Player join" || operationType === "Player unjoin") &&
      playerPubkey
    ) {
      probes.push({
        label:
          operationType === "Player join"
            ? "Player is recorded in game"
            : "Player removed from game",
        check: async () => {
          const isInGame = await this.isPlayerInGame(gamePda, playerPubkey);
          return operationType === "Player join" ? isInGame : !isInGame;
        },
      });
    }

    try {
      return await confirmTransactionWithRecovery({
        wallet: this.wallet,
        initialSignature: signature,
        operationLabel: operationType,
        resubmit,
        probes,
        retryDelays: options?.retryDelays,
        logger: debugLog,
      });
    } catch (error: any) {
      try {
        const hasCause = (error as any).cause !== undefined;
        if (operationType === "Game creation") {
          const gameAccount = await fetchGameAccountNullable();
          if (!gameAccount && !hasCause) {
            (error as any).cause = new Error(
              "Game account not found after timeout (attempted recovery).",
            );
          }
        } else if (operationType === "Game close") {
          const gameAccount = await fetchGameAccountNullable();
          if (gameAccount && !hasCause) {
            (error as any).cause = new Error(
              "Game account still exists after timeout (attempted recovery).",
            );
          }
        } else if (
          (operationType === "Player join" || operationType === "Player unjoin") &&
          playerPubkey
        ) {
          const isInGame = await this.isPlayerInGame(gamePda, playerPubkey).catch(() => false);
          const violation = operationType === "Player join" ? !isInGame : isInGame;
          if (violation && !hasCause) {
            (error as any).cause = new Error(
              operationType === "Player join"
                ? "Player not recorded in game after timeout (attempted recovery)."
                : "Player still recorded in game after timeout (attempted recovery).",
            );
          }
        }
      } catch (probeError) {
        (error as any).cause =
          probeError instanceof Error ? probeError : new Error(String(probeError));
      }
      throw error;
    }
  }

  private async sendInstructionsWithFallback(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    operationLabel: string,
    options?: { skipConfirmation?: boolean },
  ): Promise<string> {
    const walletWithResubmits = (this.wallet as any).sendAndConfirmWithResubmits;
    if (typeof walletWithResubmits === "function") {
      return await walletWithResubmits.call(this.wallet, instructions, signers, {
        operationLabel,
        skipConfirmation: options?.skipConfirmation,
      });
    }

    const signature = await this.wallet.sendTransaction(instructions, signers);
    if (!options?.skipConfirmation) {
      await this.wallet.confirmTransaction(signature);
    }
    return signature;
  }

  /**
   * Calculate game account rent based on maxTickets.
   * Game account structure (from IDL):
   * - 8 bytes discriminator
   * - 32 bytes creator (pubkey)
   * - 1 byte game_type (enum)
   * - 8 bytes ticket_amount (u64)
   * - 4 bytes max_tickets (u32)
   * - 4 bytes min_tickets (u32)
   * - 4 bytes tickets_count (u32)
   * - 32 bytes token_mint (pubkey)
   * - 8 bytes created_at (u64)
   * - 8 bytes timeout (u64)
   * - 8 bytes last_slot (u64)
   * - 1 byte is_private (bool)
   * - 8 bytes total_amount (u64)
   * - 4 bytes participants vec length
   * - 32 bytes per participant public key
   */
  private async getGameCreationRentLamports(maxTickets: number): Promise<number> {
    const safeMaxTickets = Math.max(0, Math.trunc(maxTickets) || 0);
    const accountSize =
      GAME_BASE_ACCOUNT_SIZE +
      PARTICIPANTS_VECTOR_PREFIX_SIZE +
      safeMaxTickets * PARTICIPANT_PUBLIC_KEY_SIZE;

    return this.getRentExemptionLamports(accountSize, "game deposit");
  }

  private async getNativeWalletReserveLamports(): Promise<number> {
    return this.getRentExemptionLamports(0, "wallet reserve");
  }

  private async getRentExemptionLamports(accountSize: number, label: string): Promise<number> {
    try {
      const rent = await this.getConnection().getMinimumBalanceForRentExemption(accountSize);
      if (Number.isFinite(rent) && rent > 0) {
        return rent;
      }
    } catch (error) {
      console.warn(`⚠️ Failed to determine ${label} lamports:`, error);
    }

    throw new Error(`Unable to calculate the ${label}. Please try again.`);
  }

  private async ensureWrappedSolBalance(
    telegramId: bigint,
    requiredLamports: number,
    currentTokenBalance: number,
    currentSolBalance: number,
    context: "create" | "join",
    solReserveOverrideLamports?: number,
  ): Promise<
    { success: true; tokenBalance: number; solBalance: number } | { success: false; error: string }
  > {
    const [wrapFeeBuffer, defaultMinSolBuffer] = await Promise.all([
      this.feeBudget.getWrapFeeBufferLamports(),
      this.feeBudget.getGameSafetyBufferLamports(),
    ]);
    const minSolBuffer =
      solReserveOverrideLamports !== undefined ? solReserveOverrideLamports : defaultMinSolBuffer;

    debugLog(
      `🔍 WSOL wrap check (${context}): required=${this.wallet.formatSolBalance(
        requiredLamports,
      )} WSOL, currentWSOL=${this.wallet.formatSolBalance(
        currentTokenBalance,
      )}, currentSOL=${this.wallet.formatSolBalance(currentSolBalance)}, wrapBuffer=${this.wallet.formatSolBalance(
        wrapFeeBuffer,
      )}, minSolBuffer=${this.wallet.formatSolBalance(minSolBuffer)}`,
    );

    if (currentTokenBalance >= requiredLamports) {
      return {
        success: true,
        tokenBalance: currentTokenBalance,
        solBalance: currentSolBalance,
      };
    }

    const deficit = requiredLamports - currentTokenBalance;

    const projectedRemaining = currentSolBalance - deficit - wrapFeeBuffer;
    if (projectedRemaining < minSolBuffer) {
      const requiredReserve = deficit + wrapFeeBuffer + minSolBuffer;
      console.warn(
        `⚠️ Not enough SOL to wrap ${this.wallet.formatSolBalance(
          deficit,
        )} for ${context}. Current SOL=${this.wallet.formatSolBalance(
          currentSolBalance,
        )}, projected SOL after wrap=${this.wallet.formatSolBalance(
          projectedRemaining,
        )}, required reserve=${this.wallet.formatSolBalance(requiredReserve)}`,
      );
      return {
        success: false,
        error: this.buildGameSolShortfallMessage({
          currentLamports: currentSolBalance,
          requiredLamports: requiredReserve,
          action: context === "create" ? "create this game" : "join this game",
          explanation: "Using SOL for the stake would leave too little SOL for the transaction.",
          nextSteps:
            context === "create" ? "Add SOL or create a smaller game." : "Add SOL and try again.",
        }),
      };
    }

    debugLog(
      `🔄 Wrapping ${this.wallet.formatSolBalance(deficit)} SOL into WSOL for game ${context}...`,
    );

    try {
      const wrapSignature = await this.wallet.wrapSol(telegramId, deficit);
      debugLog(`✅ Wrap transaction submitted (${context}): signature=${wrapSignature}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const friendly = await formatUserFriendlyError(
        new Error(`Failed to wrap SOL automatically: ${detail}`),
        this.wallet,
      );
      console.error(
        `❌ Wrap failed for ${context}: ${friendly}. deficit=${this.wallet.formatSolBalance(
          deficit,
        )}, solBefore=${this.wallet.formatSolBalance(currentSolBalance)}`,
      );
      return {
        success: false,
        error: friendly,
      };
    }

    let updatedTokenBalance: number;
    let updatedSolBalance: number;

    const retryDelays = getWrapBalanceRetryDelays();

    for (let attempt = 0; ; attempt++) {
      [updatedTokenBalance, updatedSolBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, WSOL_MINT),
        this.wallet.getBalance(telegramId),
      ]);

      if (updatedTokenBalance >= requiredLamports) {
        break;
      }

      if (attempt >= retryDelays.length) {
        break;
      }
      const delay = retryDelays[attempt] ?? 0;

      debugLog(
        `⏳ Waiting for WSOL balance propagation (attempt ${attempt + 1}/${
          retryDelays.length + 1
        })`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (updatedTokenBalance < requiredLamports) {
      console.error(
        `⚠️ Wrap completed but WSOL balance ${this.wallet.formatSolBalance(
          updatedTokenBalance,
        )} still below required ${this.wallet.formatSolBalance(requiredLamports)}`,
      );
      return {
        success: false,
        error:
          "Wrap completed but WSOL balance is still below the required stake. Top up SOL and try again.",
      };
    }

    if (updatedSolBalance < minSolBuffer) {
      console.warn(
        `⚠️ Wrap left SOL balance ${this.wallet.formatSolBalance(
          updatedSolBalance,
        )}, below buffer ${this.wallet.formatSolBalance(minSolBuffer)}`,
      );
      return {
        success: false,
        error: this.buildGameSolShortfallMessage({
          currentLamports: updatedSolBalance,
          requiredLamports: minSolBuffer,
          action: context === "create" ? "create this game" : "join this game",
        }),
      };
    }

    debugLog(
      `✅ Wrapped SOL. New WSOL balance: ${this.wallet.formatSolBalance(
        updatedTokenBalance,
      )}, remaining SOL: ${this.wallet.formatSolBalance(updatedSolBalance)}`,
    );

    return {
      success: true,
      tokenBalance: updatedTokenBalance,
      solBalance: updatedSolBalance,
    };
  }

  private async ensureUnjoinFeePayerBalance(options: {
    telegramId: string;
    tokenMint: string | null;
    tokenDecimals: number;
    tokenTicker: string;
    userKeypair: Keypair;
    logContext: string;
  }): Promise<{ success: true } | { success: false; reason: string }> {
    const { telegramId, tokenMint, tokenDecimals, tokenTicker, userKeypair, logContext } = options;

    if (!telegramId) {
      return { success: false, reason: "Missing Telegram identifier" };
    }

    let telegramBigInt: bigint;
    try {
      telegramBigInt = BigInt(telegramId);
    } catch {
      return { success: false, reason: "Invalid player identifier" };
    }

    try {
      const minSolBuffer = await this.feeBudget.getGameSafetyBufferLamports();
      let solBalance = await this.wallet.getBalance(telegramBigInt);
      if (solBalance >= minSolBuffer) {
        return { success: true };
      }

      if (!tokenMint) {
        return {
          success: false,
          reason: "Missing token mint information required for SOL top-up",
        };
      }

      const tokenBalance = await this.wallet.getTokenBalance(telegramBigInt, tokenMint, {
        createIfMissing: false,
      });

      if (tokenBalance <= 0) {
        return {
          success: false,
          reason: `No spare ${tokenTicker.toUpperCase()} available to swap for SOL fees.`,
        };
      }

      const swapResult = await this.swapManager.performJustInTimeSolSwap({
        userKeypair,
        tokenMint,
        tokenDecimals,
        availableTokenAmountRaw: Math.max(Math.floor(tokenBalance), 0),
        desiredLamports: minSolBuffer,
        tokenTicker,
        logContext,
      });

      if (!swapResult.swapped) {
        return {
          success: false,
          reason: swapResult.error ?? `Unable to swap ${tokenTicker.toUpperCase()} for SOL fees.`,
        };
      }

      this.wallet.clearCachedWalletData?.(telegramBigInt);

      solBalance = await this.wallet.getBalance(telegramBigInt, {
        forceFresh: true,
      });
      if (solBalance < minSolBuffer) {
        return {
          success: false,
          reason: this.buildSolShortfallMessage({
            currentLamports: solBalance,
            requiredLamports: minSolBuffer,
            reason: "Just-in-time swap did not leave enough SOL for the rent and fee reserve",
            nextSteps: "Add more SOL to continue.",
          }),
        };
      }

      return { success: true };
    } catch (error) {
      console.error(`Failed to prepare SOL balance for ${logContext}:`, error);
      const message = error instanceof Error ? error.message : String(error ?? "unknown error");
      return { success: false, reason: message };
    }
  }

  // ================================
  // USERNAME UTILITIES
  // ================================

  /**
   * Format Solana address for display
   */
  private formatAddress(address: string): string {
    return formatPlayerAddress(address);
  }

  /**
   * Get username from Telegram ID with consistent error handling
   */
  public async getUsernameFromTelegramId(
    ctx: Context,
    telegramId: string,
    options?: { allowNetworkLookup?: boolean },
  ): Promise<string | null> {
    try {
      const trimmedId = telegramId.trim();
      if (!/^\d+$/.test(trimmedId)) {
        throw new Error(`Invalid Telegram ID: ${telegramId}`);
      }

      const chatId = ctx.chat?.id;
      if (chatId === undefined || chatId === null) {
        throw new Error("Chat context is required to resolve usernames");
      }

      const cacheKey = this.buildUsernameCacheKey(ctx, trimmedId);
      const cached = this.usernameCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const hinted = this.usernameHints.get(trimmedId) ?? null;
      const persistedDisplayName =
        typeof this.gameDb.getPlayerDisplayName === "function"
          ? this.gameDb.getPlayerDisplayName(trimmedId)
          : null;
      const fallbackCandidate = hinted ?? persistedDisplayName ?? null;
      if (persistedDisplayName && !hinted) {
        this.rememberTelegramUsername(trimmedId, persistedDisplayName);
      }

      if (options?.allowNetworkLookup === false) {
        this.setCachedUsername(cacheKey, fallbackCandidate);
        return fallbackCandidate;
      }

      this.usernameCache.delete(cacheKey);
      this.removeUsernameCacheKey(cacheKey);

      let lookup = this.usernameLookupPromises.get(cacheKey);
      if (!lookup) {
        lookup = (async () => {
          try {
            const maybeNumericId = Number(trimmedId);
            const targetId = Number.isSafeInteger(maybeNumericId) ? maybeNumericId : trimmedId;
            const chatMember = await (ctx.api as any).getChatMember(chatId, targetId);
            const userRecord = chatMember.user ?? {};
            const handle =
              typeof userRecord.username === "string" && userRecord.username.trim().length > 0
                ? `@${userRecord.username.trim()}`
                : null;
            const firstName =
              typeof userRecord.first_name === "string" ? userRecord.first_name.trim() : "";
            const lastName =
              typeof userRecord.last_name === "string" ? userRecord.last_name.trim() : "";
            const fullName = [firstName, lastName].filter((name) => name.length > 0).join(" ");
            const resolved = handle || (fullName.length > 0 ? fullName : null);
            if (resolved) {
              this.rememberTelegramUsername(trimmedId, resolved);
            }
            this.setCachedUsername(cacheKey, resolved);
            return resolved;
          } catch (fetchError) {
            if (fallbackCandidate) {
              this.rememberTelegramUsername(trimmedId, fallbackCandidate);
              this.setCachedUsername(cacheKey, fallbackCandidate);
              return fallbackCandidate;
            }
            this.setCachedUsername(cacheKey, null);
            throw fetchError;
          } finally {
            this.usernameLookupPromises.delete(cacheKey);
          }
        })();
        this.usernameLookupPromises.set(cacheKey, lookup);
      }

      return await lookup;
    } catch (error) {
      console.warn(`Error getting username for Telegram ID ${telegramId}:`, error);
      return null;
    }
  }

  /**
   * Resolve display name for leaderboards with graceful fallback
   */
  public async getLeaderboardDisplayName(ctx: Context, telegramId: string): Promise<string> {
    const username = await this.getUsernameFromTelegramId(ctx, telegramId);
    if (username) {
      return username;
    }

    return `Player ${telegramId}`;
  }

  /**
   * Get game creator display name - optimized single method
   * Returns @username for Telegram users or formatted address for blockchain players
   */
  public async getGameCreatorUsername(ctx: Context, gameAddress: string): Promise<string> {
    const creatorInfo = this.gameDb.getCreatorInfo(gameAddress);
    if (!creatorInfo) {
      return "Unknown";
    }

    // If we have telegram ID, try to get username
    if (creatorInfo.telegramId && /^\d+$/.test(creatorInfo.telegramId.trim())) {
      const username = await this.getUsernameFromTelegramId(ctx, creatorInfo.telegramId);
      if (username) {
        return username;
      }
    }

    // Fall back to formatted address
    if (creatorInfo.publicKey) {
      return this.formatAddress(creatorInfo.publicKey);
    }

    return "Unknown";
  }

  /**
   * Get player username with fallback to address display
   * Returns @username for Telegram users or formatted address for blockchain players
   */
  public async getPlayerUsername(ctx: Context, publicKey: string): Promise<string> {
    debugLog(`🔍 Getting username for publicKey: ${publicKey}`);

    const playerTelegramId = await this.getPlayerTelegramIdWithRetry(publicKey);
    debugLog(`🔍 Found telegramId: ${playerTelegramId} for publicKey: ${publicKey}`);

    if (!playerTelegramId) {
      debugLog(`⚠️ No telegram ID found for publicKey: ${publicKey}`);
      return this.formatAddress(publicKey);
    }

    const username = await this.getUsernameFromTelegramId(ctx, playerTelegramId);
    debugLog(`🔍 Found username: ${username} for telegramId: ${playerTelegramId}`);

    if (!username) {
      debugLog(`⚠️ No username found for telegramId: ${playerTelegramId}`);
      return this.formatAddress(publicKey);
    }

    return username;
  }

  private async getPlayerTelegramIdWithRetry(publicKey: string): Promise<string | null> {
    for (let attempt = 0; attempt < PLAYER_TELEGRAM_ID_POLL_ATTEMPTS; attempt++) {
      const candidate = this.gameDb.getPlayerTelegramId(publicKey);
      if (candidate) {
        return candidate;
      }
      if (attempt < PLAYER_TELEGRAM_ID_POLL_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, PLAYER_TELEGRAM_ID_POLL_INTERVAL_MS));
      }
    }
    return null;
  }

  // ================================
  // GAME MESSAGE MANAGEMENT
  // ================================

  public getActiveGameMessages(gameAddress: string): Map<number, GameMessage> | undefined {
    return this.activeGameMessages.get(gameAddress);
  }

  private async getActiveGameStats(
    gamePda: PublicKey,
    amountLamportsInput: number | bigint,
    providedTotalPotInput?: number | bigint,
  ) {
    const baseAmountLamports = coerceLamportValue(amountLamportsInput) ?? 0n;
    const providedTotalPot =
      providedTotalPotInput !== undefined ? coerceLamportValue(providedTotalPotInput) : null;

    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const currentTickets = Number(gameAccount.ticketsCount ?? 0);
      const maxTickets = Number(gameAccount.maxTickets ?? 0);
      const minTickets = Number(gameAccount.minTickets ?? 0);

      // Calculate totalPot based on game type
      let totalPot = providedTotalPot ?? null;
      if (totalPot === null) {
        const chainTotal = coerceLamportValue((gameAccount as any)?.totalAmount);
        if (chainTotal !== null && chainTotal > 0n) {
          totalPot = chainTotal;
        } else {
          const gameType = this.getGameType(gameAccount);
          if (gameType === "giveaway") {
            // For giveaways, totalPot is just the amount (prize from creator)
            totalPot = baseAmountLamports;
          } else {
            // For coinflips, totalPot = amount * participants
            totalPot = baseAmountLamports * BigInt(Math.max(currentTickets, 0));
          }
        }
      }

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const expirationInfo = await formatExpirationTime(expiresAt, this.wallet, "\n⏰ ");
      const tokenMint = ((gameAccount as any)?.tokenMint as PublicKey | undefined)?.toBase58();
      const participantAddresses = Array.isArray((gameAccount as any)?.participants)
        ? (gameAccount as any).participants.flatMap((participant: unknown) => {
            try {
              return [new PublicKey(participant as any).toBase58()];
            } catch {
              return [];
            }
          })
        : [];

      this.gameDb.saveGameParticipantAddresses?.(
        gamePda.toBase58(),
        participantAddresses.slice(0, currentTickets),
      );

      return {
        currentTickets,
        maxTickets,
        minTickets,
        totalPot: totalPot ?? baseAmountLamports,
        expirationInfo,
        tokenMint,
        participantAddresses,
      };
    } catch (error) {
      console.warn(`Warning: Could not fetch game account for ${gamePda.toBase58()}:`, error);
      return {
        currentTickets: 0,
        maxTickets: 0,
        minTickets: 0,
        totalPot: baseAmountLamports,
        expirationInfo: "",
        tokenMint: undefined,
        participantAddresses: [],
      };
    }
  }

  private async getCompletedGameStats(
    gamePda: PublicKey,
    amountLamportsInput: number | bigint,
    providedTotalPotInput?: number | bigint,
  ) {
    const baseAmountLamports = coerceLamportValue(amountLamportsInput) ?? 0n;
    const providedTotalPot =
      providedTotalPotInput !== undefined ? coerceLamportValue(providedTotalPotInput) : null;

    const gameAddress = gamePda.toBase58();
    const gameData = this.gameDb.getGame(gameAddress);
    const participants = this.getGamePlayers(gameAddress);
    const participantAddresses = this.gameDb.getGameParticipantAddresses?.(gameAddress) ?? [];
    const currentTickets = Math.max(participants.length, participantAddresses.length);

    const parsedMax = Number(gameData?.max_players);
    const maxTickets =
      Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : Math.max(currentTickets, 0);

    const parsedMin = Number(gameData?.min_players);
    let minTickets =
      Number.isFinite(parsedMin) && parsedMin > 0
        ? parsedMin
        : Math.min(currentTickets, maxTickets);

    if (!Number.isFinite(minTickets) || minTickets <= 0) {
      minTickets = Math.min(maxTickets, Math.max(currentTickets, 0));
    }

    // Get game type from database to calculate totalPot correctly
    let totalPot = providedTotalPot ?? null;
    if (totalPot === null) {
      // Prefer canonical `totalPot` and fall back to legacy `total_amount` for older rows.
      const storedTotal = coerceLamportValue(
        (gameData as any)?.totalPot ?? (gameData as any)?.total_amount,
      );
      if (storedTotal !== null && storedTotal > 0n) {
        totalPot = storedTotal;
      } else {
        const gameType = gameData?.game_type || "coinflip"; // default to coinflip if not found

        if (gameType === "giveaway") {
          // For giveaways, totalPot is just the amount (prize from creator)
          totalPot = baseAmountLamports;
        } else {
          // For coinflips, totalPot = amount * participants
          totalPot = baseAmountLamports * BigInt(Math.max(currentTickets, 0));
        }
      }
    }

    return {
      currentTickets,
      maxTickets,
      minTickets,
      totalPot: totalPot ?? baseAmountLamports,
      expirationInfo: "",
      tokenMint: gameData?.token_mint || undefined,
      participantAddresses,
    };
  }

  private async getWinnerInfo(
    ctx: Context,
    status: string,
    winnerAddress?: string,
    winnerSignature?: string,
    suppressMentions: boolean = false,
  ): Promise<string> {
    if (status.toLowerCase() !== "completed" || !winnerAddress) return "";

    if (winnerAddress === "cancelled" || winnerAddress === DEFAULT_NULL_ADDRESS) {
      return `\nStatus: Cancelled`;
    }

    const winnerUsername = await this.getPlayerUsername(ctx, winnerAddress);
    const gameUrl = winnerSignature
      ? `https://timba.cc/games/${encodeURIComponent(winnerSignature)}`
      : null;
    const sanitize = suppressMentions
      ? sanitizeTelegramDisplayNameWithoutMention
      : sanitizeTelegramDisplayName;
    const safeWinner =
      winnerUsername === this.formatAddress(winnerAddress)
        ? buildPlayerProfileLink(winnerAddress)
        : escapeHtml(sanitize(winnerUsername));
    const linkLine = gameUrl ? `\n\n<a href="${gameUrl}">🔗 View game</a>` : "";
    return `\n\nWinner: ${safeWinner}${linkLine}`;
  }

  private generateGameKeyboard(status: string, gamePda: PublicKey) {
    if (status.toLowerCase() === "completed") return [];

    const keyboard = [
      [
        { text: "🎮 Join", callback_data: `join_${gamePda.toBase58()}` },
        { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` },
      ],
    ];

    return keyboard;
  }

  public async formatAndSendGameMessage(
    ctx: Context,
    gamePda: PublicKey,
    gameType: string,
    amount: number,
    creatorUsername: string,
    status: string,
    tokenTicker: string,
    winnerAddress?: string,
    providedTotalPot?: number,
    winnerSignature?: string,
  ): Promise<any> {
    const gameAddress = gamePda.toBase58();
    const formatted = await this.formatGameMessage(
      ctx,
      gamePda,
      gameType,
      amount,
      creatorUsername,
      status,
      tokenTicker,
      winnerAddress,
      providedTotalPot,
      winnerSignature,
    );

    const chatId = ctx.chat?.id;
    const media = resolveGameMedia(gameType, chatId);
    const replyMarkup = { inline_keyboard: formatted.keyboard };
    let message: any;
    let usesVideo = false;

    const sendText = async () =>
      ctx.reply(formatted.messageText, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });

    if (media) {
      try {
        if (media.mediaType === "photo") {
          message = await ctx.replyWithPhoto(media.fileId, {
            caption: formatted.messageText,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          });
        } else if (media.mediaType === "animation") {
          message = await ctx.replyWithAnimation(media.fileId, {
            caption: formatted.messageText,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          });
        } else {
          message = await ctx.replyWithVideo(media.fileId, {
            caption: formatted.messageText,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          });
        }
        usesVideo = true;
      } catch (error) {
        if (isRecoverableMediaError(error)) {
          console.warn("Falling back to text announcement after media send failure:", error);
          message = await sendText();
        } else {
          throw error;
        }
      }
    } else {
      message = await sendText();
    }

    // Save the game message to database and activeGameMessages for future updates
    this.gameDb.saveGameMessage(gameAddress, message.message_id, message.chat.id);

    const existing = this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
    existing.set(message.chat.id, {
      messageId: message.message_id,
      chatId: message.chat.id,
      usesVideo,
    });
    this.activeGameMessages.set(gameAddress, existing);

    this.gameMessageReadyListener?.(gameAddress);

    return message;
  }

  public async formatGameMessage(
    ctx: Context,
    gamePda: PublicKey,
    gameType: string,
    amount: number | bigint,
    creatorUsername: string,
    status: string,
    tokenTicker: string,
    winnerAddress?: string,
    providedTotalPot?: number | bigint,
    winnerSignature?: string,
    options?: {
      suppressMentions?: boolean;
      priceHint?: CachedPriceLookup | null;
    },
  ): Promise<GameMessageFormat> {
    const suppressMentions = options?.suppressMentions === true;
    const cachedGamePrice =
      options?.priceHint ?? this.gamePriceCache.get(gamePda.toBase58()) ?? null;
    const sanitizeDisplay = suppressMentions
      ? sanitizeTelegramDisplayNameWithoutMention
      : sanitizeTelegramDisplayName;
    const isCompleted = status.toLowerCase() === "completed";
    const gameCacheKey = gamePda.toBase58();

    const amountLamports = typeof amount === "bigint" ? amount : BigInt(Math.trunc(amount));

    const coerceProvidedTotal =
      providedTotalPot !== undefined && providedTotalPot !== null
        ? coerceLamportValue(providedTotalPot)
        : null;

    const gameStats = isCompleted
      ? await this.getCompletedGameStats(gamePda, amountLamports, coerceProvidedTotal ?? undefined)
      : await this.getActiveGameStats(gamePda, amountLamports, coerceProvidedTotal ?? undefined);

    const { currentTickets, maxTickets, minTickets, totalPot, expirationInfo } = gameStats as any;
    const tokenMintHint = (gameStats as { tokenMint?: string | null }).tokenMint;
    const participantAddresses = (gameStats as { participantAddresses?: string[] })
      .participantAddresses;

    const {
      formatBalance: formatBalanceForDisplay,
      decimals,
      tokenMint,
      isSol,
    } = await this.resolveTokenFormattingInfo(gamePda, tokenTicker, tokenMintHint);

    const usdApproximation = await this.getUsdApproximation(
      amountLamports,
      decimals,
      tokenMint,
      isSol,
      cachedGamePrice,
      gameCacheKey,
    );

    const winnerInfo = await this.getWinnerInfo(
      ctx,
      status,
      winnerAddress,
      winnerSignature,
      suppressMentions,
    );

    const formattedTicketAmount = formatBalanceForDisplay(amountLamports);
    const explorerUrl = NetworkDetector.buildSolscanAccountUrl(gamePda.toBase58());

    const safeCreatorUsername = sanitizeDisplay(creatorUsername);
    const getCreatorInfo = (this.gameDb as any).getCreatorInfo?.bind(this.gameDb) as
      ((gameAddress: string) => { publicKey?: string | null } | null) | undefined;
    const creatorPublicKey = getCreatorInfo?.(gamePda.toBase58())?.publicKey ?? null;
    const creatorWalletAddress =
      creatorPublicKey && creatorUsername === this.formatAddress(creatorPublicKey)
        ? creatorPublicKey
        : null;
    const header = buildGameHeader(
      formatGameTypeWithEmoji(gameType),
      formattedTicketAmount,
      tokenTicker,
      safeCreatorUsername,
      currentTickets,
      maxTickets,
      usdApproximation?.text,
      explorerUrl,
      creatorWalletAddress,
    );
    // Show current prize if different from base amount
    let prizeUsdApproximation: string | null = null;
    if (usdApproximation) {
      prizeUsdApproximation = this.formatUsdValue(totalPot, decimals, usdApproximation.price);
    } else if (currentTickets > 0 || totalPot !== amountLamports) {
      const computedPrizeUsd = await this.getUsdApproximation(
        totalPot,
        decimals,
        tokenMint,
        isSol,
        cachedGamePrice,
        gameCacheKey,
      );
      prizeUsdApproximation = computedPrizeUsd?.text ?? null;
    }

    const prize = buildPrizeLine(
      currentTickets > 0 || totalPot !== amountLamports,
      formatBalanceForDisplay(totalPot),
      tokenTicker,
      prizeUsdApproximation,
    );

    const baseBeforeParticipants = header + prize;

    const participantDisplayNames: ParticipantDisplay[] = [];
    let totalParticipants = 0;
    if (currentTickets > 0) {
      try {
        totalParticipants = Math.max(0, Number(currentTickets) || 0);
        const previewLimit = Math.max(0, GAME_MESSAGE_PARTICIPANTS_PREVIEW_LIMIT);
        const getPreview = (this.gameDb as any).getGameParticipantsPreview?.bind(this.gameDb) as
          ((game: string, limit: number) => string[]) | undefined;
        const previewIds =
          typeof getPreview === "function"
            ? getPreview(gamePda.toBase58(), previewLimit)
            : this.getGamePlayers(gamePda.toBase58()).slice(0, previewLimit);
        const allowNetworkLookup =
          totalParticipants <= GAME_MESSAGE_NETWORK_LOOKUP_MAX_PARTICIPANTS;

        const previewEntries: Array<{ publicKey: string | null; telegramId: string | null }> =
          participantAddresses && participantAddresses.length > 0
            ? participantAddresses.slice(0, previewLimit).map((publicKey) => ({
                publicKey,
                telegramId: this.gameDb.getPlayerTelegramId(publicKey),
              }))
            : previewIds.map((telegramId) => ({ telegramId, publicKey: null }));

        const resolved = await mapWithConcurrency(
          previewEntries,
          GAME_MESSAGE_USERNAME_LOOKUP_CONCURRENCY,
          async ({ telegramId, publicKey }) => {
            if (telegramId) {
              try {
                const username = await this.getUsernameFromTelegramId(ctx, telegramId, {
                  allowNetworkLookup,
                });
                if (username) {
                  return sanitizeDisplay(username);
                }
              } catch {
                // fall through to wallet or player placeholder
              }
            }
            return publicKey
              ? { address: publicKey, label: `Wallet ${formatPlayerAddress(publicKey)}` }
              : `Player ${telegramId?.slice(0, 6) ?? "unknown"}...`;
          },
        );
        participantDisplayNames.push(...resolved);
      } catch (error) {
        console.error("Error getting player list:", error);
      }
    }

    const statusSection = !isCompleted
      ? `\nStatus: ${buildGameStatus(currentTickets, minTickets, maxTickets)}${expirationInfo}`
      : "";

    const composeMessage = (names: ParticipantDisplay[], omittedCount: number): string => {
      const participantsSection = names.length > 0 ? buildParticipantsList(names) : "";
      let message = baseBeforeParticipants + participantsSection;
      if (isCompleted && participantsSection.endsWith("\n")) {
        message = message.slice(0, -1);
      }
      if (omittedCount > 0) {
        message += `\n… and ${omittedCount} more`;
      }
      message += statusSection;
      message += winnerInfo;
      return message;
    };

    let messageText = composeMessage(
      participantDisplayNames,
      Math.max(0, totalParticipants - participantDisplayNames.length),
    );

    if (messageText.length > TELEGRAM_MESSAGE_CHAR_LIMIT && participantDisplayNames.length > 0) {
      for (let keep = participantDisplayNames.length; keep >= 0; keep -= 1) {
        const omitted = Math.max(0, totalParticipants - keep);
        const candidate = composeMessage(participantDisplayNames.slice(0, keep), omitted);
        if (candidate.length <= TELEGRAM_MESSAGE_CHAR_LIMIT || keep === 0) {
          messageText = candidate;
          break;
        }
      }
    }

    if (messageText.length > TELEGRAM_MESSAGE_CHAR_LIMIT) {
      messageText = messageText.slice(0, TELEGRAM_MESSAGE_CHAR_LIMIT - 1) + "…";
    }

    const keyboard = this.generateGameKeyboard(status, gamePda);

    return { messageText, keyboard };
  }

  private async buildGameMessagePayload(
    ctx: Context,
    params: {
      gameAddress: string;
      gameType: string;
      amount: number;
      creatorUsername: string;
      status: string;
      tokenTicker: string;
      winnerAddress?: string;
      totalPot?: number;
      winnerSignature?: string;
      chatId?: number;
      options?: {
        priceHint?: CachedPriceLookup | null;
        suppressMentions?: boolean;
      };
    },
    formatted?: GameMessageFormat,
  ): Promise<{
    text: string;
    keyboard: GameMessageFormat["keyboard"];
    media?: { fileId: string; mediaType: "photo" | "video" | "animation" };
  }> {
    const formatResult =
      formatted ??
      (await this.formatGameMessage(
        ctx,
        new PublicKey(params.gameAddress),
        params.gameType,
        params.amount,
        params.creatorUsername,
        params.status,
        params.tokenTicker,
        params.winnerAddress,
        params.totalPot,
        params.winnerSignature,
        params.options,
      ));

    const media = resolveGameMedia(params.gameType, params.chatId ?? ctx.chat?.id);

    return {
      text: formatResult.messageText,
      keyboard: formatResult.keyboard,
      media,
    };
  }

  public async getPrizeDisplay(
    gameAddress: string,
    totalPot: number,
    tokenTickerHint?: string | null,
    tokenMintHint?: string | null,
  ): Promise<{
    formattedAmount: string;
    tokenTicker: string;
    usdApproximation: string | null;
  } | null> {
    if (!Number.isFinite(totalPot) || totalPot <= 0) {
      return null;
    }

    try {
      const gamePda = new PublicKey(gameAddress);
      const storedGame = this.gameDb.getGame(gameAddress);
      const resolvedTicker =
        tokenTickerHint ??
        storedGame?.token_ticker ??
        (storedGame?.token_mint === "SOL" ? "SOL" : "");
      const resolvedMint = tokenMintHint ?? storedGame?.token_mint ?? undefined;
      const priceHint = this.gamePriceCache.get(gameAddress) ?? null;

      const { formatBalance, decimals, tokenMint, isSol } = await this.resolveTokenFormattingInfo(
        gamePda,
        resolvedTicker || "",
        resolvedMint,
      );

      const formattedAmount = formatBalance(totalPot);
      const usdApproximation = await this.getUsdApproximation(
        totalPot,
        decimals,
        tokenMint,
        isSol,
        priceHint,
        gameAddress,
      );

      const displayTicker = resolvedTicker || (isSol ? "SOL" : "");

      return {
        formattedAmount,
        tokenTicker: displayTicker,
        usdApproximation: usdApproximation?.text ?? null,
      };
    } catch (error) {
      console.warn(`Failed to compute prize display for ${gameAddress}:`, error);
      return null;
    }
  }

  public async createGameMessage(
    ctx: Context,
    gameAddress: string,
    gameType: string,
    amount: number,
    creatorUsername: string,
    tokenTicker: string,
    status: string = "Active",
    replyToMessageId?: number,
    options?: { priceHint?: CachedPriceLookup | null },
  ): Promise<number> {
    const cachedPrice = options?.priceHint ?? this.gamePriceCache.get(gameAddress) ?? null;
    const payload = await this.buildGameMessagePayload(ctx, {
      gameAddress,
      gameType,
      amount,
      creatorUsername,
      status,
      tokenTicker,
      chatId: ctx.chat?.id,
      options: { priceHint: cachedPrice },
    });

    const replyTo = replyToMessageId ?? (ctx as any).message?.message_id;
    const replyMarkup =
      payload.keyboard.length > 0 ? { inline_keyboard: payload.keyboard } : undefined;
    const media = payload.media;
    const sendResult = await sendMediaWithFallback<any, any>({
      videoFileId: media?.fileId ?? null,
      logLabel: "game video",
      sendText: () =>
        ctx.reply(payload.text, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
          reply_to_message_id: replyTo,
        }),
      sendVideo:
        media && typeof (ctx as any).replyWithVideo === "function"
          ? () => {
              if (media.mediaType === "photo") {
                return ctx.replyWithPhoto(media.fileId, {
                  caption: payload.text,
                  parse_mode: "HTML",
                  reply_markup: replyMarkup,
                  reply_to_message_id: replyTo,
                }) as any;
              } else if (media.mediaType === "animation") {
                return ctx.replyWithAnimation(media.fileId, {
                  caption: payload.text,
                  parse_mode: "HTML",
                  reply_markup: replyMarkup,
                  reply_to_message_id: replyTo,
                }) as any;
              } else {
                return ctx.replyWithVideo(media.fileId, {
                  caption: payload.text,
                  parse_mode: "HTML",
                  reply_markup: replyMarkup,
                  reply_to_message_id: replyTo,
                }) as any;
              }
            }
          : undefined,
    });

    const message: any = sendResult.result;
    const usesVideo = sendResult.usedVideo;

    this.gameDb.saveGameMessage(gameAddress, message.message_id, message.chat.id);

    const existing = this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
    existing.set(message.chat.id, {
      messageId: message.message_id,
      chatId: message.chat.id,
      usesVideo,
    });
    this.activeGameMessages.set(gameAddress, existing);

    this.gameMessageReadyListener?.(gameAddress);

    return message.message_id;
  }

  public async updateGameMessage(
    ctx: Context,
    gameAddress: string,
    gameType: string,
    amount: number,
    creatorUsername: string,
    status: string,
    tokenTicker: string,
    winnerAddress?: string,
    totalPot?: number,
    winnerSignature?: string,
  ): Promise<void> {
    let messageMap = this.activeGameMessages.get(gameAddress);
    if (!messageMap || messageMap.size === 0) {
      // Fallback: Check database for any existing messages for this game
      try {
        const dbMessages = this.gameDb.getGameMessages(gameAddress);
        if (dbMessages && dbMessages.length > 0) {
          messageMap = new Map<number, GameMessage>();
          for (const msg of dbMessages) {
            messageMap.set(msg.chatId, {
              messageId: msg.messageId,
              chatId: msg.chatId,
              usesVideo: true, // Default to true as a safe bet for media update logic
            });
          }
          this.activeGameMessages.set(gameAddress, messageMap);
          console.log(
            `♻️ Restored ${messageMap.size} message target(s) from DB for game ${gameAddress}`,
          );
        }
      } catch (dbError) {
        console.warn(`Error loading message targets from DB for ${gameAddress}:`, dbError);
      }
    }

    if (!messageMap || messageMap.size === 0) return;

    let messageTextValue = "";
    let inlineKeyboardValue: any;

    try {
      const priceHint = this.gamePriceCache.get(gameAddress) ?? null;
      const formatted = await this.formatGameMessage(
        ctx,
        new PublicKey(gameAddress),
        gameType,
        amount,
        creatorUsername,
        status,
        tokenTicker,
        winnerAddress,
        totalPot,
        winnerSignature,
        { priceHint },
      );
      messageTextValue = formatted.messageText;

      const inlineKeyboard =
        formatted.keyboard.length > 0 ? { inline_keyboard: formatted.keyboard } : undefined;
      inlineKeyboardValue = inlineKeyboard;
      const lowerStatus = status.toLowerCase();

      for (const gameMessage of messageMap.values()) {
        const payload = await this.buildGameMessagePayload(
          ctx,
          {
            gameAddress,
            gameType,
            amount,
            creatorUsername,
            status,
            tokenTicker,
            winnerAddress,
            totalPot,
            winnerSignature,
            chatId: gameMessage.chatId,
            options: { priceHint },
          },
          formatted,
        );
        const winnerMedia = payload.media;
        try {
          const supportsVideo = gameMessage.usesVideo !== false;

          const editAsText = () =>
            ctx.api.editMessageText(gameMessage.chatId, gameMessage.messageId, payload.text, {
              parse_mode: "HTML",
              reply_markup: inlineKeyboard,
            });

          const recreateMissingMessage = async (err: unknown): Promise<boolean> => {
            if (!messageTextValue || !isMessageMissing(err)) {
              return false;
            }

            const lockKey = `${gameAddress}:${gameMessage.chatId}`;
            if (this.messageRecreationLocks.has(lockKey)) {
              return true;
            }

            this.messageRecreationLocks.add(lockKey);
            try {
              await this.recreateMissingGameMessage(ctx, gameAddress, {
                chatId: gameMessage.chatId,
                messageText: messageTextValue,
                inlineKeyboard: inlineKeyboardValue,
                gameType,
              });
            } finally {
              this.messageRecreationLocks.delete(lockKey);
            }

            return true;
          };

          if (winnerMedia && supportsVideo) {
            try {
              const isCompleted = lowerStatus === "completed";
              const runEditWithFallback = (edit: () => Promise<any>) =>
                editMediaWithFallback({
                  edit,
                  fallback: async () => {
                    // Media/caption failed - try text as last resort
                    try {
                      return await editAsText();
                    } catch (textError) {
                      // Both media/caption and text failed - message might be deleted or inaccessible
                      console.warn(
                        `Both media and text edits failed for game ${gameAddress} chat ${gameMessage.chatId}:`,
                        textError,
                      );
                      // Mark as not using video since we couldn't edit it
                      const current =
                        this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
                      current.set(gameMessage.chatId, {
                        ...gameMessage,
                        usesVideo: false,
                      });
                      this.activeGameMessages.set(gameAddress, current);
                      return null;
                    }
                  },
                  logLabel: `game media update (${gameMessage.chatId})`,
                  onFallback: () => {
                    const current =
                      this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
                    current.set(gameMessage.chatId, {
                      ...gameMessage,
                      usesVideo: false,
                    });
                    this.activeGameMessages.set(gameAddress, current);
                  },
                });

              const queueKey = `${gameMessage.chatId}:${gameMessage.messageId}`;
              const queuedEditResult = isCompleted
                ? await enqueueMessageMediaEdit(queueKey, () =>
                    runEditWithFallback(() =>
                      ctx.api.editMessageMedia(
                        gameMessage.chatId,
                        gameMessage.messageId,
                        {
                          type: winnerMedia.mediaType,
                          media: winnerMedia.fileId,
                          caption: payload.text,
                          parse_mode: "HTML",
                        },
                        { reply_markup: inlineKeyboard },
                      ),
                    ),
                  )
                : {
                    result: await runEditWithFallback(() =>
                      ctx.api.editMessageCaption(gameMessage.chatId, gameMessage.messageId, {
                        caption: payload.text,
                        parse_mode: "HTML",
                        reply_markup: inlineKeyboard,
                      }),
                    ),
                    skipped: false,
                  };

              if (queuedEditResult.skipped || !queuedEditResult.result) {
                continue;
              }

              const { usedFallback, skipped } = queuedEditResult.result;

              if (skipped) {
                continue;
              }

              if (!usedFallback) {
                const current =
                  this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
                current.set(gameMessage.chatId, {
                  ...gameMessage,
                  usesVideo: true,
                });
                this.activeGameMessages.set(gameAddress, current);
              }

              continue;
            } catch (mediaError) {
              // If we get here, something unexpected happened
              const recreated = await recreateMissingMessage(mediaError);
              if (!recreated) {
                console.warn(
                  `Unexpected error in media edit path for game ${gameAddress} chat ${gameMessage.chatId}:`,
                  mediaError,
                );
              }
              continue;
            }
          }

          // Message has video but no winnerMedia (e.g. restored from DB) - try caption edit first
          if (supportsVideo) {
            try {
              const { usedFallback, skipped } = await editMediaWithFallback({
                edit: () =>
                  ctx.api.editMessageCaption(gameMessage.chatId, gameMessage.messageId, {
                    caption: payload.text,
                    parse_mode: "HTML",
                    reply_markup: inlineKeyboard,
                  }),
                fallback: async () => {
                  // Caption failed - try text as last resort
                  try {
                    return await editAsText();
                  } catch (textError) {
                    // Both caption and text failed - message might be deleted or inaccessible
                    console.warn(
                      `Both caption and text edits failed for game ${gameAddress} chat ${gameMessage.chatId}:`,
                      textError,
                    );
                    // Mark as not using video since we couldn't edit it
                    const current =
                      this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
                    current.set(gameMessage.chatId, {
                      ...gameMessage,
                      usesVideo: false,
                    });
                    this.activeGameMessages.set(gameAddress, current);
                    return null;
                  }
                },
                logLabel: `game caption update (${gameMessage.chatId})`,
                onFallback: () => {
                  const current =
                    this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
                  current.set(gameMessage.chatId, {
                    ...gameMessage,
                    usesVideo: false,
                  });
                  this.activeGameMessages.set(gameAddress, current);
                },
              });

              if (skipped) {
                continue;
              }

              if (!usedFallback) {
                const current =
                  this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
                current.set(gameMessage.chatId, {
                  ...gameMessage,
                  usesVideo: true,
                });
                this.activeGameMessages.set(gameAddress, current);
              }

              continue;
            } catch (captionError) {
              // If we get here, something unexpected happened
              const recreated = await recreateMissingMessage(captionError);
              if (!recreated) {
                console.warn(
                  `Unexpected error in caption edit path for game ${gameAddress} chat ${gameMessage.chatId}:`,
                  captionError,
                );
              }
              continue;
            }
          }

          const { skipped, usedFallback: textUsedFallback } = await editMediaWithFallback({
            edit: () => editAsText(),
            fallback: async () => {
              // Text edit failed - try caption as fallback (message might actually be media)
              try {
                return await ctx.api.editMessageCaption(gameMessage.chatId, gameMessage.messageId, {
                  caption: payload.text,
                  parse_mode: "HTML",
                  reply_markup: inlineKeyboard,
                });
              } catch (captionError) {
                // Both text and caption failed - message might be deleted or inaccessible
                console.warn(
                  `Both text and caption edits failed for game ${gameAddress} chat ${gameMessage.chatId}:`,
                  captionError,
                );
                return null;
              }
            },
            logLabel: `game text update (${gameMessage.chatId})`,
            onFallback: () => {
              // Text failed but caption worked - message is actually media
              const current =
                this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
              current.set(gameMessage.chatId, {
                ...gameMessage,
                usesVideo: true,
              });
              this.activeGameMessages.set(gameAddress, current);
            },
          });

          if (textUsedFallback) {
            // Text failed but caption worked - already marked usesVideo: true
            continue;
          }

          if (skipped) {
            continue;
          }
        } catch (error) {
          if (messageTextValue && isMessageMissing(error)) {
            // Only lock/recreate for this specific message instance
            // We use a composite key for the lock to avoid blocking updates to other chats
            const lockKey = `${gameAddress}:${gameMessage.chatId}`;
            if (this.messageRecreationLocks.has(lockKey)) {
              continue;
            }

            this.messageRecreationLocks.add(lockKey);
            try {
              await this.recreateMissingGameMessage(ctx, gameAddress, {
                chatId: gameMessage.chatId,
                messageText: messageTextValue,
                inlineKeyboard: inlineKeyboardValue,
                gameType,
              });
            } finally {
              this.messageRecreationLocks.delete(lockKey);
            }
            continue;
          }
          console.error(`Error in updateGameMessage for chat ${gameMessage.chatId}:`, error);
        }
      }
    } catch (error) {
      console.error("Error in updateGameMessage (preparation):", error);
    }
  }

  /**
   * Simplified updateGameMessage that automatically fetches required data
   * This reduces duplication and ensures consistency across the codebase
   */
  public async updateGameMessageFromData(
    ctx: Context,
    gameAddress: string,
    status: string = "Active",
    winnerAddress?: string,
    totalPot?: number,
    winnerSignature?: string,
  ): Promise<void> {
    try {
      const gameData = this.gameDb.getGame(gameAddress);
      if (!gameData) {
        console.warn(`No game data found for ${gameAddress}`);
        return;
      }

      const creatorUsername = await this.getGameCreatorUsername(ctx, gameAddress);
      const gameType = gameData.game_type
        ? gameData.game_type.charAt(0).toUpperCase() + gameData.game_type.slice(1)
        : "Game";

      await this.updateGameMessage(
        ctx,
        gameAddress,
        gameType,
        gameData.amount,
        creatorUsername,
        status,
        gameData.token_ticker || "",
        winnerAddress,
        totalPot,
        winnerSignature,
      );
    } catch (error) {
      console.error(`Error updating game message for ${gameAddress}:`, error);
    }
  }

  // ================================
  // GAME OPERATIONS
  // ================================

  public async getGameInfo(ctx: Context, gamePda: PublicKey): Promise<string> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const rawGameType = this.getGameType(gameAccount);
      const amount = this.getDisplayAmountFromAccount(gameAccount, rawGameType);

      // Get token info from database
      const gameData = this.gameDb.getGame(gamePda.toBase58());
      if (!gameData?.token_mint || !gameData?.token_ticker) {
        return `Error: Game token information not found`;
      }

      const tokenTicker = gameData.token_ticker;
      const creatorPubkey = gameAccount.creator.toString();

      const creatorUsername = await this.getGameCreatorUsername(ctx, gamePda.toBase58());
      const creatorInfo =
        creatorUsername !== "Unknown" ? creatorUsername : `<code>${creatorPubkey}</code>`;

      const status = gameData?.status ?? "active";
      const { messageText } = await this.formatGameMessage(
        ctx,
        gamePda,
        rawGameType,
        amount,
        creatorInfo,
        status,
        tokenTicker,
        gameData?.winner_address,
        Number(gameAccount.totalAmount) || undefined,
        undefined,
        { suppressMentions: true },
      );

      return messageText;
    } catch (error: any) {
      console.error(`Error fetching game info for ${gamePda.toBase58()}:`, error);
      return "⚠️ Unable to load this game right now. Please try again in a moment.";
    }
  }

  // Helper method to get game info for completed games from database
  public async getCompletedGameInfo(ctx: Context, gameData: any): Promise<string> {
    try {
      const creatorUsername = await this.getUsernameFromTelegramId(
        ctx,
        gameData.creator_telegram_id,
      );
      const rawAmount = Number(gameData.amount);
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0;
      const gameAddress = gameData.game_address as string | undefined;
      const getCount = (this.gameDb as any).getGameParticipantsCount?.bind(this.gameDb) as
        ((address: string) => number) | undefined;

      let currentTickets = 0;

      if (gameAddress) {
        try {
          if (typeof getCount === "function") {
            currentTickets = Math.max(0, Math.trunc(getCount(gameAddress)));
          } else {
            currentTickets = (this.gameDb.getGameParticipants(gameAddress) ?? []).length;
          }
        } catch (participantError) {
          console.error("Error retrieving participant count for completed game:", participantError);
        }
      }
      const storedMax = Number(gameData.max_players);
      const maxTickets =
        Number.isFinite(storedMax) && storedMax > 0 ? storedMax : Math.max(currentTickets, 0);
      const playerCountDisplay =
        maxTickets > 0 ? `${currentTickets}/${maxTickets}` : `${currentTickets}`;
      const gameTypeText = formatGameTypeWithEmoji(gameData.game_type);
      const tokenTicker = gameData.token_ticker || "WSOL";
      const explorerUrl = gameAddress ? NetworkDetector.buildSolscanAccountUrl(gameAddress) : null;
      const gameExplorerIcon = explorerUrl ? `<a href="${escapeHtml(explorerUrl)}">🅴</a>` : "🅴";
      const gameLabel = `${escapeHtml(gameTypeText)} ${gameExplorerIcon}`;
      let formatBalanceForDisplay = (value: number) => this.wallet.formatTokenBalance(value, 6);
      if (gameAddress) {
        try {
          const resolver = await this.resolveTokenFormattingInfo(
            new PublicKey(gameAddress),
            tokenTicker,
            gameData.token_mint,
          );
          formatBalanceForDisplay = resolver.formatBalance;
        } catch (resolveError) {
          console.error("Error resolving token formatting for completed game:", resolveError);
        }
      }
      const creatorLabel = creatorUsername
        ? sanitizeTelegramDisplayNameWithoutMention(creatorUsername)
        : `Player ${String(gameData.creator_telegram_id).slice(0, 6)}...`;

      // Handle different winner states
      let winnerLine = "";
      if (
        gameData.winner_address === "cancelled" ||
        gameData.winner_address === DEFAULT_NULL_ADDRESS
      ) {
        winnerLine = "";
      } else {
        const winnerUsername = await this.getPlayerUsername(ctx, gameData.winner_address);
        const safeWinner =
          winnerUsername === this.formatAddress(gameData.winner_address)
            ? buildPlayerProfileLink(gameData.winner_address)
            : escapeHtml(sanitizeTelegramDisplayNameWithoutMention(winnerUsername));
        winnerLine = `Winner: ${safeWinner}`;
      }

      const amountDisplay = formatCompactTokenDisplay(formatBalanceForDisplay(amount));
      const safeAmountDisplay = escapeHtml(amountDisplay);
      const safeTicker = escapeHtml(tokenTicker);
      const safeCreator = escapeHtml(creatorLabel);
      const safePlayerCount = escapeHtml(playerCountDisplay);
      const message =
        `${gameLabel} • ${safeAmountDisplay} ${safeTicker}` +
        `\nCreator: ${safeCreator} • ${safePlayerCount} tickets`;

      // Build simple message without participants list
      const winnerSection = winnerLine ? `\n\n${winnerLine}` : "";
      let composed = message + winnerSection;

      if (composed.length > TELEGRAM_MESSAGE_CHAR_LIMIT) {
        composed = composed.slice(0, TELEGRAM_MESSAGE_CHAR_LIMIT - 1) + "…";
      }

      return composed;
    } catch (error) {
      console.error("Error formatting completed game info:", error);
      return "❌ Error loading game details";
    }
  }

  public async createGame(
    gameType: GameType,
    parsedAmount: Pick<
      ParsedAmount,
      "amount" | "tokenMint" | "tokenTicker" | "isSol" | "requestedNativeSol" | "priceLookup"
    >,
    maxTickets: number,
    minTickets: number,
    timeout: number,
    telegramId: bigint,
    options?: { isPrivate?: boolean },
    chatId?: number,
    requestTimestampMs: number = Date.now(),
  ): Promise<{
    success: boolean;
    error?: string;
    gameAddress?: string;
    autoJoinResult?: { success: boolean; error?: string };
  }> {
    if (parsedAmount.isSol && !parsedAmount.requestedNativeSol) {
      return {
        success: false,
        error:
          `❌ Native SOL games must be routed through WSOL.\n` +
          `Please retry using SOL (auto-wrapped) or another SPL token.`,
      };
    }

    const telegramIdStr = telegramId.toString();
    const isPrivate = options?.isPrivate ?? true;
    const inFlightCount = this.getInFlightCreations(telegramIdStr);
    const activeGameCount = this.gameDb.countActiveGamesByCreator(telegramIdStr);

    if (activeGameCount + inFlightCount >= MAX_ACTIVE_GAMES_PER_CREATOR) {
      return {
        success: false,
        error: `Active game limit reached. You currently have ${
          activeGameCount + inFlightCount
        } active games (maximum ${MAX_ACTIVE_GAMES_PER_CREATOR}). Finish or cancel an existing game before creating a new one.`,
      };
    }

    const nowMs = Date.now();
    const safeRequestTimestamp = Number.isFinite(requestTimestampMs)
      ? Math.min(nowMs, Math.max(0, Math.trunc(requestTimestampMs)))
      : nowMs;
    const expiresAtMs = safeRequestTimestamp + timeout * 1000;

    const windowStart = Math.max(
      nowMs - GAME_CREATION_RATE_LIMIT_WINDOW_MS,
      safeRequestTimestamp - GAME_CREATION_RATE_LIMIT_WINDOW_MS,
    );
    const pendingRequestTimestamp = Math.max(safeRequestTimestamp, nowMs);

    const pendingCount = this.prunePendingCreationRequests(telegramIdStr, windowStart);
    const recentCreationCount = this.gameDb.countRecentGamesByCreator(telegramIdStr, windowStart);

    const totalWindowCreations = pendingCount + recentCreationCount;

    if (totalWindowCreations >= MAX_GAMES_PER_CREATOR_WINDOW) {
      const windowLabel = formatRateLimitWindow(GAME_CREATION_RATE_LIMIT_WINDOW_MS);
      return {
        success: false,
        error: `Game creation rate limit reached. You have ${totalWindowCreations} game creation${
          totalWindowCreations === 1 ? "" : "s"
        } in the last ${windowLabel} (maximum ${MAX_GAMES_PER_CREATOR_WINDOW}). Please wait before creating a new game.${
          pendingCount > 0 ? " Some requests are still processing." : ""
        }`,
      };
    }

    this.trackPendingCreationRequest(telegramIdStr, pendingRequestTimestamp);
    this.incrementInFlightCreations(telegramIdStr);

    try {
      const { tokenMint, tokenTicker, amount } = parsedAmount;
      const requestedSol = parsedAmount.requestedNativeSol === true || tokenMint === WSOL_MINT;

      const metadata = await this.wallet.getTokenMetadata(tokenMint);
      const playerKp = this.wallet.getKeyPair(telegramId);
      const [minSolBuffer, gameRentLamports, nativeWalletReserveLamports] = await Promise.all([
        this.feeBudget.getGameSafetyBufferLamports(),
        this.getGameCreationRentLamports(maxTickets),
        this.getNativeWalletReserveLamports(),
      ]);
      let [tokenBalance, solBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, tokenMint),
        this.wallet.getBalance(telegramId),
      ]);

      let fundingPlan = this.buildGameFundingPlan({
        currentSolLamports: solBalance,
        gameDepositLamports: gameRentLamports,
        feeSafetyReserveLamports: minSolBuffer,
        retainedWalletReserveLamports: nativeWalletReserveLamports,
        stakeRaw: amount,
        tokenBalanceRaw: tokenBalance,
      });

      if (requestedSol) {
        const ensured = await this.ensureWrappedSolBalance(
          telegramId,
          amount,
          tokenBalance,
          solBalance,
          "create",
          fundingPlan.requiredSolLamports,
        );

        if (!ensured.success) {
          return { success: false, error: ensured.error };
        }

        tokenBalance = ensured.tokenBalance;
        solBalance = ensured.solBalance;
        fundingPlan = this.buildGameFundingPlan({
          currentSolLamports: solBalance,
          gameDepositLamports: gameRentLamports,
          feeSafetyReserveLamports: minSolBuffer,
          retainedWalletReserveLamports: nativeWalletReserveLamports,
          stakeRaw: amount,
          tokenBalanceRaw: tokenBalance,
        });
      }

      debugLog("Game creation funding plan:", fundingPlan);

      if (tokenBalance < amount) {
        const friendlyTokenBalance = this.wallet.formatTokenBalance(
          tokenBalance,
          metadata.decimals,
        );
        const friendlyRequired = this.wallet.formatTokenBalance(amount, metadata.decimals);
        const friendlySolBalance = this.wallet.formatSolBalance(solBalance);
        console.warn(
          `⚠️ Token balance check failed (${tokenTicker}). have=${friendlyTokenBalance} ${tokenTicker}, need=${friendlyRequired}${tokenTicker}, detected SOL=${friendlySolBalance}`,
        );
        const safeTokenBalance = escapeHtml(friendlyTokenBalance);
        const safeRequired = escapeHtml(friendlyRequired);
        const safeTicker = escapeHtml(tokenTicker);
        let errorMessage = `❌ Not enough ${safeTicker}. You have ${safeTokenBalance} but need ${safeRequired}.`;
        errorMessage += ` Add more ${safeTicker} or lower the amount and try again.`;
        if (requestedSol) {
          errorMessage += ` If you recently deposited SOL, wait for confirmation before trying again.`;
        }
        return {
          success: false,
          error: errorMessage,
        };
      }
      const reservedTicketAmount = fundingPlan.stakeRaw;
      const swapAllowanceRaw = fundingPlan.spareTokenRaw;

      let lamportsBalance = solBalance;
      if (fundingPlan.shortfallLamports > 0) {
        if (swapAllowanceRaw <= 0) {
          const formattedStake = this.wallet.formatTokenBalance(
            reservedTicketAmount,
            metadata.decimals,
          );

          const safeStake = escapeHtml(formattedStake);
          const safeTicker = escapeHtml(tokenTicker);
          return {
            success: false,
            error: this.buildGameCreationShortfallMessage(fundingPlan, safeStake, safeTicker),
          };
        }

        const jitResult = await this.swapManager.performJustInTimeSolSwap({
          userKeypair: playerKp,
          tokenMint,
          tokenDecimals: metadata.decimals,
          availableTokenAmountRaw: swapAllowanceRaw,
          desiredLamports: fundingPlan.requiredSolLamports,
          tokenTicker,
          logContext: `create ${gameType} game`,
        });

        if (!jitResult.swapped) {
          if (jitResult.error) {
            return { success: false, error: jitResult.error };
          }

          return {
            success: false,
            error: "Unable to top up SOL balance automatically. Add SOL manually and try again.",
          };
        }

        tokenBalance = await this.wallet.getTokenBalance(telegramId, tokenMint);

        if (tokenBalance < amount) {
          const remainingBalance = this.wallet.formatTokenBalance(tokenBalance, metadata.decimals);
          const requiredBalance = this.wallet.formatTokenBalance(amount, metadata.decimals);
          return {
            success: false,
            error: `Swap completed but only ${escapeHtml(remainingBalance)} ${escapeHtml(
              tokenTicker,
            )} remain, which is below the required ${escapeHtml(
              requiredBalance,
            )}. Please top up your tokens and try again.`,
          };
        }

        this.wallet.clearCachedWalletData?.(telegramId);

        lamportsBalance = await this.wallet.getBalance(telegramId, {
          forceFresh: true,
        });
        if (lamportsBalance < fundingPlan.requiredSolLamports) {
          return {
            success: false,
            error: this.buildGameSolShortfallMessage({
              currentLamports: lamportsBalance,
              requiredLamports: fundingPlan.requiredSolLamports,
              action: "create this game",
            }),
          };
        }
      }

      const creatorPubkey = playerKp.publicKey.toBase58();
      this.gameDb.savePlayerMapping(creatorPubkey, telegramId.toString());

      // Check oracle and generate game secrets
      debugLog("🔍 Checking Oracle health for game creation...");
      const isOracleHealthy = await this.oracleClient.isHealthy();

      let randomHash: string;
      let randomHashBuffer: Buffer;
      let oracleOperator: PublicKey;

      if (!isOracleHealthy) {
        return {
          success: false,
          error: "❌ Oracle service is unavailable. Please try again later.",
        };
      } else {
        debugLog("✅ Oracle is healthy, generating proper random hash");
        const secretsResponse = await this.oracleClient.generateGameSecrets();
        randomHash = secretsResponse.randomHash;
        randomHashBuffer = this.oracleClient.hexToBuffer(randomHash);
        oracleOperator = new PublicKey(secretsResponse.oracleOperator);
      }

      // Create game
      const gameConfig = {
        gameType: gameType === "coinflip" ? { coinflip: {} } : { giveaway: {} },
        // u64 must be BN
        amount: new anchor.BN(amount),
        // u32 are fine as numbers, but field names must match IDL
        maxTickets: maxTickets,
        minTickets: minTickets,
        // u64 must be BN
        timeout: new anchor.BN(timeout),
        isPrivate,
      };

      const tokenMintPubkey = new PublicKey(tokenMint);
      const gamePda = PDAManager.getGamePDA(randomHashBuffer, this.program.programId);
      const tokenAccounts = await this.resolveGameTokenAccounts(tokenMintPubkey);
      const gameTokenCtx = this.buildGameTokenContext(tokenMintPubkey, tokenAccounts);
      const creatorTokenAccount = await this.deriveAta(
        tokenMintPubkey,
        playerKp.publicKey,
        tokenAccounts.tokenProgram,
      );
      const oraclePda = this.getOraclePda();
      const usesAtomicCreatorJoin = gameType === "coinflip";
      const gameInstruction = await this.program.methods
        .initializeGame(gameConfig, Array.from(randomHashBuffer))
        .accounts({
          game: gamePda,
          creator: playerKp.publicKey,
          oracle: oraclePda,
          oracleOperator: usesAtomicCreatorJoin ? oracleOperator : Keypair.generate().publicKey,
          gameTokenCtx,
          creatorTokenAccount,
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction();

      let creationInstructions: TransactionInstruction[] = [gameInstruction];
      if (usesAtomicCreatorJoin) {
        const { accounts: joinAccounts, setupInstructions } = await this.buildJoinAccounts(
          gamePda,
          { tokenMint },
          playerKp.publicKey,
          isPrivate ? oracleOperator : undefined,
        );
        const joinInstruction = await this.program.methods
          .joinGame()
          .accounts(joinAccounts as any)
          .instruction();
        if (!isPrivate) {
          // Anchor resolves an omitted optional signer to the provider wallet. Public games
          // must encode `None` with the program ID placeholder instead.
          joinInstruction.keys[2] = {
            pubkey: this.program.programId,
            isSigner: false,
            isWritable: false,
          };
        }
        creationInstructions = [gameInstruction, ...setupInstructions, joinInstruction];
      }

      const sendCreationTransaction = async () => {
        const latestBlockhash = await this.wallet.getLatestBlockhash();
        const unsigned = new Transaction({
          feePayer: playerKp.publicKey,
          ...latestBlockhash,
        }).add(...creationInstructions);
        if (usesAtomicCreatorJoin) unsigned.partialSign(playerKp);
        const oracleSigned = await this.oracleClient.signGameTransaction(unsigned);
        return this.wallet.sendPartiallySignedTransaction(
          oracleSigned,
          [playerKp],
          latestBlockhash,
        );
      };
      const creationTx = await sendCreationTransaction();

      debugLog(`📍 Game address: ${gamePda.toBase58()}`);

      const confirmedCreationTx = await this.confirmTransactionWithRecovery(
        creationTx,
        gamePda,
        "Game creation",
        undefined,
        sendCreationTransaction,
      );

      // Save game
      this.gameDb.saveGame(
        gamePda.toBase58(),
        telegramIdStr,
        amount,
        gameType,
        tokenMint,
        tokenTicker,
        maxTickets,
        minTickets,
        chatId,
        timeout,
        expiresAtMs,
      );

      // Auto-join logic based on game type
      let autoJoinResult: { success: boolean; error?: string } | undefined;
      if (usesAtomicCreatorJoin) {
        this.gameDb.saveGameParticipant?.(gamePda.toBase58(), telegramIdStr, creatorPubkey, {
          status: "confirmed",
          joinSignature: confirmedCreationTx,
          lastVerifiedAt: Date.now(),
        });
        autoJoinResult = { success: true };
      } else {
        debugLog(
          `🎁 ${
            gameType.charAt(0).toUpperCase() + gameType.slice(1)
          } game ${gamePda.toBase58()} created - creator not auto-joined`,
        );
      }

      if (parsedAmount.priceLookup) {
        const priceMint = parsedAmount.isSol ? WSOL_MINT : tokenMint;
        const cachedPrice = rememberPriceLookup(parsedAmount.priceLookup, {
          tokenMint: priceMint,
        });
        this.gamePriceCache.setWithTTL(gamePda.toBase58(), cachedPrice);
      }

      return {
        success: true,
        gameAddress: gamePda.toBase58(),
        autoJoinResult,
      };
    } catch (error: any) {
      const userFriendlyError = await logAndFormatError(
        error,
        `creating ${gameType} game`,
        this.wallet,
      );
      return {
        success: false,
        error: userFriendlyError,
      };
    } finally {
      this.decrementInFlightCreations(telegramIdStr);
      this.clearPendingCreationRequest(telegramIdStr, pendingRequestTimestamp);
    }
  }

  // HELPER METHODS
  // ================================

  // Balances are tracked directly in token accounts (no separate player balance account)

  // ================================
  // EXPIRATION HANDLING
  // ================================
  // EXPIRATION HANDLING
  // ================================

  public async handleExpiredGame(
    gamePda: PublicKey,
    gameAccount: any,
  ): Promise<GameCancellationResult | false> {
    const gameType = this.getGameType(gameAccount);
    const ticketsCount = Number(gameAccount.ticketsCount || 0);
    const minTickets = Number(gameAccount.minTickets || 0);
    const hasEnoughTickets = ticketsCount >= minTickets;
    const expired = GameManager.isExpired(gameAccount);

    if (!expired) {
      return false;
    }

    const bufferElapsed = this.isGameExpiredWithBuffer(gameAccount);

    debugLog(
      `🔄 Processing expired ${gameType} game ${gamePda.toBase58()} (${ticketsCount}/${
        gameAccount.maxTickets
      })`,
    );

    // Giveaway:
    // - If expired and minimum tickets were NOT reached, close immediately (participants don't need refunds).
    // - If minimum tickets were reached, wait for oracle completion.
    if (gameType === "giveaway") {
      const shouldCancel = ticketsCount === 0 || (minTickets > 0 && !hasEnoughTickets);

      if (shouldCancel) {
        try {
          const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
          if (result.success) {
            return {
              cancelled: true,
              amount: Number(gameAccount.ticketAmount),
              creator: gameAccount.creator.toBase58(),
              tx: result.tx!,
            };
          }
        } catch (error) {
          console.error(`Error closing expired giveaway:`, error);
        }
      } else {
        if (!bufferElapsed) {
          debugLog("⏳ Giveaway has participants; waiting for oracle to complete.");
          return false;
        }
        debugLog("⌛ Giveaway buffer elapsed; awaiting oracle completion.");
      }
      return false;
    }

    // Competitive games (coinflip):
    // If there are no participants, we can close directly.
    if (ticketsCount === 0) {
      try {
        const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
        if (result.success) {
          return {
            cancelled: true,
            amount: Number(gameAccount.ticketAmount),
            creator: gameAccount.creator.toBase58(),
            tx: result.tx!,
          };
        }
      } catch (error) {
        console.error(`Error closing expired ${gameType} with zero tickets:`, error);
      }
      return false;
    }

    // If there are participants but not enough to complete, try to unjoin them.
    if (!hasEnoughTickets) {
      const didCleanup = await this.handleExpiredCoinflip(gamePda, gameAccount, gamePda.toBase58());
      if (!didCleanup) return false;

      // After cleanup, check if game can now be closed
      try {
        const refreshed = await this.program.account.game.fetch(gamePda);
        const remaining = Number(refreshed.ticketsCount || 0);
        if (remaining === 0) {
          const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
          if (result.success) {
            return {
              cancelled: true,
              amount: Number(refreshed.ticketAmount),
              creator: refreshed.creator.toBase58(),
              tx: result.tx!,
            };
          }
        }
      } catch (error: any) {
        // If account doesn't exist, the game was already successfully closed
        if (error.message?.includes("Account does not exist")) {
          debugLog("✅ Game account already closed successfully");
        } else {
          console.error("Post-cleanup close attempt failed:", error);
        }
      }
      return false;
    }

    // Has enough tickets -> wait for oracle completion during buffer period
    if (!bufferElapsed) {
      debugLog("⏳ Game has minimum tickets; waiting for oracle to complete.");
      return false;
    }

    // Buffer elapsed and oracle didn't complete -> force cleanup
    debugLog(`⏰ Buffer elapsed for ${gameType} with ${ticketsCount} tickets; forcing cleanup...`);

    if (gameType === "coinflip") {
      const didCleanup = await this.handleExpiredCoinflip(gamePda, gameAccount, gamePda.toBase58());
      if (!didCleanup) return false;

      // After cleanup, check if game can now be closed
      try {
        const refreshed = await this.program.account.game.fetch(gamePda);
        const remaining = Number(refreshed.ticketsCount || 0);
        if (remaining === 0) {
          const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
          if (result.success) {
            return {
              cancelled: true,
              amount: Number(refreshed.ticketAmount),
              creator: refreshed.creator.toBase58(),
              tx: result.tx!,
            };
          }
        }
      } catch (error: any) {
        if (error.message?.includes("Account does not exist")) {
          debugLog("✅ Game account already closed successfully after buffer cleanup");
        } else {
          console.error("Post-buffer cleanup close attempt failed:", error);
        }
      }
      return false;
    }

    // For giveaways with buffer elapsed, force close
    const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
    if (result.success) {
      return {
        cancelled: true,
        amount: Number(gameAccount.ticketAmount),
        creator: gameAccount.creator.toBase58(),
        tx: result.tx!,
      };
    }
    return false;
  }

  // ================================
  // JOIN/UNJOIN FUNCTIONALITY
  // ================================

  /**
   * Comprehensive join game method that handles all validation and logic
   */
  public async joinGame(
    gameAddress: string,
    telegramId: bigint,
    chatId?: number,
    displayName?: string | null,
  ): Promise<{ success: boolean; error?: string; isRoll?: boolean }> {
    try {
      const gamePda = new PublicKey(gameAddress);
      const playerKp = this.wallet.getKeyPair(telegramId);

      // Get game data and validate
      let gameData = this.gameDb.getGame(gameAddress);
      if (!gameData) {
        gameData = await this.ensureGameDataFromChain(gameAddress);
      }
      if (!gameData) {
        return {
          success: false,
          error: "Game not found or has expired.",
        };
      }

      if (gameData.status !== "active") {
        return { success: false, error: "This game is no longer active!" };
      }

      // Validate token data
      if (!gameData.token_mint || !gameData.token_ticker) {
        return {
          success: false,
          error: "Game data incomplete - please contact support",
        };
      }

      // Fetch blockchain game state
      let gameAccount: any;
      try {
        const accountApi = this.program.account.game as any;
        const fetchNullable = accountApi?.fetchNullable?.bind(accountApi);
        gameAccount = fetchNullable
          ? await fetchNullable(gamePda)
          : await accountApi.fetch(gamePda);

        if (!gameAccount) {
          return {
            success: false,
            error: this.completedGameErrorMessage,
          };
        }
      } catch (fetchError: any) {
        if (fetchError?.message?.includes("Account does not exist")) {
          return {
            success: false,
            error: this.completedGameErrorMessage,
          };
        }
        throw fetchError;
      }

      // Check if player already in game
      const isInGame = await this.isPlayerInGame(gamePda, playerKp.publicKey);

      if (isInGame) {
        return { success: false, error: "You have already joined this game!" };
      }

      if (gameAccount.ticketsCount >= gameAccount.maxTickets) {
        return { success: false, error: "This game is already full!" };
      }

      // Pre-flight balance validation for ALL game types (coinflip, giveaway, etc.)
      // This prevents the confusing "Attempt to debit an account but found no record of a prior credit" error
      const currentGameType = Object.keys(gameAccount.gameType)[0];
      const gameAmount = Number(gameAccount.ticketAmount);
      const metadata = await this.wallet.getTokenMetadata(gameData.token_mint);
      const minSolBuffer = await this.feeBudget.getGameSafetyBufferLamports();

      let [tokenBalance, solBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, gameData.token_mint),
        this.wallet.getBalance(telegramId),
      ]);

      const normalizedTicker = gameData.token_ticker?.toUpperCase?.() ?? "";
      const isSolBackedGame =
        gameData.token_mint === WSOL_MINT &&
        (normalizedTicker === "SOL" || normalizedTicker === "WSOL");

      // Handle SOL-backed games (WSOL wrapping)
      if (isSolBackedGame) {
        const ensured = await this.ensureWrappedSolBalance(
          telegramId,
          gameAmount,
          tokenBalance,
          solBalance,
          "join",
        );

        if (!ensured.success) {
          return { success: false, error: ensured.error };
        }

        tokenBalance = ensured.tokenBalance;
        solBalance = ensured.solBalance;
      }

      // Check if user has enough tokens to cover the game stake
      if (tokenBalance < gameAmount) {
        const formattedBalance = this.wallet.formatTokenBalance(tokenBalance, metadata.decimals);
        const formattedNeed = this.wallet.formatTokenBalance(gameAmount, metadata.decimals);
        const safeTicker = escapeHtml(gameData.token_ticker);

        // Check if user has no token account at all (balance = 0)
        if (tokenBalance === 0) {
          return {
            success: false,
            error: `❌ You don't have any ${safeTicker} tokens. You need ${formattedNeed} ${safeTicker} to join this game. Use /balance to check your address and transfer tokens.`,
          };
        }

        return {
          success: false,
          error: `❌ Not enough ${safeTicker}. You have ${formattedBalance} but need ${formattedNeed}. Add more ${safeTicker} or reduce the amount and try again.`,
        };
      }

      // SOL fee reserve check and JIT swap (for all game types - even giveaways need SOL for tx fees)
      // For coinflip: reservedTicketAmount is the stake, so we can only swap spare tokens
      // For giveaway: reservedTicketAmount is always 0 because giveaways are free to join.
      // `availableTokenAmountRaw` is an upper bound only; the JIT swap targets `desiredLamports`
      // and should consume only what is needed to cover SOL fees.
      const reservedTicketAmount = currentGameType === "coinflip" ? gameAmount : 0;
      const swapAllowanceRaw = Math.max(tokenBalance - reservedTicketAmount, 0);

      const lamportsBalance = solBalance;
      if (lamportsBalance < minSolBuffer) {
        if (swapAllowanceRaw <= 0) {
          debugLog("Game join funding shortfall:", {
            currentSolLamports: solBalance,
            feeSafetyReserveLamports: minSolBuffer,
            shortfallLamports: Math.max(minSolBuffer - solBalance, 0),
            stakeRaw: reservedTicketAmount,
            spareTokenRaw: swapAllowanceRaw,
          });

          if (currentGameType === "coinflip") {
            const formattedStake = this.wallet.formatTokenBalance(gameAmount, metadata.decimals);
            const safeTicker = escapeHtml(gameData.token_ticker);
            return {
              success: false,
              error: this.buildGameJoinShortfallMessage(solBalance, minSolBuffer, {
                amount: formattedStake,
                ticker: safeTicker,
              }),
            };
          }

          return {
            success: false,
            error: this.buildGameJoinShortfallMessage(solBalance, minSolBuffer),
          };
        }

        const jitResult = await this.swapManager.performJustInTimeSolSwap({
          userKeypair: playerKp,
          tokenMint: gameData.token_mint,
          tokenDecimals: metadata.decimals,
          availableTokenAmountRaw: swapAllowanceRaw,
          desiredLamports: minSolBuffer,
          tokenTicker: gameData.token_ticker,
          logContext: `join ${gameAddress}`,
        });

        if (!jitResult.swapped && jitResult.error) {
          return { success: false, error: jitResult.error };
        }

        if (jitResult.swapped) {
          tokenBalance = await this.wallet.getTokenBalance(telegramId, gameData.token_mint);

          // Only check token balance after swap for coinflip (giveaway doesn't require tokens)
          if (currentGameType === "coinflip" && tokenBalance < gameAmount) {
            return {
              success: false,
              error: `Swap completed but only ${this.wallet.formatTokenBalance(
                tokenBalance,
                metadata.decimals,
              )} ${gameData.token_ticker} remain, which is below the required ${this.wallet.formatTokenBalance(
                gameAmount,
                metadata.decimals,
              )}. Please top up your tokens and try again.`,
            };
          }

          this.wallet.clearCachedWalletData?.(telegramId);

          const refreshedLamports = await this.wallet.getBalance(telegramId, {
            forceFresh: true,
          });
          if (refreshedLamports < minSolBuffer) {
            return {
              success: false,
              error: this.buildGameSolShortfallMessage({
                currentLamports: refreshedLamports,
                requiredLamports: minSolBuffer,
                action: "join this game",
              }),
            };
          }
        }
      }

      // Execute join

      const telegramIdStr = telegramId.toString();
      const normalizedDisplayName =
        typeof displayName === "string" && displayName.trim().length > 0
          ? displayName.trim()
          : null;
      if (normalizedDisplayName) {
        this.rememberTelegramUsername(telegramIdStr, normalizedDisplayName);
      }
      const playerPubkey = playerKp.publicKey.toBase58();
      let joinTx: string | undefined;
      let joinConfirmed = false;
      let pendingRecorded = false;

      if (gameAccount.isPrivate) {
        const result = await this.joinPrivateGame(gamePda, playerKp, chatId || 0);
        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to join private game",
          };
        }
        joinTx = result.tx;
        this.gameDb.saveGameParticipant(gameAddress, telegramIdStr, playerPubkey, {
          status: "pending",
          joinSignature: joinTx ?? null,
          lastVerifiedAt: null,
        });
        pendingRecorded = true;
        joinConfirmed = true;
      } else {
        const maxAttempts = 2;
        for (let attempt = 0; attempt < maxAttempts && !joinConfirmed; attempt++) {
          let setupInstructions: TransactionInstruction[] = [];
          let joinInstructions: TransactionInstruction[] = [];
          try {
            const { accounts: joinAccounts, setupInstructions: setupIxs } =
              await this.buildJoinAccounts(
                gamePda,
                gameAccount,
                playerKp.publicKey,
                // Explicitly fill the optional oracleOperator signer slot with the player
                // so Anchor doesn't require a signature from the default (all-zeros) key.
                playerKp.publicKey,
              );
            setupInstructions = setupIxs;
            const joinInstruction = await this.program.methods
              .joinGame()
              .accounts(joinAccounts as any)
              .instruction();
            joinInstructions = [...setupInstructions, joinInstruction];

            joinTx = await this.wallet.sendTransaction(joinInstructions, [playerKp]);
            this.gameDb.saveGameParticipant(gameAddress, telegramIdStr, playerPubkey, {
              status: "pending",
              joinSignature: joinTx ?? null,
              lastVerifiedAt: null,
            });
            pendingRecorded = true;

            joinTx = await this.confirmTransactionWithRecovery(
              joinTx,
              gamePda,
              "Player join",
              playerKp.publicKey,
              async () => {
                const resendJoinTransaction = async () => {
                  return await this.sendInstructionsWithFallback(
                    joinInstructions,
                    [playerKp],
                    "Player join transaction",
                  );
                };

                const refreshedSignature = await resendJoinTransaction();

                this.gameDb.saveGameParticipant(gameAddress, telegramIdStr, playerPubkey, {
                  status: "pending",
                  joinSignature: refreshedSignature ?? null,
                  lastVerifiedAt: null,
                });

                return refreshedSignature ?? joinTx;
              },
            );
            joinConfirmed = true;
          } catch (joinError: any) {
            const message = joinError?.message ?? "";
            const normalized = message.toLowerCase();
            const needsAtaCreation = setupInstructions.length > 0;
            const isAtaInitFailure =
              needsAtaCreation &&
              (normalized.includes("associated token account") ||
                normalized.includes("accountnotinitialized") ||
                normalized.includes("uninitialized"));
            const isTimeout =
              normalized.includes("timeout") || normalized.includes("not confirmed");
            const isLastAttempt = attempt === maxAttempts - 1;

            if (isTimeout && !isLastAttempt) {
              const alreadyJoined = await this.isPlayerInGame(gamePda, playerKp.publicKey).catch(
                () => false,
              );

              if (alreadyJoined) {
                joinConfirmed = true;
                break;
              }

              console.warn(
                `⚠️ Player join attempt ${attempt + 1} for ${gameAddress} timed out; retrying with a fresh blockhash.`,
              );
              continue;
            }

            if (isAtaInitFailure) {
              throw new Error(
                "Failed to initialize your token account for this game. Please try again or ensure you have enough SOL for fees.",
                { cause: joinError },
              );
            }

            throw joinError;
          }
        }
      }

      if (!joinConfirmed) {
        if (pendingRecorded) {
          this.gameDb.removeGameParticipant(gameAddress, telegramIdStr);
        }
        return {
          success: false,
          error: "Join transaction is still pending on Solana. Tap Refresh or try again shortly.",
        };
      }

      // Update database
      if (normalizedDisplayName) {
        this.gameDb.savePlayerMapping(playerPubkey, telegramIdStr, normalizedDisplayName);
      } else {
        this.gameDb.savePlayerMapping(playerPubkey, telegramIdStr);
      }
      const verified = await this.verifyParticipantJoin(
        gamePda,
        playerKp.publicKey,
        telegramIdStr,
        { joinSignature: joinTx ?? null },
      );

      if (!verified) {
        return {
          success: false,
          error:
            "Join transaction confirmed but participant record is still syncing. We'll retry automatically.",
        };
      }

      try {
        const updatedGameAccount = await this.program.account.game.fetch(gamePda);
        const ticketsCount = Number(updatedGameAccount.ticketsCount ?? 0);
        const maxTickets = Number(updatedGameAccount.maxTickets ?? 0);
        const requestCompletion = this.oracleClient.requestGameCompletion;

        if (
          maxTickets > 0 &&
          ticketsCount >= maxTickets &&
          typeof requestCompletion === "function"
        ) {
          void requestCompletion.call(this.oracleClient, gameAddress);
        }
      } catch (completionWakeError) {
        console.warn(
          `Failed to request oracle completion for ${gameAddress}:`,
          completionWakeError,
        );
      }

      return { success: true };
    } catch (error: any) {
      console.error(`Error joining game ${gameAddress}:`, error);
      try {
        this.gameDb.removeGameParticipant(gameAddress, telegramId.toString());
      } catch (_) {
        // ignore cleanup errors
      }
      const userFriendlyError = await logAndFormatError(
        error,
        `joining game ${gameAddress}`,
        this.wallet,
      );
      return { success: false, error: userFriendlyError };
    }
  }

  /**
   * Enhanced unjoin game method with all validation
   */
  public async unjoinGame(
    gameAddress: string,
    telegramId: bigint,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const gamePda = new PublicKey(gameAddress);
      const playerKp = this.wallet.getKeyPair(telegramId);

      // Get game data for validation
      const gameData = this.gameDb.getGame(gameAddress);
      if (!gameData) {
        return { success: false, error: "Game not found!" };
      }

      // Check if player is actually in the game
      const isInGame = await this.isPlayerInGame(gamePda, playerKp.publicKey);
      if (!isInGame) {
        return { success: false, error: "You are not in this game" };
      }

      // Execute unjoin
      await this.unjoinPlayerFromGame(gamePda, playerKp, playerKp.publicKey, telegramId.toString());

      return { success: true };
    } catch (error: any) {
      console.error(`Error unjoining game ${gameAddress}:`, error);
      return {
        success: false,
        error: error.message || "Failed to unjoin game",
      };
    }
  }

  // ================================
  // GAME CLOSURE AND CLEANUP
  // ================================

  private async closeGameWithCreatorAuthority(options: {
    gamePda: PublicKey;
    gameAccount: any;
    creatorTelegramId: string;
    gameType: string;
    attemptLog?: string;
    successPrefix?: string;
    failurePrefix?: string;
  }): Promise<{ success: boolean; tx?: string; error?: string }> {
    const {
      gamePda,
      gameAccount,
      creatorTelegramId,
      gameType,
      attemptLog,
      successPrefix,
      failurePrefix,
    } = options;

    const address = gamePda.toBase58();
    if (attemptLog) {
      debugLog(attemptLog);
    } else {
      debugLog(`Closing ${gameType} game ${address} with cleanup`);
    }

    try {
      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const closeAccounts = await this.buildCloseGameAccounts(gamePda, gameAccount);
      const closeInstruction = await this.program.methods
        .closeGame()
        .accounts(closeAccounts as any)
        .instruction();

      const sendCloseTransaction = async () => {
        return await this.sendInstructionsWithFallback(
          [closeInstruction],
          [creatorKp],
          `${gameType} close transaction`,
          { skipConfirmation: true },
        );
      };

      let tx = await sendCloseTransaction();

      tx = await this.confirmTransactionWithRecovery(
        tx,
        gamePda,
        "Game close",
        creatorKp.publicKey,
        async () =>
          await this.sendInstructionsWithFallback(
            [closeInstruction],
            [creatorKp],
            `${gameType} close transaction`,
          ),
      );

      const successMessage = successPrefix ?? `✅ Successfully closed ${gameType} game`;
      debugLog(`${successMessage} ${address} with tx: ${tx}`);

      return { success: true, tx };
    } catch (error: any) {
      const failureMessage = failurePrefix ?? `❌ Failed to close ${gameType} game`;
      console.error(`${failureMessage} ${address}:`, error?.message ?? error);
      return { success: false, error: error?.message ?? String(error) };
    }
  }

  public async cancelGameWithPlayerKeys(
    gamePda: PublicKey,
    gameType: string,
  ): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const gameAddress = gamePda.toBase58();

      // Step 2: Close the game using creator's key to recover remaining rent
      const creatorPubkey = gameAccount.creator.toBase58();
      const creatorTelegramId = this.gameDb.getPlayerTelegramId(creatorPubkey);

      if (!creatorTelegramId) {
        debugLog(`No telegram ID found for creator ${creatorPubkey}, cannot close game`);
        return { success: false, error: "Creator not found in database" };
      }

      return await this.closeGameWithCreatorAuthority({
        gamePda,
        gameAccount,
        creatorTelegramId,
        gameType,
        attemptLog: `Attempting to close ${gameType} game ${gameAddress} with cleanup`,
      });
    } catch (error: any) {
      console.error(`❌ Error closing ${gameType} game ${gamePda.toBase58()}:`, error);
      return { success: false, error: error.message };
    }
  }

  private async unjoinPlayerFromGame(
    gamePda: PublicKey,
    authorityKp: Keypair,
    playerPubkey: PublicKey,
    playerTelegramId?: string,
    options?: { skipDbCheck?: boolean },
  ): Promise<void> {
    const gameAddress = gamePda.toBase58();
    const playerPubkeyBase58 = playerPubkey.toBase58();
    const skipDbChecks = options?.skipDbCheck === true;
    const participantIds = this.gameDb.getGameParticipants(gameAddress);

    if (!skipDbChecks) {
      if (participantIds.length === 0) {
        throw new Error("No participants found in game");
      }

      const isTracked = participantIds.some((id) => {
        const mapped = this.gameDb.getPlayerPublicKey(id);
        return mapped === playerPubkeyBase58;
      });

      if (!isTracked) {
        throw new Error("Player not found in game participants");
      }
    }

    let gameAccount: any;

    try {
      gameAccount = await this.program.account.game.fetch(gamePda);
    } catch (error: any) {
      throw new Error(
        `Failed to fetch game account for ${gameAddress}: ${error?.message ?? error}`,
        { cause: error },
      );
    }

    const knownIds = new Set(participantIds);
    if (playerTelegramId) {
      knownIds.add(playerTelegramId);
    }

    try {
      this.recoverParticipantsFromChain(gamePda, gameAccount, knownIds);
    } catch (error) {
      console.warn(`⚠️ Unable to reconcile on-chain participants for ${gameAddress}:`, error);
    }

    if (skipDbChecks && playerTelegramId) {
      const existingMapping = this.gameDb.getPlayerPublicKey(playerTelegramId);
      if (existingMapping !== playerPubkeyBase58) {
        try {
          this.gameDb.savePlayerMapping?.(playerPubkeyBase58, playerTelegramId);
        } catch (error) {
          console.warn(
            `⚠️ Failed to persist mapping for ${playerTelegramId} during cleanup:`,
            error,
          );
        }
      }
    }

    const creatorPubkeyFromAccount =
      typeof gameAccount?.creator === "string"
        ? new PublicKey(gameAccount.creator)
        : (gameAccount?.creator ?? null);

    if (skipDbChecks) {
      const isPlayerAuthority = authorityKp.publicKey.equals(playerPubkey);
      const isCreatorAuthority =
        !!creatorPubkeyFromAccount && authorityKp.publicKey.equals(creatorPubkeyFromAccount);

      if (!isPlayerAuthority && !isCreatorAuthority) {
        throw new Error(
          "Unauthorized unjoin attempt during cleanup; authority must be player or creator.",
        );
      }
    }

    const unjoinAccounts = await this.buildUnjoinAccounts(
      gamePda,
      gameAccount,
      playerPubkey,
      authorityKp.publicKey,
    );
    const unjoinInstruction = await this.program.methods
      .unjoinGame()
      .accounts(unjoinAccounts as any)
      .instruction();

    const sendUnjoinTransaction = async () => {
      return await this.sendInstructionsWithFallback(
        [unjoinInstruction],
        [authorityKp],
        "Player unjoin transaction",
        { skipConfirmation: true },
      );
    };

    const unjoinTx = await sendUnjoinTransaction();

    await this.confirmTransactionWithRecovery(
      unjoinTx,
      gamePda,
      "Player unjoin",
      playerPubkey,
      async () =>
        await this.sendInstructionsWithFallback(
          [unjoinInstruction],
          [authorityKp],
          "Player unjoin transaction",
        ),
    );

    const resolvedTelegramId =
      playerTelegramId ?? this.gameDb.getPlayerTelegramId(playerPubkeyBase58) ?? null;

    if (resolvedTelegramId) {
      try {
        this.gameDb.removeGameParticipant(gameAddress, resolvedTelegramId);
        debugLog(`Unjoined player ${resolvedTelegramId} from game participants tracking`);
      } catch (error) {
        console.warn(
          "⚠️ Failed to remove participant " +
            resolvedTelegramId +
            " from local DB for " +
            gameAddress +
            ":",
          error,
        );
      }
    }
  }

  // ================================
  // PRIVATE GAME FUNCTIONALITY
  // ================================

  public async joinPrivateGame(
    gamePda: PublicKey,
    playerKp: Keypair,
    chatId: number,
  ): Promise<{
    success: boolean;
    tx?: string;
    error?: string;
  }> {
    try {
      const authResult = await this.oracleClient.authorizePlayer(gamePda, chatId);

      if (!authResult.authorized) {
        return {
          success: false,
          error: authResult.error || "Not authorized to join this private game",
        };
      }

      // Get game data to determine the token mint
      const gameData = this.gameDb.getGame(gamePda.toBase58());
      if (!gameData?.token_mint) {
        return {
          success: false,
          error: "Game data incomplete - token info missing",
        };
      }

      const adminKp = authResult.operatorKeypair!;
      const loadGameAccount = async (): Promise<any | null> => {
        const accountApi = this.program.account.game as any;
        const fetchNullable = accountApi?.fetchNullable?.bind(accountApi);
        const account = fetchNullable
          ? await fetchNullable(gamePda)
          : await accountApi.fetch(gamePda);
        return account ?? null;
      };

      let gameAccount: any;
      try {
        gameAccount = await loadGameAccount();
      } catch (fetchError: any) {
        if (fetchError?.message?.includes("Account does not exist")) {
          return { success: false, error: this.completedGameErrorMessage };
        }
        throw fetchError;
      }

      if (!gameAccount) {
        return { success: false, error: this.completedGameErrorMessage };
      }

      const maxAttempts = 2;
      let lastSignature: string | undefined;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let setupInstructions: TransactionInstruction[] = [];
        let joinInstructions: TransactionInstruction[] = [];
        try {
          if (attempt > 0) {
            gameAccount = await loadGameAccount();
            if (!gameAccount) {
              return {
                success: false,
                error: this.completedGameErrorMessage,
              };
            }
          }

          const { accounts: joinAccounts, setupInstructions: setupIxs = [] } =
            await this.buildJoinAccounts(
              gamePda,
              gameAccount,
              playerKp.publicKey,
              adminKp.publicKey,
            );
          setupInstructions = setupIxs;

          const joinInstruction = await this.program.methods
            .joinGame()
            .accounts(joinAccounts as any)
            .instruction();
          joinInstructions = [...setupInstructions, joinInstruction];

          lastSignature = await this.wallet.sendTransaction(joinInstructions, [playerKp, adminKp]);

          lastSignature = await this.confirmTransactionWithRecovery(
            lastSignature!,
            gamePda,
            "Player join",
            playerKp.publicKey,
            async () => {
              const resendJoinTransaction = async () => {
                return await this.sendInstructionsWithFallback(
                  joinInstructions,
                  [playerKp, adminKp],
                  "Player join transaction",
                );
              };

              return await resendJoinTransaction();
            },
          );

          return { success: true, tx: lastSignature };
        } catch (joinError: any) {
          const message = joinError?.message ?? "";

          if (message.includes("Account does not exist")) {
            return {
              success: false,
              error: this.completedGameErrorMessage,
            };
          }

          const normalized = message.toLowerCase();
          const needsAtaCreation = (setupInstructions ?? []).length > 0;
          const isAtaInitFailure =
            needsAtaCreation &&
            (normalized.includes("associated token account") ||
              normalized.includes("accountnotinitialized") ||
              normalized.includes("uninitialized"));
          const isTimeout = normalized.includes("timeout") || normalized.includes("not confirmed");
          const isExpiration =
            normalized.includes("expired before confirmation") ||
            normalized.includes("last valid block height");
          const isLastAttempt = attempt === maxAttempts - 1;

          if ((isTimeout || isExpiration) && !isLastAttempt) {
            const alreadyJoined = await this.isPlayerInGame(gamePda, playerKp.publicKey).catch(
              () => false,
            );

            if (alreadyJoined) {
              return { success: true, tx: lastSignature };
            }

            console.warn(
              `⚠️ Player join attempt ${attempt + 1} for ${gamePda.toBase58()} ` +
                `timed out or expired; retrying with a fresh blockhash.`,
            );
            continue;
          }

          if (isAtaInitFailure) {
            throw new Error(
              "Failed to initialize your token account for this game. Please try again or ensure you have enough SOL for fees.",
              { cause: joinError },
            );
          }

          throw joinError;
        }
      }

      return {
        success: false,
        error: "Join transaction is still pending on Solana. Tap Refresh or try again shortly.",
        tx: lastSignature,
      };
    } catch (error: any) {
      console.error("Error joining private game:", error);
      if (error?.message?.includes("Account does not exist")) {
        return {
          success: false,
          error: "Game not found or has expired.",
        };
      }
      const userFriendlyError = this.wallet.getFriendlyErrorMessage(error);
      return { success: false, error: userFriendlyError };
    }
  }

  // ================================
  // USER GAMES
  // ================================

  public async getUserGames(
    ctx: Context,
    telegramId: bigint,
  ): Promise<{
    activeGames: string | null;
    recentGames: string | null;
  }> {
    const telegramIdStr = telegramId.toString();
    const playerKp = this.wallet.getKeyPair(telegramId);
    const playerPublicKey = playerKp.publicKey.toString();

    const [activeGamesData, recentGamesData] = await Promise.all([
      this.gameDb.getActiveGames(telegramIdStr),
      this.gameDb.getRecentGames(telegramIdStr, GAME_INFO_LIMIT),
    ]);

    // Active games
    const validActiveGames = await this.processActiveGames(ctx, activeGamesData);
    const activeGamesSection =
      validActiveGames.length > 0
        ? "🎮 <b>Active Games</b>\n\n" + validActiveGames.join("\n\n")
        : "";

    // Recent games
    const validRecentGames = await this.processRecentGames(
      ctx,
      recentGamesData,
      telegramIdStr,
      playerPublicKey,
    );

    // Categorize recent games
    const categories: GameCategory = {
      won: validRecentGames.filter((g) => g.category === "won"),
      lost: validRecentGames.filter((g) => g.category === "lost"),
      cancelled: validRecentGames.filter((g) => g.category === "cancelled"),
      created: validRecentGames.filter((g) => g.category === "created"),
    };

    const formatSection = this.formatGameSection.bind(this);

    const recentGamesSections = [
      formatSection(categories.won, "🏆 <b>Won Games</b>"),
      formatSection(categories.lost, "💀 <b>Lost Games</b>"),
      formatSection(categories.created, "📝 <b>Created Games</b>"),
      formatSection(categories.cancelled, "🚫 <b>Cancelled Games</b>"),
    ]
      .filter((section) => section !== "")
      .join("\n");

    return {
      activeGames: activeGamesSection,
      recentGames: recentGamesSections,
    };
  }

  /**
   * Get structured game history for the improved /games command.
   * Returns categorized games with amounts for summary calculation.
   */
  public async getUserGamesHistory(ctx: Context, telegramId: bigint): Promise<GameHistoryResult> {
    const telegramIdStr = telegramId.toString();
    const playerKp = this.wallet.getKeyPair(telegramId);
    const playerPublicKey = playerKp.publicKey.toString();

    const recentGamesData = await this.gameDb.getRecentGames(telegramIdStr, GAMES_HISTORY_LIMIT);

    const entries: GameHistoryEntry[] = [];
    const tickerCounts = new Map<string, number>();
    const tickerInfo = new Map<string, { mint: string; decimals: number }>();

    for (const gameData of recentGamesData) {
      try {
        // Skip giveaways - they're free to join, not wins/losses
        const gameType = (gameData.game_type as string)?.toLowerCase();
        if (gameType === "giveaway") continue;

        const category = categorizeGame(gameData, telegramIdStr, playerPublicKey);

        // Skip "created" games (not useful for history)
        if (category === "created") continue;

        const gameAddress = gameData.game_address as string;
        const rawAmount = Number(gameData.amount);
        const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0;
        const tokenTicker = gameData.token_ticker || "TOKENS";
        const tokenMint = gameData.token_mint || "";
        const completedAt = gameData.completed_at || Date.now();

        // Get decimals for the token
        let tokenDecimals = 6; // default
        try {
          if (tokenMint) {
            const meta = await this.wallet.getTokenMetadata(tokenMint);
            if (meta?.decimals != null) {
              tokenDecimals = meta.decimals;
            }
          }
        } catch {
          // ignore
        }

        // Track token frequency and info
        tickerCounts.set(tokenTicker, (tickerCounts.get(tokenTicker) || 0) + 1);
        if (!tickerInfo.has(tokenTicker)) {
          tickerInfo.set(tokenTicker, {
            mint: tokenMint,
            decimals: tokenDecimals,
          });
        }

        // Get participant count
        let ticketCount = 0;
        let maxTickets = 0;
        try {
          const getCount = (this.gameDb as any).getGameParticipantsCount?.bind(this.gameDb);
          if (typeof getCount === "function") {
            ticketCount = Math.max(0, Math.trunc(getCount(gameAddress)));
          } else {
            ticketCount = (this.gameDb.getGameParticipants(gameAddress) ?? []).length;
          }
          const storedMax = Number(gameData.max_players);
          maxTickets =
            Number.isFinite(storedMax) && storedMax > 0 ? storedMax : Math.max(ticketCount, 0);
        } catch {
          // ignore
        }

        // Get creator display
        let creatorDisplay = "";
        try {
          const creatorUsername = await this.getUsernameFromTelegramId(
            ctx,
            gameData.creator_telegram_id,
          );
          creatorDisplay = creatorUsername
            ? sanitizeTelegramDisplayNameWithoutMention(creatorUsername)
            : `Player ${String(gameData.creator_telegram_id).slice(0, 6)}...`;
        } catch {
          creatorDisplay = `Player ${String(gameData.creator_telegram_id).slice(0, 6)}...`;
        }

        // Get opponent display (winner for losses)
        let opponentDisplay = "";
        if (category === "lost" && gameData.winner_address) {
          try {
            const winnerUsername = await this.getPlayerUsername(ctx, gameData.winner_address);
            opponentDisplay = winnerUsername
              ? sanitizeTelegramDisplayNameWithoutMention(winnerUsername)
              : "";
          } catch {
            // ignore
          }
        }

        const explorerUrl = gameAddress
          ? NetworkDetector.buildSolscanAccountUrl(gameAddress)
          : null;

        entries.push({
          gameAddress,
          amount,
          tokenTicker,
          tokenMint,
          tokenDecimals,
          ticketCount,
          maxTickets,
          creatorDisplay,
          opponentDisplay,
          completedAt,
          explorerUrl,
          category,
        });
      } catch (error) {
        console.error(`Error processing game ${gameData.game_address}:`, error);
      }
    }

    // Determine primary ticker
    let primaryTicker = "TOKENS";
    let primaryDecimals = 6;
    let maxCount = 0;
    for (const [ticker, count] of tickerCounts) {
      if (count > maxCount) {
        maxCount = count;
        primaryTicker = ticker;
        primaryDecimals = tickerInfo.get(ticker)?.decimals ?? 6;
      }
    }

    // Get USD prices for all unique tokens
    const tokenPrices = new Map<string, number>();
    for (const [ticker, info] of tickerInfo) {
      if (info.mint) {
        try {
          const priceMint = info.mint === "SOL" ? WSOL_MINT : info.mint;
          const priceResult = await getUsdPrice({
            tokenMint: priceMint,
          });
          if (priceResult?.price != null && priceResult.price > 0) {
            tokenPrices.set(ticker, priceResult.price);
          }
        } catch {
          // ignore
        }
      }
    }

    // Categorize entries for the game list display
    const won = entries.filter((e) => e.category === "won");
    const lost = entries.filter((e) => e.category === "lost");
    const cancelled = entries.filter((e) => e.category === "cancelled");

    // For display list, use the limited entries
    const wonTotal = won.reduce((sum, g) => sum + g.amount, 0);
    const lostTotal = lost.reduce((sum, g) => sum + g.amount, 0);

    // Get ACCURATE stats from database aggregation (same as leaderboard)
    // This ensures /games and /lb show matching numbers
    const playerStats = this.gameDb.getPlayerGlobalStats(telegramIdStr);

    let wonUsd = 0;
    let lostUsd = 0;

    // Convert won amounts to USD
    if (playerStats?.wonAmountByToken) {
      for (const [tokenMint, wonAmount] of Object.entries(playerStats.wonAmountByToken)) {
        if (wonAmount <= 0) continue;
        try {
          let decimals = 9;
          try {
            const meta = await this.wallet.getTokenMetadata(tokenMint);
            if (meta?.decimals != null) decimals = meta.decimals;
          } catch {
            /* ignore */
          }

          const priceResult = await getUsdPrice({
            tokenMint: tokenMint === "SOL" ? WSOL_MINT : tokenMint,
          });
          if (priceResult?.price && priceResult.price > 0) {
            const divisor = Math.pow(10, decimals);
            wonUsd += (wonAmount / divisor) * priceResult.price;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // Convert lost amounts to USD
    if (playerStats?.lostAmountByToken) {
      for (const [tokenMint, lostAmount] of Object.entries(playerStats.lostAmountByToken)) {
        if (lostAmount <= 0) continue;
        try {
          let decimals = 9;
          try {
            const meta = await this.wallet.getTokenMetadata(tokenMint);
            if (meta?.decimals != null) decimals = meta.decimals;
          } catch {
            /* ignore */
          }

          const priceResult = await getUsdPrice({
            tokenMint: tokenMint === "SOL" ? WSOL_MINT : tokenMint,
          });
          if (priceResult?.price && priceResult.price > 0) {
            const divisor = Math.pow(10, decimals);
            lostUsd += (lostAmount / divisor) * priceResult.price;
          }
        } catch {
          /* ignore */
        }
      }
    }

    return {
      won: {
        games: won,
        totalAmount: wonTotal,
        totalUsd: wonUsd,
      },
      lost: {
        games: lost,
        totalAmount: lostTotal,
        totalUsd: lostUsd,
      },
      cancelled: {
        games: cancelled,
        count: cancelled.length,
      },
      primaryTicker,
      primaryDecimals,
    };
  }

  /**
   * Format a single game line for the compact /games output.
   * ✅ 151.1k TIMBA 🅴 • 2/2 • by @seebaacs • 19 Dec 00:02
   * ❌ 154.0k TIMBA 🅴 • 7/10 • vs @ThrasherMagazinee • 19 Dec 00:00
   * 🚫 14.0k TIMBA 🅴 • 0/2 • 19 Dec 00:44
   */
  public formatCompactGameLine(game: GameHistoryEntry): string {
    const emoji = game.category === "won" ? "✅" : game.category === "lost" ? "❌" : "🚫";

    const amountStr = formatCompactAmount(game.amount, game.tokenDecimals);
    const ticketsStr = `${game.ticketCount}/${game.maxTickets}`;
    const dateStr = formatCompactDate(game.completedAt);
    const ticker = escapeHtml(game.tokenTicker);

    // Build the person reference
    let personPart = "";
    if (game.category === "won" || game.category === "cancelled") {
      // Show creator ("by @user")
      if (game.creatorDisplay) {
        personPart = ` • by ${escapeHtml(game.creatorDisplay)}`;
      }
    } else if (game.category === "lost") {
      // Show opponent/winner ("vs @user")
      if (game.opponentDisplay) {
        personPart = ` • vs ${escapeHtml(game.opponentDisplay)}`;
      }
    }

    // Build explorer link with 🅴 emoji (like game messages)
    const explorerIcon = game.explorerUrl ? `<a href="${escapeHtml(game.explorerUrl)}">🅴</a>` : "";

    return `${emoji} ${escapeHtml(amountStr)} ${ticker} ${explorerIcon}• ${ticketsStr}${personPart} • ${dateStr}`;
  }

  /**
   * Build the summary header for /games command.
   * 🎲 Games — @username
   * Last 30 days
   * Net: <code>+$13.00</code> (Won <code>$21.00</code> • Lost <code>$8.00</code>)
   * ────────
   */
  public formatGamesHeader(username: string, result: GameHistoryResult): string {
    const formatUsd = (value: number): string => {
      if (value >= 1000) {
        const k = value / 1000;
        return k >= 10 ? `$${Math.round(k)}k` : `$${k.toFixed(1)}k`;
      }
      // Always show 2 decimal places for consistency with leaderboard
      return `$${value.toFixed(2)}`;
    };

    // Always show USD - games can be in multiple tokens so we can't show token amounts
    const wonUsd = formatUsd(result.won.totalUsd);
    const lostUsd = formatUsd(result.lost.totalUsd);
    const netUsd = result.won.totalUsd - result.lost.totalUsd;
    const netSign = netUsd >= 0 ? "+" : "-";
    const netStr = formatUsd(Math.abs(netUsd));

    // Calculate win rate from game counts
    const wins = result.won.games.length;
    const losses = result.lost.games.length;
    const totalGames = wins + losses;
    const winRate = totalGames > 0 ? (wins / totalGames) * 100 : 0;
    const winRateStr =
      winRate > 0 ? (Number.isInteger(winRate) ? winRate.toFixed(0) : winRate.toFixed(1)) : "0";

    // Remove the $ from netStr since we'll add it with the sign
    const summaryLine = `Net: ${netSign}$${netStr.replace("$", "")} (Won ${wonUsd} • Lost ${lostUsd})`;

    const lines = [
      `🎲 <b>Games</b> — ${escapeHtml(username)} [30D]`,
      summaryLine,
      `${wins} wins • ${losses} losses • ${winRateStr}% WR`,
      "────────",
    ];

    return lines.join("\n");
  }

  /**
   * Format a full /games message for a specific tab and page.
   */
  public formatGamesMessage(
    username: string,
    result: GameHistoryResult,
    tab: GamesTab,
    page: number,
  ): string {
    const header = this.formatGamesHeader(username, result);

    // Determine which games to show
    let games: GameHistoryEntry[];
    let sectionTitle: string;

    switch (tab) {
      case "won":
        games = result.won.games;
        sectionTitle = `✅ Won (${games.length})`;
        break;
      case "lost":
        games = result.lost.games;
        sectionTitle = `❌ Lost (${games.length})`;
        break;
      case "cancelled":
        games = result.cancelled.games;
        sectionTitle = `🚫 Cancelled (${games.length})`;
        break;
      case "all":
      default:
        // Merge all and sort by date
        games = [...result.won.games, ...result.lost.games, ...result.cancelled.games].sort(
          (a, b) => b.completedAt - a.completedAt,
        );
        sectionTitle = `All (${games.length})`;
        break;
    }

    if (games.length === 0) {
      return `${header}\n\n<i>No games in this category.</i>`;
    }

    // Paginate
    const totalPages = Math.ceil(games.length / GAMES_PER_PAGE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePage * GAMES_PER_PAGE;
    const pageGames = games.slice(start, start + GAMES_PER_PAGE);

    // Deduplicate identical games (same amount, tickets, creator, date minute)
    // Collapse to "×N" suffix
    const dedupeKeyForGame = (game: GameHistoryEntry): string =>
      JSON.stringify({
        category: game.category,
        amount: game.amount,
        ticketCount: game.ticketCount,
        maxTickets: game.maxTickets,
        creatorDisplay: game.creatorDisplay,
        dateMinute: Math.floor(game.completedAt / 60000),
      });

    const deduped: { game: GameHistoryEntry; count: number }[] = [];
    for (const game of pageGames) {
      // Create a key based on: category, amount, tickets, creator, date (rounded to minute)
      const key = dedupeKeyForGame(game);

      const existing = deduped.find((d) => {
        return dedupeKeyForGame(d.game) === key;
      });

      if (existing) {
        existing.count++;
      } else {
        deduped.push({ game, count: 1 });
      }
    }

    // Format game lines with optional ×N suffix
    const gameLines = deduped
      .map(({ game, count }) => {
        const line = this.formatCompactGameLine(game);
        return count > 1 ? `• ${line} ×${count}` : `• ${line}`;
      })
      .join("\n");

    const pageInfo = totalPages > 1 ? ` • Page ${safePage + 1}/${totalPages}` : "";

    return `${header}\n${sectionTitle}${pageInfo}\n${gameLines}`;
  }

  /**
   * Build inline keyboard for /games tabs and pagination.
   */
  public buildGamesKeyboard(
    telegramId: string,
    result: GameHistoryResult,
    currentTab: GamesTab,
    currentPage: number,
  ): any[][] {
    const keyboard: any[][] = [];

    // Row 1: Tabs
    const tabs: Array<{ label: string; tab: GamesTab; count: number }> = [
      { label: "Won", tab: "won", count: result.won.games.length },
      { label: "Lost", tab: "lost", count: result.lost.games.length },
      { label: "Canc", tab: "cancelled", count: result.cancelled.games.length },
      {
        label: "All",
        tab: "all",
        count: result.won.games.length + result.lost.games.length + result.cancelled.games.length,
      },
    ];

    const tabRow = tabs.map(({ label, tab, count }) => {
      const isActive = tab === currentTab;
      const displayLabel = isActive ? `[${label} (${count})]` : `${label} (${count})`;
      return {
        text: displayLabel,
        callback_data: `games_tab:${tab}:0:${telegramId}`,
      };
    });
    keyboard.push(tabRow);

    // Row 2: Pagination (if needed)
    const games =
      currentTab === "all"
        ? [...result.won.games, ...result.lost.games, ...result.cancelled.games]
        : currentTab === "won"
          ? result.won.games
          : currentTab === "lost"
            ? result.lost.games
            : result.cancelled.games;

    const totalPages = Math.ceil(games.length / GAMES_PER_PAGE);

    if (totalPages > 1) {
      const navRow: any[] = [];

      // Prev button
      if (currentPage > 0) {
        navRow.push({
          text: "◀ Prev",
          callback_data: `games_tab:${currentTab}:${currentPage - 1}:${telegramId}`,
        });
      }

      // Refresh button
      navRow.push({
        text: "↻ Refresh",
        callback_data: `games_refresh:${telegramId}`,
      });

      // Next button
      if (currentPage < totalPages - 1) {
        navRow.push({
          text: "Next ▶",
          callback_data: `games_tab:${currentTab}:${currentPage + 1}:${telegramId}`,
        });
      }

      keyboard.push(navRow);
    } else {
      // Just refresh button
      keyboard.push([
        {
          text: "↻ Refresh",
          callback_data: `games_refresh:${telegramId}`,
        },
      ]);
    }

    return keyboard;
  }

  private async formatActiveGamesList(
    ctx: Context,
    activeGamesData: any[],
  ): Promise<
    Array<{
      messageText: string;
      keyboard: any[];
      gameAddress: string;
      currentTickets?: number;
      maxTickets?: number;
      minTickets?: number;
    }>
  > {
    type ActiveGameRow = {
      messageText: string;
      keyboard: any[];
      gameAddress: string;
      currentTickets?: number;
      maxTickets?: number;
      minTickets?: number;
    };

    const formattedGames: Array<ActiveGameRow | null> = await Promise.all(
      activeGamesData.map(async (gameData) => {
        if (!gameData?.game_address) {
          return null;
        }

        let gamePda: PublicKey;
        try {
          gamePda = new PublicKey(gameData.game_address);
        } catch (error) {
          console.error("Invalid game address", gameData.game_address, error);
          return null;
        }

        const creatorUsername = await this.getGameCreatorUsername(ctx, gameData.game_address);

        const { messageText, keyboard } = await this.formatGameMessage(
          ctx,
          gamePda,
          gameData.game_type || "game",
          Number(gameData.amount) || 0,
          creatorUsername,
          gameData.status || "active",
          gameData.token_ticker || gameData.token_mint || DEFAULT_TOKEN_TICKER,
          gameData.winner_address,
          undefined,
          undefined,
          { suppressMentions: true },
        );
        let currentTickets: number | undefined;
        let maxTickets: number | undefined;
        let minTickets: number | undefined;
        try {
          const stats = await this.getActiveGameStats(
            gamePda,
            Number(gameData.amount) || 0,
            undefined,
          );
          currentTickets = stats?.currentTickets;
          maxTickets = stats?.maxTickets;
          minTickets = stats?.minTickets;
        } catch (statError) {
          console.warn("Failed to fetch game stats for active list:", statError);
        }

        return {
          messageText,
          keyboard,
          gameAddress: gameData.game_address,
          currentTickets,
          maxTickets,
          minTickets,
        };
      }),
    );

    return formattedGames.filter((game): game is ActiveGameRow => game !== null);
  }

  public async getChatActiveGames(
    ctx: Context,
    chatId: number,
  ): Promise<
    Array<{
      messageText: string;
      keyboard: any[];
      gameAddress: string;
      currentTickets?: number;
      maxTickets?: number;
      minTickets?: number;
    }>
  > {
    const activeGamesData = this.gameDb.getActiveGamesByChat(chatId);
    return this.formatActiveGamesList(ctx, activeGamesData);
  }

  public async getAllActivePublicGames(ctx: Context): Promise<
    Array<{
      messageText: string;
      keyboard: any[];
      gameAddress: string;
      currentTickets?: number;
      maxTickets?: number;
      minTickets?: number;
    }>
  > {
    // Fetch all games from the blockchain
    const allGames = await this.program.account.game.all();

    // Filter for public (non-private) games that are still joinable.
    const publicGames = allGames.filter((game) => {
      const account = game.account as any;
      if (account?.isPrivate) return false;

      const createdAt = Number(account?.createdAt ?? 0);
      const timeout = Number(account?.timeout ?? 0);
      const hasTiming =
        Number.isFinite(createdAt) && createdAt > 0 && Number.isFinite(timeout) && timeout > 0;

      if (hasTiming && GameManager.isExpired(account)) {
        return false;
      }

      return true;
    });

    const getExpiryTimestamp = (account: any): number => {
      const createdAt = Number(account?.createdAt ?? 0);
      const timeout = Number(account?.timeout ?? 0);
      if (Number.isFinite(createdAt) && Number.isFinite(timeout) && timeout > 0) {
        return createdAt + timeout;
      }

      return Number.POSITIVE_INFINITY;
    };

    publicGames.sort((left, right) => {
      const leftExpiry = getExpiryTimestamp(left.account);
      const rightExpiry = getExpiryTimestamp(right.account);
      if (leftExpiry !== rightExpiry) {
        return leftExpiry - rightExpiry;
      }

      const leftCreatedAt = Number(left.account?.createdAt ?? 0);
      const rightCreatedAt = Number(right.account?.createdAt ?? 0);
      return leftCreatedAt - rightCreatedAt;
    });

    // Map to GameData-like structure
    const activeGamesData = await Promise.all(
      publicGames.map(async (game) => {
        const account = game.account;
        const gameType = this.getGameType(account);
        const tokenMint = account.tokenMint.toBase58();
        const amount = this.getDisplayAmountFromAccount(account, gameType);

        let tokenTicker = DEFAULT_TOKEN_TICKER;
        try {
          const metadata = await this.wallet.getTokenMetadata(tokenMint);
          if (metadata?.symbol) {
            tokenTicker = metadata.symbol;
          }
        } catch (e) {
          // Ignore metadata fetch errors
        }

        return {
          game_address: game.publicKey.toBase58(),
          game_type: gameType,
          amount,
          token_mint: tokenMint,
          token_ticker: tokenTicker,
          status: "active", // Assumed active if account exists
          winner_address: undefined, // Not in Game account
        };
      }),
    );

    return this.formatActiveGamesList(ctx, activeGamesData);
  }

  /**
   * Ensure local DB contains minimal data for an on-chain game.
   * Used for /public joins where this bot may not have tracked the game yet.
   */
  public async ensureGameDataFromChain(gameAddress: string): Promise<GameData | null> {
    const existing = this.gameDb.getGame(gameAddress);
    if (existing) {
      return existing;
    }

    let gameAccount: any | null;
    try {
      const gamePda = new PublicKey(gameAddress);
      const accountApi = this.program.account.game as any;
      const fetchNullable = accountApi?.fetchNullable?.bind(accountApi);
      gameAccount = fetchNullable ? await fetchNullable(gamePda) : await accountApi.fetch(gamePda);
    } catch (error: any) {
      const message = error?.message ?? "";
      if (message.includes("Account does not exist")) {
        return null;
      }
      throw error;
    }

    if (!gameAccount) {
      return null;
    }

    const createdAtSeconds = Number(gameAccount.createdAt ?? 0);
    const timeoutSeconds = Number(gameAccount.timeout ?? 0);
    const hasTiming =
      Number.isFinite(createdAtSeconds) &&
      createdAtSeconds > 0 &&
      Number.isFinite(timeoutSeconds) &&
      timeoutSeconds > 0;

    if (hasTiming && GameManager.isExpired(gameAccount)) {
      return null;
    }

    const tokenMint =
      typeof gameAccount.tokenMint?.toBase58 === "function"
        ? gameAccount.tokenMint.toBase58()
        : null;
    if (!tokenMint) {
      return null;
    }

    let tokenTicker = DEFAULT_TOKEN_TICKER;
    try {
      const metadata = await this.wallet.getTokenMetadata(tokenMint);
      if (metadata?.symbol) {
        tokenTicker = metadata.symbol;
      }
    } catch {
      // ignore metadata errors
    }

    const creatorPubkey =
      typeof gameAccount.creator?.toBase58 === "function"
        ? gameAccount.creator.toBase58()
        : String(gameAccount.creator ?? "");

    const creatorTelegramId =
      (creatorPubkey ? this.gameDb.getPlayerTelegramId(creatorPubkey) : null) ?? creatorPubkey;

    if (creatorPubkey && creatorTelegramId) {
      try {
        this.gameDb.savePlayerMapping(creatorPubkey, creatorTelegramId);
      } catch (error) {
        console.warn(`Failed to persist creator mapping for hydrated game ${gameAddress}:`, error);
      }
    }

    const gameType = this.getGameType(gameAccount);
    const amount = this.getDisplayAmountFromAccount(gameAccount, gameType);
    const maxPlayers = Number(gameAccount.maxTickets ?? 0) || undefined;
    const minPlayers = Number(gameAccount.minTickets ?? 0) || undefined;

    const createdAtMs = hasTiming ? createdAtSeconds * 1000 : Date.now();
    const expiresAtMs = hasTiming ? (createdAtSeconds + timeoutSeconds) * 1000 : undefined;

    try {
      this.gameDb.saveGame(
        gameAddress,
        creatorTelegramId || "unknown",
        Number.isFinite(amount) && amount > 0 ? amount : 0,
        gameType,
        tokenMint,
        tokenTicker,
        maxPlayers,
        minPlayers,
        undefined,
        hasTiming ? timeoutSeconds : undefined,
        expiresAtMs,
        createdAtMs,
      );
    } catch (error) {
      console.warn(`Failed to hydrate game ${gameAddress} into local DB:`, error);
    }

    return this.gameDb.getGame(gameAddress);
  }

  private async processActiveGames(ctx: Context, activeGamesData: any[]): Promise<string[]> {
    const activeGames = await Promise.all(
      activeGamesData.map(async (gameData) => {
        try {
          if (!gameData.game_address) {
            console.error("Game data missing address:", gameData);
            return null;
          }

          let gamePda: PublicKey;
          try {
            gamePda = new PublicKey(gameData.game_address);
          } catch (pkError) {
            console.error("Invalid game address format:", gameData.game_address);
            return null;
          }

          return this.getGameInfo(ctx, gamePda);
        } catch (error) {
          console.error("Error fetching game " + gameData.game_address + ":", error);
          return null;
        }
      }),
    );

    return activeGames.filter((game): game is string => game !== null);
  }

  private async processRecentGames(
    ctx: Context,
    recentGamesData: any[],
    telegramIdStr: string,
    playerPublicKey: string,
  ): Promise<any[]> {
    const recentGames = await Promise.all(
      recentGamesData.map(async (gameData) => {
        try {
          const category = categorizeGame(gameData, telegramIdStr, playerPublicKey);
          const gameInfo = await this.getCompletedGameInfo(ctx, gameData);
          return { category, gameInfo, completedAt: gameData.completed_at };
        } catch (error) {
          console.error("Error processing game " + gameData.game_address + ":", error);
          return null;
        }
      }),
    );

    return recentGames.filter((game): game is any => game !== null);
  }

  private static readonly MAX_GAMES_PER_SECTION = 8;

  private formatGameSection(games: any[], title: string): string {
    if (games.length === 0) return "";
    const lines: string[] = [title, ""]; // blank line after title

    const limit = GameManager.MAX_GAMES_PER_SECTION;
    const limitedGames = games.slice(0, limit);

    for (const game of limitedGames) {
      lines.push(game.gameInfo);
      if (game.completedAt) {
        lines.push("📅 " + formatDate(game.completedAt));
      }
      lines.push("");
    }

    if (lines[lines.length - 1] === "") {
      lines.pop();
    }

    if (games.length > limit) {
      const remaining = games.length - limit;
      lines.push(
        "",
        "<i>+" + remaining + " more game" + (remaining === 1 ? "" : "s") + " not shown</i>",
      );
    }

    return lines.join("\n") + "\n";
  }

  // ================================
  // RELOAD FUNCTIONALITY
  // ================================

  public async reloadGameMessages(): Promise<void> {
    const allGames = this.gameDb.getAllGames();
    try {
      let count = 0;
      for (const game of allGames) {
        const messageMap = new Map<number, GameMessage>();
        const messages = this.gameDb.getGameMessages(game.game_address);

        if (messages.length > 0) {
          for (const msg of messages) {
            messageMap.set(msg.chatId, {
              messageId: msg.messageId,
              chatId: msg.chatId,
              usesVideo: true, // Default to true (caption edit) as games typically have media
            });
          }
        } else if (game.message_id && game.chat_id) {
          // Fallback to legacy
          messageMap.set(game.chat_id, {
            messageId: game.message_id,
            chatId: game.chat_id,
            usesVideo: true, // Default to true (caption edit) as games typically have media
          });
        }

        if (messageMap.size > 0) {
          this.activeGameMessages.set(game.game_address, messageMap);
          count += messageMap.size;
        }
      }
      debugLog("Reloaded " + count + " game messages for " + allGames.length + " games");
    } catch (error) {
      console.error("Error reloading game messages:", error);
    }
  }

  // ================================
  // BLOCKCHAIN SCANNING
  // ================================

  public async scanBlockchainForOrphanedGames(): Promise<void> {
    try {
      debugLog("🔍 Starting blockchain scan for orphaned games...");

      const orphanedGames = await this.findOrphanedGames();
      debugLog("🚨 Found " + orphanedGames.length + " orphaned games");

      let cancelledCount = 0;
      for (const { address } of orphanedGames) {
        const cancelled = await this.cancelOrphanedGame(address);
        if (cancelled) cancelledCount++;
      }

      debugLog(
        "🏁 Blockchain scan completed. Cancelled " +
          cancelledCount +
          "/" +
          orphanedGames.length +
          " orphaned games",
      );
    } catch (error) {
      console.error("❌ Error during blockchain scan:", error);
    }
  }

  private async findOrphanedGames(): Promise<{ address: string; account: any }[]> {
    const orphanedGames: { address: string; account: any }[] = [];

    try {
      const allGameAccounts = await this.program.account.game.all();

      for (const gameAccountInfo of allGameAccounts) {
        const gameAddress = gameAccountInfo.publicKey.toBase58();
        const gameAccount = gameAccountInfo.account;

        // Check if this game is in our database
        if (!this.gameDb.gameExists(gameAddress)) {
          debugLog(
            "🔍 Found orphaned game: " +
              gameAddress +
              " (" +
              gameAccount.ticketsCount +
              "/" +
              gameAccount.maxTickets +
              ")",
          );
          orphanedGames.push({ address: gameAddress, account: gameAccount });
        }
      }
    } catch (error) {
      console.error("Error scanning for orphaned games:", error);
    }

    return orphanedGames;
  }

  private async cancelOrphanedGame(address: string): Promise<boolean> {
    try {
      const gamePda = new PublicKey(address);
      const gameAccount = await this.program.account.game.fetch(gamePda);

      const expired = GameManager.isExpired(gameAccount);
      if (!expired) {
        debugLog("⏰ Game " + address + " not expired yet, skipping");
        return false;
      }

      const bufferElapsed = this.isGameExpiredWithBuffer(gameAccount);
      const ticketsCount = Number(gameAccount.ticketsCount ?? 0);
      const minTickets = Number(gameAccount.minTickets ?? 0);

      const gameType = this.getGameType(gameAccount);
      debugLog(
        "🔄 Processing expired " +
          gameType +
          " game " +
          address +
          " (" +
          gameAccount.ticketsCount +
          "/" +
          gameAccount.maxTickets +
          ")",
      );

      if (!bufferElapsed && ticketsCount >= minTickets && minTickets > 0) {
        debugLog("⏳ Game has enough participants, waiting for oracle before cleanup");
        return false;
      }

      return gameType === "giveaway"
        ? await this.handleExpiredGiveaway(gamePda, gameAccount, address)
        : await this.handleExpiredCoinflip(gamePda, gameAccount, address);
    } catch (error: any) {
      return this.handleGameProcessingError(error, address);
    }
  }

  public static isExpired(gameAccount: any, currentTimeSeconds?: number): boolean {
    const currentTime = currentTimeSeconds ?? Math.floor(Date.now() / 1000);
    const createdAt = Number(gameAccount.createdAt ?? 0);
    const timeout = Number(gameAccount.timeout ?? 0);
    const expiresAt = createdAt + timeout;
    return currentTime > expiresAt;
  }

  public static isExpiredWithBuffer(gameAccount: any, currentTimeSeconds?: number): boolean {
    const currentTime = currentTimeSeconds ?? Math.floor(Date.now() / 1000);
    const createdAt = Number(gameAccount.createdAt);
    const timeout = Number(gameAccount.timeout);
    const expiresAt = createdAt + timeout;
    return currentTime > expiresAt + GAME_EXPIRATION_BUFFER_TIME;
  }

  private isGameExpiredWithBuffer(gameAccount: any): boolean {
    return GameManager.isExpiredWithBuffer(gameAccount);
  }

  private getDisplayAmountFromAccount(gameAccount: any, gameTypeOverride?: string): number {
    const gameType = gameTypeOverride ?? this.getGameType(gameAccount);
    const ticketAmount = Number(gameAccount?.ticketAmount ?? 0);
    const totalAmount = Number(gameAccount?.totalAmount ?? 0);

    const safeTicketAmount = Number.isFinite(ticketAmount) ? ticketAmount : 0;
    const safeTotalAmount = Number.isFinite(totalAmount) ? totalAmount : 0;

    if (gameType === "giveaway") {
      return safeTotalAmount > 0 ? safeTotalAmount : safeTicketAmount;
    }

    return safeTicketAmount;
  }

  private getGameType(gameAccount: any): string {
    const type = gameAccount?.gameType;
    if (!type || typeof type !== "object") {
      return "game";
    }
    const gameTypeKeys = Object.keys(type);
    if (gameTypeKeys.length === 0) {
      return "unknown";
    }
    return gameTypeKeys[0] || "game";
  }

  private handleGameProcessingError(error: any, address: string): boolean {
    if (error.message?.includes("Account does not exist")) {
      debugLog("ℹ️ Orphaned game " + address + " was already closed");
      return true;
    } else {
      console.error("❌ Error processing orphaned game " + address + ":", error.message);
      return false;
    }
  }

  private async handleExpiredGiveaway(
    gamePda: PublicKey,
    gameAccount: any,
    address: string,
  ): Promise<boolean> {
    const gameType = this.getGameType(gameAccount);
    const ticketsCount = Number(gameAccount.ticketsCount ?? 0);
    const minTickets = Number(gameAccount.minTickets ?? 0);
    const hasEnoughTickets = ticketsCount >= minTickets;

    const shouldCancelImmediately = ticketsCount === 0 || (minTickets > 0 && !hasEnoughTickets);

    if (shouldCancelImmediately) {
      const immediateResult = await this.cancelGameWithPlayerKeys(gamePda, gameType);
      if (immediateResult.success) {
        debugLog("✅ Successfully handled expired giveaway: " + address);
        return true;
      }
      return false;
    }

    if (!this.isGameExpiredWithBuffer(gameAccount)) {
      return false;
    }

    debugLog(
      "🔄 Processing expired " +
        gameType +
        " game " +
        address +
        " (" +
        gameAccount.ticketsCount +
        "/" +
        gameAccount.maxTickets +
        ")",
    );

    const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
    if (result.success) {
      debugLog("✅ Successfully handled expired giveaway: " + address);
      return true;
    }

    return false;
  }

  private async handleExpiredCoinflip(
    gamePda: PublicKey,
    gameAccount: any,
    address: string,
  ): Promise<boolean> {
    const onChainTickets = Number(gameAccount.ticketsCount ?? 0);
    const onChainParticipants = this.getOnChainParticipantCount(gameAccount);
    const dbParticipantsSnapshot = this.gameDb.getGameParticipants(address);
    await this.reconcilePendingParticipants(gamePda);
    const playerKeyInfo = this.analyzePlayerKeys(gamePda, gameAccount, address);
    const effectiveOnChainTickets = playerKeyInfo.onChainTickets ?? onChainTickets;
    const effectiveOnChainParticipants = playerKeyInfo.onChainParticipants ?? onChainParticipants;
    const effectiveDbParticipants =
      playerKeyInfo.dbParticipantCount ?? dbParticipantsSnapshot.length;

    debugLog(
      "🪙 Coinflip " +
        address +
        ": " +
        playerKeyInfo.available.length +
        "/" +
        playerKeyInfo.total +
        " player keys available (on-chain tickets: " +
        effectiveOnChainTickets +
        ", on-chain participants: " +
        effectiveOnChainParticipants +
        ", db participants: " +
        effectiveDbParticipants +
        ")",
    );

    if (effectiveOnChainTickets !== effectiveOnChainParticipants) {
      console.warn(
        "⚠️ Participant mismatch for " +
          address +
          ": on-chain tickets " +
          effectiveOnChainTickets +
          ", participant list length " +
          effectiveOnChainParticipants,
      );
    }

    if (effectiveOnChainTickets !== effectiveDbParticipants) {
      console.warn(
        "⚠️ Database mismatch for " +
          address +
          ": on-chain tickets " +
          effectiveOnChainTickets +
          ", local participants " +
          effectiveDbParticipants,
      );
    }

    if (
      Array.isArray(playerKeyInfo.unmatchedParticipants) &&
      playerKeyInfo.unmatchedParticipants.length > 0
    ) {
      console.warn(
        "⚠️ Unable to map " +
          playerKeyInfo.unmatchedParticipants.length +
          " participant(s) for " +
          address,
      );
    }

    if (effectiveOnChainTickets === 0) {
      const staleParticipants = this.gameDb.getGameParticipants(address);
      if (staleParticipants.length > 0) {
        console.warn(
          "⚠️ Clearing " +
            staleParticipants.length +
            " stale participant(s) from local DB for " +
            address,
        );
        for (const telegramId of staleParticipants) {
          try {
            this.gameDb.removeGameParticipant(address, telegramId);
          } catch (error) {
            console.warn(
              "⚠️ Failed to remove participant " +
                telegramId +
                " from local DB for " +
                address +
                ":",
              error,
            );
          }
        }
      }

      let creatorTelegramId =
        playerKeyInfo.creator?.telegramId ??
        (typeof this.gameDb.getCreatorTelegramId === "function"
          ? this.gameDb.getCreatorTelegramId(address)
          : null);

      const creatorPubkey =
        playerKeyInfo.creator?.pubkey ??
        (() => {
          try {
            return gameAccount.creator instanceof PublicKey
              ? gameAccount.creator
              : new PublicKey(gameAccount.creator);
          } catch (_) {
            return null;
          }
        })();

      if (!creatorTelegramId && creatorPubkey) {
        creatorTelegramId = this.gameDb.getPlayerTelegramId?.(creatorPubkey.toBase58()) ?? null;
      }

      if (!creatorTelegramId && typeof this.gameDb.getCreatorInfo === "function") {
        const info = this.gameDb.getCreatorInfo(address);
        if (info?.telegramId) {
          creatorTelegramId = info.telegramId;
        }
      }

      if (!creatorTelegramId) {
        console.warn(
          "⚠️ Cannot cancel " + address + ": creator Telegram ID is missing from local data",
        );
        return false;
      }

      return await this.cancelGameWithCreator(
        gamePda,
        gameAccount,
        creatorTelegramId,
        address,
        "coinflip",
      );
    }

    // Strategy 1: Complete cleanup (unjoin all non-creators, then cancel)
    if (playerKeyInfo.canCompleteCleanup) {
      return await this.executeCompleteCleanup(gamePda, gameAccount, playerKeyInfo, address);
    }

    // Strategy 2: Partial cleanup (unjoin available players only)
    return await this.executePartialCleanup(gamePda, gameAccount, playerKeyInfo, address);
  }

  private analyzePlayerKeys(gamePda: PublicKey, gameAccount: any, gameAddress: string) {
    // Get players from database since contract no longer stores players array
    const dbParticipants = this.getGamePlayers(gameAddress);
    const participantTelegramIds = new Set(dbParticipants);
    const onChainTickets = Number(gameAccount.ticketsCount ?? 0);
    let creatorPubkey: PublicKey | null;
    let creatorTelegramId: string | null = null;

    try {
      creatorPubkey =
        gameAccount.creator instanceof PublicKey
          ? gameAccount.creator
          : new PublicKey(gameAccount.creator);
    } catch (_) {
      creatorPubkey = null;
    }

    if (creatorPubkey) {
      try {
        creatorTelegramId = this.gameDb.getPlayerTelegramId?.(creatorPubkey.toBase58()) ?? null;
        if (creatorTelegramId) {
          participantTelegramIds.add(creatorTelegramId);
        } else {
          console.warn("⚠️ Unable to resolve creator Telegram ID for orphaned game " + gameAddress);
        }
      } catch (error) {
        console.warn("⚠️ Failed to look up creator Telegram ID for " + gameAddress + ":", error);
      }
    }

    const onChainParticipantCount = this.getOnChainParticipantCount(gameAccount);

    const { unmatchedParticipants } = this.recoverParticipantsFromChain(
      gamePda,
      gameAccount,
      participantTelegramIds,
    );

    const available: Array<{
      pubkey: PublicKey;
      telegramId: string;
      isCreator: boolean;
    }> = [];
    const unavailable: string[] = [];

    for (const telegramId of participantTelegramIds) {
      try {
        const playerPubkeyStr = this.gameDb.getPlayerPublicKey(telegramId);
        if (!playerPubkeyStr) {
          unavailable.push(telegramId);
          continue;
        }

        const playerPubkey = new PublicKey(playerPubkeyStr);
        const isCreator = !!creatorPubkey && playerPubkey.equals(creatorPubkey);

        available.push({
          pubkey: playerPubkey,
          telegramId,
          isCreator,
        });
      } catch (error) {
        unavailable.push(telegramId);
      }
    }

    if (!available.some((p) => p.isCreator) && creatorPubkey && creatorTelegramId) {
      available.push({
        pubkey: creatorPubkey,
        telegramId: creatorTelegramId,
        isCreator: true,
      });
    } else if (creatorPubkey && !creatorTelegramId) {
      unavailable.push(creatorPubkey.toBase58());
    }

    if (unmatchedParticipants.length > 0) {
      for (const participant of unmatchedParticipants) {
        unavailable.push(participant);
      }
    }

    const totalParticipants = Math.max(
      participantTelegramIds.size,
      onChainParticipantCount,
      onChainTickets,
      creatorPubkey ? 1 : 0,
    );

    const nonCreators = available.filter((p) => !p.isCreator);
    const creator = available.find((p) => p.isCreator);
    const canCompleteCleanup = unavailable.length === 0 && creator !== undefined;

    return {
      available,
      unavailable,
      nonCreators,
      creator,
      canCompleteCleanup,
      total: totalParticipants,
      onChainTickets,
      onChainParticipants: onChainParticipantCount,
      dbParticipantCount: dbParticipants.length,
      unmatchedParticipants,
    };
  }

  private async executeCompleteCleanup(
    gamePda: PublicKey,
    gameAccount: any,
    playerKeyInfo: any,
    address: string,
  ): Promise<boolean> {
    debugLog(
      "🔧 Strategy 1: Complete cleanup - unjoin all " +
        playerKeyInfo.available.length +
        " players, then cancel",
    );

    // Unjoin ALL players including creator for coinflip games
    const unjoinedCount = await this.unjoinPlayers(
      gamePda,
      gameAccount,
      playerKeyInfo.available,
      playerKeyInfo.creator?.telegramId,
    );

    // Only proceed if all players were successfully unjoined
    if (unjoinedCount !== playerKeyInfo.available.length) {
      debugLog(
        "❌ Could only unjoin " +
          unjoinedCount +
          "/" +
          playerKeyInfo.available.length +
          " players from coinflip " +
          address +
          ", skipping cancellation",
      );
      return false;
    }

    // Cancel with creator
    return await this.cancelGameWithCreator(
      gamePda,
      gameAccount,
      playerKeyInfo.creator.telegramId,
      address,
      "coinflip",
    );
  }

  private async executePartialCleanup(
    gamePda: PublicKey,
    gameAccount: any,
    playerKeyInfo: any,
    address: string,
  ): Promise<boolean> {
    debugLog(
      "🔧 Strategy 2: Partial cleanup - unjoin " +
        playerKeyInfo.available.length +
        " available players",
    );

    const unjoinedCount = await this.unjoinPlayers(
      gamePda,
      gameAccount,
      playerKeyInfo.available,
      playerKeyInfo.creator?.telegramId,
    );
    debugLog(
      "📊 Unjoined " +
        unjoinedCount +
        "/" +
        playerKeyInfo.available.length +
        " players from coinflip " +
        address,
    );

    return unjoinedCount > 0;
  }

  private async unjoinPlayers(
    gamePda: PublicKey,
    gameAccount: any,
    players: Array<{
      pubkey: PublicKey;
      telegramId: string;
      isCreator: boolean;
    }>,
    creatorTelegramId?: string,
  ): Promise<number> {
    let unjoinedCount = 0;
    const gameAddress = gamePda.toBase58();
    const logContext = "unjoin " + gameAddress;

    const resolvePublicKeyString = (value: any): string | null => {
      if (!value) {
        return null;
      }
      if (value instanceof PublicKey) {
        return value.toBase58();
      }
      if (typeof value === "string") {
        return value;
      }
      if (typeof value.toBase58 === "function") {
        try {
          return value.toBase58();
        } catch (_) {
          // fall through
        }
      }
      if (typeof value.toString === "function") {
        try {
          return value.toString();
        } catch (_) {
          return null;
        }
      }
      return null;
    };

    const tokenMintStr = resolvePublicKeyString(gameAccount?.tokenMint);

    let tokenDecimals = 0;
    if (tokenMintStr) {
      try {
        const metadata = await this.wallet.getTokenMetadata(tokenMintStr);
        tokenDecimals = typeof metadata.decimals === "number" ? metadata.decimals : 0;
      } catch (error) {
        console.warn(
          "⚠️ Failed to load token metadata for " + tokenMintStr + " during unjoin cleanup:",
          error,
        );
      }
    }

    const dbGame = this.gameDb.getGame(gameAddress);
    const resolvedTickerRaw =
      (dbGame?.token_ticker && dbGame.token_ticker.trim().length > 0
        ? dbGame.token_ticker
        : undefined) ??
      (tokenMintStr && tokenMintStr.toLowerCase() === WSOL_MINT.toLowerCase()
        ? "SOL"
        : DEFAULT_TOKEN_TICKER);
    const tokenTicker = resolvedTickerRaw.toUpperCase();

    const tryGetKeyPair = (telegramId?: string): Keypair | null => {
      if (!telegramId) {
        return null;
      }

      try {
        return this.wallet.getKeyPair(BigInt(telegramId));
      } catch (_) {
        return null;
      }
    };

    const creatorAuthority = tryGetKeyPair(creatorTelegramId);

    for (const player of players) {
      const playerKeypair = tryGetKeyPair(player.telegramId);
      let playerSucceeded = false;

      if (playerKeypair) {
        let canUsePlayer = true;
        if (tokenMintStr) {
          const preparation = await this.ensureUnjoinFeePayerBalance({
            telegramId: player.telegramId,
            tokenMint: tokenMintStr,
            tokenDecimals,
            tokenTicker,
            userKeypair: playerKeypair,
            logContext,
          });

          if (!preparation.success) {
            const fallbackAvailable = !player.isCreator && !!creatorAuthority;
            if (fallbackAvailable) {
              canUsePlayer = false;
            }
            console.warn(
              "⚠️ Player " +
                player.pubkey.toBase58() +
                " lacks SOL for unjoin: " +
                preparation.reason +
                (fallbackAvailable
                  ? " Falling back to creator authority."
                  : " Attempting with remaining balance."),
            );
          }
        }

        if (canUsePlayer) {
          try {
            await this.unjoinPlayerFromGame(
              gamePda,
              playerKeypair,
              player.pubkey,
              player.telegramId,
              { skipDbCheck: true },
            );
            debugLog(
              "➡️ Unjoined " +
                (player.isCreator ? "creator" : "player") +
                " " +
                player.pubkey.toBase58(),
            );
            unjoinedCount++;
            playerSucceeded = true;
          } catch (error) {
            console.error(
              "Failed to unjoin " + player.pubkey.toBase58() + " with player authority:",
              error,
            );
          }
        }
      } else {
        console.error(
          "Failed to unjoin " + player.pubkey.toBase58() + ": missing signing authority",
        );
      }

      if (playerSucceeded) {
        continue;
      }

      if (!player.isCreator && creatorAuthority) {
        if (creatorTelegramId && tokenMintStr) {
          const creatorPrep = await this.ensureUnjoinFeePayerBalance({
            telegramId: creatorTelegramId,
            tokenMint: tokenMintStr,
            tokenDecimals,
            tokenTicker,
            userKeypair: creatorAuthority,
            logContext,
          });

          if (!creatorPrep.success) {
            console.warn(
              "⚠️ Creator fallback lacks SOL for unjoin: " +
                creatorPrep.reason +
                " Attempting with current balance.",
            );
          }
        }

        try {
          await this.unjoinPlayerFromGame(
            gamePda,
            creatorAuthority,
            player.pubkey,
            player.telegramId,
            { skipDbCheck: true },
          );
          debugLog("➡️ Unjoined player " + player.pubkey.toBase58() + " using creator authority");
          unjoinedCount++;
          continue;
        } catch (fallbackError) {
          console.error(
            "Failed to unjoin " + player.pubkey.toBase58() + " using creator authority:",
            fallbackError,
          );
        }
      }
    }

    return unjoinedCount;
  }

  private async cancelGameWithCreator(
    gamePda: PublicKey,
    gameAccount: any,
    creatorTelegramId: string,
    address: string,
    gameType: string,
  ): Promise<boolean> {
    const result = await this.closeGameWithCreatorAuthority({
      gamePda,
      gameAccount,
      creatorTelegramId,
      gameType,
      attemptLog: "🎁 Closing expired " + gameType + " " + address + " with cleanup",
      successPrefix: "✅ Successfully closed expired " + gameType,
      failurePrefix: "❌ Failed to close expired " + gameType,
    });
    return result.success;
  }
}

export const __test_resolveGameMedia = resolveGameMedia;
