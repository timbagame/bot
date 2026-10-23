import { RpcRetryLaterError } from "./rpc-request-budget";
import { mapWithConcurrency } from "./concurrency";
import {
  getCreationRecoveryDelay,
  withCreationRebroadcast,
  parseCreationProofCheckpoint,
} from "./game-creation-recovery";
import { PublicKey, Keypair, Connection, SystemProgram, TransactionInstruction } from "#solana";
import { randomUUID } from "node:crypto";
import {
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "#token";
import { Context } from "grammy";

import { WalletManager } from "./wallet";
import {
  GameDatabase,
  type ChallengedPlayer,
  type PendingGameCreationRecord,
  type PendingGameCreationState,
} from "./game-database";
import { CHALLENGE_JOIN_LABEL } from "./game-challenge";
import { OracleClient, formatOraclePolicyError } from "./oracle";
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
import {
  isMessageMissing,
  isMessageNotModified,
  isMissingEditableContent,
} from "./telegram-errors";
import { isMissingAccountError } from "./account-errors";
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
import type { TimbaProgram } from "./timba-program";
import {
  buildPlayerProfileLink,
  formatPlayerAddress,
  type ParticipantDisplay,
  buildGameStatus,
  buildGameHeader,
  buildPrizeLine,
  buildParticipantsList,
  buildExpirationText,
  buildGameStateUnavailableMessage,
  buildChallengeHeader,
  buildChallengeStatus,
  buildUserMention,
} from "./game-ui";
import {
  sanitizeTelegramDisplayName,
  sanitizeTelegramDisplayNameWithoutMention,
} from "./telegram-display";
import { getUsdPrice, rememberPriceLookup, type CachedPriceLookup } from "./price-service";
import { NetworkDetector } from "./network-detector";
import { SwapManager } from "./swap-manager";
import {
  confirmTransactionWithRecovery,
  getConfirmationRetryDelays,
  type TransactionProbe,
} from "./transaction-runner";
import { createExpiringCache } from "./expiring-cache";
import { refreshDynamicFeeBudgets } from "./fee-budget-refresh";
import { DEFAULT_MAINNET_ENDPOINT, resolvePrimaryRpcEndpoint } from "./rpc-endpoints";
import { contractCapabilities, contractVersion } from "./contract-idl";
import { buildGameFundsContext, type ResolvedContractTokenAccounts } from "./contract-adapter";
import {
  assertIsFullySignedTransaction,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
} from "@solana/kit";
import {
  buildOracleSignableGameTransaction,
  decodeGameTransaction,
  finalizeOracleSignedGameTransaction,
  refreshGameTransaction,
} from "./game-transaction";

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

const GAME_STATE_RECOVERY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

export type ActiveGameListRow = {
  messageText: string;
  keyboard: any[];
  gameAddress: string;
  currentTickets?: number;
  maxTickets?: number;
  minTickets?: number;
};

export type JoinGameResult = {
  success: boolean;
  error?: string;
  isRoll?: boolean;
  /** Game account read right after a successful join, when available. */
  gameAccount?: any;
  ticketsCount?: number;
  maxTickets?: number;
};

type TerminalGameMessageUpdate = {
  status: "Completed";
  winnerAddress?: string;
  totalPot?: number;
  winnerSignature?: string;
};

// Parallel Telegram edits per game update (one per chat that shows the game).
const GAME_MESSAGE_EDIT_CONCURRENCY = 4;

export type GameMessageUpdateOptions = {
  /** Freshly fetched game account; skips the lookup while formatting an active game. */
  gameAccount?: any;
};

export type PublicGamesFilter = {
  gameType?: "coinflip" | "giveaway";
  ticker?: string;
};

type PublicGameEntry = {
  account: any;
  gameData: {
    game_address: string;
    game_type: string;
    amount: number;
    token_mint: string;
    token_ticker: string;
    status: string;
    winner_address: undefined;
  };
};

// Short enough that a newly created game shows up almost immediately, long enough
// that paging through /public does not rescan the whole program.
const PUBLIC_GAMES_CACHE_TTL_MS = 8_000;

type GameMessageUpdateRequest = {
  status: string;
  winnerAddress?: string;
  totalPot?: number;
  winnerSignature?: string;
};

type GameMessageCompletionMetadata = GameMessageUpdateRequest & {
  generation: number;
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

// ================================
// UTILITY FUNCTIONS
// ================================

const DEFAULT_FRIENDLY_ERROR_MESSAGE = "❌ Something went wrong. Please try again in a moment.";
const PENDING_GAME_CREATION_SUBMISSION_LEASE_MS = 120_000;

const isDefinitiveGameCreationFailure = (error: unknown): boolean => {
  const parts: string[] = [];
  const collect = (value: unknown, seen = new Set<unknown>()): void => {
    if (value == null || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (value instanceof Error) parts.push(value.message);
    if (typeof value === "object") {
      const candidate = value as { cause?: unknown; logs?: unknown };
      collect(candidate.cause, seen);
      if (Array.isArray(candidate.logs)) candidate.logs.forEach((log) => collect(log, seen));
    }
  };
  collect(error);
  const message = parts.join(" ").toLowerCase();
  return (
    message.includes("simulation failed") ||
    message.includes("custom program error") ||
    message.includes("insufficient funds") ||
    message.includes("insufficient lamports") ||
    message.includes("invalid transaction") ||
    message.includes("invalid signature") ||
    message.includes("transaction failed") ||
    message.includes("program failed to complete")
  );
};

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
    program: TimbaProgram;
    wallet: WalletManager;
    gameDb: GameDatabase;
  };
  private activeGameMessages = new Map<string, Map<number, GameMessage>>();
  private cachedConnection?: Connection;
  private foregroundCreationGames = new Set<string>();
  private recoveryFlights = new Map<string, Promise<boolean>>();
  private activeCreationRequestKeys = new Set<string>();
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
  private readonly gameMessageUpdateQueues = new Map<string, Promise<void>>();
  private readonly gameMessageUpdateGenerations = new Map<string, number>();
  private readonly latestGameMessageUpdateRequests = new Map<
    string,
    GameMessageUpdateRequest & { generation: number }
  >();
  private readonly gameMessageCompletionMetadata = new Map<string, GameMessageCompletionMetadata>();
  private readonly unavailableStateRecoveryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly gamePriceCache =
    createExpiringCache<CachedPriceLookup>(TOKEN_PRICE_CACHE_TTL_MS);
  private usernameLookupPromises = new Map<string, Promise<string | null>>();
  private publicGamesCache: { entries: PublicGameEntry[]; expiresAt: number } | null = null;
  private publicGamesInFlight: Promise<PublicGameEntry[]> | null = null;
  private gameMessageReadyListener?: (gameAddress: string) => void;

  private constructor(
    private program: TimbaProgram,
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
    program: TimbaProgram,
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
    GameManager.instance?.clearUnavailableStateRecoveryTimers();
    GameManager.instance?.latestGameMessageUpdateRequests.clear();
    GameManager.instance?.gameMessageCompletionMetadata.clear();
    GameManager.instance = undefined as any;
    GameManager.instanceDeps = undefined;
  }

  public setGameMessageReadyListener(listener: ((gameAddress: string) => void) | undefined): void {
    this.gameMessageReadyListener = listener ?? undefined;
  }

  private clearUnavailableStateRecoveryTimers(): void {
    for (const timer of this.unavailableStateRecoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.unavailableStateRecoveryTimers.clear();
  }

  private enqueueGameMessageUpdate(
    gameAddress: string,
    update: () => Promise<void>,
  ): Promise<void> {
    const previous = this.gameMessageUpdateQueues.get(gameAddress) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await update();
      });
    this.gameMessageUpdateQueues.set(gameAddress, next);
    void next.then(
      () => {
        if (this.gameMessageUpdateQueues.get(gameAddress) === next) {
          this.gameMessageUpdateQueues.delete(gameAddress);
        }
      },
      () => {
        if (this.gameMessageUpdateQueues.get(gameAddress) === next) {
          this.gameMessageUpdateQueues.delete(gameAddress);
        }
      },
    );
    return next;
  }

  private nextGameMessageUpdateGeneration(gameAddress: string): number {
    const next = (this.gameMessageUpdateGenerations.get(gameAddress) ?? 0) + 1;
    this.gameMessageUpdateGenerations.set(gameAddress, next);
    return next;
  }

  private rememberGameMessageUpdateRequest(
    gameAddress: string,
    generation: number,
    request: GameMessageUpdateRequest,
  ): void {
    const current = this.latestGameMessageUpdateRequests.get(gameAddress);
    if (!current || generation >= current.generation) {
      this.latestGameMessageUpdateRequests.set(gameAddress, { ...request, generation });
    }

    if (request.status.toLowerCase() !== "completed") {
      return;
    }

    const currentCompletion = this.gameMessageCompletionMetadata.get(gameAddress);
    if (!currentCompletion || generation >= currentCompletion.generation) {
      const merged: GameMessageCompletionMetadata = {
        status: request.status,
        generation,
      };
      if (currentCompletion?.winnerAddress !== undefined) {
        merged.winnerAddress = currentCompletion.winnerAddress;
      }
      if (currentCompletion?.totalPot !== undefined) {
        merged.totalPot = currentCompletion.totalPot;
      }
      if (currentCompletion?.winnerSignature !== undefined) {
        merged.winnerSignature = currentCompletion.winnerSignature;
      }
      if (request.winnerAddress !== undefined) {
        merged.winnerAddress = request.winnerAddress;
      }
      if (request.totalPot !== undefined) {
        merged.totalPot = request.totalPot;
      }
      if (request.winnerSignature !== undefined) {
        merged.winnerSignature = request.winnerSignature;
      }
      this.gameMessageCompletionMetadata.set(gameAddress, merged);
      return;
    }

    // An older completion may still carry the only rich field (for example, a
    // signature) when a newer refresh request was already registered. Preserve
    // missing fields without allowing the older request to overwrite newer data.
    const enriched = { ...currentCompletion };
    if (enriched.winnerAddress === undefined && request.winnerAddress !== undefined) {
      enriched.winnerAddress = request.winnerAddress;
    }
    if (enriched.totalPot === undefined && request.totalPot !== undefined) {
      enriched.totalPot = request.totalPot;
    }
    if (enriched.winnerSignature === undefined && request.winnerSignature !== undefined) {
      enriched.winnerSignature = request.winnerSignature;
    }
    this.gameMessageCompletionMetadata.set(gameAddress, enriched);
  }

  private persistCompletionSignature(
    gameAddress: string,
    generation: number,
    request: GameMessageUpdateRequest,
  ): void {
    const winnerSignature = request.winnerSignature;
    if (!winnerSignature) {
      return;
    }

    const latestRequest = this.latestGameMessageUpdateRequests.get(gameAddress);
    if (
      latestRequest &&
      latestRequest.generation > generation &&
      latestRequest.winnerSignature !== undefined &&
      latestRequest.winnerSignature !== winnerSignature
    ) {
      return;
    }

    const completionMetadata = this.gameMessageCompletionMetadata.get(gameAddress);
    if (
      completionMetadata &&
      completionMetadata.generation > generation &&
      completionMetadata.winnerSignature !== undefined &&
      completionMetadata.winnerSignature !== winnerSignature
    ) {
      return;
    }

    const recordGameCompletionFinance = (this.gameDb as any)?.recordGameCompletionFinance;
    if (typeof recordGameCompletionFinance !== "function") {
      return;
    }

    try {
      const currentGame = (this.gameDb as any)?.getGame?.(gameAddress);
      if (
        currentGame?.completion_signature &&
        currentGame.completion_signature !== winnerSignature
      ) {
        return;
      }
      recordGameCompletionFinance.call(this.gameDb, gameAddress, { signature: winnerSignature });
    } catch (error) {
      console.warn(`Failed to persist completion signature for ${gameAddress}:`, error);
    }
  }

  private isSupersededActiveGameMessageUpdate(
    gameAddress: string,
    request: GameMessageUpdateRequest,
    updateGeneration?: number,
  ): boolean {
    if (updateGeneration === undefined) {
      return false;
    }

    const latestGeneration = this.gameMessageUpdateGenerations.get(gameAddress) ?? updateGeneration;
    if (updateGeneration >= latestGeneration) {
      return false;
    }

    // Request intent must survive DB terminal-state conversion. An older Active
    // refresh is stale even if the database now says Completed.
    if (request.status.toLowerCase() !== "completed") {
      return true;
    }

    const latestRequest = this.latestGameMessageUpdateRequests.get(gameAddress);
    if (!latestRequest || latestRequest.generation <= updateGeneration) {
      return false;
    }

    // Do not let an older, less informative terminal update erase a newer
    // completion's prize, winner, or verification signature. A richer older
    // completion remains eligible to fill fields missing from a newer refresh.
    if (
      latestRequest.status.toLowerCase() === "completed" &&
      ((latestRequest.winnerAddress !== undefined &&
        request.winnerAddress !== latestRequest.winnerAddress) ||
        (latestRequest.totalPot !== undefined && request.totalPot !== latestRequest.totalPot) ||
        (latestRequest.winnerSignature !== undefined &&
          request.winnerSignature !== latestRequest.winnerSignature))
    ) {
      return true;
    }

    return false;
  }

  private getPersistedTerminalUpdate(
    gameAddress: string,
    requestedStatus: string,
    winnerAddress?: string,
    totalPot?: number,
    winnerSignature?: string,
  ): {
    status: "Completed";
    winnerAddress?: string;
    totalPot?: number;
    winnerSignature?: string;
  } | null {
    let gameData: any;
    try {
      gameData = this.gameDb.getGame(gameAddress);
    } catch {
      return null;
    }

    const persistedStatus = String(gameData?.status ?? "active").toLowerCase();
    const isTerminal = persistedStatus === "completed" || !!gameData?.winner_address;
    if (!isTerminal && requestedStatus.toLowerCase() !== "completed") {
      return null;
    }

    const completionMetadata = this.gameMessageCompletionMetadata.get(gameAddress);
    const persistedTotalPot =
      isTerminal && typeof gameData?.total_amount === "number" ? gameData.total_amount : undefined;

    return {
      status: "Completed",
      winnerAddress: gameData?.winner_address ?? completionMetadata?.winnerAddress ?? winnerAddress,
      totalPot: persistedTotalPot ?? completionMetadata?.totalPot ?? totalPot,
      winnerSignature:
        gameData?.completion_signature ?? completionMetadata?.winnerSignature ?? winnerSignature,
    };
  }

  private async fetchGameAccountForRecovery(gameAddress: string): Promise<any | null> {
    const gamePda = new PublicKey(gameAddress);
    const accountApi = this.program.account.game as any;
    if (typeof accountApi.fetchNullable === "function") {
      return (await accountApi.fetchNullable(gamePda)) ?? null;
    }

    try {
      return await accountApi.fetch(gamePda);
    } catch (error) {
      if (isMissingAccountError(error)) {
        return null;
      }
      throw error;
    }
  }

  private scheduleUnavailableStateRecovery(
    ctx: Context,
    gameAddress: string,
    gameType: string,
    attempt: number = 0,
  ): void {
    const chatId = ctx.chat?.id;
    const delayMs = GAME_STATE_RECOVERY_DELAYS_MS[attempt];
    if (typeof chatId !== "number" || delayMs === undefined) {
      return;
    }

    const recoveryKey = `${gameAddress}:${chatId}`;
    if (this.unavailableStateRecoveryTimers.has(recoveryKey)) {
      return;
    }

    const timer = setTimeout(async () => {
      this.unavailableStateRecoveryTimers.delete(recoveryKey);

      const getGame = (this.gameDb as any)?.getGame;
      if (typeof getGame !== "function") {
        return;
      }

      let gameData: any;
      try {
        gameData = getGame.call(this.gameDb, gameAddress);
      } catch {
        return;
      }
      if (!gameData) {
        return;
      }

      try {
        await this.fetchGameAccountForRecovery(gameAddress);
        await this.updateGameMessageFromData(ctx, gameAddress, "Active");
      } catch (error) {
        console.warn(`Game state recovery attempt failed for ${gameAddress}:`, error);
        this.scheduleUnavailableStateRecovery(ctx, gameAddress, gameType, attempt + 1);
        return;
      }

      let persisted: any;
      try {
        persisted = getGame.call(this.gameDb, gameAddress);
      } catch {
        return;
      }
      const persistedStatus = String(persisted?.status ?? "active").toLowerCase();
      if (persistedStatus !== "completed" && !persisted?.winner_address) {
        this.scheduleUnavailableStateRecovery(ctx, gameAddress, gameType, attempt + 1);
      }
    }, delayMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.unavailableStateRecoveryTimers.set(recoveryKey, timer);
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

  private evictTelegramUsernameCache(telegramId: string, keepUsername?: string): void {
    for (const key of [...this.usernameToIdCacheKeys]) {
      if (key !== keepUsername && this.normalizedUsernameToIdCache.get(key) === telegramId) {
        this.normalizedUsernameToIdCache.delete(key);
        this.removeUsernameToIdCacheKey(key);
      }
    }
  }

  public clearTelegramUsernames(telegramId: string): void {
    this.gameDb.deleteUsernameMappingsForTelegramId(telegramId);
    this.evictTelegramUsernameCache(telegramId);
    this.usernameHints.delete(telegramId);
  }

  public invalidateUsernameMapping(username: string, telegramId: string): void {
    const normalized = this.normalizeUsernameForLookup(username);
    if (!normalized) return;
    this.gameDb.deleteUsernameMapping(normalized, telegramId);
    if (this.normalizedUsernameToIdCache.get(normalized) === telegramId) {
      this.normalizedUsernameToIdCache.delete(normalized);
      this.removeUsernameToIdCacheKey(normalized);
    }
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

  /**
   * Only a handle Telegram reported as the account's own username may claim a
   * name in the lookup; anything else (full names, typed words) is display only.
   */
  private rememberTelegramUsername(telegramId: string, username: string, isHandle = false): void {
    const trimmedId = telegramId.trim();
    const trimmedUsername = username.trim();
    if (!/^\d+$/.test(trimmedId) || trimmedUsername.length === 0) {
      return;
    }

    if (!isHandle) {
      this.usernameHints.set(trimmedId, trimmedUsername);
      return;
    }

    const normalized = this.normalizeUsernameForLookup(trimmedUsername);
    if (!normalized) {
      return;
    }

    // This runs on every update from a user with a username; skip the SQLite
    // write when this process already stored the same mapping in both directions.
    const alreadyStored =
      this.usernameHints.get(trimmedId) === trimmedUsername &&
      this.normalizedUsernameToIdCache.get(normalized) === trimmedId;
    if (alreadyStored) {
      return;
    }
    this.gameDb.saveUsernameMapping(normalized, trimmedId, trimmedUsername);
    this.evictTelegramUsernameCache(trimmedId, normalized);
    this.cacheTelegramIdForUsername(trimmedId, trimmedUsername);
    this.usernameHints.set(trimmedId, trimmedUsername);
  }

  /** `isHandle` says Telegram reported `username` as this account's own @username. */
  public primeUsernameCache(
    ctx: Context,
    telegramId: string,
    username: string | null,
    isHandle = false,
  ): void {
    if (!username) {
      return;
    }

    const trimmedId = telegramId.trim();
    const trimmedUsername = username.trim();
    if (!/^\d+$/.test(trimmedId) || trimmedUsername.length === 0) {
      return;
    }

    this.rememberTelegramUsername(trimmedId, trimmedUsername, isHandle);
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
      // Called when a replacement was sent but could be neither persisted nor
      // retired, so it may still show live controls.
      onStrandedReplacement?: () => void;
    },
  ): Promise<boolean> {
    const fallbackChatId =
      options.chatId ?? ctx.chat?.id ?? this.gameDb.getGame(gameAddress)?.chat_id ?? null;

    if (typeof fallbackChatId !== "number" || Number.isNaN(fallbackChatId)) {
      console.warn(`Unable to recreate Telegram message for ${gameAddress}: missing chat id`);
      return false;
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

      try {
        this.gameDb.saveGameMessage(gameAddress, sentMessage.message_id, sentMessage.chat.id);
      } catch (persistError) {
        // The caller keeps the old message ID and retries, so an unpersisted
        // replacement must not stay visible or every retry adds another card.
        const retired = await this.retireUnpersistedGameMessage(
          ctx,
          sentMessage.chat.id,
          sentMessage.message_id,
        );
        if (!retired) options.onStrandedReplacement?.();
        throw persistError;
      }

      const existing = this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
      existing.set(sentMessage.chat.id, {
        messageId: sentMessage.message_id,
        chatId: sentMessage.chat.id,
        usesVideo,
      });
      this.activeGameMessages.set(gameAddress, existing);

      this.gameMessageReadyListener?.(gameAddress);
      return true;
    } catch (sendError) {
      console.error(`Failed to recreate Telegram message for game ${gameAddress}:`, sendError);
      return false;
    }
  }

  private async retireUnpersistedGameMessage(
    ctx: Context,
    chatId: number,
    messageId: number,
  ): Promise<boolean> {
    try {
      await ctx.api.deleteMessage(chatId, messageId);
      return true;
    } catch (deleteError) {
      if (isMessageMissing(deleteError)) return true;
      console.warn(
        `Failed to delete unpersisted game message ${chatId}:${messageId}:`,
        deleteError,
      );
    }
    try {
      await ctx.api.editMessageReplyMarkup(chatId, messageId, {
        reply_markup: { inline_keyboard: [] },
      });
      return true;
    } catch (retireError) {
      // Gone or already without buttons: nothing live remains.
      if (isMessageMissing(retireError) || isMessageNotModified(retireError)) return true;
      console.warn(
        `Failed to retire unpersisted game message ${chatId}:${messageId}:`,
        retireError,
      );
    }
    return false;
  }

  private getOraclePda(): Promise<PublicKey> {
    return PDAManager.getOraclePDA(this.program.programId);
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

  private async resolveGameVaultAccounts(
    tokenMint: PublicKey,
  ): Promise<ResolvedContractTokenAccounts> {
    const tokenProgram = await this.resolveTokenProgramId(tokenMint);
    const gameToken = await PDAManager.getGameTokenPDA(tokenMint, this.program.programId);
    const gameVault = await PDAManager.getGameVaultPDA(tokenMint, this.program.programId);
    const gameVaultTokenAccount = await this.deriveAta(tokenMint, gameVault, tokenProgram, true);

    return {
      tokenProgram,
      gameToken,
      gameVault,
      gameVaultTokenAccount,
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
    const tokenAccounts = await this.resolveGameVaultAccounts(tokenMint);
    const gameFundsContext = buildGameFundsContext(contractVersion, tokenMint, tokenAccounts);
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
      ...gameFundsContext,
      playerTokenAccount,
      oracle: await this.getOraclePda(),
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
    const tokenAccounts = await this.resolveGameVaultAccounts(tokenMint);
    const gameFundsContext = buildGameFundsContext(contractVersion, tokenMint, tokenAccounts);
    const creatorPubkey = new PublicKey(gameAccount.creator);
    const creatorTokenAccount = await this.deriveAta(
      tokenMint,
      creatorPubkey,
      tokenAccounts.tokenProgram,
    );

    return {
      game: gamePda,
      creator: creatorPubkey,
      oracle: await this.getOraclePda(),
      ...gameFundsContext,
      creatorTokenAccount,
      ...(contractCapabilities.gameTokenAccount ? { systemProgram: SystemProgram.programId } : {}),
    };
  }

  // ================================
  // PLAYER UTILITIES
  // ================================

  /**
   * Whether the database already holds a confirmed join for this player. Only a
   * shortcut: an unknown or failed lookup answers false.
   */
  private isConfirmedParticipant(gameAddress: string, telegramId: bigint): boolean {
    try {
      return (this.gameDb as any).isGameParticipant?.(gameAddress, telegramId.toString()) === true;
    } catch (error) {
      console.warn(`⚠️ Failed to check local participant records for ${gameAddress}:`, error);
      return false;
    }
  }

  /**
   * The message for a token balance that cannot cover the stake, or null when it can.
   */
  private describeStakeShortfall(
    tokenBalance: number,
    gameAmount: number,
    decimals: number,
    tokenTicker: string,
  ): string | null {
    if (tokenBalance >= gameAmount) {
      return null;
    }

    const formattedBalance = this.wallet.formatTokenBalance(tokenBalance, decimals);
    const formattedNeed = this.wallet.formatTokenBalance(gameAmount, decimals);
    const safeTicker = escapeHtml(tokenTicker);

    // Check if user has no token account at all (balance = 0)
    if (tokenBalance === 0) {
      return `❌ You don't have any ${safeTicker} tokens. You need ${formattedNeed} ${safeTicker} to join this game. Use /balance to check your address and transfer tokens.`;
    }

    return `❌ Not enough ${safeTicker}. You have ${formattedBalance} but need ${formattedNeed}. Add more ${safeTicker} or reduce the amount and try again.`;
  }

  /**
   * Check if a player is in a game via database records, then the on-chain
   * participant list. Pass an already-fetched game account to skip the lookup.
   */
  private async isPlayerInGame(
    gamePda: PublicKey,
    playerPubkey: PublicKey,
    knownGameAccount?: any,
  ): Promise<boolean> {
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
      let gameAccount = knownGameAccount;
      if (gameAccount === undefined) {
        const accountInterface = this.program.account.game as any;
        const fetchNullable = accountInterface?.fetchNullable?.bind(accountInterface);
        gameAccount = fetchNullable
          ? await fetchNullable(gamePda)
          : await accountInterface.fetch(gamePda);
      }

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

  private async isGameAccountClosed(gamePda: PublicKey): Promise<boolean> {
    try {
      const accountInterface = this.program.account.game as any;
      if (typeof accountInterface?.fetchNullable !== "function") return false;
      return (await accountInterface.fetchNullable(gamePda)) === null;
    } catch {
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
      // A confirmed join that took the last seat lets the Oracle settle and close
      // the game before this read, so a closed account means the join landed.
      if (isOnChain || (options.joinSignature && (await this.isGameAccountClosed(gamePda)))) {
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
          return [String(new PublicKey(participant).toBase58())];
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
        unmatchedParticipants.delete(String(new PublicKey(publicKey).toBase58()));
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

      if (unmatchedParticipants.has(String(identifier))) {
        recovered.push({ telegramId, publicKey });
        unmatchedParticipants.delete(String(identifier));
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
        priorityFee: true,
      });
    }

    const signature = await this.wallet.sendTransaction(instructions, signers, {
      priorityFee: true,
    });
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
      const rent = Number(
        await this.getConnection().getMinimumBalanceForRentExemption(accountSize),
      );
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
          reason:
            swapResult.userMessage ??
            `Unable to swap ${tokenTicker.toUpperCase()} for SOL fees. Add SOL manually and try again.`,
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
            if (!handle) this.clearTelegramUsernames(trimmedId);
            const firstName =
              typeof userRecord.first_name === "string" ? userRecord.first_name.trim() : "";
            const lastName =
              typeof userRecord.last_name === "string" ? userRecord.last_name.trim() : "";
            const fullName = [firstName, lastName].filter((name) => name.length > 0).join(" ");
            const resolved = handle || (fullName.length > 0 ? fullName : null);
            if (resolved) {
              this.rememberTelegramUsername(trimmedId, resolved, handle !== null);
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
    providedGameAccount?: any,
  ) {
    const baseAmountLamports = coerceLamportValue(amountLamportsInput) ?? 0n;
    const providedTotalPot =
      providedTotalPotInput !== undefined ? coerceLamportValue(providedTotalPotInput) : null;

    try {
      const gameAccount =
        providedGameAccount ??
        (this.program.account.game.fetchNullable
          ? await this.program.account.game.fetchNullable(gamePda)
          : await this.program.account.game.fetch(gamePda));
      if (!gameAccount) {
        return {
          currentTickets: 0,
          maxTickets: 0,
          minTickets: 0,
          totalPot: baseAmountLamports,
          expirationInfo: "",
          tokenMint: undefined,
          participantAddresses: [],
          stateUnavailable: true,
        };
      }
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
        stateUnavailable: true,
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

  private generateGameKeyboard(status: string, gamePda: PublicKey, isChallenge = false) {
    if (status.toLowerCase() === "completed") return [];

    const keyboard = [
      [
        {
          text: isChallenge ? CHALLENGE_JOIN_LABEL : "🎮 Join",
          callback_data: `join_${gamePda.toBase58()}`,
        },
        { text: "🔁 Refresh", callback_data: `refresh_${gamePda.toBase58()}` },
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
    const stateUnavailable = formatted.stateUnavailable === true || formatted.skipUpdate === true;
    const messageText =
      typeof formatted.messageText === "string" && formatted.messageText.trim().length > 0
        ? formatted.messageText
        : buildGameStateUnavailableMessage(gameAddress, gameType);
    const keyboard =
      Array.isArray(formatted.keyboard) && formatted.keyboard.length > 0
        ? formatted.keyboard
        : stateUnavailable
          ? [[{ text: "🔁 Refresh", callback_data: `refresh_${gameAddress}` }]]
          : [];
    const replyMarkup = { inline_keyboard: keyboard };
    let message: any;
    let usesVideo = false;

    const sendText = async () =>
      ctx.reply(messageText, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });

    if (media) {
      try {
        if (media.mediaType === "photo") {
          message = await ctx.replyWithPhoto(media.fileId, {
            caption: messageText,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          });
        } else if (media.mediaType === "animation") {
          message = await ctx.replyWithAnimation(media.fileId, {
            caption: messageText,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          });
        } else {
          message = await ctx.replyWithVideo(media.fileId, {
            caption: messageText,
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
    if (stateUnavailable) {
      this.scheduleUnavailableStateRecovery(ctx, gameAddress, gameType);
    }

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
      gameAccount?: any;
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
      : await this.getActiveGameStats(
          gamePda,
          amountLamports,
          coerceProvidedTotal ?? undefined,
          options?.gameAccount,
        );

    const { currentTickets, maxTickets, minTickets, totalPot, expirationInfo, stateUnavailable } =
      gameStats as any;
    if (!isCompleted && stateUnavailable) {
      return {
        messageText: buildGameStateUnavailableMessage(gameCacheKey, gameType),
        keyboard: [[{ text: "🔁 Refresh", callback_data: `refresh_${gameCacheKey}` }]],
        skipUpdate: true,
        stateUnavailable: true,
      };
    }
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
    const challenge = this.readGameChallenge(gameCacheKey);
    // A drawn winner means everyone played, even if the local player list lags;
    // a challenge that expired short of them has neither, so it never reads as a match.
    const hasWinner =
      !!winnerAddress && winnerAddress !== "cancelled" && winnerAddress !== DEFAULT_NULL_ADDRESS;
    const challengeAccepted = hasWinner || currentTickets >= challenge.length + 1;
    const header =
      challenge.length > 0
        ? buildChallengeHeader(
            formattedTicketAmount,
            tokenTicker,
            safeCreatorUsername,
            challenge.map((player) =>
              suppressMentions
                ? escapeHtml(sanitizeDisplay(player.displayName))
                : buildUserMention(player.telegramId, sanitizeDisplay(player.displayName)),
            ),
            challengeAccepted,
            usdApproximation?.text,
            explorerUrl,
            creatorWalletAddress,
          )
        : buildGameHeader(
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
    // A challenge header already names every player.
    if (currentTickets > 0 && challenge.length === 0) {
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

    const statusText =
      (challenge.length > 0
        ? this.challengeStatus(
            challenge,
            challengeAccepted,
            currentTickets,
            participantAddresses ?? [],
          )
        : null) ?? buildGameStatus(currentTickets, minTickets, maxTickets);
    const statusSection = !isCompleted ? `\nStatus: ${statusText}${expirationInfo}` : "";

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

    const keyboard = this.generateGameKeyboard(status, gamePda, challenge.length > 0);

    return { messageText, keyboard };
  }

  /**
   * A card that cannot read its challenge renders as a regular coinflip; the
   * join authorization still reads the challenge and fails closed.
   */
  private readGameChallenge(gameAddress: string): ChallengedPlayer[] {
    try {
      return (this.gameDb as any).getGameChallenge?.(gameAddress) ?? [];
    } catch (error) {
      console.warn(`Failed to read challenge for ${gameAddress}:`, error);
      return [];
    }
  }

  /**
   * The status of a challenge card, or null when who is still missing cannot be
   * told and the count is what is still true. A coinflip's creator joins in the
   * transaction that creates it, so until a second ticket every challenged player
   * is missing. Past that, they are named only when the ones left add up to the
   * seats left, so a player list that lags or a wallet the bot cannot place never
   * names someone who already joined.
   */
  private challengeStatus(
    challenge: ChallengedPlayer[],
    accepted: boolean,
    currentTickets: number,
    participantAddresses: string[],
  ): string | null {
    const named = (players: ChallengedPlayer[]) =>
      buildChallengeStatus(
        accepted,
        players.map((player) =>
          escapeHtml(sanitizeTelegramDisplayNameWithoutMention(player.displayName)),
        ),
      );
    if (accepted || currentTickets <= 1) {
      return named(challenge);
    }
    let waiting: ChallengedPlayer[];
    try {
      const joined = new Set(
        participantAddresses
          .slice(0, currentTickets)
          .map((address) => this.gameDb.getPlayerTelegramId(address)),
      );
      waiting = challenge.filter((player) => !joined.has(player.telegramId));
    } catch (error) {
      console.warn("Failed to read who accepted a challenge:", error);
      return null;
    }
    return waiting.length === challenge.length + 1 - currentTickets ? named(waiting) : null;
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
    skipUpdate?: boolean;
    stateUnavailable?: boolean;
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
    const isUnavailable =
      formatResult.stateUnavailable === true || formatResult.skipUpdate === true;
    const text =
      typeof formatResult.messageText === "string" && formatResult.messageText.trim().length > 0
        ? formatResult.messageText
        : buildGameStateUnavailableMessage(params.gameAddress, params.gameType);
    const keyboard =
      Array.isArray(formatResult.keyboard) && formatResult.keyboard.length > 0
        ? formatResult.keyboard
        : isUnavailable
          ? [[{ text: "🔁 Refresh", callback_data: `refresh_${params.gameAddress}` }]]
          : [];

    return {
      text,
      keyboard,
      media,
      skipUpdate: formatResult.skipUpdate,
      stateUnavailable: formatResult.stateUnavailable,
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
    options?: {
      priceHint?: CachedPriceLookup | null;
      reserveDelivery?: boolean;
      winnerAddress?: string;
      totalPot?: number;
    },
  ): Promise<number> {
    const deliveryChatId = ctx.chat?.id;
    let deliveryReserved = false;
    let messageSent = false;
    try {
      if (options?.reserveDelivery && typeof deliveryChatId === "number") {
        const reservation = this.gameDb.reserveGameMessageDelivery(gameAddress, deliveryChatId);
        if (!reservation.acquired) {
          return reservation.messageId ?? 0;
        }
        deliveryReserved = true;
      }

      const cachedPrice = options?.priceHint ?? this.gamePriceCache.get(gameAddress) ?? null;
      const payload = await this.buildGameMessagePayload(ctx, {
        gameAddress,
        gameType,
        amount,
        creatorUsername,
        status,
        tokenTicker,
        winnerAddress: options?.winnerAddress,
        totalPot: options?.totalPot,
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
      messageSent = true;

      const message: any = sendResult.result;
      const usesVideo = sendResult.usedVideo;

      if (deliveryReserved && typeof deliveryChatId === "number") {
        this.gameDb.completeGameMessageDelivery(gameAddress, deliveryChatId, message.message_id);
      } else {
        this.gameDb.saveGameMessage(gameAddress, message.message_id, message.chat.id);
      }

      const existing = this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
      existing.set(message.chat.id, {
        messageId: message.message_id,
        chatId: message.chat.id,
        usesVideo,
      });
      this.activeGameMessages.set(gameAddress, existing);

      this.gameMessageReadyListener?.(gameAddress);
      if (payload.stateUnavailable === true || payload.skipUpdate === true) {
        this.scheduleUnavailableStateRecovery(ctx, gameAddress, gameType);
      }

      return message.message_id;
    } catch (error) {
      if (deliveryReserved && !messageSent && typeof deliveryChatId === "number") {
        this.gameDb.releaseGameMessageDelivery(gameAddress, deliveryChatId);
      }
      throw error;
    }
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
    updateGeneration?: number,
    updateRequest?: GameMessageUpdateRequest,
    updateOptions?: GameMessageUpdateOptions,
  ): Promise<void> {
    const generation = updateGeneration ?? this.nextGameMessageUpdateGeneration(gameAddress);
    const latestGeneration = this.gameMessageUpdateGenerations.get(gameAddress) ?? 0;
    if (generation > latestGeneration) {
      this.gameMessageUpdateGenerations.set(gameAddress, generation);
    }

    const request = updateRequest ?? {
      status,
      winnerAddress,
      totalPot,
      winnerSignature,
    };
    this.rememberGameMessageUpdateRequest(gameAddress, generation, request);
    if (request.status.toLowerCase() === "completed") {
      this.persistCompletionSignature(gameAddress, generation, request);
    }

    await this.enqueueGameMessageUpdate(gameAddress, () =>
      this.updateGameMessageInternal(
        ctx,
        gameAddress,
        gameType,
        amount,
        creatorUsername,
        status,
        tokenTicker,
        winnerAddress,
        totalPot,
        winnerSignature,
        generation,
        request,
        updateOptions,
      ),
    );
  }

  private async updateGameMessageInternal(
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
    updateGeneration?: number,
    updateRequest?: GameMessageUpdateRequest,
    updateOptions?: GameMessageUpdateOptions,
  ): Promise<void> {
    const request = updateRequest ?? {
      status,
      winnerAddress,
      totalPot,
      winnerSignature,
    };
    if (this.isSupersededActiveGameMessageUpdate(gameAddress, request, updateGeneration)) {
      return;
    }

    const persistedTerminal = this.getPersistedTerminalUpdate(
      gameAddress,
      status,
      winnerAddress,
      totalPot,
      winnerSignature,
    );
    if (persistedTerminal) {
      status = persistedTerminal.status;
      winnerAddress = persistedTerminal.winnerAddress;
      totalPot = persistedTerminal.totalPot;
      winnerSignature = persistedTerminal.winnerSignature;
    }

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
        { priceHint, gameAccount: updateOptions?.gameAccount },
      );

      const terminalBeforeDispatch = this.getPersistedTerminalUpdate(
        gameAddress,
        status,
        winnerAddress,
        totalPot,
        winnerSignature,
      );
      if (terminalBeforeDispatch && status.toLowerCase() !== "completed") {
        await this.updateGameMessageInternal(
          ctx,
          gameAddress,
          gameType,
          amount,
          creatorUsername,
          terminalBeforeDispatch.status,
          tokenTicker,
          terminalBeforeDispatch.winnerAddress,
          terminalBeforeDispatch.totalPot,
          terminalBeforeDispatch.winnerSignature,
          updateGeneration,
          request,
        );
        return;
      }

      if (this.isSupersededActiveGameMessageUpdate(gameAddress, request, updateGeneration)) {
        return;
      }

      if (formatted.skipUpdate) {
        return;
      }
      messageTextValue = formatted.messageText;

      const inlineKeyboard =
        formatted.keyboard.length > 0 ? { inline_keyboard: formatted.keyboard } : undefined;
      inlineKeyboardValue = inlineKeyboard;
      const lowerStatus = status.toLowerCase();

      // Edit every chat's copy in parallel (bounded) instead of one after another.
      // A terminal update or a newer generation found mid-way stops the remaining
      // edits; the terminal redraw then runs once for all chats.
      let terminalRedirect: TerminalGameMessageUpdate | null = null;
      let superseded = false;
      const updateTarget = async (gameMessage: GameMessage): Promise<void> => {
        if (terminalRedirect || superseded) {
          return;
        }
        const latestTerminal = this.getPersistedTerminalUpdate(
          gameAddress,
          status,
          winnerAddress,
          totalPot,
          winnerSignature,
        );
        if (latestTerminal && status.toLowerCase() !== "completed") {
          terminalRedirect ??= latestTerminal;
          return;
        }

        if (this.isSupersededActiveGameMessageUpdate(gameAddress, request, updateGeneration)) {
          superseded = true;
          return;
        }

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
        const terminalAfterPayload = this.getPersistedTerminalUpdate(
          gameAddress,
          status,
          winnerAddress,
          totalPot,
          winnerSignature,
        );
        if (terminalAfterPayload && status.toLowerCase() !== "completed") {
          terminalRedirect ??= terminalAfterPayload;
          return;
        }

        if (this.isSupersededActiveGameMessageUpdate(gameAddress, request, updateGeneration)) {
          superseded = true;
          return;
        }
        const winnerMedia = payload.media;
        try {
          const supportsVideo = gameMessage.usesVideo !== false;

          const editAsText = () =>
            ctx.api.editMessageText(gameMessage.chatId, gameMessage.messageId, payload.text, {
              parse_mode: "HTML",
              reply_markup: inlineKeyboard,
            });

          let fallbackUsesVideo = false;
          const recoverMediaAsText = async (
            textError: unknown,
            tryCaption = false,
          ): Promise<null> => {
            if (!isMessageMissing(textError) && !isMissingEditableContent(textError))
              throw textError;
            if (tryCaption) {
              try {
                await ctx.api.editMessageCaption(gameMessage.chatId, gameMessage.messageId, {
                  caption: payload.text,
                  parse_mode: "HTML",
                  reply_markup: inlineKeyboard,
                });
                fallbackUsesVideo = true;
                return null;
              } catch (captionError) {
                if (isMessageNotModified(captionError)) {
                  fallbackUsesVideo = true;
                  return null;
                }
                if (!isRecoverableMediaError(captionError)) throw captionError;
              }
            }
            // Retire the old keyboard before publishing a second card. If Telegram
            // cannot do that, retain this message for retry instead of abandoning it.
            let retired = false;
            try {
              await ctx.api.editMessageReplyMarkup(gameMessage.chatId, gameMessage.messageId, {
                reply_markup: { inline_keyboard: [] },
              });
              retired = true;
            } catch (retireError) {
              // An earlier attempt may already have cleared this keyboard.
              if (isMessageNotModified(retireError)) retired = true;
              else if (!isMessageMissing(retireError)) throw retireError;
            }
            // Telegram cannot convert a media message into text with an edit.
            // Persist the replacement ID before marking this chat's copy as text.
            let replacementStranded = false;
            const recreated = await this.recreateMissingGameMessage(ctx, gameAddress, {
              chatId: gameMessage.chatId,
              messageText: payload.text,
              inlineKeyboard,
              onStrandedReplacement: () => {
                replacementStranded = true;
              },
            });
            if (!recreated) {
              // The original card is still the tracked one, so give its
              // controls back rather than leaving the game without buttons,
              // unless a replacement with live controls could not be retired.
              if (retired && inlineKeyboard && !replacementStranded) {
                try {
                  await ctx.api.editMessageReplyMarkup(gameMessage.chatId, gameMessage.messageId, {
                    reply_markup: inlineKeyboard,
                  });
                } catch (restoreError) {
                  console.warn(
                    `Failed to restore game keyboard ${gameMessage.chatId}:${gameMessage.messageId}:`,
                    restoreError,
                  );
                }
              }
              throw textError;
            }
            return null;
          };

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
                      return recoverMediaAsText(textError, true);
                    }
                  },
                  logLabel: `game media update (${gameMessage.chatId})`,
                  onFallback: () => {
                    const current =
                      this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
                    current.set(gameMessage.chatId, {
                      ...(current.get(gameMessage.chatId) ?? gameMessage),
                      usesVideo: fallbackUsesVideo,
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
                return;
              }

              const { usedFallback, skipped } = queuedEditResult.result;

              if (skipped) {
                return;
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

              return;
            } catch (mediaError) {
              // If we get here, something unexpected happened
              const recreated = await recreateMissingMessage(mediaError);
              if (!recreated) {
                console.warn(
                  `Unexpected error in media edit path for game ${gameAddress} chat ${gameMessage.chatId}:`,
                  mediaError,
                );
              }
              return;
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
                    return recoverMediaAsText(textError);
                  }
                },
                logLabel: `game caption update (${gameMessage.chatId})`,
                onFallback: () => {
                  const current =
                    this.activeGameMessages.get(gameAddress) ?? new Map<number, GameMessage>();
                  current.set(gameMessage.chatId, {
                    ...(current.get(gameMessage.chatId) ?? gameMessage),
                    usesVideo: fallbackUsesVideo,
                  });
                  this.activeGameMessages.set(gameAddress, current);
                },
              });

              if (skipped) {
                return;
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

              return;
            } catch (captionError) {
              // If we get here, something unexpected happened
              const recreated = await recreateMissingMessage(captionError);
              if (!recreated) {
                console.warn(
                  `Unexpected error in caption edit path for game ${gameAddress} chat ${gameMessage.chatId}:`,
                  captionError,
                );
              }
              return;
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
            return;
          }

          if (skipped) {
            return;
          }
        } catch (error) {
          if (messageTextValue && isMessageMissing(error)) {
            // Only lock/recreate for this specific message instance
            // We use a composite key for the lock to avoid blocking updates to other chats
            const lockKey = `${gameAddress}:${gameMessage.chatId}`;
            if (this.messageRecreationLocks.has(lockKey)) {
              return;
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
            return;
          }
          console.error(`Error in updateGameMessage for chat ${gameMessage.chatId}:`, error);
        }
      };

      await mapWithConcurrency(
        Array.from(messageMap.values()),
        GAME_MESSAGE_EDIT_CONCURRENCY,
        updateTarget,
      );

      const redirect = terminalRedirect as TerminalGameMessageUpdate | null;
      if (redirect) {
        await this.updateGameMessageInternal(
          ctx,
          gameAddress,
          gameType,
          amount,
          creatorUsername,
          redirect.status,
          tokenTicker,
          redirect.winnerAddress,
          redirect.totalPot,
          redirect.winnerSignature,
          updateGeneration,
          request,
        );
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
    updateOptions?: GameMessageUpdateOptions,
  ): Promise<void> {
    const updateGeneration = this.nextGameMessageUpdateGeneration(gameAddress);
    const request: GameMessageUpdateRequest = {
      status,
      winnerAddress,
      totalPot,
      winnerSignature,
    };
    try {
      let gameData = this.gameDb.getGame(gameAddress);
      if (!gameData) {
        console.warn(`No game data found for ${gameAddress}`);
        return;
      }

      let persistedStatus = String(gameData.status ?? "active").toLowerCase();
      let terminalStatus = persistedStatus === "completed" || !!gameData.winner_address;
      let effectiveStatus = terminalStatus ? "Completed" : status;
      let effectiveWinner = terminalStatus ? gameData.winner_address : winnerAddress;
      let effectiveTotalPot =
        terminalStatus && typeof gameData.total_amount === "number"
          ? gameData.total_amount
          : totalPot;
      let effectiveWinnerSignature = winnerSignature ?? gameData.completion_signature ?? undefined;
      const creatorUsername = await this.getGameCreatorUsername(ctx, gameAddress);

      // Username lookup can yield to completion persistence. Re-read all terminal fields
      // immediately before formatting so an active snapshot cannot win the race.
      gameData = this.gameDb.getGame(gameAddress) ?? gameData;
      persistedStatus = String(gameData.status ?? "active").toLowerCase();
      terminalStatus = persistedStatus === "completed" || !!gameData.winner_address;
      effectiveStatus = terminalStatus ? "Completed" : status;
      effectiveWinner = terminalStatus ? gameData.winner_address : winnerAddress;
      effectiveTotalPot =
        terminalStatus && typeof gameData.total_amount === "number"
          ? gameData.total_amount
          : totalPot;
      effectiveWinnerSignature =
        winnerSignature ?? gameData.completion_signature ?? effectiveWinnerSignature;

      const gameType = gameData.game_type
        ? gameData.game_type.charAt(0).toUpperCase() + gameData.game_type.slice(1)
        : "Game";

      await this.updateGameMessage(
        ctx,
        gameAddress,
        gameType,
        gameData.amount,
        creatorUsername,
        effectiveStatus,
        gameData.token_ticker || "",
        effectiveWinner,
        effectiveTotalPot,
        effectiveWinnerSignature,
        updateGeneration,
        request,
        terminalStatus ? undefined : updateOptions,
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
      const formatted = await this.formatGameMessage(
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
        { suppressMentions: true, gameAccount },
      );

      return (
        formatted.messageText || buildGameStateUnavailableMessage(gamePda.toBase58(), rawGameType)
      );
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
      const gameExplorerIcon = explorerUrl ? `<a href="${escapeHtml(explorerUrl)}">🔎</a>` : "🔎";
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
        `\nCreator: ${safeCreator} • ${safePlayerCount} players`;

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

  private async fetchConfirmedGame(gamePda: PublicKey) {
    const retryDelays = getConfirmationRetryDelays();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.program.account.game.fetch(gamePda);
      } catch (error) {
        if (attempt >= retryDelays.length) throw error;
        console.warn(`Retrying confirmed game account read for ${gamePda.toBase58()}:`, error);
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
      }
    }
  }

  public hasGameCreationRequest(telegramId: bigint, chatId?: number, messageId?: number): boolean {
    return (
      chatId != null &&
      messageId != null &&
      (this.gameDb.hasGameCreationRequest?.(telegramId.toString(), chatId, messageId) ?? false)
    );
  }

  public ownsPendingCreationMessage(
    gameAddress: string,
    chatId: number,
    messageId: number,
  ): boolean {
    const pending = this.gameDb.getPendingGameCreation(gameAddress);
    return pending?.chat_id === chatId && pending.creation_message_id === messageId;
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
    options?: {
      isPrivate?: boolean;
      replyToMessageId?: number;
      creationMessageId?: number;
      challenge?: ChallengedPlayer[];
    },
    chatId?: number,
    requestTimestampMs: number = Date.now(),
  ): Promise<{
    success: boolean;
    error?: string;
    gameAddress?: string;
    confirmedSignature?: string;
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
    // Only private games need the operator's signature to join, which is what
    // keeps everyone but the challenged players out of a challenge.
    const isPrivate = options?.challenge?.length ? true : (options?.isPrivate ?? true);
    const requestKey =
      chatId != null && options?.replyToMessageId != null
        ? `${telegramIdStr}:${chatId}:${options.replyToMessageId}`
        : undefined;
    if (requestKey && this.activeCreationRequestKeys.has(requestKey))
      return { success: false, error: "This game request is already being handled." };
    const nowMs = Date.now();
    const safeRequestTimestamp = Number.isFinite(requestTimestampMs)
      ? Math.min(nowMs, Math.max(0, Math.trunc(requestTimestampMs)))
      : nowMs;
    const requestedExpiresAtMs = safeRequestTimestamp + timeout * 1000;

    const windowStart = Math.max(
      nowMs - GAME_CREATION_RATE_LIMIT_WINDOW_MS,
      safeRequestTimestamp - GAME_CREATION_RATE_LIMIT_WINDOW_MS,
    );
    const pendingRequestTimestamp = Math.max(safeRequestTimestamp, nowMs);

    let pendingCount: number;
    let recentCreationCount: number;
    try {
      if (this.hasGameCreationRequest(telegramId, chatId, options?.replyToMessageId)) {
        return { success: false, error: "This game request has already been submitted." };
      }
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

      pendingCount = this.prunePendingCreationRequests(telegramIdStr, windowStart);
      recentCreationCount = this.gameDb.countRecentGamesByCreator(telegramIdStr, windowStart);
    } catch (error) {
      return {
        success: false,
        error: await logAndFormatError(error, `checking ${gameType} creation limits`, this.wallet),
      };
    }

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

    if (requestKey) this.activeCreationRequestKeys.add(requestKey);
    this.trackPendingCreationRequest(telegramIdStr, pendingRequestTimestamp);
    this.incrementInFlightCreations(telegramIdStr);

    let foregroundGameAddress: string | undefined;
    let confirmedCreation: { gameAddress: string; confirmedSignature: string } | undefined;
    let pendingCreation:
      | {
          gameAddress: string;
          transactionSignature: string;
          blockhash: string;
          lastValidBlockHeight: number;
          signedTransactionBase64: string;
        }
      | undefined;
    let pendingCreationPersisted = false;
    let pendingCreationState: PendingGameCreationState = "prepared";
    let creationConfirmed = false;
    let activeSubmissionLeaseId: string | null = null;
    const buildPendingCreationInput = (state: PendingGameCreationState) => ({
      gameAddress: pendingCreation!.gameAddress,
      creatorTelegramId: telegramIdStr,
      creatorDisplayName: null,
      amount: parsedAmount.amount,
      gameType,
      tokenMint: parsedAmount.tokenMint,
      tokenTicker: parsedAmount.tokenTicker,
      maxPlayers: maxTickets,
      minPlayers: minTickets,
      chatId,
      timeoutSeconds: timeout,
      expiresAt: requestedExpiresAtMs,
      transactionSignature: pendingCreation!.transactionSignature,
      state,
      isPrivate,
      transactionBlockhash: pendingCreation!.blockhash,
      lastValidBlockHeight: pendingCreation!.lastValidBlockHeight,
      signedTransactionBase64: pendingCreation!.signedTransactionBase64,
      replyToMessageId: options?.replyToMessageId ?? null,
    });

    const persistPendingCreation = (state: PendingGameCreationState, error?: unknown): void => {
      if (!pendingCreation || typeof chatId !== "number" || chatId === 0) return;
      const database = this.gameDb as any;
      const savePending = database.savePendingGameCreation;
      const setState = database.setPendingGameCreationState;
      const setStateIfCurrent = database.setPendingGameCreationStateIfCurrent;
      const errorMessage = error instanceof Error ? error.message : error ? String(error) : null;

      if (state === "prepared" && typeof savePending === "function" && !pendingCreationPersisted) {
        savePending.call(this.gameDb, buildPendingCreationInput(state));
        pendingCreationPersisted = true;
        if (options?.creationMessageId)
          this.gameDb.setPendingCreationMessage?.(
            pendingCreation.gameAddress,
            options.creationMessageId,
          );
        return;
      }

      // A prepared record is the proof that no send path has started. Once it
      // exists, no later error handler may write prepared back over a durable
      // submission admission.
      if (state === "prepared") return;

      const expectedStates: PendingGameCreationState[] =
        state === "confirmed"
          ? ["submitted", "unknown", "confirmed"]
          : state === "delivered"
            ? ["confirmed", "delivered"]
            : ["submitted", "unknown"];

      if (typeof setStateIfCurrent === "function" && pendingCreationPersisted) {
        try {
          setStateIfCurrent.call(this.gameDb, pendingCreation.gameAddress, expectedStates, state, {
            error: errorMessage,
            now: Date.now(),
            clearSubmissionLease: state === "confirmed" || state === "failed",
            submissionLeaseId: activeSubmissionLeaseId,
            expectedSignature: pendingCreation.transactionSignature,
          });
        } catch (stateError) {
          console.error(
            `Failed to update pending game creation state for ${pendingCreation.gameAddress}`,
            stateError,
          );
        }
        return;
      }

      if (typeof setState === "function" && pendingCreationPersisted) {
        try {
          setState.call(this.gameDb, pendingCreation.gameAddress, state, {
            error: errorMessage,
            now: Date.now(),
          });
        } catch (stateError) {
          console.error(
            `Failed to update pending game creation state for ${pendingCreation.gameAddress}`,
            stateError,
          );
        }
        return;
      }

      // Keep compatibility with older database test doubles and deployments
      // that have the record writer but not the state-update helper.
      if (typeof savePending === "function" && pendingCreationPersisted) {
        try {
          savePending.call(this.gameDb, buildPendingCreationInput(state));
        } catch (stateError) {
          console.error(
            `Failed to update pending game creation for ${pendingCreation.gameAddress}`,
            stateError,
          );
        }
      }
    };

    const admitPendingCreationSubmission = (): string | null => {
      const database = this.gameDb as any;
      if (!pendingCreationPersisted) {
        if (typeof database.savePendingGameCreation !== "function") return null;
        throw new Error("Game creation intent was not durably prepared before broadcast");
      }

      const claimSubmission = database.claimPendingGameCreationSubmission;
      if (typeof claimSubmission !== "function") {
        // A real GameDatabase always has the admission primitive. A test
        // double without pending persistence has no durable send obligation;
        // any double that does persist must fail closed here.
        if (typeof database.savePendingGameCreation === "function") {
          throw new Error("Durable game submission admission is unavailable");
        }
        return null;
      }

      const leaseId = randomUUID();
      const result = claimSubmission.call(
        this.gameDb,
        pendingCreation!.gameAddress,
        leaseId,
        Date.now() + PENDING_GAME_CREATION_SUBMISSION_LEASE_MS,
        Date.now(),
      );
      if (!result || result.acquired !== true) {
        const reason = result?.reason ?? "unavailable";
        throw new Error(`Game creation submission was not admitted (${reason})`);
      }
      activeSubmissionLeaseId = leaseId;
      return leaseId;
    };

    const finishPendingCreationSubmission = (
      leaseId: string | null,
      state: "submitted" | "unknown" | "failed",
      error?: unknown,
    ): boolean => {
      if (!leaseId) {
        persistPendingCreation(state, error);
        return true;
      }

      const finishSubmission = (this.gameDb as any).finishPendingGameCreationSubmission;
      if (typeof finishSubmission !== "function") {
        // Admission already durably changed prepared -> submitted. Never fall
        // back to an unconditional state write after a network call.
        return false;
      }

      try {
        const completed =
          finishSubmission.call(this.gameDb, pendingCreation!.gameAddress, leaseId, state, {
            error: error instanceof Error ? error.message : error ? String(error) : null,
            now: Date.now(),
          }) === true;
        if (completed) activeSubmissionLeaseId = null;
        return completed;
      } catch (stateError) {
        console.error(
          `Failed to finish pending game creation submission for ${pendingCreation!.gameAddress}`,
          stateError,
        );
        return false;
      }
    };

    try {
      const { tokenMint, tokenTicker, amount } = parsedAmount;
      if (contractCapabilities.oracleTokenPolicy) {
        await this.oracleClient.requireTokenPolicy(tokenMint, BigInt(amount));
      }
      const requestedSol = parsedAmount.requestedNativeSol === true || tokenMint === WSOL_MINT;

      const metadata = await this.wallet.getTokenMetadata(tokenMint);
      const playerKp = await this.wallet.getKeyPair(telegramId);
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
          return {
            success: false,
            error:
              jitResult.userMessage ??
              "Unable to top up SOL balance automatically. Add SOL manually and try again.",
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
        amount: BigInt(amount),
        // u32 are fine as numbers, but field names must match IDL
        maxTickets: maxTickets,
        minTickets: minTickets,
        // u64 must be BN
        timeout: BigInt(timeout),
        isPrivate,
      };

      const tokenMintPubkey = new PublicKey(tokenMint);
      const gamePda = await PDAManager.getGamePDA(randomHashBuffer, this.program.programId);
      foregroundGameAddress = gamePda.toBase58();
      this.foregroundCreationGames.add(foregroundGameAddress);
      // Before the transaction exists, so the game never reaches the chain without it.
      if (options?.challenge?.length)
        this.gameDb.saveGameChallenge(foregroundGameAddress, options.challenge);
      const tokenAccounts = await this.resolveGameVaultAccounts(tokenMintPubkey);
      const gameFundsContext = buildGameFundsContext(
        contractVersion,
        tokenMintPubkey,
        tokenAccounts,
      );
      const creatorTokenAccount = await this.deriveAta(
        tokenMintPubkey,
        playerKp.publicKey,
        tokenAccounts.tokenProgram,
      );
      const oraclePda = await this.getOraclePda();
      const usesAtomicCreatorJoin = gameType === "coinflip";
      const gameInstruction = await this.program.methods
        .initializeGame(gameConfig, Array.from(randomHashBuffer))
        .accounts({
          game: gamePda,
          creator: playerKp.publicKey,
          oracle: oraclePda,
          oracleOperator,
          ...gameFundsContext,
          creatorTokenAccount,
          systemProgram: SystemProgram.programId,
        } as any)
        .instruction();

      const vaultSetupInstructions = contractCapabilities.gameTokenAccount
        ? []
        : [
            createAssociatedTokenAccountIdempotentInstruction(
              playerKp.publicKey,
              tokenAccounts.gameVaultTokenAccount,
              tokenAccounts.gameVault,
              tokenMintPubkey,
              tokenAccounts.tokenProgram,
              ASSOCIATED_TOKEN_PROGRAM_ID,
            ),
          ];
      let creationInstructions: TransactionInstruction[] = [
        ...vaultSetupInstructions,
        gameInstruction,
      ];
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
          // Public games encode the absent optional signer with the program ID placeholder.
          joinInstruction.keys[2] = {
            pubkey: this.program.programId,
            isSigner: false,
            isWritable: false,
          };
        }
        creationInstructions = [
          ...vaultSetupInstructions,
          gameInstruction,
          ...setupInstructions,
          joinInstruction,
        ];
      }

      let preparedCreation:
        | {
            transaction: Awaited<ReturnType<typeof finalizeOracleSignedGameTransaction>>;
            blockhash: { blockhash: string; lastValidBlockHeight: number };
            signature: string;
          }
        | undefined;
      let submissionAttempted = false;
      const sendCreationTransaction = async () => {
        if (!preparedCreation) {
          const latestBlockhash = await this.wallet.getLatestBlockhash();
          const prepared = await buildOracleSignableGameTransaction({
            instructions: creationInstructions,
            creator: playerKp,
            blockhash: latestBlockhash,
          });
          const oracleSignedBase64 = await this.oracleClient.signGameTransaction(prepared.txBase64);
          const fullySigned = await finalizeOracleSignedGameTransaction({
            oracleSignedBase64,
            expectedMessageBytes: prepared.messageBytes,
            creator: playerKp,
          });
          const signature = getSignatureFromTransaction(fullySigned);
          preparedCreation = {
            transaction: fullySigned,
            blockhash: latestBlockhash,
            signature,
          };
          pendingCreation = {
            gameAddress: gamePda.toBase58(),
            transactionSignature: signature,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            signedTransactionBase64: getBase64EncodedWireTransaction(fullySigned),
          };

          // The exact signed transaction and its stable PDA/signature identity
          // must be durable before the first broadcast. A prepared record is
          // known not to have entered the send path yet, so recovery can safely
          // resolve it as never-sent once its blockhash lifetime expires.
          pendingCreationState = "prepared";
          persistPendingCreation("prepared");
          confirmedCreation = {
            gameAddress: pendingCreation.gameAddress,
            confirmedSignature: pendingCreation.transactionSignature,
          };
        }

        const initialAttempt = !submissionAttempted;
        const submissionLeaseId = admitPendingCreationSubmission();
        submissionAttempted = true;
        pendingCreationState = "submitted";
        try {
          const prepared = preparedCreation;
          if (!prepared) throw new Error("Game creation transaction was not prepared");
          const signature = await this.wallet.sendFullySignedGameTransaction(
            prepared.transaction,
            prepared.blockhash,
          );
          finishPendingCreationSubmission(submissionLeaseId, "submitted");
          return signature;
        } catch (error) {
          const nextState =
            initialAttempt && isDefinitiveGameCreationFailure(error) ? "failed" : "unknown";
          const durableTransitionCompleted = finishPendingCreationSubmission(
            submissionLeaseId,
            nextState,
            error,
          );
          // If the post-send state write failed, the durable admission remains
          // submitted (or its lease remains recoverable). Never report a
          // failed state locally in a way that could invite a second creation.
          pendingCreationState = durableTransitionCompleted ? nextState : "submitted";
          throw error;
        }
      };
      const creationTx = await sendCreationTransaction();

      debugLog(`📍 Game address: ${gamePda.toBase58()}`);

      let confirmedCreationTx: string;
      try {
        confirmedCreationTx = await withCreationRebroadcast(
          () =>
            this.confirmTransactionWithRecovery(
              creationTx,
              gamePda,
              "Game creation",
              undefined,
              undefined,
              { retryDelays: [] },
            ),
          this.rebroadcastCurrentGameCreation.bind(this, gamePda.toBase58(), creationTx),
        );
      } catch (error) {
        // After broadcast, even a processed failure can belong to a fork.
        // Recovery waits for finalized failure before releasing this intent.
        pendingCreationState = "unknown";
        persistPendingCreation(pendingCreationState, error);
        throw error;
      }

      const authoritativeCreation = this.gameDb.getPendingGameCreation?.(gamePda.toBase58());
      if (authoritativeCreation && authoritativeCreation.transaction_signature !== creationTx) {
        // A delayed foreground response must not hydrate a replacement using
        // the old signature. Its durable worker owns delivery now.
        return {
          success: false,
          gameAddress: gamePda.toBase58(),
          confirmedSignature: authoritativeCreation.transaction_signature,
        };
      }
      creationConfirmed = true;
      pendingCreationState = "confirmed";
      confirmedCreation = {
        gameAddress: confirmedCreation?.gameAddress ?? gamePda.toBase58(),
        confirmedSignature: confirmedCreationTx,
      };
      // Keep the durable intent until local hydration and Telegram delivery
      // complete. A confirmed transaction must remain recoverable even if
      // either follow-up step fails.
      persistPendingCreation("confirmed");
      const createdGameAccount = await this.fetchConfirmedGame(gamePda);
      if (!createdGameAccount.creator.equals(playerKp.publicKey)) {
        throw new Error("Confirmed game creator does not match the requesting wallet");
      }
      if (!createdGameAccount.tokenMint.equals(tokenMintPubkey)) {
        throw new Error("Confirmed game token mint does not match the requested token");
      }
      if (
        this.getGameType(createdGameAccount) !== gameType ||
        this.getDisplayAmountFromAccount(createdGameAccount, gameType) !== amount ||
        Number(createdGameAccount.maxTickets) !== maxTickets ||
        Number(createdGameAccount.minTickets) !== minTickets
      ) {
        throw new Error("Confirmed game account does not match the requested configuration");
      }

      if (createdGameAccount.timeout != null && Number(createdGameAccount.timeout) !== timeout) {
        throw new Error("Confirmed game timeout does not match the requested configuration");
      }
      if (
        createdGameAccount.isPrivate != null &&
        Boolean(createdGameAccount.isPrivate) !== isPrivate
      ) {
        throw new Error("Confirmed game visibility does not match the requested configuration");
      }

      const createdAtSeconds = Number(createdGameAccount.createdAt ?? 0);
      const timeoutSeconds = Number(createdGameAccount.timeout ?? 0);
      const hasAuthoritativeTiming =
        Number.isFinite(createdAtSeconds) &&
        createdAtSeconds > 0 &&
        Number.isFinite(timeoutSeconds) &&
        timeoutSeconds > 0;
      const authoritativeCreatedAtMs = hasAuthoritativeTiming
        ? createdAtSeconds * 1_000
        : undefined;
      const authoritativeExpiresAtMs = hasAuthoritativeTiming
        ? (createdAtSeconds + timeoutSeconds) * 1_000
        : undefined;
      const setPendingChainTiming = (this.gameDb as any)?.setPendingGameCreationChainTiming;
      if (
        hasAuthoritativeTiming &&
        typeof setPendingChainTiming === "function" &&
        pendingCreation
      ) {
        setPendingChainTiming.call(
          this.gameDb,
          pendingCreation.gameAddress,
          authoritativeCreatedAtMs,
          authoritativeExpiresAtMs,
          Date.now(),
        );
      }

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
        authoritativeExpiresAtMs,
        authoritativeCreatedAtMs,
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
      if (confirmedCreation && (pendingCreationState as string) !== "failed") {
        persistPendingCreation(creationConfirmed ? "confirmed" : pendingCreationState, error);
        console.error("Failed to finish confirmed game creation", confirmedCreation, error);
        return {
          success: false,
          ...confirmedCreation,
        };
      }
      const policyMessage = formatOraclePolicyError(error);
      if (policyMessage) {
        return { success: false, error: policyMessage };
      }
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
      if (foregroundGameAddress) this.foregroundCreationGames.delete(foregroundGameAddress);
      if (requestKey) this.activeCreationRequestKeys.delete(requestKey);
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
        debugLog("⏰ Giveaway buffer elapsed; closing the unresolved game.");
        const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
        if (result.success) {
          return {
            cancelled: true,
            amount: Number(gameAccount.ticketAmount),
            creator: gameAccount.creator.toBase58(),
            tx: result.tx!,
          };
        }
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
        if (isMissingAccountError(error)) {
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
        if (isMissingAccountError(error)) {
          debugLog("✅ Game account already closed successfully after buffer cleanup");
        } else {
          console.error("Post-buffer cleanup close attempt failed:", error);
        }
      }
      return false;
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
  ): Promise<JoinGameResult> {
    try {
      const gamePda = new PublicKey(gameAddress);
      const playerKp = await this.wallet.getKeyPair(telegramId);

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

      const normalizedTicker = gameData.token_ticker?.toUpperCase?.() ?? "";
      const isSolBackedGame =
        gameData.token_mint === WSOL_MINT &&
        (normalizedTicker === "SOL" || normalizedTicker === "WSOL");

      // The stake check needs only the token balance, so its read starts with the
      // game account read. A player already confirmed in this game skips it.
      const earlyTokenBalanceRead = this.isConfirmedParticipant(gameAddress, telegramId)
        ? undefined
        : this.wallet.getTokenBalance(telegramId, gameData.token_mint);
      // The checks below may return before it is awaited.
      void earlyTokenBalanceRead?.catch(() => undefined);

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
        if (isMissingAccountError(fetchError)) {
          return {
            success: false,
            error: this.completedGameErrorMessage,
          };
        }
        throw fetchError;
      }

      // Check if player already in game (reuses the account fetched above)
      const isInGame = await this.isPlayerInGame(gamePda, playerKp.publicKey, gameAccount);

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
      // Independent reads: token metadata, fee reserve and both balances start together.
      // The wallet throttle still spaces the two balance reads of one wallet.
      const metadataRead = this.wallet.getTokenMetadata(gameData.token_mint);
      const minSolBufferRead = this.feeBudget.getGameSafetyBufferLamports();
      const tokenBalanceRead =
        earlyTokenBalanceRead ?? this.wallet.getTokenBalance(telegramId, gameData.token_mint);
      const solBalanceRead = this.wallet.getBalance(telegramId);
      // A short stake returns before these two are awaited.
      void minSolBufferRead.catch(() => undefined);
      void solBalanceRead.catch(() => undefined);

      // SOL-backed games may wrap SOL to cover the stake. Any other game is checked
      // here, without waiting for the throttled SOL read, so a short stake is
      // reported while the button can still answer with it.
      if (!isSolBackedGame) {
        const [stakeMetadata, stakeBalance] = await Promise.all([metadataRead, tokenBalanceRead]);
        const shortfall = this.describeStakeShortfall(
          stakeBalance,
          gameAmount,
          stakeMetadata.decimals,
          gameData.token_ticker,
        );
        if (shortfall) {
          return { success: false, error: shortfall };
        }
      }

      const [metadata, minSolBuffer, initialTokenBalance, initialSolBalance] = await Promise.all([
        metadataRead,
        minSolBufferRead,
        tokenBalanceRead,
        solBalanceRead,
      ]);
      let tokenBalance = initialTokenBalance;
      let solBalance = initialSolBalance;

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

        // A successful wrap leaves at least the stake in WSOL.
        tokenBalance = ensured.tokenBalance;
        solBalance = ensured.solBalance;
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

        if (!jitResult.swapped) {
          return {
            success: false,
            error:
              jitResult.userMessage ??
              "Unable to top up SOL balance automatically. Add SOL manually and try again.",
          };
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
        const result = await this.joinPrivateGame(gamePda, playerKp, chatId || 0, telegramId);
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
                // Fill the optional oracleOperator signer slot with the player for a direct join.
                playerKp.publicKey,
              );
            setupInstructions = setupIxs;
            const joinInstruction = await this.program.methods
              .joinGame()
              .accounts(joinAccounts as any)
              .instruction();
            joinInstructions = [...setupInstructions, joinInstruction];

            joinTx = await this.wallet.sendTransaction(joinInstructions, [playerKp], {
              priorityFee: true,
            });
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

      this.invalidatePublicGamesCache();

      // The post-join account is returned so callers can show the ticket count and
      // redraw the game message without fetching it again.
      let updatedGameAccount: any;
      try {
        updatedGameAccount = await this.program.account.game.fetch(gamePda);
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

      return updatedGameAccount
        ? {
            success: true,
            gameAccount: updatedGameAccount,
            ticketsCount: Number(updatedGameAccount.ticketsCount ?? 0),
            maxTickets: Number(updatedGameAccount.maxTickets ?? 0),
          }
        : { success: true };
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
      const playerKp = await this.wallet.getKeyPair(telegramId);

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
        error: await logAndFormatError(error, `unjoining game ${gameAddress}`, this.wallet),
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
      const creatorKp = await this.wallet.getKeyPair(BigInt(creatorTelegramId));

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
      return {
        success: false,
        error: await logAndFormatError(error, `closing ${gameType} game ${address}`, this.wallet),
      };
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
      return {
        success: false,
        error: await logAndFormatError(
          error,
          `cancelling ${gameType} game ${gamePda.toBase58()}`,
          this.wallet,
        ),
      };
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
    telegramId: bigint,
  ): Promise<{
    success: boolean;
    tx?: string;
    error?: string;
  }> {
    try {
      const authResult = await this.oracleClient.authorizePlayer(gamePda, chatId, telegramId);

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
        if (isMissingAccountError(fetchError)) {
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

          lastSignature = await this.wallet.sendTransaction(joinInstructions, [playerKp, adminKp], {
            priorityFee: true,
          });

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

          if (isMissingAccountError(joinError)) {
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
      if (isMissingAccountError(error)) {
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
    const playerKp = await this.wallet.getKeyPair(telegramId);
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
    const playerKp = await this.wallet.getKeyPair(telegramId);
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
   * ✅ 151.1k TIMBA 🔎 • 2/2 • by @seebaacs • 19 Dec 00:02
   * ❌ 154.0k TIMBA 🔎 • 7/10 • vs @ThrasherMagazinee • 19 Dec 00:00
   * 🚫 14.0k TIMBA 🔎 • 0/2 • 19 Dec 00:44
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

    // Build explorer link with 🔎 emoji (like game messages)
    const explorerIcon = game.explorerUrl ? `<a href="${escapeHtml(game.explorerUrl)}">🔎</a>` : "";

    return `${emoji} ${escapeHtml(amountStr)} ${ticker} ${explorerIcon}• ${ticketsStr}${personPart} • ${dateStr}`;
  }

  /**
   * Build the summary header for /games command.
   * 🎲 Games: @username
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
      `🎲 <b>Games</b>: ${escapeHtml(username)} [30D]`,
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
        text: "🔁 Refresh",
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
          text: "🔁 Refresh",
          callback_data: `games_refresh:${telegramId}`,
        },
      ]);
    }

    return keyboard;
  }

  /**
   * Batch-load game accounts with one getMultipleAccounts call per 100 addresses.
   * Addresses the batch could not answer are left out of the map so callers can
   * fall back to a single lookup; absent accounts map to null.
   */
  private async fetchGameAccountsBatch(addresses: string[]): Promise<Map<string, any | null>> {
    const accounts = new Map<string, any | null>();
    const accountApi = this.program.account.game as any;
    if (addresses.length === 0 || typeof accountApi?.fetchMultiple !== "function") {
      return accounts;
    }

    const valid: Array<{ address: string; pda: PublicKey }> = [];
    for (const address of new Set(addresses)) {
      try {
        valid.push({ address, pda: new PublicKey(address) });
      } catch {
        // Invalid addresses are reported by the per-game path.
      }
    }
    if (valid.length === 0) {
      return accounts;
    }

    try {
      const fetched: Array<any | null> = await accountApi.fetchMultiple(
        valid.map((entry) => entry.pda),
      );
      valid.forEach((entry, index) => {
        accounts.set(entry.address, fetched[index] ?? null);
      });
    } catch (error) {
      console.warn("Batch game account lookup failed; falling back to single lookups:", error);
    }
    return accounts;
  }

  private async formatActiveGamesList(
    ctx: Context,
    activeGamesData: any[],
  ): Promise<ActiveGameListRow[]> {
    const needsFetch = activeGamesData
      .filter((gameData) => gameData?.game_address && gameData.game_account === undefined)
      .map((gameData) => String(gameData.game_address));
    const prefetched = await this.fetchGameAccountsBatch(needsFetch);

    const formattedGames: Array<ActiveGameListRow | null> = await Promise.all(
      activeGamesData.map(async (gameData) => {
        try {
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

          let onChainGame: any;
          if (gameData.game_account !== undefined) {
            onChainGame = gameData.game_account;
          } else if (prefetched.has(gameData.game_address)) {
            onChainGame = prefetched.get(gameData.game_address);
          } else {
            const accountApi = this.program.account.game as any;
            onChainGame = accountApi.fetchNullable
              ? await accountApi.fetchNullable(gamePda)
              : await accountApi.fetch(gamePda).catch((error: unknown) => {
                  const message = error instanceof Error ? error.message : String(error);
                  if (message.includes("does not exist")) return null;
                  throw error;
                });
          }
          if (!onChainGame) {
            console.warn(`Omitting stale active game ${gameData.game_address}; account is absent`);
            return null;
          }

          const creatorUsername = await this.getGameCreatorUsername(ctx, gameData.game_address);

          const formatted = await this.formatGameMessage(
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
            { suppressMentions: true, gameAccount: onChainGame },
          );
          const messageText =
            formatted.messageText ||
            buildGameStateUnavailableMessage(gameData.game_address, gameData.game_type || "game");
          const keyboard = formatted.keyboard;
          const currentTickets = Number(onChainGame.ticketsCount ?? 0);
          const maxTickets = Number(onChainGame.maxTickets ?? 0);
          const minTickets = Number(onChainGame.minTickets ?? 0);

          return {
            messageText,
            keyboard,
            gameAddress: gameData.game_address,
            currentTickets,
            maxTickets,
            minTickets,
          };
        } catch (error) {
          console.warn(
            `Failed to format active game ${gameData?.game_address ?? "unknown"}:`,
            error,
          );
          return null;
        }
      }),
    );

    return formattedGames.filter((game): game is ActiveGameListRow => game !== null);
  }

  public async getChatActiveGames(ctx: Context, chatId: number): Promise<ActiveGameListRow[]> {
    const activeGamesData = this.gameDb.getActiveGamesByChat(chatId);
    return this.formatActiveGamesList(ctx, activeGamesData);
  }

  public async getUserActiveGames(ctx: Context, telegramId: bigint): Promise<ActiveGameListRow[]> {
    const activeGamesData = this.gameDb.getActiveGames(telegramId.toString());
    return this.formatActiveGamesList(ctx, activeGamesData);
  }

  /**
   * Load every open public game with one getProgramAccounts call. The sorted list
   * (with decoded accounts) is cached briefly so page taps and repeated /public
   * commands do not rescan the program.
   */
  private async loadActivePublicGameEntries(): Promise<PublicGameEntry[]> {
    const now = Date.now();
    const cached = this.publicGamesCache;
    let entries: PublicGameEntry[];
    if (cached && cached.expiresAt > now) {
      entries = cached.entries;
    } else {
      if (!this.publicGamesInFlight) {
        this.publicGamesInFlight = this.fetchActivePublicGameEntries()
          .then((fetched) => {
            this.publicGamesCache = {
              entries: fetched,
              expiresAt: Date.now() + PUBLIC_GAMES_CACHE_TTL_MS,
            };
            return fetched;
          })
          .finally(() => {
            this.publicGamesInFlight = null;
          });
      }
      entries = await this.publicGamesInFlight;
    }

    // Games can expire while the list is cached.
    return entries.filter((entry) => !GameManager.isPublicEntryExpired(entry.account));
  }

  /** Drop the cached /public list, e.g. after a game is created, joined or closed. */
  public invalidatePublicGamesCache(): void {
    this.publicGamesCache = null;
  }

  private static isPublicEntryExpired(account: any): boolean {
    const createdAt = Number(account?.createdAt ?? 0);
    const timeout = Number(account?.timeout ?? 0);
    const hasTiming =
      Number.isFinite(createdAt) && createdAt > 0 && Number.isFinite(timeout) && timeout > 0;
    return hasTiming && GameManager.isExpired(account);
  }

  private async fetchActivePublicGameEntries(): Promise<PublicGameEntry[]> {
    // Fetch all games from the blockchain
    const allGames = await this.program.account.game.all();

    // Filter for public (non-private) games that are still joinable.
    const publicGames = allGames.filter((game) => {
      const account = game.account as any;
      if (account?.isPrivate) return false;
      return !GameManager.isPublicEntryExpired(account);
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

    // Resolve each distinct mint's ticker once instead of once per game.
    const tickerByMint = new Map<string, Promise<string>>();
    const resolveTicker = (tokenMint: string): Promise<string> => {
      let pending = tickerByMint.get(tokenMint);
      if (!pending) {
        pending = this.wallet
          .getTokenMetadata(tokenMint)
          .then((metadata) => metadata?.symbol || DEFAULT_TOKEN_TICKER)
          .catch(() => DEFAULT_TOKEN_TICKER);
        tickerByMint.set(tokenMint, pending);
      }
      return pending;
    };

    return Promise.all(
      publicGames.map(async (game) => {
        const account = game.account;
        const gameType = this.getGameType(account);
        const tokenMint = account.tokenMint.toBase58();
        const amount = this.getDisplayAmountFromAccount(account, gameType);
        const tokenTicker = await resolveTicker(tokenMint);

        return {
          account,
          gameData: {
            game_address: game.publicKey.toBase58(),
            game_type: gameType,
            amount,
            token_mint: tokenMint,
            token_ticker: tokenTicker,
            status: "active", // Assumed active if account exists
            winner_address: undefined, // Not in Game account
          },
        };
      }),
    );
  }

  private static matchesPublicGamesFilter(
    entry: PublicGameEntry,
    filter: PublicGamesFilter | undefined,
  ): boolean {
    if (!filter) return true;
    if (filter.gameType && entry.gameData.game_type !== filter.gameType) return false;
    if (filter.ticker) {
      const ticker = String(entry.gameData.token_ticker ?? "").toUpperCase();
      if (ticker !== filter.ticker.toUpperCase()) return false;
    }
    return true;
  }

  public async getAllActivePublicGames(
    ctx: Context,
    filter?: PublicGamesFilter,
  ): Promise<ActiveGameListRow[]> {
    const entries = (await this.loadActivePublicGameEntries()).filter((entry) =>
      GameManager.matchesPublicGamesFilter(entry, filter),
    );
    return this.formatActiveGamesList(
      ctx,
      entries.map((entry) => ({ ...entry.gameData, game_account: entry.account })),
    );
  }

  /**
   * Format only the requested page of public games. The page is clamped to the
   * available range; `totalGames` counts every matching game.
   */
  public async getActivePublicGamesPage(
    ctx: Context,
    options: { page: number; pageSize: number; filter?: PublicGamesFilter },
  ): Promise<{ games: ActiveGameListRow[]; totalGames: number; page: number }> {
    const entries = (await this.loadActivePublicGameEntries()).filter((entry) =>
      GameManager.matchesPublicGamesFilter(entry, options.filter),
    );
    const pageSize = Math.max(1, Math.trunc(options.pageSize));
    const totalGames = entries.length;
    const lastPage = Math.max(0, Math.ceil(totalGames / pageSize) - 1);
    const page = Math.min(Math.max(0, Math.trunc(options.page)), lastPage);
    const pageEntries = entries.slice(page * pageSize, (page + 1) * pageSize);
    const games = await this.formatActiveGamesList(
      ctx,
      pageEntries.map((entry) => ({ ...entry.gameData, game_account: entry.account })),
    );
    return { games, totalGames, page };
  }

  private async hydrateGameDataFromChain(
    gameAddress: string,
    options: { allowExpired?: boolean } = {},
  ): Promise<GameData | null> {
    const allowExpired = options.allowExpired === true;
    const getGame = (this.gameDb as any)?.getGame;
    if (!allowExpired && typeof getGame === "function") {
      const existing = getGame.call(this.gameDb, gameAddress);
      if (existing) return existing;
    }

    const gameAccount = await this.fetchGameAccountForRecovery(gameAddress);
    if (!gameAccount) return null;

    const createdAtSeconds = Number(gameAccount.createdAt ?? 0);
    const timeoutSeconds = Number(gameAccount.timeout ?? 0);
    const hasTiming =
      Number.isFinite(createdAtSeconds) &&
      createdAtSeconds > 0 &&
      Number.isFinite(timeoutSeconds) &&
      timeoutSeconds > 0;
    if (hasTiming && !allowExpired && GameManager.isExpired(gameAccount)) return null;

    const tokenMint =
      typeof gameAccount.tokenMint?.toBase58 === "function"
        ? gameAccount.tokenMint.toBase58()
        : typeof gameAccount.tokenMint === "string"
          ? gameAccount.tokenMint
          : null;
    if (!tokenMint) return null;

    let tokenTicker = DEFAULT_TOKEN_TICKER;
    const getTokenMetadata = (this.wallet as any)?.getTokenMetadata;
    if (typeof getTokenMetadata === "function") {
      try {
        const metadata = await getTokenMetadata.call(this.wallet, tokenMint);
        if (metadata?.symbol) tokenTicker = metadata.symbol;
      } catch {
        // Ignore metadata errors; the mint remains the source of truth.
      }
    }

    const creatorPubkey =
      typeof gameAccount.creator?.toBase58 === "function"
        ? gameAccount.creator.toBase58()
        : String(gameAccount.creator ?? "");
    const getPlayerTelegramId = (this.gameDb as any)?.getPlayerTelegramId;
    const creatorTelegramId =
      (creatorPubkey && typeof getPlayerTelegramId === "function"
        ? getPlayerTelegramId.call(this.gameDb, creatorPubkey)
        : null) ?? creatorPubkey;

    if (creatorPubkey && creatorTelegramId) {
      try {
        const savePlayerMapping = (this.gameDb as any)?.savePlayerMapping;
        if (typeof savePlayerMapping === "function") {
          savePlayerMapping.call(this.gameDb, creatorPubkey, creatorTelegramId);
        }
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
    const hydrated: GameData = {
      game_address: gameAddress,
      creator_telegram_id: creatorTelegramId || "unknown",
      amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
      created_at: createdAtMs,
      status: "active",
      game_type: gameType,
      token_mint: tokenMint,
      token_ticker: tokenTicker,
      max_players: maxPlayers,
      min_players: minPlayers,
      timeout_seconds: hasTiming ? timeoutSeconds : undefined,
      expires_at: expiresAtMs,
    };

    try {
      const saveGame = (this.gameDb as any)?.saveGame;
      if (typeof saveGame === "function") {
        saveGame.call(
          this.gameDb,
          gameAddress,
          creatorTelegramId || "unknown",
          hydrated.amount,
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
      }

      if (hasTiming) {
        const setGameChainTiming = (this.gameDb as any)?.setGameChainTiming;
        if (typeof setGameChainTiming === "function") {
          setGameChainTiming.call(this.gameDb, gameAddress, createdAtMs, expiresAtMs);
        }
      }
    } catch (error) {
      console.warn(`Failed to hydrate game ${gameAddress} into local DB:`, error);
    }

    if (typeof getGame === "function") {
      try {
        return getGame.call(this.gameDb, gameAddress) ?? hydrated;
      } catch {
        return hydrated;
      }
    }
    return hydrated;
  }

  /**
   * Ensure local DB contains minimal data for an on-chain game.
   * Used for /public joins where this bot may not have tracked the game yet.
   */
  public async ensureGameDataFromChain(gameAddress: string): Promise<GameData | null> {
    return this.hydrateGameDataFromChain(gameAddress);
  }

  private createChatBoundContext(ctx: Context, chatId: number): Context {
    if (ctx.chat?.id === chatId) {
      return ctx;
    }

    const api = ctx.api as any;
    return {
      api,
      chat: { id: chatId },
      from: ctx.from,
      reply: (text: string, options?: any) => api.sendMessage(chatId, text, options),
      replyWithPhoto: (photo: any, options?: any) => api.sendPhoto(chatId, photo, options),
      replyWithAnimation: (animation: any, options?: any) =>
        api.sendAnimation(chatId, animation, options),
      replyWithVideo: (video: any, options?: any) => api.sendVideo(chatId, video, options),
    } as unknown as Context;
  }

  private getPendingGameCreationMessages(gameAddress: string): Array<{
    chatId?: number;
    chat_id?: number;
    messageId?: number;
    message_id?: number;
  }> {
    const getGameMessages = (this.gameDb as any)?.getGameMessages;
    if (typeof getGameMessages !== "function") {
      return [];
    }

    const messages = getGameMessages.call(this.gameDb, gameAddress);
    return Array.isArray(messages) ? messages : [];
  }

  private async finishCreationPlaceholder(
    ctx: Context,
    pending: PendingGameCreationRecord,
    failed = false,
  ): Promise<void> {
    if (!pending.creation_message_id) return;
    try {
      if (failed)
        await ctx.api.editMessageText(
          pending.chat_id,
          pending.creation_message_id,
          "❌ Game creation failed. Please try again.",
        );
      else await ctx.api.deleteMessage(pending.chat_id, pending.creation_message_id);
    } catch (error) {
      if (!isMessageMissing(error) && !isMessageNotModified(error)) throw error;
    }
  }

  private async deliverPendingGameCreation(
    ctx: Context,
    pending: PendingGameCreationRecord,
    gameData: GameData,
  ): Promise<void> {
    const originContext = this.createChatBoundContext(ctx, pending.chat_id);
    const hasOriginMessage = this.getPendingGameCreationMessages(pending.game_address).some(
      (message) =>
        Number(message.chatId ?? message.chat_id) === pending.chat_id &&
        Number(message.messageId ?? message.message_id) > 0,
    );
    if (hasOriginMessage) {
      await this.finishCreationPlaceholder(ctx, pending);
      return;
    }

    let creatorDisplayName = pending.creator_display_name || "Unknown";
    if (!pending.creator_display_name) {
      try {
        const getCreatorInfo = (this.gameDb as any)?.getCreatorInfo;
        const creatorInfo =
          typeof getCreatorInfo === "function"
            ? getCreatorInfo.call(this.gameDb, pending.game_address)
            : null;
        if (creatorInfo?.publicKey) {
          creatorDisplayName = await this.getPlayerUsername(originContext, creatorInfo.publicKey);
        }
      } catch (error) {
        console.warn(
          `Failed to resolve creator for recovered game ${pending.game_address}:`,
          error,
        );
      }
    }

    const status = String(gameData.status ?? "active").toLowerCase();
    const terminal = status === "completed" || status === "cancelled" || !!gameData.winner_address;
    const messageId = await this.createGameMessage(
      originContext,
      pending.game_address,
      gameData.game_type || pending.game_type,
      gameData.amount || pending.amount,
      creatorDisplayName,
      gameData.token_ticker || pending.token_ticker,
      terminal ? "Completed" : "Active",
      pending.reply_to_message_id ?? undefined,
      {
        reserveDelivery: true,
        winnerAddress: terminal ? gameData.winner_address : undefined,
        totalPot: terminal ? gameData.total_amount : undefined,
      },
    );
    if (messageId === 0) {
      throw new Error("game message delivery is already in flight");
    }
    await this.finishCreationPlaceholder(ctx, pending);
  }

  /** Rebroadcast a creation while it is still the durable, unexpired submission. */
  private async rebroadcastCurrentGameCreation(
    gameAddress: string,
    signature: string,
    signal: AbortSignal,
  ): Promise<void> {
    const pending = this.gameDb.getPendingGameCreation?.(gameAddress);
    if (
      pending &&
      pending.transaction_signature === signature &&
      !(await this.isPendingGameCreationLifetimeExpired(pending))
    ) {
      signal.throwIfAborted();
      await this.rebroadcastPendingGameCreation(pending, signal);
    }
  }

  private async isPendingGameCreationLifetimeExpired(
    pending: PendingGameCreationRecord,
  ): Promise<boolean> {
    if (pending.last_valid_block_height == null) return false;
    const lastValidBlockHeight = Number(pending.last_valid_block_height);
    if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight < 0) {
      return false;
    }

    const getConnection = (this.wallet as any)?.getConnection;
    if (typeof getConnection !== "function") {
      return false;
    }

    const connection = getConnection.call(this.wallet) as unknown as {
      getBlockHeight?: (commitment?: "finalized") => Promise<number | bigint>;
    };
    if (typeof connection.getBlockHeight !== "function") {
      return false;
    }

    const currentBlockHeight = Number(await connection.getBlockHeight("finalized"));
    return Number.isFinite(currentBlockHeight) && currentBlockHeight > lastValidBlockHeight;
  }

  private async rebroadcastPendingGameCreation(
    pending: PendingGameCreationRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const signedTransactionBase64 = pending.signed_transaction_base64;
    const blockhash = pending.transaction_blockhash;
    const lastValidBlockHeight = Number(pending.last_valid_block_height);
    if (
      !signedTransactionBase64 ||
      !blockhash ||
      !Number.isSafeInteger(lastValidBlockHeight) ||
      lastValidBlockHeight < 0
    ) {
      throw new Error("pending game creation has no reusable signed transaction lifetime");
    }

    const connection = this.wallet.getConnection?.();
    if (
      typeof connection?.getBlockHeight === "function" &&
      Number(await connection.getBlockHeight("confirmed")) > lastValidBlockHeight
    ) {
      throw new Error("Game transaction is no longer broadcastable; awaiting finalized expiry");
    }

    // A foreground confirmation may finish while the height read is pending.
    // Do not admit a new send once its confirmation owner has stopped.
    signal?.throwIfAborted();

    const claimSubmission = (this.gameDb as any)?.claimPendingGameCreationSubmission;
    if (typeof claimSubmission !== "function") {
      throw new Error("Durable game submission admission is unavailable");
    }

    const leaseId = randomUUID();
    const now = Date.now();
    const claim = claimSubmission.call(
      this.gameDb,
      pending.game_address,
      leaseId,
      now + PENDING_GAME_CREATION_SUBMISSION_LEASE_MS,
      now,
      pending.transaction_signature,
    );
    if (!claim || claim.acquired !== true) {
      const reason = claim?.reason ?? "unavailable";
      if (reason === "in-flight") {
        throw new Error(
          `Pending game creation submission is already in flight; keeping ${pending.game_address} reserved`,
        );
      }
      throw new Error(`Pending game creation submission was not admitted (${reason})`);
    }

    const finishSubmission = (state: "submitted" | "unknown", error?: unknown): void => {
      const finish = (this.gameDb as any)?.finishPendingGameCreationSubmission;
      if (typeof finish !== "function") return;
      try {
        finish.call(this.gameDb, pending.game_address, leaseId, state, {
          error: error instanceof Error ? error.message : error ? String(error) : null,
          now: Date.now(),
        });
      } catch (stateError) {
        // The admission itself is already durable. If this write fails, leave
        // submitted/leased state in place so expiry cannot unlock the intent.
        console.error(
          `Failed to finish pending game creation submission for ${pending.game_address}`,
          stateError,
        );
      }
    };

    try {
      const transaction = decodeGameTransaction(signedTransactionBase64);
      assertIsFullySignedTransaction(transaction);
      const signature = await this.wallet.sendFullySignedGameTransaction(
        transaction,
        {
          blockhash,
          lastValidBlockHeight,
        },
        true,
      );
      if (signature !== pending.transaction_signature) {
        throw new Error(
          `Pending game rebroadcast returned an unexpected signature for ${pending.game_address}`,
        );
      }
      finishSubmission("submitted");
    } catch (error) {
      finishSubmission("unknown", error);
      throw error;
    }
  }

  /**
   * Finish a confirmed creation after the transaction path returned before
   * local setup completed. This is deliberately idempotent: the delivery
   * reservation prevents a second Telegram message for the same game/chat.
   */
  public async recoverPendingGameCreation(
    ctx: Context,
    pending: PendingGameCreationRecord,
  ): Promise<boolean> {
    if (this.foregroundCreationGames.has(pending.game_address)) return false;
    const existing = this.recoveryFlights.get(pending.game_address);
    if (existing) return existing;
    const flight = this.runPendingGameCreationRecovery(ctx, pending);
    this.recoveryFlights.set(pending.game_address, flight);
    try {
      return await flight;
    } finally {
      if (this.recoveryFlights.get(pending.game_address) === flight)
        this.recoveryFlights.delete(pending.game_address);
    }
  }

  private async runPendingGameCreationRecovery(
    ctx: Context,
    pending: PendingGameCreationRecord,
  ): Promise<boolean> {
    const latest = this.gameDb.getPendingGameCreation?.(pending.game_address) ?? pending;
    if (latest.recovery_paused_at != null || (latest.recovery_retry_not_before ?? 0) > Date.now())
      return false;
    pending = latest;
    try {
      const delivery = ["confirmed", "delivered", "failed"].includes(pending.state);
      const started = delivery ? pending.delivery_recovery_started_at : pending.recovery_started_at;
      if (started != null && Date.now() - started >= (delivery ? 3_600_000 : 900_000))
        throw new Error(
          delivery
            ? "Delivery recovery window ended; evidence retained for reconciliation"
            : "Automatic recovery window ended; evidence retained for reconciliation",
        );
      return await this.recoverPendingGameCreationAttempt(ctx, pending);
    } catch (error) {
      // Resolve the chain outcome first. A definitive failure must retain its
      // placeholder for the durable failure edit, even on an old request.
      const current = this.gameDb.getPendingGameCreation?.(pending.game_address);
      if (current) {
        const now = Date.now();
        const notBefore =
          error instanceof RpcRetryLaterError ? Math.max(now + 3_000, error.retryAt) : null;
        this.gameDb.scheduleGameCreationRecovery?.(
          current.game_address,
          current.transaction_signature,
          error instanceof Error ? error.message : String(error),
          notBefore ??
            now +
              (["confirmed", "delivered", "failed"].includes(current.state)
                ? 15_000
                : getCreationRecoveryDelay(current, now)),
          notBefore,
          now,
        );
      }

      if (
        current &&
        current.state !== "failed" &&
        current.creation_message_id &&
        Date.now() - (current.transaction_prepared_at ?? current.created_at) >= 180_000
      ) {
        try {
          await this.finishCreationPlaceholder(ctx, current);
          this.gameDb.setPendingCreationMessage(current.game_address, null);
          console.error(
            `Game creation needs operator attention: ${current.game_address} (${current.transaction_signature}); recovery is still pending`,
          );
        } catch (cleanupError) {
          console.warn("Unable to remove unresolved creation placeholder", cleanupError);
        }
      }
      throw error;
    }
  }

  private async recoverPendingGameCreationAttempt(
    ctx: Context,
    pending: PendingGameCreationRecord,
  ): Promise<boolean> {
    const getGame = (this.gameDb as any)?.getGame;
    const clearPending = (this.gameDb as any)?.clearPendingGameCreation;
    const clearPendingIfState = (this.gameDb as any)?.clearPendingGameCreationIfState;
    const setPendingState = (this.gameDb as any)?.setPendingGameCreationState;
    const setPendingStateIfCurrent = (this.gameDb as any)?.setPendingGameCreationStateIfCurrent;
    const failPreparedIfCurrent = (this.gameDb as any)?.failPreparedGameCreationIfCurrent;
    const getPending = (this.gameDb as any)?.getPendingGameCreation;
    const currentPending =
      typeof getPending === "function"
        ? getPending.call(this.gameDb, pending.game_address)
        : pending;
    if (!currentPending && typeof getPending === "function") return true;
    if (currentPending) {
      // Recovery callers receive a retry snapshot. Replace it with the
      // authoritative row before making any expiry or lifecycle decision.
      pending = currentPending;
    }
    if (pending.state === "failed") {
      await this.finishCreationPlaceholder(ctx, pending, true);
      if (pending.creation_message_id)
        this.gameDb.clearPendingGameCreationIfState(pending.game_address, ["failed"]);
      return true;
    }

    const setGameOriginChat = (this.gameDb as any)?.setGameOriginChat;
    const persistOriginChat = (): void => {
      if (typeof setGameOriginChat === "function") {
        setGameOriginChat.call(this.gameDb, pending.game_address, pending.chat_id);
      }
    };
    const clearAsFailed = (error: string): boolean => {
      const now = Date.now();
      let transitioned = false;
      if (typeof setPendingStateIfCurrent === "function") {
        transitioned =
          setPendingStateIfCurrent.call(
            this.gameDb,
            pending.game_address,
            ["prepared", "submitted", "unknown"],
            "failed",
            {
              error,
              now,
              clearSubmissionLease: true,
              expectedSignature: pending.transaction_signature,
            },
          ) === true;
      } else if (typeof setPendingState === "function") {
        // Compatibility for focused test doubles; production uses the
        // compare-and-set method above.
        setPendingState.call(this.gameDb, pending.game_address, "failed", { error, now });
        transitioned = true;
      }
      if (!transitioned) return false;
      // Keep terminal notification durable until Telegram accepts it.
      if (pending.creation_message_id) return true;

      if (typeof clearPendingIfState === "function") {
        clearPendingIfState.call(this.gameDb, pending.game_address, ["failed"]);
      } else if (typeof clearPending === "function") {
        clearPending.call(this.gameDb, pending.game_address);
      }
      return true;
    };
    const localGame =
      typeof getGame === "function" ? getGame.call(this.gameDb, pending.game_address) : null;
    const localTerminal =
      localGame &&
      (String(localGame.status).toLowerCase() === "completed" ||
        String(localGame.status).toLowerCase() === "cancelled" ||
        Boolean(localGame.winner_address));

    if (localTerminal) {
      // A locally terminal game can still be missing its Telegram card. Finish
      // that delivery before deleting the durable creation intent.
      persistOriginChat();
      await this.deliverPendingGameCreation(ctx, pending, localGame as GameData);
      let markedDelivered = false;
      if (typeof setPendingStateIfCurrent === "function") {
        markedDelivered =
          setPendingStateIfCurrent.call(
            this.gameDb,
            pending.game_address,
            ["submitted", "unknown", "confirmed", "delivered"],
            "delivered",
            { now: Date.now(), clearSubmissionLease: true },
          ) === true;
      } else if (typeof setPendingState === "function") {
        setPendingState.call(this.gameDb, pending.game_address, "delivered", {
          now: Date.now(),
        });
        markedDelivered = true;
      }
      if (markedDelivered && typeof clearPendingIfState === "function") {
        clearPendingIfState.call(this.gameDb, pending.game_address, ["delivered"]);
      } else if (markedDelivered && typeof clearPending === "function") {
        clearPending.call(this.gameDb, pending.game_address);
      }
      if (!markedDelivered) {
        throw new Error(
          "Pending game creation state changed while finalizing local delivery; keeping the current record",
        );
      }
      return true;
    }

    const gameAccount = await this.fetchGameAccountForRecovery(pending.game_address);
    if (!gameAccount) {
      const getTransactionOutcome = (this.wallet as any)?.getTransactionOutcome;
      let transactionOutcome: "confirmed" | "failed" | "unknown" | undefined;
      if (typeof getTransactionOutcome === "function" && pending.transaction_signature) {
        try {
          transactionOutcome = await getTransactionOutcome.call(
            this.wallet,
            pending.transaction_signature,
            { requireFinalizedFailure: true },
          );
        } catch (error) {
          throw new Error("Unable to determine the pending game transaction outcome", {
            cause: error,
          });
        }
      }

      if (transactionOutcome === "failed") {
        const resolved = clearAsFailed(
          "Game creation transaction failed before the game account was created",
        );
        if (resolved) return true;
        throw new Error(
          "Pending game creation state changed while resolving the failed transaction; keeping the current record",
        );
      }

      // A confirmed signature is evidence that the transaction landed, not
      // evidence that this RPC read has caught up with the account. Keep the
      // record so a later sweep can hydrate and deliver it.
      if (transactionOutcome === "confirmed") {
        throw new Error(
          "Game creation transaction is confirmed, but the game account is not available yet; keeping the pending creation for recovery",
        );
      }

      const lifetimeExpired = await this.isPendingGameCreationLifetimeExpired(pending);
      if (pending.state === "prepared" && lifetimeExpired) {
        // Prepared means the process recorded the exact transaction before it
        // entered the send path. Once its lifetime expires it is safe to
        // resolve as never broadcast, but only if the authoritative row is
        // still prepared at the conditional database write.
        const error = "Prepared game creation transaction expired before broadcast";
        if (typeof failPreparedIfCurrent === "function") {
          const resolved =
            failPreparedIfCurrent.call(this.gameDb, pending.game_address, error, Date.now()) ===
            true;
          if (resolved) {
            if (pending.creation_message_id) return true;
            if (typeof clearPendingIfState === "function") {
              clearPendingIfState.call(this.gameDb, pending.game_address, ["failed"]);
            } else if (typeof clearPending === "function") {
              clearPending.call(this.gameDb, pending.game_address);
            }
            return true;
          }

          const latest =
            typeof getPending === "function"
              ? getPending.call(this.gameDb, pending.game_address)
              : null;
          if (latest) pending = latest;
        } else if (clearAsFailed(error)) {
          return true;
        }

        // Another worker may have admitted the submission between the read
        // and the expiry check. Retain that authoritative state.
        if (pending.state !== "prepared") {
          throw new Error(
            "Pending game creation submission was admitted while expiry was being resolved; keeping it reserved",
          );
        }
        throw new Error(
          "Prepared game creation expiry could not be resolved atomically; keeping the pending creation reserved",
        );
      }

      if (
        !lifetimeExpired &&
        pending.signed_transaction_base64 &&
        pending.transaction_blockhash &&
        pending.last_valid_block_height != null
      ) {
        await this.rebroadcastPendingGameCreation(pending);
        throw new Error(
          "Pending game transaction was rebroadcast; the game account is not available yet",
        );
      }

      if (lifetimeExpired) {
        if (
          pending.transaction_blockhash &&
          pending.signed_transaction_base64 &&
          typeof this.wallet.proveGameCreationAbsent === "function" &&
          (await this.wallet.proveGameCreationAbsent(
            {
              signature: pending.transaction_signature,
              blockhash: pending.transaction_blockhash,
              lastValidBlockHeight: pending.last_valid_block_height!,
              gameAddress: pending.game_address,
            },
            {
              checkpoint: parseCreationProofCheckpoint(pending.recovery_checkpoint),
              save: (checkpoint) =>
                this.gameDb.saveCreationRecoveryCheckpoint(
                  pending.game_address,
                  pending.transaction_signature,
                  JSON.stringify(checkpoint),
                ),
            },
          ))
        ) {
          if ((pending.replacement_count ?? 0) >= 1 || Date.now() > pending.expires_at) {
            if (clearAsFailed("Game creation expired without landing")) {
              await this.finishCreationPlaceholder(ctx, pending, true);
              this.gameDb.clearPendingGameCreationIfState(pending.game_address, ["failed"]);
              return true;
            }
          } else {
            const creator = await this.wallet.getKeyPair(BigInt(pending.creator_telegram_id));
            const blockhash = await this.wallet.getLatestBlockhash(true);
            if (
              blockhash.blockhash === pending.transaction_blockhash ||
              blockhash.lastValidBlockHeight <= pending.last_valid_block_height!
            ) {
              throw new Error("RPC has not supplied a fresh game transaction lifetime yet");
            }
            const refreshed = await refreshGameTransaction(
              pending.signed_transaction_base64,
              blockhash,
              creator,
            );
            const signed = await finalizeOracleSignedGameTransaction({
              oracleSignedBase64: await this.oracleClient.signGameTransaction(refreshed.txBase64),
              expectedMessageBytes: refreshed.messageBytes,
              creator,
            });
            const replaced = this.gameDb.replaceExpiredGameCreation(
              pending.game_address,
              pending.transaction_signature,
              {
                signature: getSignatureFromTransaction(signed),
                ...blockhash,
                wire: getBase64EncodedWireTransaction(signed),
              },
            );
            if (replaced) {
              const latest = this.gameDb.getPendingGameCreation(pending.game_address);
              if (latest) await this.rebroadcastPendingGameCreation(latest);
              throw new Error("Expired game creation safely refreshed; awaiting confirmation");
            }
          }
        }
        throw new Error(
          "Pending game transaction lifetime expired before the game account became available; keeping the pending creation for manual reconciliation",
        );
      }

      throw new Error(
        "Game account is not available yet and the transaction outcome is unknown; keeping the pending creation for recovery",
      );
    }

    const accountAddress = (value: unknown): string =>
      typeof (value as { toBase58?: unknown })?.toBase58 === "function"
        ? (value as { toBase58: () => string }).toBase58()
        : String(value ?? "");
    const accountCreator = accountAddress(gameAccount.creator);
    const getKeyPair = (this.wallet as any)?.getKeyPair;
    if (typeof getKeyPair === "function" && pending.creator_telegram_id) {
      const creatorKeypair = await getKeyPair.call(
        this.wallet,
        BigInt(pending.creator_telegram_id),
      );
      if (accountCreator && !creatorKeypair.publicKey.equals(new PublicKey(accountCreator))) {
        throw new Error("Pending game creator does not match the confirmed game account");
      }
    }
    if (accountCreator && pending.creator_telegram_id) {
      const savePlayerMapping = (this.gameDb as any)?.savePlayerMapping;
      if (typeof savePlayerMapping === "function") {
        savePlayerMapping.call(this.gameDb, accountCreator, pending.creator_telegram_id);
      }
    }

    const accountTokenMint = accountAddress(gameAccount.tokenMint);
    if (pending.token_mint && accountTokenMint && pending.token_mint !== accountTokenMint) {
      throw new Error("Pending game token mint does not match the confirmed game account");
    }

    const accountGameType = this.getGameType(gameAccount);
    if (pending.game_type && accountGameType !== pending.game_type) {
      throw new Error("Pending game type does not match the confirmed game account");
    }
    const accountAmount = this.getDisplayAmountFromAccount(gameAccount, accountGameType);
    if (Number.isFinite(pending.amount) && pending.amount > 0 && accountAmount !== pending.amount) {
      throw new Error("Pending game amount does not match the confirmed game account");
    }
    if (
      pending.max_players > 0 &&
      gameAccount.maxTickets != null &&
      Number(gameAccount.maxTickets) !== pending.max_players
    ) {
      throw new Error("Pending game player limit does not match the confirmed game account");
    }
    if (
      pending.min_players > 0 &&
      gameAccount.minTickets != null &&
      Number(gameAccount.minTickets) !== pending.min_players
    ) {
      throw new Error(
        "Pending game minimum player limit does not match the confirmed game account",
      );
    }
    if (
      pending.timeout_seconds > 0 &&
      gameAccount.timeout != null &&
      Number(gameAccount.timeout) !== pending.timeout_seconds
    ) {
      throw new Error("Pending game timeout does not match the confirmed game account");
    }
    if (
      pending.is_private != null &&
      gameAccount.isPrivate != null &&
      Boolean(pending.is_private) !== Boolean(gameAccount.isPrivate)
    ) {
      throw new Error("Pending game visibility does not match the confirmed game account");
    }

    const createdAtSeconds = Number(gameAccount.createdAt ?? 0);
    const timeoutSeconds = Number(gameAccount.timeout ?? 0);
    const hasAuthoritativeTiming =
      Number.isFinite(createdAtSeconds) &&
      createdAtSeconds > 0 &&
      Number.isFinite(timeoutSeconds) &&
      timeoutSeconds > 0;
    if (!hasAuthoritativeTiming) {
      throw new Error("Confirmed game account is missing authoritative creation timing");
    }
    const authoritativeCreatedAtMs = createdAtSeconds * 1_000;
    const authoritativeExpiresAtMs = (createdAtSeconds + timeoutSeconds) * 1_000;

    // Account existence plus the identity/configuration checks above are the
    // evidence-bearing transition. Persist it before local hydration or
    // Telegram work so either of those failures leaves a confirmed intent for
    // the next sweep.
    let markedConfirmed = false;
    if (typeof setPendingStateIfCurrent === "function") {
      markedConfirmed =
        setPendingStateIfCurrent.call(
          this.gameDb,
          pending.game_address,
          ["prepared", "submitted", "unknown", "confirmed"],
          "confirmed",
          { now: Date.now(), clearSubmissionLease: true },
        ) === true;
    } else if (typeof setPendingState === "function") {
      setPendingState.call(this.gameDb, pending.game_address, "confirmed", { now: Date.now() });
      markedConfirmed = true;
    }
    if (!markedConfirmed) {
      throw new Error(
        "Confirmed game could not be durably marked confirmed; retaining the pending creation",
      );
    }

    const setPendingChainTiming = (this.gameDb as any)?.setPendingGameCreationChainTiming;
    if (typeof setPendingChainTiming === "function") {
      setPendingChainTiming.call(
        this.gameDb,
        pending.game_address,
        authoritativeCreatedAtMs,
        authoritativeExpiresAtMs,
        Date.now(),
      );
    }

    const setGameChainTiming = (this.gameDb as any)?.setGameChainTiming;
    if (typeof setGameChainTiming === "function") {
      setGameChainTiming.call(
        this.gameDb,
        pending.game_address,
        authoritativeCreatedAtMs,
        authoritativeExpiresAtMs,
      );
    }

    const hydratedGameData = await this.hydrateGameDataFromChain(pending.game_address, {
      allowExpired: true,
    });
    const accountMaxPlayers = Number(gameAccount.maxTickets);
    const accountMinPlayers = Number(gameAccount.minTickets);
    const displayAmount = this.getDisplayAmountFromAccount(gameAccount, accountGameType);
    const gameData: GameData = {
      ...(hydratedGameData ?? {}),
      game_address: pending.game_address,
      creator_telegram_id: pending.creator_telegram_id,
      amount: displayAmount > 0 ? displayAmount : pending.amount,
      created_at: authoritativeCreatedAtMs,
      status: hydratedGameData?.status ?? "active",
      game_type: accountGameType || pending.game_type,
      token_mint: accountTokenMint || pending.token_mint,
      token_ticker: hydratedGameData?.token_ticker || pending.token_ticker,
      max_players:
        Number.isFinite(accountMaxPlayers) && accountMaxPlayers > 0
          ? accountMaxPlayers
          : pending.max_players,
      min_players:
        Number.isFinite(accountMinPlayers) && accountMinPlayers > 0
          ? accountMinPlayers
          : pending.min_players,
      timeout_seconds: timeoutSeconds,
      expires_at: authoritativeExpiresAtMs,
    };

    const expired = GameManager.isExpired(gameAccount);
    if (expired) {
      const cancellation = await this.handleExpiredGame(
        new PublicKey(pending.game_address),
        gameAccount,
      );
      if (cancellation && typeof cancellation === "object" && cancellation.cancelled) {
        const completeGame = (this.gameDb as any)?.completeGame;
        if (typeof completeGame === "function") {
          completeGame.call(
            this.gameDb,
            pending.game_address,
            "cancelled",
            Date.now(),
            Number(cancellation.amount) || undefined,
          );
        }
        persistOriginChat();
        const terminalGameData: GameData = {
          ...gameData,
          status: "completed",
          winner_address: "cancelled",
          total_amount: Number(cancellation.amount) || gameData.total_amount,
        };
        await this.deliverPendingGameCreation(ctx, pending, terminalGameData);
        let markedDelivered = false;
        if (typeof setPendingStateIfCurrent === "function") {
          markedDelivered =
            setPendingStateIfCurrent.call(
              this.gameDb,
              pending.game_address,
              ["prepared", "submitted", "unknown", "confirmed", "delivered"],
              "delivered",
              { now: Date.now(), clearSubmissionLease: true },
            ) === true;
        } else if (typeof setPendingState === "function") {
          setPendingState.call(this.gameDb, pending.game_address, "delivered", {
            now: Date.now(),
          });
          markedDelivered = true;
        }
        if (markedDelivered && typeof clearPendingIfState === "function") {
          clearPendingIfState.call(this.gameDb, pending.game_address, ["delivered"]);
        } else if (markedDelivered && typeof clearPending === "function") {
          clearPending.call(this.gameDb, pending.game_address);
        }
        if (!markedDelivered) {
          throw new Error(
            "Pending game creation state changed while finalizing expired-game delivery; keeping the current record",
          );
        }
        return true;
      }

      // An expired account may still be waiting for the oracle, the expiry
      // buffer, or participant cleanup. Do not publish an "Expired" card and
      // clear the durable record while the on-chain account is still live;
      // the next recovery sweep must get another chance to finish cleanup.
      throw new Error("expired confirmed game still requires cleanup");
    }

    persistOriginChat();
    await this.deliverPendingGameCreation(ctx, pending, gameData);

    let markedDelivered = false;
    if (typeof setPendingStateIfCurrent === "function") {
      markedDelivered =
        setPendingStateIfCurrent.call(
          this.gameDb,
          pending.game_address,
          ["confirmed", "delivered"],
          "delivered",
          { now: Date.now(), clearSubmissionLease: true },
        ) === true;
    } else if (typeof setPendingState === "function") {
      setPendingState.call(this.gameDb, pending.game_address, "delivered", { now: Date.now() });
      markedDelivered = true;
    }
    if (markedDelivered && typeof clearPendingIfState === "function") {
      clearPendingIfState.call(this.gameDb, pending.game_address, ["delivered"]);
    } else if (markedDelivered && typeof clearPending === "function") {
      clearPending.call(this.gameDb, pending.game_address);
    }
    if (!markedDelivered) {
      throw new Error(
        "Pending game creation state changed while finalizing delivery; keeping the current record",
      );
    }
    return true;
  }

  public async recoverPendingGameCreationByAddress(
    ctx: Context,
    gameAddress: string,
  ): Promise<boolean> {
    const pending = this.gameDb.getPendingGameCreation(gameAddress);
    if (!pending) return false;
    return this.recoverPendingGameCreation(ctx, pending);
  }

  public clearPendingGameCreation(gameAddress: string): void {
    this.gameDb.clearPendingGameCreation(gameAddress);
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
    if (isMissingAccountError(error)) {
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

    const tryGetKeyPair = async (telegramId?: string): Promise<Keypair | null> => {
      if (!telegramId) {
        return null;
      }

      try {
        return await this.wallet.getKeyPair(BigInt(telegramId));
      } catch (_) {
        return null;
      }
    };

    const creatorAuthority = await tryGetKeyPair(creatorTelegramId);

    for (const player of players) {
      const playerKeypair = await tryGetKeyPair(player.telegramId);
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
