import {
  PublicKey,
  Keypair,
  Connection,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { createHash } from "crypto";

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
import {
  DEFAULT_NULL_ADDRESS,
  GAME_CREATION_RATE_LIMIT_WINDOW_MS,
  GAME_INFO_LIMIT,
  GAME_EXPIRATION_BUFFER_TIME,
  MAX_ACTIVE_GAMES_PER_CREATOR,
  MAX_GAMES_PER_CREATOR_WINDOW,
  WSOL_MINT,
  DEFAULT_TOKEN_TICKER,
  getCoinflipVideoId,
  getGiveawayVideoId,
  TELEGRAM_USERNAME_CACHE_TTL_MS,
} from "./constants";
import {
  editMediaWithFallback,
  isRecoverableMediaError,
  sendMediaWithFallback,
} from "./media";
import { isMessageMissing } from "./telegram-errors";
import { FeeBudgetManager } from "./fee-budget";
import type { FeeBudgetProvider } from "./fee-budget";
import type {
  GameMessage,
  GameCancellationResult,
  GameMessageFormat,
  GameCategory,
  GameType,
} from "../types";
import type { Timba } from "../../idl/idlType";
import {
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
import { resolveTokenPriceUSD } from "./prices";
import { NetworkDetector } from "./network-detector";
import { SwapManager } from "./swap-manager";
import { confirmTransactionWithRecovery, type TransactionProbe } from "./transaction-runner";
import { createExpiringCache } from "./expiring-cache";
import { refreshDynamicFeeBudgets } from "./fee-budget-refresh";
import {
  DEFAULT_MAINNET_ENDPOINT,
  resolvePrimaryRpcEndpoint,
} from "./rpc-endpoints";

const resolveGameVideoId = (gameType: string): string | undefined => {
  const lower = gameType.toLowerCase();
  if (lower === "coinflip") {
    const id = getCoinflipVideoId();
    return id && id.length > 0 ? id : undefined;
  }
  if (lower === "giveaway") {
    const id = getGiveawayVideoId();
    return id && id.length > 0 ? id : undefined;
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

const PLAYER_TELEGRAM_ID_POLL_INTERVAL_MS =
  process.env.NODE_ENV === "test" ? 1 : 40;
const PLAYER_TELEGRAM_ID_POLL_ATTEMPTS = 5;

const isDebugLoggingEnabled =
  (process.env["TIMBA_DEBUG"] ?? "").toLowerCase() === "true";

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

  const seconds = Math.ceil(windowMs / 1_000);
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  const days = Math.ceil(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
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

const DEFAULT_FRIENDLY_ERROR_MESSAGE =
  "❌ Something went wrong. Please try again in a moment.";

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

  if (value && typeof value === "object") {
    const candidate = (value as { toString?: () => string; toNumber?: () => number }) ?? {};
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
  walletManager?: WalletManager
): Promise<string> => {
  console.error(`Error in ${operation}:`, error);
  try {
    return await formatUserFriendlyError(error, walletManager);
  } catch (formatError) {
    console.error(
      `Failed to format user-friendly error for ${operation}:`,
      formatError
    );
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
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};

const formatExpirationTime = async (
  expiresAt: number,
  walletManager?: WalletManager,
  prefix: string = "⏰ "
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
  playerPublicKey: string
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
// GAME MANAGER CLASS
// ================================

export class GameManager {
  private static instance: GameManager;
  private static instanceDeps?: {
    program: anchor.Program<Timba>;
    wallet: WalletManager;
    gameDb: GameDatabase;
  };
  private activeGameMessages = new Map<string, GameMessage>();
  private cachedConnection?: Connection;
  private tokenProgramCache = new Map<string, PublicKey>();
  private gameRentLamports: number | null = null;
  private inFlightGameCreations = new Map<string, number>();
  private pendingCreationRequests = new Map<string, number[]>();
  private readonly completedGameErrorMessage =
    "This game has already completed. Refresh to see the result.";
  private readonly usernameCacheTtlMs = TELEGRAM_USERNAME_CACHE_TTL_MS;
  private readonly usernameCacheMaxEntries = 500;
  private readonly usernameCache = createExpiringCache<string | null>(
    TELEGRAM_USERNAME_CACHE_TTL_MS
  );
  private readonly usernameCacheKeys: string[] = [];
  private readonly usernameHints = new Map<string, string>();
  private readonly normalizedUsernameToIdCache = createExpiringCache<string>(
    TELEGRAM_USERNAME_CACHE_TTL_MS
  );
  private readonly usernameToIdCacheKeys: string[] = [];
  private readonly messageRecreationLocks = new Set<string>();
  private usernameLookupPromises = new Map<string, Promise<string | null>>();
  private gameMessageReadyListener?: (gameAddress: string) => void;

  private constructor(
    private program: anchor.Program<Timba>,
    private wallet: WalletManager,
    private gameDb: GameDatabase,
    private oracleClient: OracleClient,
    private swapManager: SwapManager,
    private feeBudget: FeeBudgetProvider
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

  private prunePendingCreationRequests(
    telegramId: string,
    windowStartMs: number
  ): number {
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

  private trackPendingCreationRequest(
    telegramId: string,
    timestampMs: number
  ): void {
    const existing = this.pendingCreationRequests.get(telegramId);
    if (existing) {
      existing.push(timestampMs);
      return;
    }

    this.pendingCreationRequests.set(telegramId, [timestampMs]);
  }

  private clearPendingCreationRequest(
    telegramId: string,
    timestampMs: number
  ): void {
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
    gameDb: GameDatabase
  ): GameManager {
    const depsChanged = (() => {
      const current = GameManager.instanceDeps;
      if (!current) {
        return true;
      }
      return (
        current.program !== program ||
        current.wallet !== wallet ||
        current.gameDb !== gameDb
      );
    })();

    if (!GameManager.instance || depsChanged) {
      const oracleClient = OracleClient.getInstance(wallet);
      const maybeGetConnection = (wallet as any).getConnection;
      const connection =
        typeof maybeGetConnection === "function"
          ? maybeGetConnection.call(wallet)
          : (wallet as any).connection ??
            new Connection(
              resolvePrimaryRpcEndpoint(
                process.env.SOLANA_NETWORK,
                DEFAULT_MAINNET_ENDPOINT
              ),
              "confirmed"
            );
      const feeBudget = FeeBudgetManager.getInstance(connection);
      const swapManager = new SwapManager(connection, wallet, feeBudget);
      GameManager.instance = new GameManager(
        program,
        wallet,
        gameDb,
        oracleClient,
        swapManager,
        feeBudget
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

  public setGameMessageReadyListener(
    listener: ((gameAddress: string) => void) | undefined
  ): void {
    this.gameMessageReadyListener = listener ?? undefined;
  }

  private getConnection(): Connection {
    if (this.cachedConnection) {
      return this.cachedConnection;
    }

    const providerConnection = (this.program.provider as any)?.connection as
      | Connection
      | undefined;
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

    const fallback = (this.wallet as any).connection as
      | Connection
      | undefined;
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
      value === null
        ? Math.min(this.usernameCacheTtlMs, 30_000)
        : this.usernameCacheTtlMs;

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

  private setCachedTelegramIdForUsername(
    key: string,
    telegramId: string
  ): void {
    this.normalizedUsernameToIdCache.setWithTTL(
      key,
      telegramId,
      this.usernameCacheTtlMs
    );
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

  private cacheTelegramIdForUsername(
    telegramId: string,
    username: string
  ): void {
    const normalized = this.normalizeUsernameForLookup(username);
    const trimmedId = telegramId.trim();

    if (!normalized || !/^\d+$/.test(trimmedId)) {
      return;
    }

    this.setCachedTelegramIdForUsername(normalized, trimmedId);
  }

  private rememberTelegramUsername(
    telegramId: string,
    username: string
  ): void {
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

  public primeUsernameCache(
    ctx: Context,
    telegramId: string,
    username: string | null
  ): void {
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
    options: { chatId?: number; messageText: string; inlineKeyboard?: any }
  ): Promise<void> {
    const fallbackChatId =
      options.chatId ??
      ctx.chat?.id ??
      this.gameDb.getGame(gameAddress)?.chat_id ??
      null;

    if (typeof fallbackChatId !== "number" || Number.isNaN(fallbackChatId)) {
      console.warn(
        `Unable to recreate Telegram message for ${gameAddress}: missing chat id`
      );
      return;
    }

    try {
      this.gameDb.clearGameMessage(gameAddress);
    } catch (clearError) {
      console.warn(
        `Failed to clear stale message mapping for ${gameAddress}:`,
        clearError
      );
    }

    this.activeGameMessages.delete(gameAddress);

    try {
      const sentMessage = await ctx.api.sendMessage(
        fallbackChatId,
        options.messageText,
        {
          parse_mode: "HTML",
          reply_markup: options.inlineKeyboard,
          link_preview_options: { is_disabled: true },
        }
      );

      this.gameDb.saveGameMessage(
        gameAddress,
        sentMessage.message_id,
        sentMessage.chat.id
      );
      this.activeGameMessages.set(gameAddress, {
        messageId: sentMessage.message_id,
        chatId: sentMessage.chat.id,
        usesVideo: false,
      });
      this.gameMessageReadyListener?.(gameAddress);
    } catch (sendError) {
      console.error(
        `Failed to recreate Telegram message for game ${gameAddress}:`,
        sendError
      );
    }
  }

  private getOraclePda(): PublicKey {
    return PDAManager.getOraclePDA(this.program.programId);
  }

  private getGameVaultPda(tokenMint: PublicKey): PublicKey {
    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), tokenMint.toBuffer()],
      this.program.programId
    );
    return gameVaultPda;
  }

  private async resolveTokenProgramId(tokenMint: PublicKey): Promise<PublicKey> {
    const cacheKey = tokenMint.toBase58();
    const cached = this.tokenProgramCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const accountInfo = await this.getConnection().getAccountInfo(tokenMint);
    if (!accountInfo) {
      throw new Error(`Token mint ${cacheKey} not found`);
    }

    this.tokenProgramCache.set(cacheKey, accountInfo.owner);
    return accountInfo.owner;
  }

  private async deriveAta(
    tokenMint: PublicKey,
    owner: PublicKey,
    tokenProgram: PublicKey,
    allowOwnerOffCurve = false
  ): Promise<PublicKey> {
    return getAssociatedTokenAddress(
      tokenMint,
      owner,
      allowOwnerOffCurve,
      tokenProgram
    );
  }

  private async resolveGameTokenAccounts(tokenMint: PublicKey): Promise<{
    tokenProgram: PublicKey;
    gameToken: PublicKey;
    gameVault: PublicKey;
    gameTokenAccount: PublicKey;
  }> {
    const tokenProgram = await this.resolveTokenProgramId(tokenMint);
    const gameToken = PDAManager.getGameTokenPDA(
      tokenMint,
      this.program.programId
    );
    const gameVault = this.getGameVaultPda(tokenMint);
    const gameTokenAccount = await this.deriveAta(
      tokenMint,
      gameVault,
      tokenProgram,
      true
    );

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
    }
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
    oracleOperator?: PublicKey
  ): Promise<{
    accounts: Record<string, unknown>;
    setupInstructions: TransactionInstruction[];
  }> {
    const tokenMint = new PublicKey(gameAccount.tokenMint);
    const tokenAccounts = await this.resolveGameTokenAccounts(tokenMint);
    const gameTokenCtx = this.buildGameTokenContext(tokenMint, tokenAccounts);
    const playerTokenAccount = await this.deriveAta(
      tokenMint,
      player,
      tokenAccounts.tokenProgram
    );

    const setupInstructions: TransactionInstruction[] = [];
    try {
      const accountInfo = await this.getConnection().getAccountInfo(
        playerTokenAccount
      );
      if (!accountInfo) {
        setupInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            player,
            playerTokenAccount,
            player,
            tokenMint,
            tokenAccounts.tokenProgram,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
    } catch (error) {
      console.warn(
        "Failed to check player ATA existence, defaulting to creation:",
        error
      );
      setupInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          player,
          playerTokenAccount,
          player,
          tokenMint,
          tokenAccounts.tokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    const accounts: Record<string, unknown> = {
      game: gamePda,
      player,
      gameTokenCtx,
      playerTokenAccount,
      oracle: this.getOraclePda(),
      systemProgram: SystemProgram.programId,
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
    authority: PublicKey
  ): Promise<Record<string, unknown>> {
    const { accounts } = await this.buildJoinAccounts(
      gamePda,
      gameAccount,
      player
    );
    accounts["authority"] = authority;
    return accounts;
  }

  private async buildCloseGameAccounts(
    gamePda: PublicKey,
    gameAccount: any
  ): Promise<Record<string, unknown>> {
    const tokenMint = new PublicKey(gameAccount.tokenMint);
    const tokenAccounts = await this.resolveGameTokenAccounts(tokenMint);
    const gameTokenCtx = this.buildGameTokenContext(tokenMint, tokenAccounts);
    const creatorPubkey = new PublicKey(gameAccount.creator);
    const creatorTokenAccount = await this.deriveAta(
      tokenMint,
      creatorPubkey,
      tokenAccounts.tokenProgram
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
  private async isPlayerInGame(
    gamePda: PublicKey,
    playerPubkey: PublicKey
  ): Promise<boolean> {
    const gameAddress = gamePda.toBase58();
    const playerPubkeyStr = playerPubkey.toBase58();

    try {
      const playerTelegramId = this.gameDb.getPlayerTelegramId?.(
        playerPubkeyStr
      );

      if (playerTelegramId) {
        const participants = this.gameDb.getGameParticipants(gameAddress);
        if (participants.includes(playerTelegramId)) {
          return true;
        }
      }
    } catch (error) {
      console.warn(
        `⚠️ Failed to check local participant records for ${gameAddress}:`,
        error
      );
    }

    try {
      const accountInterface = this.program.account.game as any;
      const fetchNullable = accountInterface?.fetchNullable?.bind(
        accountInterface
      );

      const gameAccount = fetchNullable
        ? await fetchNullable(gamePda)
        : await accountInterface.fetch(gamePda);

      if (!gameAccount) {
        return false;
      }

      const rawHashes = (gameAccount as any)?.participantHashes;
      if (!Array.isArray(rawHashes) || rawHashes.length === 0) {
        return false;
      }

      const playerHash = this.computeParticipantHash(gamePda, playerPubkey);

      return rawHashes.some((value: any) => {
        try {
          const normalized = value?.toString?.();
          return normalized === playerHash;
        } catch {
          return false;
        }
      });
    } catch (error) {
      console.warn(
        `⚠️ Failed to verify on-chain participants for ${gameAddress}:`,
        error
      );
      return false;
    }
  }

  private async verifyParticipantJoin(
    gamePda: PublicKey,
    playerPubkey: PublicKey,
    telegramId: string,
    options: { joinSignature?: string | null; maxAttempts?: number } = {}
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
      `⚠️ Player ${playerPubkeyStr} not yet recorded on-chain for ${gameAddress} after ${maxAttempts} verification attempt(s)`
    );
    return false;
  }

  private async reconcilePendingParticipants(gamePda: PublicKey): Promise<void> {
    const getPending =
      (this.gameDb as any).getPendingParticipants?.bind(this.gameDb);
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
      const telegramId =
        participant.telegram_id ?? participant.telegramId ?? null;
      if (!telegramId) {
        continue;
      }

      let playerKeyStr =
        participant.public_key ?? participant.publicKey ?? null;
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

      const joinSignature =
        participant.join_signature ?? participant.joinSignature ?? null;

      const verified = await this.verifyParticipantJoin(gamePda, playerPubkey, telegramId, {
        joinSignature,
        maxAttempts: 2,
      });

      if (!verified) {
        const joinedAt = participant.joined_at ?? participant.joinedAt ?? 0;
        if (joinedAt > 0 && now - joinedAt > staleThresholdMs) {
          console.warn(
            `⚠️ Removing stale pending participant ${telegramId} from ${gameAddress}; no on-chain record after ${Math.round(
              (now - joinedAt) / 1000
            )}s`
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

  private computeParticipantHash(
    gamePda: PublicKey,
    participant: PublicKey
  ): string {
    const digest = createHash("sha256")
      .update(Buffer.from("timba:part:v1"))
      .update(gamePda.toBuffer())
      .update(participant.toBuffer())
      .digest();

    const value = digest.subarray(0, 8).readBigUInt64LE(0);
    return value.toString();
  }

  private recoverParticipantsFromHashes(
    gamePda: PublicKey,
    gameAccount: any,
    knownTelegramIds: Set<string>
  ): {
    recovered: Array<{ telegramId: string; publicKey: string }>;
    unmatchedHashes: string[];
  } {
    const rawHashes = gameAccount.participantHashes;
    if (!Array.isArray(rawHashes) || rawHashes.length === 0) {
      return { recovered: [], unmatchedHashes: [] };
    }

    const participantHashes = rawHashes
      .map((hash: any) => {
        try {
          if (typeof hash === "bigint") {
            return hash;
          }
          if (typeof hash === "number") {
            return BigInt(hash);
          }
          if (hash && typeof hash.toString === "function") {
            return BigInt(hash.toString());
          }
        } catch (_) {
          return null;
        }
        return null;
      })
      .filter((value): value is bigint => value !== null);

    if (participantHashes.length === 0) {
      return { recovered: [], unmatchedHashes: [] };
    }

    const unmatchedHashes = new Set(
      participantHashes.map((value) => value.toString())
    );

    for (const telegramId of knownTelegramIds) {
      const publicKey = this.gameDb.getPlayerPublicKey(telegramId);
      if (!publicKey) {
        continue;
      }

      try {
        const computed = this.computeParticipantHash(
          gamePda,
          new PublicKey(publicKey)
        );
        unmatchedHashes.delete(computed);
      } catch (_) {
        // Ignore malformed public keys
      }
    }

    const initialUnmatched = unmatchedHashes.size;
    if (initialUnmatched === 0) {
      return { recovered: [], unmatchedHashes: [] };
    }

    const recovered: Array<{ telegramId: string; publicKey: string }> = [];
    const allMappings = (this.gameDb.getAllPlayerMappings?.() ?? []) as any[];

    for (const mapping of allMappings) {
      const telegramId = mapping?.telegram_id ?? mapping?.telegramId;
      const publicKey = mapping?.public_key ?? mapping?.publicKey;
      if (!telegramId || !publicKey || knownTelegramIds.has(telegramId)) {
        continue;
      }

      try {
        const computed = this.computeParticipantHash(
          gamePda,
          new PublicKey(publicKey)
        );

        if (unmatchedHashes.has(computed)) {
          recovered.push({ telegramId, publicKey });
          unmatchedHashes.delete(computed);
        }
      } catch (_) {
        // Ignore invalid public keys
      }

      if (unmatchedHashes.size === 0) {
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
          }
        );
        knownTelegramIds.add(participant.telegramId);
      } catch (error) {
        console.warn(
          `⚠️ Failed to persist recovered participant ${participant.telegramId} for ${gamePda.toBase58()}:`,
          error
        );
      }
    }

    if (recovered.length > 0) {
      debugLog(
        `🔄 Recovered ${recovered.length} participant(s) for ${gamePda.toBase58()} from on-chain hashes`
      );
    }

    if (unmatchedHashes.size > 0 && initialUnmatched === unmatchedHashes.size) {
      console.warn(
        `⚠️ Unable to match any on-chain participant hashes for ${gamePda.toBase58()}`
      );
    } else if (unmatchedHashes.size > 0) {
      console.warn(
        `⚠️ Unable to map ${unmatchedHashes.size} participant hash(es) for ${gamePda.toBase58()}`
      );
    }

    return { recovered, unmatchedHashes: Array.from(unmatchedHashes) };
  }

  private async resolveTokenFormattingInfo(
    gamePda: PublicKey,
    tokenTicker: string,
    tokenMintHint?: string | null
  ): Promise<{
    formatBalance: (value: number | bigint | string) => string;
    decimals: number;
    tokenMint?: string;
    isSol: boolean;
  }> {
    const normalizedTicker =
      typeof tokenTicker === "string" ? tokenTicker.toUpperCase() : "";
    const gameAddress = gamePda.toBase58();
    const storedGame =
      typeof this.gameDb.getGame === "function"
        ? this.gameDb.getGame(gameAddress)
        : undefined;
    let tokenMint = tokenMintHint ?? storedGame?.token_mint ?? undefined;

    let isSolToken = normalizedTicker === "SOL" || tokenMint === "SOL";

    if (!tokenMint && !isSolToken) {
      try {
        const gameAccount = await this.program.account.game.fetch(gamePda);
        const mint = (gameAccount as any)?.tokenMint as
          | PublicKey
          | undefined;
        if (mint) {
          tokenMint = mint.toBase58();
          isSolToken = tokenMint === "SOL";
        }
      } catch (error) {
        console.warn(
          `Unable to fetch game account ${gameAddress} for token info:`,
          error
        );
      }
    }

    const buildFormatter = (options: {
      decimals: number;
      useSolFormatter: boolean;
    }) => {
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
            return formatAmount(lamports, decimals, {
              maxFractionDigits: 6,
              trim: true,
            });
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

        return formatAmount(0, decimals, {
          maxFractionDigits: 6,
          trim: true,
        });
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
        const decimals =
          typeof metadata?.decimals === "number" ? metadata.decimals : 6;
        return {
          formatBalance: buildFormatter({ decimals, useSolFormatter: false }),
          decimals,
          tokenMint,
          isSol: false,
        };
      } catch (error) {
        console.warn(
          `Unable to load metadata for token ${tokenMint}, using fallback decimals`,
          error
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
    price: number
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
    tokenTicker?: string,
    isSol?: boolean
  ): Promise<{ text: string; price: number } | null> {
    const reference = isSol ? "SOL" : tokenMint || tokenTicker;
    if (!reference) return null;
    const lamports = coerceLamportValue(amount);
    if (lamports === null || lamports <= 0n) return null;
    if (lamports > MAX_SAFE_LAMPORTS) return null;
    if (process.env.NODE_ENV === "test") return null;

    try {
      const lookup = await resolveTokenPriceUSD({
        tokenMint,
        tokenTicker,
        isSol,
      });
      if (!lookup) {
        return null;
      }

      const usdText = this.formatUsdValue(lamports, decimals, lookup.price);
      if (!usdText) {
        return null;
      }

      return { text: usdText, price: lookup.price };
    } catch (error) {
      console.warn(
        `Failed to compute USD pricing for ${reference}:`,
        error
      );
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

  private async confirmTransactionWithRecovery(
    signature: string,
    gamePda: PublicKey,
    operationType:
      | "Game creation"
      | "Player join"
      | "Game close"
      | "Player unjoin",
    playerPubkey?: PublicKey,
    resubmit?: (attempt: number, previousSignature: string) => Promise<string>,
    options?: { retryDelays?: number[] }
  ): Promise<string> {
    const probes: TransactionProbe[] = [];
    const fetchGameAccountNullable = async (): Promise<any | null> => {
      try {
        const accountInterface = this.program.account.game as any;
        const fetchNullable = accountInterface?.fetchNullable?.bind(
          accountInterface
        );
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
              "Game account not found after timeout (attempted recovery)."
            );
          }
        } else if (operationType === "Game close") {
          const gameAccount = await fetchGameAccountNullable();
          if (gameAccount && !hasCause) {
            (error as any).cause = new Error(
              "Game account still exists after timeout (attempted recovery)."
            );
          }
        } else if (
          (operationType === "Player join" ||
            operationType === "Player unjoin") &&
          playerPubkey
        ) {
          const isInGame = await this.isPlayerInGame(
            gamePda,
            playerPubkey
          ).catch(() => false);
          const violation =
            operationType === "Player join" ? !isInGame : isInGame;
          if (violation && !hasCause) {
            (error as any).cause = new Error(
              operationType === "Player join"
                ? "Player not recorded in game after timeout (attempted recovery)."
                : "Player still recorded in game after timeout (attempted recovery)."
            );
          }
        }
      } catch (probeError) {
        (error as any).cause =
          probeError instanceof Error
            ? probeError
            : new Error(String(probeError));
      }
      throw error;
    }
  }

  private async sendInstructionsWithFallback(
    instructions: TransactionInstruction[],
    signers: Keypair[],
    operationLabel: string,
    options?: { skipConfirmation?: boolean }
  ): Promise<string> {
    const walletWithResubmits = (this.wallet as any)
      .sendAndConfirmWithResubmits;
    if (typeof walletWithResubmits === "function") {
      return await walletWithResubmits.call(this.wallet, instructions, signers, {
        operationLabel,
        skipConfirmation: options?.skipConfirmation,
      });
    }

    const signature = await this.wallet.sendTransaction(
      instructions,
      signers
    );
    if (!options?.skipConfirmation) {
      await this.wallet.confirmTransaction(signature);
    }
    return signature;
  }

  private async getGameCreationRentLamports(): Promise<number> {
    if (this.gameRentLamports !== null) {
      return this.gameRentLamports;
    }

    try {
      const size = (this.program.account as any)?.game?.size;
      if (typeof size === "number" && size > 0) {
        const connection = this.getConnection();
        const rent = await connection.getMinimumBalanceForRentExemption(size);
        if (Number.isFinite(rent) && rent > 0) {
          this.gameRentLamports = rent;
          return rent;
        }
      }
    } catch (error) {
      console.warn("⚠️ Failed to determine game account rent lamports, falling back to zero:", error);
    }

    this.gameRentLamports = 0;
    return 0;
  }

  private async ensureWrappedSolBalance(
    telegramId: bigint,
    requiredLamports: number,
    currentTokenBalance: number,
    currentSolBalance: number,
    context: "create" | "join",
    solReserveOverrideLamports?: number
  ): Promise<
    | { success: true; tokenBalance: number; solBalance: number }
    | { success: false; error: string }
  > {
    const [wrapFeeBuffer, defaultMinSolBuffer] = await Promise.all([
      this.feeBudget.getWrapFeeBufferLamports(),
      this.feeBudget.getGameSafetyBufferLamports(),
    ]);
    const minSolBuffer =
      solReserveOverrideLamports !== undefined
        ? solReserveOverrideLamports
        : defaultMinSolBuffer;

    debugLog(
      `🔍 WSOL wrap check (${context}): required=${this.wallet.formatSolBalance(
        requiredLamports
      )} WSOL, currentWSOL=${this.wallet.formatSolBalance(
        currentTokenBalance
      )}, currentSOL=${this.wallet.formatSolBalance(currentSolBalance)}, wrapBuffer=${this.wallet.formatSolBalance(
        wrapFeeBuffer
      )}, minSolBuffer=${this.wallet.formatSolBalance(minSolBuffer)}`
    );

    if (currentTokenBalance >= requiredLamports) {
      return {
        success: true,
        tokenBalance: currentTokenBalance,
        solBalance: currentSolBalance,
      };
    }

    const deficit = requiredLamports - currentTokenBalance;
    if (deficit <= 0) {
      return {
        success: true,
        tokenBalance: currentTokenBalance,
        solBalance: currentSolBalance,
      };
    }

    const projectedRemaining = currentSolBalance - deficit - wrapFeeBuffer;
    if (projectedRemaining < minSolBuffer) {
      const requiredReserve = deficit + wrapFeeBuffer + minSolBuffer;
      console.warn(
        `⚠️ Not enough SOL to wrap ${this.wallet.formatSolBalance(
          deficit
        )} for ${context}. Current SOL=${this.wallet.formatSolBalance(
          currentSolBalance
        )}, projected SOL after wrap=${this.wallet.formatSolBalance(
          projectedRemaining
        )}, required reserve=${this.wallet.formatSolBalance(requiredReserve)}`
      );
      return {
        success: false,
        error: this.buildSolShortfallMessage({
          currentLamports: currentSolBalance,
          requiredLamports: requiredReserve,
          reason: "Wrapping this amount would leave too little SOL for rent and fees",
          nextSteps: "Add more SOL or reduce the amount to continue.",
        }),
      };
    }

    debugLog(
      `🔄 Wrapping ${this.wallet.formatSolBalance(
        deficit
      )} SOL into WSOL for game ${context}...`
    );

    try {
      const wrapSignature = await this.wallet.wrapSol(telegramId, deficit);
      debugLog(
        `✅ Wrap transaction submitted (${context}): signature=${wrapSignature}`
      );
    } catch (error) {
      const friendly = await formatUserFriendlyError(error, this.wallet);
      console.error(
        `❌ Wrap failed for ${context}: ${friendly}. deficit=${this.wallet.formatSolBalance(
          deficit
        )}, solBefore=${this.wallet.formatSolBalance(currentSolBalance)}`
      );
      return {
        success: false,
        error:
          `Failed to wrap SOL automatically before game ${
            context === "create" ? "creation" : "join"
          }.\n${friendly}`,
      };
    }

    let updatedTokenBalance = 0;
    let updatedSolBalance = 0;

    const retryDelays = getWrapBalanceRetryDelays();

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      [updatedTokenBalance, updatedSolBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, WSOL_MINT),
        this.wallet.getBalance(telegramId),
      ]);

      if (updatedTokenBalance >= requiredLamports) {
        break;
      }

      const delay = retryDelays[attempt];
      if (delay === undefined) {
        break;
      }

      debugLog(
        `⏳ Waiting for WSOL balance propagation (attempt ${attempt + 1}/${
          retryDelays.length + 1
        })`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (updatedTokenBalance < requiredLamports) {
      console.error(
        `⚠️ Wrap completed but WSOL balance ${this.wallet.formatSolBalance(
          updatedTokenBalance
        )} still below required ${this.wallet.formatSolBalance(
          requiredLamports
        )}`
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
          updatedSolBalance
        )}, below buffer ${this.wallet.formatSolBalance(minSolBuffer)}`
      );
      return {
        success: false,
        error: this.buildSolShortfallMessage({
          currentLamports: updatedSolBalance,
          requiredLamports: minSolBuffer,
          reason: "Wrapping reduced your SOL below the fee reserve threshold",
          nextSteps: "Add more SOL before trying again.",
        }),
      };
    }

    debugLog(
      `✅ Wrapped SOL. New WSOL balance: ${this.wallet.formatSolBalance(
        updatedTokenBalance
      )}, remaining SOL: ${this.wallet.formatSolBalance(updatedSolBalance)}`
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
    const {
      telegramId,
      tokenMint,
      tokenDecimals,
      tokenTicker,
      userKeypair,
      logContext,
    } = options;

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

      const tokenBalance = await this.wallet.getTokenBalance(
        telegramBigInt,
        tokenMint,
        { createIfMissing: false }
      );

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
            swapResult.error ??
            `Unable to swap ${tokenTicker.toUpperCase()} for SOL fees.`,
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
      console.error(
        `Failed to prepare SOL balance for ${logContext}:`,
        error
      );
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown error");
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
    return address;
  }

  /**
   * Get username from Telegram ID with consistent error handling
   */
  public async getUsernameFromTelegramId(
    ctx: Context,
    telegramId: string
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

      this.usernameCache.delete(cacheKey);
      this.removeUsernameCacheKey(cacheKey);

      let lookup = this.usernameLookupPromises.get(cacheKey);
      if (!lookup) {
        lookup = (async () => {
          try {
            const maybeNumericId = Number(trimmedId);
            const targetId = Number.isSafeInteger(maybeNumericId)
              ? maybeNumericId
              : trimmedId;
            const chatMember = await (ctx.api as any).getChatMember(
              chatId,
              targetId
            );
            const userRecord = chatMember.user ?? {};
            const handle =
              typeof userRecord.username === "string" &&
              userRecord.username.trim().length > 0
                ? `@${userRecord.username.trim()}`
                : null;
            const resolved = handle ?? userRecord.first_name ?? null;
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
      console.warn(
        `Error getting username for Telegram ID ${telegramId}:`,
        error
      );
      return null;
    }
  }

  /**
   * Get game creator display name - optimized single method
   * Returns @username for Telegram users or formatted address for blockchain players
   */
  public async getGameCreatorUsername(
    ctx: Context,
    gameAddress: string
  ): Promise<string> {
    const creatorInfo = this.gameDb.getCreatorInfo(gameAddress);
    if (!creatorInfo) {
      return "Unknown";
    }

    // If we have telegram ID, try to get username
    if (creatorInfo.telegramId) {
      const username = await this.getUsernameFromTelegramId(
        ctx,
        creatorInfo.telegramId
      );
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
  public async getPlayerUsername(
    ctx: Context,
    publicKey: string
  ): Promise<string> {
    debugLog(`🔍 Getting username for publicKey: ${publicKey}`);

    const playerTelegramId = await this.getPlayerTelegramIdWithRetry(publicKey);
    debugLog(`🔍 Found telegramId: ${playerTelegramId} for publicKey: ${publicKey}`);

    if (!playerTelegramId) {
      debugLog(`⚠️ No telegram ID found for publicKey: ${publicKey}`);
      return this.formatAddress(publicKey);
    }

    const username = await this.getUsernameFromTelegramId(
      ctx,
      playerTelegramId
    );
    debugLog(`🔍 Found username: ${username} for telegramId: ${playerTelegramId}`);

    if (!username) {
      debugLog(`⚠️ No username found for telegramId: ${playerTelegramId}`);
      return this.formatAddress(publicKey);
    }

    return username;
  }

  private async getPlayerTelegramIdWithRetry(
    publicKey: string
  ): Promise<string | null> {
    for (let attempt = 0; attempt < PLAYER_TELEGRAM_ID_POLL_ATTEMPTS; attempt++) {
      const candidate = this.gameDb.getPlayerTelegramId(publicKey);
      if (candidate) {
        return candidate;
      }
      if (attempt < PLAYER_TELEGRAM_ID_POLL_ATTEMPTS - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, PLAYER_TELEGRAM_ID_POLL_INTERVAL_MS)
        );
      }
    }
    return null;
  }

  // ================================
  // GAME MESSAGE MANAGEMENT
  // ================================

  public getActiveGameMessage(gameAddress: string): GameMessage | undefined {
    return this.activeGameMessages.get(gameAddress);
  }

  private async getActiveGameStats(
    gamePda: PublicKey,
    amountLamportsInput: number | bigint,
    providedTotalPotInput?: number | bigint
  ) {
    const baseAmountLamports =
      coerceLamportValue(amountLamportsInput) ?? 0n;
    const providedTotalPot =
      providedTotalPotInput !== undefined
        ? coerceLamportValue(providedTotalPotInput)
        : null;

    try {
      let gameAccount = await this.program.account.game.fetch(gamePda);
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
      const expirationInfo = await formatExpirationTime(
        expiresAt,
        this.wallet,
        "\n⏰ "
      );
      const tokenMint = ((gameAccount as any)?.tokenMint as
        | PublicKey
        | undefined)
        ?.toBase58();

      return {
        currentTickets,
        maxTickets,
        minTickets,
        totalPot: totalPot ?? baseAmountLamports,
        expirationInfo,
        tokenMint,
      };
    } catch (error) {
      console.warn(
        `Warning: Could not fetch game account for ${gamePda.toBase58()}:`,
        error
      );
      return {
        currentTickets: 0,
        maxTickets: 0,
        minTickets: 0,
        totalPot: baseAmountLamports,
        expirationInfo: "",
        tokenMint: undefined,
      };
    }
  }

  private async getCompletedGameStats(
    gamePda: PublicKey,
    amountLamportsInput: number | bigint,
    providedTotalPotInput?: number | bigint
  ) {
    const baseAmountLamports =
      coerceLamportValue(amountLamportsInput) ?? 0n;
    const providedTotalPot =
      providedTotalPotInput !== undefined
        ? coerceLamportValue(providedTotalPotInput)
        : null;

    const gameAddress = gamePda.toBase58();
    const gameData = this.gameDb.getGame(gameAddress);
    const participants = this.getGamePlayers(gameAddress);
    const currentTickets = participants.length;

    const parsedMax = Number(gameData?.max_players);
    const maxTickets = Number.isFinite(parsedMax) && parsedMax > 0
      ? parsedMax
      : Math.max(currentTickets, 0);

    const parsedMin = Number(gameData?.min_players);
    let minTickets = Number.isFinite(parsedMin) && parsedMin > 0
      ? parsedMin
      : Math.min(currentTickets, maxTickets);

    if (!Number.isFinite(minTickets) || minTickets <= 0) {
      minTickets = Math.min(maxTickets, Math.max(currentTickets, 0));
    }

    // Get game type from database to calculate totalPot correctly
    let totalPot = providedTotalPot ?? null;
    if (totalPot === null) {
      const storedTotal = coerceLamportValue(
        (gameData as any)?.total_amount ?? (gameData as any)?.totalPot
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
    };
  }

  private async getWinnerInfo(
    ctx: Context,
    status: string,
    winnerAddress?: string,
    winnerSignature?: string,
    suppressMentions: boolean = false
  ): Promise<string> {
    if (status.toLowerCase() !== "completed" || !winnerAddress) return "";

    if (
      winnerAddress === "cancelled" ||
      winnerAddress === DEFAULT_NULL_ADDRESS
    ) {
      return `\nStatus: Cancelled`;
    }

    const winnerUsername = await this.getPlayerUsername(ctx, winnerAddress);
    const solscanUrl = NetworkDetector.buildSolscanTxUrl(winnerSignature);
    const sanitize = suppressMentions
      ? sanitizeTelegramDisplayNameWithoutMention
      : sanitizeTelegramDisplayName;
    const safeWinner = escapeHtml(sanitize(winnerUsername));
    const linkLine = solscanUrl
      ? `\n\n<a href="${solscanUrl}">🔗 View transaction</a>`
      : "";
    return `\n\nWinner: ${safeWinner}${linkLine}`;
  }

  private generateGameKeyboard(
    status: string,
    gamePda: PublicKey
  ) {
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
    winnerSignature?: string
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
      winnerSignature
    );

    const videoId = resolveGameVideoId(gameType);
    const replyMarkup = { inline_keyboard: formatted.keyboard };
    let message: any;
    let usesVideo = false;

    const sendText = async () =>
      ctx.reply(formatted.messageText, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });

    if (videoId) {
      try {
        message = await ctx.replyWithVideo(videoId, {
          caption: formatted.messageText,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
        usesVideo = true;
      } catch (error) {
        if (isRecoverableMediaError(error)) {
          console.warn(
            "Falling back to text announcement after video send failure:",
            error
          );
          message = await sendText();
        } else {
          throw error;
        }
      }
    } else {
      message = await sendText();
    }

    // Save the game message to database and activeGameMessages for future updates
    this.gameDb.saveGameMessage(
      gameAddress,
      message.message_id,
      message.chat.id
    );
    this.activeGameMessages.set(gameAddress, {
      messageId: message.message_id,
      chatId: message.chat.id,
      usesVideo,
    });

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
    options?: { suppressMentions?: boolean }
  ): Promise<GameMessageFormat> {
    const suppressMentions = options?.suppressMentions === true;
    const sanitizeDisplay = suppressMentions
      ? sanitizeTelegramDisplayNameWithoutMention
      : sanitizeTelegramDisplayName;
    const isCompleted = status.toLowerCase() === "completed";

    const amountLamports =
      typeof amount === "bigint" ? amount : BigInt(Math.trunc(amount));

    const coerceProvidedTotal =
      providedTotalPot !== undefined && providedTotalPot !== null
        ? coerceLamportValue(providedTotalPot)
        : null;

    const gameStats = isCompleted
      ? await this.getCompletedGameStats(
          gamePda,
          amountLamports,
          coerceProvidedTotal ?? undefined
        )
      : await this.getActiveGameStats(
          gamePda,
          amountLamports,
          coerceProvidedTotal ?? undefined
        );

    const {
      currentTickets,
      maxTickets,
      minTickets,
      totalPot,
      expirationInfo,
    } = gameStats as any;
    const tokenMintHint = (gameStats as { tokenMint?: string | null })
      .tokenMint;

    const {
      formatBalance: formatBalanceForDisplay,
      decimals,
      tokenMint,
      isSol,
    } = await this.resolveTokenFormattingInfo(
      gamePda,
      tokenTicker,
      tokenMintHint
    );

    const usdApproximation = await this.getUsdApproximation(
      amountLamports,
      decimals,
      tokenMint,
      tokenTicker,
      isSol
    );

    const winnerInfo = await this.getWinnerInfo(
      ctx,
      status,
      winnerAddress,
      winnerSignature,
      suppressMentions
    );

    const formattedTicketAmount = formatBalanceForDisplay(amountLamports);

    const safeCreatorUsername = sanitizeDisplay(creatorUsername);
    const header = buildGameHeader(
      formatGameTypeWithEmoji(gameType),
      formattedTicketAmount,
      tokenTicker,
      safeCreatorUsername,
      currentTickets,
      maxTickets,
      usdApproximation?.text
    );
    // Show current prize if different from base amount
    let prizeUsdApproximation: string | null = null;
    if (usdApproximation) {
      prizeUsdApproximation = this.formatUsdValue(
        totalPot,
        decimals,
        usdApproximation.price
      );
    } else if (currentTickets > 0 || totalPot !== amountLamports) {
      const computedPrizeUsd = await this.getUsdApproximation(
        totalPot,
        decimals,
        tokenMint,
        tokenTicker,
        isSol
      );
      prizeUsdApproximation = computedPrizeUsd?.text ?? null;
    }

    const prize = buildPrizeLine(
      currentTickets > 0 || totalPot !== amountLamports,
      formatBalanceForDisplay(totalPot),
      tokenTicker,
      prizeUsdApproximation
    );

    const baseBeforeParticipants = header + prize;

    const participantDisplayNames: string[] = [];
    if (currentTickets > 0) {
      try {
        const participants = this.getGamePlayers(gamePda.toBase58());
        const lookups = participants.map(async (telegramId) => {
          try {
            const username = await this.getUsernameFromTelegramId(ctx, telegramId);
            if (username) {
              return sanitizeDisplay(username);
            }
          } catch {
            // fall back to placeholder
          }
          return `Player ${telegramId.slice(0, 6)}...`;
        });
        const resolved = await Promise.all(lookups);
        participantDisplayNames.push(...resolved);
      } catch (error) {
        console.error("Error getting player list:", error);
      }
    }

    const statusSection = !isCompleted
      ? `\nStatus: ${buildGameStatus(
          currentTickets,
          minTickets,
          maxTickets
        )}${expirationInfo}`
      : "";

    const composeMessage = (
      names: string[],
      omittedCount: number
    ): string => {
      const participantsSection =
        names.length > 0 ? buildParticipantsList(names) : "";
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

    let messageText = composeMessage(participantDisplayNames, 0);

    if (
      messageText.length > TELEGRAM_MESSAGE_CHAR_LIMIT &&
      participantDisplayNames.length > 0
    ) {
      for (let keep = participantDisplayNames.length; keep >= 0; keep -= 1) {
        const omitted = participantDisplayNames.length - keep;
        const candidate = composeMessage(
          participantDisplayNames.slice(0, keep),
          omitted
        );
        if (candidate.length <= TELEGRAM_MESSAGE_CHAR_LIMIT || keep === 0) {
          messageText = candidate;
          break;
        }
      }
    }

    if (messageText.length > TELEGRAM_MESSAGE_CHAR_LIMIT) {
      messageText =
        messageText.slice(0, TELEGRAM_MESSAGE_CHAR_LIMIT - 1) + "…";
    }

    const keyboard = this.generateGameKeyboard(
      status,
      gamePda
    );

    return { messageText, keyboard };
  }

  public async getPrizeDisplay(
    gameAddress: string,
    totalPot: number,
    tokenTickerHint?: string | null,
    tokenMintHint?: string | null
  ): Promise<
    | {
        formattedAmount: string;
        tokenTicker: string;
        usdApproximation: string | null;
      }
    | null
  > {
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

      const { formatBalance, decimals, tokenMint, isSol } =
        await this.resolveTokenFormattingInfo(
          gamePda,
          resolvedTicker || "",
          resolvedMint
        );

      const formattedAmount = formatBalance(totalPot);
      const usdApproximation = await this.getUsdApproximation(
        totalPot,
        decimals,
        tokenMint,
        resolvedTicker,
        isSol
      );

      const displayTicker = resolvedTicker || (isSol ? "SOL" : "");

      return {
        formattedAmount,
        tokenTicker: displayTicker,
        usdApproximation: usdApproximation?.text ?? null,
      };
    } catch (error) {
      console.warn(
        `Failed to compute prize display for ${gameAddress}:`,
        error
      );
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
    replyToMessageId?: number
  ): Promise<number> {
    const { messageText, keyboard } = await this.formatGameMessage(
      ctx,
      new PublicKey(gameAddress),
      gameType,
      amount,
      creatorUsername,
      status,
      tokenTicker
    );

    const replyTo = replyToMessageId ?? (ctx as any).message?.message_id;
    const videoId = resolveGameVideoId(gameType);
    const replyMarkup = { inline_keyboard: keyboard };
    const sendResult = await sendMediaWithFallback({
      videoFileId: videoId ?? null,
      logLabel: "game video",
      sendText: () =>
        ctx.reply(messageText, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
          reply_to_message_id: replyTo,
        }),
      sendVideo:
        videoId && typeof (ctx as any).replyWithVideo === "function"
          ? () =>
              ctx.replyWithVideo(videoId, {
                caption: messageText,
                parse_mode: "HTML",
                reply_markup: replyMarkup,
                reply_to_message_id: replyTo,
              })
          : undefined,
    });

    const message: any = sendResult.result;
    const usesVideo = sendResult.usedVideo;

    this.gameDb.saveGameMessage(
      gameAddress,
      message.message_id,
      message.chat.id
    );
    this.activeGameMessages.set(gameAddress, {
      messageId: message.message_id,
      chatId: message.chat.id,
      usesVideo,
    });

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
    winnerSignature?: string
  ): Promise<void> {
    const gameMessage = this.activeGameMessages.get(gameAddress);
    if (!gameMessage) return;

    let messageTextValue = "";
    let inlineKeyboardValue: any;

    try {
      const { messageText, keyboard } = await this.formatGameMessage(
        ctx,
        new PublicKey(gameAddress),
        gameType,
        amount,
        creatorUsername,
        status,
        tokenTicker,
        winnerAddress,
        totalPot,
        winnerSignature
      );
      messageTextValue = messageText;

      const inlineKeyboard =
        keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
      inlineKeyboardValue = inlineKeyboard;
      const lowerStatus = status.toLowerCase();
      const supportsVideo = gameMessage.usesVideo !== false;
      const winnerVideoId = resolveGameVideoId(gameType);

      const editAsText = () =>
        ctx.api.editMessageText(
          gameMessage.chatId,
          gameMessage.messageId,
          messageText,
          {
            parse_mode: "HTML",
            reply_markup: inlineKeyboard,
          }
        );

      if (winnerVideoId && supportsVideo) {
        const isCompleted = lowerStatus === "completed";
        const { usedFallback, skipped } = await editMediaWithFallback({
          edit: () =>
            isCompleted
              ? ctx.api.editMessageMedia(
                  gameMessage.chatId,
                  gameMessage.messageId,
                  {
                    type: "video",
                    media: winnerVideoId,
                    caption: messageText,
                    parse_mode: "HTML",
                  },
                  { reply_markup: inlineKeyboard }
                )
              : ctx.api.editMessageCaption(
                  gameMessage.chatId,
                  gameMessage.messageId,
                  {
                    caption: messageText,
                    parse_mode: "HTML",
                    reply_markup: inlineKeyboard,
                  }
                ),
          fallback: () => editAsText(),
          logLabel: "game media update",
          onFallback: () => {
            this.activeGameMessages.set(gameAddress, {
              ...gameMessage,
              usesVideo: false,
            });
          },
        });

        if (skipped) {
          return;
        }

        if (!usedFallback) {
          this.activeGameMessages.set(gameAddress, {
            ...gameMessage,
            usesVideo: true,
          });
        }

        return;
      }

      const { skipped } = await editMediaWithFallback({
        edit: () => editAsText(),
        logLabel: "game text update",
      });

      if (skipped) {
        return;
      }
    } catch (error) {
      if (messageTextValue && isMessageMissing(error)) {
        if (this.messageRecreationLocks.has(gameAddress)) {
          return;
        }

        this.messageRecreationLocks.add(gameAddress);
        try {
          await this.recreateMissingGameMessage(ctx, gameAddress, {
            chatId: gameMessage.chatId,
            messageText: messageTextValue,
            inlineKeyboard: inlineKeyboardValue,
          });
        } finally {
          this.messageRecreationLocks.delete(gameAddress);
        }
        return;
      }
      console.error("Error in updateGameMessage:", error);
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
    winnerSignature?: string
  ): Promise<void> {
    try {
      const gameData = this.gameDb.getGame(gameAddress);
      if (!gameData) {
        console.warn(`No game data found for ${gameAddress}`);
        return;
      }

      const creatorUsername = await this.getGameCreatorUsername(
        ctx,
        gameAddress
      );
      const gameType = gameData.game_type
        ? gameData.game_type.charAt(0).toUpperCase() +
          gameData.game_type.slice(1)
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
        winnerSignature
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
      let gameAccount = await this.program.account.game.fetch(gamePda);
      const amount = Number(gameAccount.ticketAmount);

      // Get token info from database
      const gameData = this.gameDb.getGame(gamePda.toBase58());
      if (!gameData?.token_mint || !gameData?.token_ticker) {
        return `Error: Game token information not found`;
      }

      const tokenTicker = gameData.token_ticker;
      const creatorPubkey = gameAccount.creator.toString();
      const rawGameType = this.getGameType(gameAccount);

      const creatorUsername = await this.getGameCreatorUsername(
        ctx,
        gamePda.toBase58()
      );
      const creatorInfo =
        creatorUsername !== "Unknown"
          ? creatorUsername
          : `<code>${creatorPubkey}</code>`;

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
        { suppressMentions: true }
      );

      return messageText;
    } catch (error: any) {
      const userFriendlyError = await logAndFormatError(
        error,
        `fetching game info for ${gamePda.toBase58()}`,
        this.wallet
      );
      return (
        "⚠️ Unable to load this game right now. Please try again in a moment.\n\n" +
        userFriendlyError
      );
    }
  }

  // Helper method to get game info for completed games from database
  public async getCompletedGameInfo(
    ctx: Context,
    gameData: any
  ): Promise<string> {
    try {
      const creatorUsername = await this.getUsernameFromTelegramId(
        ctx,
        gameData.creator_telegram_id
      );
      const rawAmount = Number(gameData.amount);
      const amount = Number.isFinite(rawAmount) && rawAmount >= 0 ? rawAmount : 0;
      let participants: string[] = [];
      if (gameData.game_address) {
        try {
          participants = this.gameDb.getGameParticipants(gameData.game_address) ?? [];
        } catch (participantError) {
          console.error(
            "Error retrieving participants for completed game:",
            participantError
          );
        }
      }
      const currentTickets = participants.length;
      const storedMax = Number(gameData.max_players);
      const maxTickets = Number.isFinite(storedMax) && storedMax > 0
        ? storedMax
        : Math.max(currentTickets, 0);
      const playerCountDisplay = maxTickets > 0
        ? `${currentTickets}/${maxTickets}`
        : `${currentTickets}`;
      const gameTypeText = formatGameTypeWithEmoji(gameData.game_type);
      const tokenTicker = gameData.token_ticker || "WSOL";
      let formatBalanceForDisplay = (value: number) =>
        this.wallet.formatTokenBalance(value, 6);
      if (gameData.game_address) {
        try {
          const resolver = await this.resolveTokenFormattingInfo(
            new PublicKey(gameData.game_address),
            tokenTicker,
            gameData.token_mint
          );
          formatBalanceForDisplay = resolver.formatBalance;
        } catch (resolveError) {
          console.error(
            "Error resolving token formatting for completed game:",
            resolveError
          );
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
        const winnerUsername = await this.getPlayerUsername(
          ctx,
          gameData.winner_address
        );
        const safeWinner = escapeHtml(
          sanitizeTelegramDisplayNameWithoutMention(winnerUsername)
        );
        winnerLine = `Winner: ${safeWinner}`;
      }

      const amountDisplay = formatCompactTokenDisplay(
        formatBalanceForDisplay(amount)
      );
      const safeAmountDisplay = escapeHtml(amountDisplay);
      const safeTicker = escapeHtml(tokenTicker);
      const safeCreator = escapeHtml(creatorLabel);
      const safePlayerCount = escapeHtml(playerCountDisplay);
      let message =
        `${gameTypeText} • ${safeAmountDisplay} ${safeTicker}` +
        `\nCreator: ${safeCreator} • ${safePlayerCount} tickets`;
      if (participants.length > 0) {
        try {
          const participantNames = await Promise.all(
            participants.map(async (telegramId) => {
              const username = await this.getUsernameFromTelegramId(
                ctx,
                telegramId
              );
              return username
                ? sanitizeTelegramDisplayNameWithoutMention(username)
                : `Player ${telegramId.slice(0, 6)}...`;
            })
          );
          const participantsList = buildParticipantsList(participantNames);
          if (participantsList) {
            message += participantsList;
            if (message.endsWith("\n")) {
              message = message.slice(0, -1);
            }
          }
        } catch (participantError) {
          console.error(
            "Error retrieving participants for completed game:",
            participantError
          );
        }
      }

      if (winnerLine) {
        message += `\n\n${winnerLine}`;
      }

      return message;
    } catch (error) {
      console.error("Error formatting completed game info:", error);
      return "❌ Error loading game details";
    }
  }

  public async createGame(
    gameType: GameType,
    parsedAmount: {
      amount: number;
      tokenMint: string;
      tokenTicker: string;
      isSol: boolean;
      requestedNativeSol?: boolean;
    },
    maxTickets: number,
    minTickets: number,
    timeout: number,
    telegramId: bigint,
    options?: { isPrivate?: boolean },
    chatId?: number,
    requestTimestampMs: number = Date.now()
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
    const activeGameCount = this.gameDb.countActiveGamesByCreator(
      telegramIdStr
    );

    if (
      activeGameCount + inFlightCount >= MAX_ACTIVE_GAMES_PER_CREATOR
    ) {
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
      safeRequestTimestamp - GAME_CREATION_RATE_LIMIT_WINDOW_MS
    );
    const pendingRequestTimestamp = Math.max(safeRequestTimestamp, nowMs);

    const pendingCount = this.prunePendingCreationRequests(
      telegramIdStr,
      windowStart
    );
    const recentCreationCount = this.gameDb.countRecentGamesByCreator(
      telegramIdStr,
      windowStart
    );

    const totalWindowCreations = pendingCount + recentCreationCount;

    if (totalWindowCreations >= MAX_GAMES_PER_CREATOR_WINDOW) {
      const windowLabel = formatRateLimitWindow(
        GAME_CREATION_RATE_LIMIT_WINDOW_MS
      );
      return {
        success: false,
        error: `Game creation rate limit reached. You have ${totalWindowCreations} game creation${
          totalWindowCreations === 1 ? "" : "s"
        } in the last ${windowLabel} (maximum ${MAX_GAMES_PER_CREATOR_WINDOW}). Please wait before creating a new game.${
          pendingCount > 0
            ? " Some requests are still processing."
            : ""
        }`,
      };
    }

    this.trackPendingCreationRequest(
      telegramIdStr,
      pendingRequestTimestamp
    );
    this.incrementInFlightCreations(telegramIdStr);

    try {
      const { tokenMint, tokenTicker, amount } = parsedAmount;
      const requestedSol =
        parsedAmount.requestedNativeSol === true || tokenMint === WSOL_MINT;

      const metadata = await this.wallet.getTokenMetadata(tokenMint);
      const playerKp = this.wallet.getKeyPair(telegramId);
      const [minSolBuffer, gameRentLamports] = await Promise.all([
        this.feeBudget.getGameSafetyBufferLamports(),
        this.getGameCreationRentLamports(),
      ]);
      const requiredSolReserveLamports = minSolBuffer + gameRentLamports;

      let [tokenBalance, solBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, tokenMint),
        this.wallet.getBalance(telegramId),
      ]);

      if (requestedSol) {
        const ensured = await this.ensureWrappedSolBalance(
          telegramId,
          amount,
          tokenBalance,
          solBalance,
          "create",
          requiredSolReserveLamports
        );

        if (!ensured.success) {
          return { success: false, error: ensured.error };
        }

        tokenBalance = ensured.tokenBalance;
        solBalance = ensured.solBalance;
      }

      if (tokenBalance < amount) {
        const friendlyTokenBalance = this.wallet.formatTokenBalance(
          tokenBalance,
          metadata.decimals
        );
        const friendlyRequired = this.wallet.formatTokenBalance(
          amount,
          metadata.decimals
        );
        const friendlySolBalance = this.wallet.formatSolBalance(solBalance);
        console.warn(
          `⚠️ Token balance check failed (${tokenTicker}). have=${friendlyTokenBalance} ${tokenTicker}, need=${friendlyRequired}${tokenTicker}, detected SOL=${friendlySolBalance}`
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
      const reservedTicketAmount = amount;
      const swapAllowanceRaw = Math.max(tokenBalance - reservedTicketAmount, 0);

      let lamportsBalance = solBalance;
      if (lamportsBalance < requiredSolReserveLamports) {
        if (swapAllowanceRaw <= 0) {
          const formattedStake = this.wallet.formatTokenBalance(
            reservedTicketAmount,
            metadata.decimals
          );

          const shortfallMessage = this.buildSolShortfallMessage({
            currentLamports: solBalance,
            requiredLamports: requiredSolReserveLamports,
            reason: "Creating a game requires a SOL reserve for rent and fees",
            nextSteps:
              "Add more SOL or swap extra tokens for fees before trying again.",
          });

          const safeStake = escapeHtml(formattedStake);
          const safeTicker = escapeHtml(tokenTicker);
          return {
            success: false,
            error: `${shortfallMessage}

You currently have ${safeStake} ${safeTicker} reserved for the ticket and no spare tokens to convert into SOL fees.`,
          };
        }

        const jitResult = await this.swapManager.performJustInTimeSolSwap({
          userKeypair: playerKp,
          tokenMint,
          tokenDecimals: metadata.decimals,
          availableTokenAmountRaw: swapAllowanceRaw,
          desiredLamports: requiredSolReserveLamports,
          tokenTicker,
          logContext: `create ${gameType} game`,
        });

        if (!jitResult.swapped) {
          if (jitResult.error) {
            return { success: false, error: jitResult.error };
          }

          return {
            success: false,
            error:
              "Unable to top up SOL balance automatically. Add SOL manually and try again.",
          };
        }

        tokenBalance = await this.wallet.getTokenBalance(telegramId, tokenMint);

        if (tokenBalance < amount) {
          const remainingBalance = this.wallet.formatTokenBalance(
            tokenBalance,
            metadata.decimals
          );
          const requiredBalance = this.wallet.formatTokenBalance(
            amount,
            metadata.decimals
          );
          return {
            success: false,
            error: `Swap completed but only ${escapeHtml(
              remainingBalance
            )} ${escapeHtml(
              tokenTicker
            )} remain, which is below the required ${escapeHtml(
              requiredBalance
            )}. Please top up your tokens and try again.`,
          };
        }

        this.wallet.clearCachedWalletData?.(telegramId);

        lamportsBalance = await this.wallet.getBalance(telegramId, {
          forceFresh: true,
        });
        solBalance = lamportsBalance;
        if (lamportsBalance < requiredSolReserveLamports) {
          return {
            success: false,
            error: this.buildSolShortfallMessage({
              currentLamports: lamportsBalance,
              requiredLamports: requiredSolReserveLamports,
              reason: "Just-in-time swap did not leave enough SOL for the rent and fee reserve",
              nextSteps: "Add more SOL to continue.",
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
      const gamePda = PDAManager.getGamePDA(
        randomHashBuffer,
        this.program.programId
      );
      const tokenAccounts = await this.resolveGameTokenAccounts(tokenMintPubkey);
      const gameTokenCtx = this.buildGameTokenContext(
        tokenMintPubkey,
        tokenAccounts
      );
      const creatorTokenAccount = await this.deriveAta(
        tokenMintPubkey,
        playerKp.publicKey,
        tokenAccounts.tokenProgram
      );
      const oraclePda = this.getOraclePda();

      const gameInstruction = await this.program.methods
        .initializeGame(gameConfig, Array.from(randomHashBuffer))
        .accounts(
          {
            game: gamePda,
            creator: playerKp.publicKey,
            oracle: oraclePda,
            gameTokenCtx,
            creatorTokenAccount,
            systemProgram: SystemProgram.programId,
          } as any
        )
        .instruction();

      let tx = await this.wallet.sendTransaction([
        gameInstruction,
      ], [playerKp]);

      debugLog(`📍 Game address: ${gamePda.toBase58()}`);

      tx = await this.confirmTransactionWithRecovery(
        tx,
        gamePda,
        "Game creation",
        undefined,
        async () => {
          const resendGameTransaction = async () => {
            return await this.sendInstructionsWithFallback(
              [gameInstruction],
              [playerKp],
              "Game creation transaction"
            );
          };

          return await resendGameTransaction();
        }
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
        expiresAtMs
      );

      // Auto-join logic based on game type
      let autoJoinResult: { success: boolean; error?: string } | undefined;
      if (gameType === "coinflip") {
        autoJoinResult = await this.handleGameAutoJoinPure(
          gamePda,
          playerKp,
          telegramId,
          creatorPubkey,
          gameType,
          chatId || 0
        );
      } else {
        debugLog(
          `🎁 ${
            gameType.charAt(0).toUpperCase() + gameType.slice(1)
          } game ${gamePda.toBase58()} created - creator not auto-joined`
        );
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
        this.wallet
      );
      return {
        success: false,
        error: userFriendlyError,
      };
    } finally {
      this.decrementInFlightCreations(telegramIdStr);
      this.clearPendingCreationRequest(
        telegramIdStr,
        pendingRequestTimestamp
      );
    }
  }

  private async handleGameAutoJoinPure(
    gamePda: PublicKey,
    playerKp: Keypair,
    telegramId: bigint,
    creatorPubkey: string,
    gameType: string,
    chatId?: number
  ): Promise<{ success: boolean; error?: string }> {
    debugLog(
      `🎮 Auto-joining creator to ${gameType} game ${gamePda.toBase58()}...`
    );

    try {
      let gameAccount = await this.program.account.game.fetch(gamePda);
      const gameAddress = gamePda.toBase58();
      const telegramIdStr = telegramId.toString();
      let joinTx: string | undefined;
      let joinConfirmed = false;
      let pendingRecorded = false;

      if (gameAccount.isPrivate) {
        debugLog(`🔐 Game is private, using authorized join...`);
        const result = await this.joinPrivateGame(
          gamePda,
          playerKp,
          chatId || 0
        );
        if (!result.success) {
          return {
            success: false,
            error: result.error || "Failed to join private game",
          };
        }
        joinTx = result.tx;
        this.gameDb.saveGameParticipant(gameAddress, telegramIdStr, creatorPubkey, {
          status: "pending",
          joinSignature: joinTx ?? null,
          lastVerifiedAt: null,
        });
        pendingRecorded = true;
        joinConfirmed = true;
      } else {
        debugLog(`🌐 Game is public, using regular join...`);
        const maxJoinAttempts = 2;

        for (let attempt = 0; attempt < maxJoinAttempts; attempt++) {
          let setupInstructions: TransactionInstruction[] = [];
          let joinInstructions: TransactionInstruction[] = [];
          try {
            if (attempt > 0) {
              gameAccount = await this.program.account.game.fetch(gamePda);
            }

            const { accounts: joinAccounts, setupInstructions: setupIxs = [] } =
              await this.buildJoinAccounts(
                gamePda,
                gameAccount,
                playerKp.publicKey,
                // Provide a signer for the optional oracleOperator slot to avoid
                // Anchor inserting the default pubkey as a required (unsigned) signer
                // which triggers signature verification failures on public joins.
                playerKp.publicKey
              );
            setupInstructions = setupIxs;
            const joinInstruction = await this.program.methods
              .joinGame()
              .accounts(joinAccounts as any)
              .instruction();
            joinInstructions = [...setupInstructions, joinInstruction];

            joinTx = await this.wallet.sendTransaction(
              joinInstructions,
              [playerKp]
            );

            this.gameDb.saveGameParticipant(
              gameAddress,
              telegramIdStr,
              creatorPubkey,
              {
                status: "pending",
                joinSignature: joinTx ?? null,
                lastVerifiedAt: null,
              }
            );
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
                    "Player join transaction"
                  );
                };

                const refreshedSignature = await resendJoinTransaction();

                this.gameDb.saveGameParticipant(
                  gameAddress,
                  telegramIdStr,
                  creatorPubkey,
                  {
                    status: "pending",
                    joinSignature: refreshedSignature ?? null,
                    lastVerifiedAt: null,
                  }
                );

                return refreshedSignature ?? joinTx;
              }
            );

            joinConfirmed = true;
            break;
          } catch (joinError: any) {
            const message = joinError?.message ?? "";
            const normalized = message.toLowerCase();
            const needsAtaCreation = (setupInstructions ?? []).length > 0;
            const isAtaInitFailure =
              needsAtaCreation &&
              (normalized.includes("associated token account") ||
                normalized.includes("accountnotinitialized") ||
                normalized.includes("uninitialized"));
            const isTimeout =
              normalized.includes("timeout") ||
              normalized.includes("not confirmed");
            const isExpiration =
              normalized.includes("expired before confirmation") ||
              normalized.includes("last valid block height");
            const isLastAttempt = attempt === maxJoinAttempts - 1;

            if ((isTimeout || isExpiration) && !isLastAttempt) {
              const alreadyJoined = await this.isPlayerInGame(
                gamePda,
                playerKp.publicKey
              ).catch(() => false);

              if (alreadyJoined) {
                joinConfirmed = true;
                break;
              }

              console.warn(
                `⚠️ Player join attempt ${attempt + 1} for ${gamePda.toBase58()} ` +
                  `timed out or expired; retrying with a fresh blockhash.`
              );
              continue;
            }

            if (isAtaInitFailure) {
              throw new Error(
                "Failed to initialize your token account for this game. Please try again or ensure you have enough SOL for fees."
              );
            }

            throw joinError;
          }
        }
      }

      if (joinConfirmed) {
        const verified = await this.verifyParticipantJoin(
          gamePda,
          playerKp.publicKey,
          telegramIdStr,
          { joinSignature: joinTx ?? null }
        );
        if (verified) {
          return { success: true };
        }

        return {
          success: false,
          error:
            "Join transaction confirmed but participant record is still syncing. We'll retry automatically.",
        };
      } else {
        if (pendingRecorded) {
          this.gameDb.removeGameParticipant(gameAddress, telegramIdStr);
        }
        return {
          success: false,
          error: "Failed to confirm auto-join transaction",
        };
      }
    } catch (joinError: any) {
      try {
        this.gameDb.removeGameParticipant(
          gamePda.toBase58(),
          telegramId.toString()
        );
      } catch (_) {
        // ignore cleanup errors
      }
      const errorMsg = await logAndFormatError(
        joinError,
        `auto-joining creator to ${gameType} game`,
        this.wallet
      );
      return {
        success: false,
        error: `Game created successfully, but failed to auto-join creator!\n\nPlease manually join the game using the "🎮 Join" button.\n\nError: ${errorMsg}`,
      };
    }
  }

  // ================================
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
    gameAccount: any
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
      })`
    );

    // Giveaway: close only if no participants; otherwise wait for oracle completion
    if (gameType === "giveaway") {
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
          console.error(`Error closing expired giveaway:`, error);
        }
      } else {
        if (!bufferElapsed) {
          debugLog(
            "⏳ Giveaway has participants; waiting for oracle to complete."
          );
          return false;
        }
        debugLog(
          "⌛ Giveaway buffer elapsed; awaiting oracle completion."
        );
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
        console.error(
          `Error closing expired ${gameType} with zero tickets:`,
          error
        );
      }
      return false;
    }

    // If there are participants but not enough to complete, try to unjoin them.
    if (!hasEnoughTickets) {
      const didCleanup = await this.handleExpiredCoinflip(
        gamePda,
        gameAccount,
        gamePda.toBase58()
      );
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

    // Has enough tickets -> wait for oracle completion, do not attempt close
    if (!bufferElapsed) {
      debugLog("⏳ Game has minimum tickets; waiting for oracle to complete.");
      return false;
    }

    debugLog("⌛ Buffer elapsed; waiting for oracle completion.");
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
    displayName?: string | null
  ): Promise<{ success: boolean; error?: string; isRoll?: boolean }> {
    try {
      const gamePda = new PublicKey(gameAddress);
      const playerKp = this.wallet.getKeyPair(telegramId);

      // Get game data and validate
      const gameData = this.gameDb.getGame(gameAddress);
      if (!gameData) {
        return { success: false, error: "Game not found!" };
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

      // Balance validation for paid games
      const currentGameType = Object.keys(gameAccount.gameType)[0];
      if (currentGameType === "coinflip") {
        const gameAmount = Number(gameAccount.ticketAmount);
        const metadata = await this.wallet.getTokenMetadata(
          gameData.token_mint
        );
        const minSolBuffer = await this.feeBudget.getGameSafetyBufferLamports();

        let [tokenBalance, solBalance] = await Promise.all([
          this.wallet.getTokenBalance(telegramId, gameData.token_mint),
          this.wallet.getBalance(telegramId),
        ]);

        const normalizedTicker =
          gameData.token_ticker?.toUpperCase?.() ?? "";
        const isSolBackedGame =
          gameData.token_mint === WSOL_MINT &&
          (normalizedTicker === "SOL" || normalizedTicker === "WSOL");

        if (isSolBackedGame) {
          const ensured = await this.ensureWrappedSolBalance(
            telegramId,
            gameAmount,
            tokenBalance,
            solBalance,
            "join"
          );

          if (!ensured.success) {
            return { success: false, error: ensured.error };
          }

          tokenBalance = ensured.tokenBalance;
          solBalance = ensured.solBalance;
        }

        if (tokenBalance < gameAmount) {
          const formattedBalance = this.wallet.formatTokenBalance(
            tokenBalance,
            metadata.decimals
          );
          const formattedNeed = this.wallet.formatTokenBalance(
            gameAmount,
            metadata.decimals
          );
          const safeTicker = escapeHtml(gameData.token_ticker);
          return {
            success: false,
            error: `❌ Not enough ${safeTicker}. You have ${formattedBalance} but need ${formattedNeed}. Add more ${safeTicker} or reduce the amount and try again.`,
          };
        }

        const reservedTicketAmount = gameAmount;
        const swapAllowanceRaw = Math.max(tokenBalance - reservedTicketAmount, 0);

        let lamportsBalance = solBalance;
        if (lamportsBalance < minSolBuffer) {
          if (swapAllowanceRaw <= 0) {
            const formattedStake = this.wallet.formatTokenBalance(
              reservedTicketAmount,
              metadata.decimals
            );

            const shortfallMessage = this.buildSolShortfallMessage({
              currentLamports: solBalance,
              requiredLamports: minSolBuffer,
              reason: "Joining this game requires a SOL reserve for rent and transaction fees",
              nextSteps:
                "Add more SOL or swap extra tokens for fees before trying again.",
            });

            return {
              success: false,
              error: `${shortfallMessage}

You currently have ${formattedStake} ${gameData.token_ticker} reserved for the ticket and no spare tokens to convert into SOL fees.`,
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
            tokenBalance = await this.wallet.getTokenBalance(
              telegramId,
              gameData.token_mint
            );

            if (tokenBalance < gameAmount) {
              return {
                success: false,
                error: `Swap completed but only ${this.wallet.formatTokenBalance(
                  tokenBalance,
                  metadata.decimals
                )} ${gameData.token_ticker} remain, which is below the required ${this.wallet.formatTokenBalance(
                  gameAmount,
                  metadata.decimals
                )}. Please top up your tokens and try again.`,
              };
            }

            this.wallet.clearCachedWalletData?.(telegramId);

            const refreshedLamports = await this.wallet.getBalance(telegramId, {
              forceFresh: true,
            });
            lamportsBalance = refreshedLamports;
            solBalance = refreshedLamports;
            if (refreshedLamports < minSolBuffer) {
              return {
                success: false,
                error: this.buildSolShortfallMessage({
                  currentLamports: refreshedLamports,
                  requiredLamports: minSolBuffer,
                  reason: "Just-in-time swap did not leave enough SOL for the rent and fee reserve",
                nextSteps: "Add more SOL to continue.",
                }),
              };
            }
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
        const result = await this.joinPrivateGame(
          gamePda,
          playerKp,
          chatId || 0
        );
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
                playerKp.publicKey
              );
            setupInstructions = setupIxs;
            const joinInstruction = await this.program.methods
              .joinGame()
              .accounts(joinAccounts as any)
              .instruction();
            joinInstructions = [...setupInstructions, joinInstruction];

            joinTx = await this.wallet.sendTransaction(
              joinInstructions,
              [playerKp]
            );
            this.gameDb.saveGameParticipant(
              gameAddress,
              telegramIdStr,
              playerPubkey,
              {
                status: "pending",
                joinSignature: joinTx ?? null,
                lastVerifiedAt: null,
              }
            );
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
                    "Player join transaction"
                  );
                };

                const refreshedSignature = await resendJoinTransaction();

                this.gameDb.saveGameParticipant(
                  gameAddress,
                  telegramIdStr,
                  playerPubkey,
                  {
                    status: "pending",
                    joinSignature: refreshedSignature ?? null,
                    lastVerifiedAt: null,
                  }
                );

                return refreshedSignature ?? joinTx;
              }
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
              const alreadyJoined = await this.isPlayerInGame(
                gamePda,
                playerKp.publicKey
              ).catch(() => false);

              if (alreadyJoined) {
                joinConfirmed = true;
                break;
              }

              console.warn(
                `⚠️ Player join attempt ${attempt + 1} for ${gameAddress} timed out; retrying with a fresh blockhash.`
              );
              continue;
            }

            if (isAtaInitFailure) {
              throw new Error(
                "Failed to initialize your token account for this game. Please try again or ensure you have enough SOL for fees."
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
          error:
            "Join transaction is still pending on Solana. Tap Refresh or try again shortly.",
        };
      }

      // Update database
      if (normalizedDisplayName) {
        this.gameDb.savePlayerMapping(
          playerPubkey,
          telegramIdStr,
          normalizedDisplayName
        );
      } else {
        this.gameDb.savePlayerMapping(playerPubkey, telegramIdStr);
      }
      const verified = await this.verifyParticipantJoin(
        gamePda,
        playerKp.publicKey,
        telegramIdStr,
        { joinSignature: joinTx ?? null }
      );

      if (!verified) {
        return {
          success: false,
          error:
            "Join transaction confirmed but participant record is still syncing. We'll retry automatically.",
        };
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
        this.wallet
      );
      return { success: false, error: userFriendlyError };
    }
  }

  /**
   * Enhanced unjoin game method with all validation
   */
  public async unjoinGame(
    gameAddress: string,
    telegramId: bigint
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
      await this.unjoinPlayerFromGame(
        gamePda,
        playerKp,
        playerKp.publicKey,
        telegramId.toString()
      );

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

      const closeAccounts = await this.buildCloseGameAccounts(
        gamePda,
        gameAccount
      );
      const closeInstruction = await this.program.methods
        .closeGame()
        .accounts(closeAccounts as any)
        .instruction();

      const sendCloseTransaction = async () => {
        return await this.sendInstructionsWithFallback(
          [closeInstruction],
          [creatorKp],
          `${gameType} close transaction`,
          { skipConfirmation: true }
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
            `${gameType} close transaction`
          )
      );

      const successMessage =
        successPrefix ?? `✅ Successfully closed ${gameType} game`;
      debugLog(`${successMessage} ${address} with tx: ${tx}`);

      return { success: true, tx };
    } catch (error: any) {
      const failureMessage =
        failurePrefix ?? `❌ Failed to close ${gameType} game`;
      console.error(
        `${failureMessage} ${address}:`,
        error?.message ?? error
      );
      return { success: false, error: error?.message ?? String(error) };
    }
  }

  public async cancelGameWithPlayerKeys(
    gamePda: PublicKey,
    gameType: string
  ): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const gameAddress = gamePda.toBase58();

      // Step 2: Close the game using creator's key to recover remaining rent
      const creatorPubkey = gameAccount.creator.toBase58();
      const creatorTelegramId = this.gameDb.getPlayerTelegramId(creatorPubkey);

      if (!creatorTelegramId) {
        debugLog(
          `No telegram ID found for creator ${creatorPubkey}, cannot close game`
        );
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
      console.error(
        `❌ Error closing ${gameType} game ${gamePda.toBase58()}:`,
        error
      );
      return { success: false, error: error.message };
    }
  }

  private async unjoinPlayerFromGame(
    gamePda: PublicKey,
    authorityKp: Keypair,
    playerPubkey: PublicKey,
    playerTelegramId?: string,
    options?: { skipDbCheck?: boolean }
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
        `Failed to fetch game account for ${gameAddress}: ${
          error?.message ?? error
        }`
      );
    }

    const knownIds = new Set(participantIds);
    if (playerTelegramId) {
      knownIds.add(playerTelegramId);
    }

    try {
      this.recoverParticipantsFromHashes(gamePda, gameAccount, knownIds);
    } catch (error) {
      console.warn(
        `⚠️ Unable to reconcile participant hashes for ${gameAddress}:`,
        error
      );
    }

    if (skipDbChecks && playerTelegramId) {
      const existingMapping = this.gameDb.getPlayerPublicKey(playerTelegramId);
      if (existingMapping !== playerPubkeyBase58) {
        try {
          this.gameDb.savePlayerMapping?.(
            playerPubkeyBase58,
            playerTelegramId
          );
        } catch (error) {
          console.warn(
            `⚠️ Failed to persist mapping for ${playerTelegramId} during cleanup:`,
            error
          );
        }
      }
    }

    const creatorPubkeyFromAccount =
      typeof gameAccount?.creator === "string"
        ? new PublicKey(gameAccount.creator)
        : gameAccount?.creator ?? null;

    if (skipDbChecks) {
      const isPlayerAuthority = authorityKp.publicKey.equals(playerPubkey);
      const isCreatorAuthority =
        !!creatorPubkeyFromAccount &&
        authorityKp.publicKey.equals(creatorPubkeyFromAccount);

      if (!isPlayerAuthority && !isCreatorAuthority) {
        throw new Error(
          "Unauthorized unjoin attempt during cleanup; authority must be player or creator."
        );
      }
    }

    const unjoinAccounts = await this.buildUnjoinAccounts(
      gamePda,
      gameAccount,
      playerPubkey,
      authorityKp.publicKey
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
        { skipConfirmation: true }
      );
    };

    let tx = await sendUnjoinTransaction();

    tx = await this.confirmTransactionWithRecovery(
      tx,
      gamePda,
      "Player unjoin",
      playerPubkey,
      async () =>
        await this.sendInstructionsWithFallback(
          [unjoinInstruction],
          [authorityKp],
          "Player unjoin transaction"
        )
    );

    const resolvedTelegramId =
      playerTelegramId ??
      this.gameDb.getPlayerTelegramId(playerPubkeyBase58) ??
      null;

    if (resolvedTelegramId) {
      try {
        this.gameDb.removeGameParticipant(gameAddress, resolvedTelegramId);
        debugLog(
          `Unjoined player ${resolvedTelegramId} from game participants tracking`
        );
      } catch (error) {
        console.warn(
          "⚠️ Failed to remove participant " + resolvedTelegramId + " from local DB for " + gameAddress + ":",
          error
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
    chatId: number
  ): Promise<{
    success: boolean;
    tx?: string;
    error?: string;
  }> {
    try {
      const authResult = await this.oracleClient.authorizePlayer(
        gamePda,
        chatId
      );

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

      const adminKp = authResult.adminKeypair!;
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
              adminKp.publicKey
            );
          setupInstructions = setupIxs;

          const joinInstruction = await this.program.methods
            .joinGame()
            .accounts(joinAccounts as any)
            .instruction();
          joinInstructions = [...setupInstructions, joinInstruction];

          lastSignature = await this.wallet.sendTransaction(
            joinInstructions,
            [playerKp, adminKp]
          );

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
                  "Player join transaction"
                );
              };

              return await resendJoinTransaction();
            }
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
          const isTimeout =
            normalized.includes("timeout") ||
            normalized.includes("not confirmed");
          const isExpiration =
            normalized.includes("expired before confirmation") ||
            normalized.includes("last valid block height");
          const isLastAttempt = attempt === maxAttempts - 1;

          if ((isTimeout || isExpiration) && !isLastAttempt) {
            const alreadyJoined = await this.isPlayerInGame(
              gamePda,
              playerKp.publicKey
            ).catch(() => false);

            if (alreadyJoined) {
              return { success: true, tx: lastSignature };
            }

            console.warn(
              `⚠️ Player join attempt ${attempt + 1} for ${gamePda.toBase58()} ` +
                `timed out or expired; retrying with a fresh blockhash.`
            );
            continue;
          }

          if (isAtaInitFailure) {
            throw new Error(
              "Failed to initialize your token account for this game. Please try again or ensure you have enough SOL for fees."
            );
          }

          throw joinError;
        }
      }

      return {
        success: false,
        error:
          "Join transaction is still pending on Solana. Tap Refresh or try again shortly.",
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
    telegramId: bigint
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
    const validActiveGames = await this.processActiveGames(
      ctx,
      activeGamesData
    );
    const activeGamesSection =
      validActiveGames.length > 0
        ? "🎮 <b>Active Games</b>\n\n" + validActiveGames.join("\n\n")
        : "";

    // Recent games
    const validRecentGames = await this.processRecentGames(
      ctx,
      recentGamesData,
      telegramIdStr,
      playerPublicKey
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

  private async formatActiveGamesList(
    ctx: Context,
    activeGamesData: any[]
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

        const creatorUsername = await this.getGameCreatorUsername(
          ctx,
          gameData.game_address
        );

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
          { suppressMentions: true }
        );
        let currentTickets: number | undefined;
        let maxTickets: number | undefined;
        let minTickets: number | undefined;
        try {
          const stats = await this.getActiveGameStats(
            gamePda,
            Number(gameData.amount) || 0,
            undefined
          );
          currentTickets = stats?.currentTickets;
          maxTickets = stats?.maxTickets;
          minTickets = stats?.minTickets;
        } catch (statError) {
          console.warn(
            "Failed to fetch game stats for active list:",
            statError
          );
        }

        return {
          messageText,
          keyboard,
          gameAddress: gameData.game_address,
          currentTickets,
          maxTickets,
          minTickets,
        };
      })
    );

    return formattedGames.filter(
      (game): game is ActiveGameRow => game !== null
    );
  }

  public async getChatActiveGames(
    ctx: Context,
    chatId: number
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

    // Filter for public games
    const publicGames = allGames.filter((game) => !game.account.isPrivate);

    // Map to GameData-like structure
    const activeGamesData = await Promise.all(
      publicGames.map(async (game) => {
        const account = game.account;
        const gameType = Object.keys(account.gameType)[0] || "game";
        const tokenMint = account.tokenMint.toBase58();

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
          amount: Number(account.ticketAmount),
          token_mint: tokenMint,
          token_ticker: tokenTicker,
          status: "active", // Assumed active if account exists
          winner_address: undefined, // Not in Game account
        };
      })
    );

    return this.formatActiveGamesList(ctx, activeGamesData);
  }


  private async processActiveGames(
    ctx: Context,
    activeGamesData: any[]
  ): Promise<string[]> {
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
      })
    );

    return activeGames.filter((game): game is string => game !== null);
  }

  private async processRecentGames(
    ctx: Context,
    recentGamesData: any[],
    telegramIdStr: string,
    playerPublicKey: string
  ): Promise<any[]> {
    const recentGames = await Promise.all(
      recentGamesData.map(async (gameData) => {
        try {
          const category = categorizeGame(
            gameData,
            telegramIdStr,
            playerPublicKey
          );
          const gameInfo = await this.getCompletedGameInfo(ctx, gameData);
          return { category, gameInfo, completedAt: gameData.completed_at };
        } catch (error) {
          console.error(
            "Error processing game " + gameData.game_address + ":",
            error
          );
          return null;
        }
      })
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
      lines.push("", "<i>+" + remaining + " more game" + (remaining === 1 ? "" : "s") + " not shown</i>");
    }

    return lines.join("\n") + "\n";
  }

  // ================================
  // RELOAD FUNCTIONALITY
  // ================================

  public async reloadGameMessages(): Promise<void> {
    const allGames = this.gameDb.getAllGames();
    try {
      for (const game of allGames) {
        if (game.message_id && game.chat_id) {
          this.activeGameMessages.set(game.game_address, {
            messageId: game.message_id,
            chatId: game.chat_id,
          });
        }
      }
      debugLog("Reloaded " + this.activeGameMessages.size + " game messages");
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
        "🏁 Blockchain scan completed. Cancelled " + cancelledCount + "/" + orphanedGames.length + " orphaned games"
      );
    } catch (error) {
      console.error("❌ Error during blockchain scan:", error);
    }
  }

  private async findOrphanedGames(): Promise<
    { address: string; account: any }[]
  > {
    const orphanedGames: { address: string; account: any }[] = [];

    try {
      const allGameAccounts = await this.program.account.game.all();

      for (const gameAccountInfo of allGameAccounts) {
        const gameAddress = gameAccountInfo.publicKey.toBase58();
        const gameAccount = gameAccountInfo.account;

        // Check if this game is in our database
        if (!this.gameDb.gameExists(gameAddress)) {
          debugLog(
            "🔍 Found orphaned game: " + gameAddress + " (" + gameAccount.ticketsCount + "/" + gameAccount.maxTickets + ")"
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
        "🔄 Processing expired " + gameType + " game " + address + " (" + gameAccount.ticketsCount + "/" + gameAccount.maxTickets + ")"
      );

      if (!bufferElapsed && ticketsCount >= minTickets && minTickets > 0) {
        debugLog(
          "⏳ Game has enough participants, waiting for oracle before cleanup"
        );
        return false;
      }

      return gameType === "giveaway"
        ? await this.handleExpiredGiveaway(gamePda, gameAccount, address)
        : await this.handleExpiredCoinflip(gamePda, gameAccount, address);
    } catch (error: any) {
      return this.handleGameProcessingError(error, address);
    }
  }

  public static isExpired(
    gameAccount: any,
    currentTimeSeconds?: number
  ): boolean {
    const currentTime =
      currentTimeSeconds ?? Math.floor(Date.now() / 1000);
    const createdAt = Number(gameAccount.createdAt ?? 0);
    const timeout = Number(gameAccount.timeout ?? 0);
    const expiresAt = createdAt + timeout;
    return currentTime > expiresAt;
  }

  public static isExpiredWithBuffer(
    gameAccount: any,
    currentTimeSeconds?: number
  ): boolean {
    const currentTime =
      currentTimeSeconds ?? Math.floor(Date.now() / 1000);
    const createdAt = Number(gameAccount.createdAt);
    const timeout = Number(gameAccount.timeout);
    const expiresAt = createdAt + timeout;
    return currentTime > expiresAt + GAME_EXPIRATION_BUFFER_TIME;
  }

  private isGameExpiredWithBuffer(gameAccount: any): boolean {
    return GameManager.isExpiredWithBuffer(gameAccount);
  }

  private getGameType(gameAccount: any): string {
    const gameTypeKeys = Object.keys(gameAccount.gameType);
    return gameTypeKeys[0] || "unknown";
  }

  private handleGameProcessingError(error: any, address: string): boolean {
    if (error.message?.includes("Account does not exist")) {
      debugLog("ℹ️ Orphaned game " + address + " was already closed");
      return true;
    } else {
      console.error(
        "❌ Error processing orphaned game " + address + ":",
        error.message
      );
      return false;
    }
  }

  private async handleExpiredGiveaway(
    gamePda: PublicKey,
    gameAccount: any,
    address: string
  ): Promise<boolean> {
    const gameType = this.getGameType(gameAccount);
    const ticketsCount = Number(gameAccount.ticketsCount ?? 0);

    if (ticketsCount === 0) {
      const immediateResult = await this.cancelGameWithPlayerKeys(
        gamePda,
        gameType
      );
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
      "🔄 Processing expired " + gameType + " game " + address + " (" + gameAccount.ticketsCount + "/" + gameAccount.maxTickets + ")"
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
    address: string
  ): Promise<boolean> {
    const onChainTickets = Number(gameAccount.ticketsCount ?? 0);
    const onChainHashes = Array.isArray(gameAccount.participantHashes)
      ? gameAccount.participantHashes.length
      : 0;
    const dbParticipantsSnapshot = this.gameDb.getGameParticipants(address);
    await this.reconcilePendingParticipants(gamePda);
    const playerKeyInfo = this.analyzePlayerKeys(gamePda, gameAccount, address);
    const effectiveOnChainTickets =
      playerKeyInfo.onChainTickets ?? onChainTickets;
    const effectiveOnChainHashes =
      playerKeyInfo.onChainParticipantHashes ?? onChainHashes;
    const effectiveDbParticipants =
      playerKeyInfo.dbParticipantCount ?? dbParticipantsSnapshot.length;

    debugLog(
      "🪙 Coinflip " + address + ": " + playerKeyInfo.available.length + "/" + playerKeyInfo.total + " player keys available (on-chain tickets: " + effectiveOnChainTickets + ", on-chain hashes: " + effectiveOnChainHashes + ", db participants: " + effectiveDbParticipants + ")"
    );

    if (effectiveOnChainTickets !== effectiveOnChainHashes) {
      console.warn(
        "⚠️ Participant hash mismatch for " + address + ": on-chain tickets " + effectiveOnChainTickets + ", hash list length " + effectiveOnChainHashes
      );
    }

    if (effectiveOnChainTickets !== effectiveDbParticipants) {
      console.warn(
        "⚠️ Database mismatch for " + address + ": on-chain tickets " + effectiveOnChainTickets + ", local participants " + effectiveDbParticipants
      );
    }

    if (
      Array.isArray(playerKeyInfo.unmatchedHashes) &&
      playerKeyInfo.unmatchedHashes.length > 0
    ) {
      console.warn(
        "⚠️ Unable to map " + playerKeyInfo.unmatchedHashes.length + " participant hash(es) for " + address
      );
    }

    if (effectiveOnChainTickets === 0) {
      const staleParticipants = this.gameDb.getGameParticipants(address);
      if (staleParticipants.length > 0) {
        console.warn(
          "⚠️ Clearing " + staleParticipants.length + " stale participant(s) from local DB for " + address
        );
        for (const telegramId of staleParticipants) {
          try {
            this.gameDb.removeGameParticipant(address, telegramId);
          } catch (error) {
            console.warn(
              "⚠️ Failed to remove participant " + telegramId + " from local DB for " + address + ":",
              error
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
        creatorTelegramId =
          this.gameDb.getPlayerTelegramId?.(creatorPubkey.toBase58()) ?? null;
      }

      if (
        !creatorTelegramId &&
        typeof this.gameDb.getCreatorInfo === "function"
      ) {
        const info = this.gameDb.getCreatorInfo(address);
        if (info?.telegramId) {
          creatorTelegramId = info.telegramId;
        }
      }

      if (!creatorTelegramId) {
        console.warn(
          "⚠️ Cannot cancel " + address + ": creator Telegram ID is missing from local data"
        );
        return false;
      }

      return await this.cancelGameWithCreator(
        gamePda,
        gameAccount,
        creatorTelegramId,
        address,
        "coinflip"
      );
    }

    // Strategy 1: Complete cleanup (unjoin all non-creators, then cancel)
    if (playerKeyInfo.canCompleteCleanup) {
      return await this.executeCompleteCleanup(
        gamePda,
        gameAccount,
        playerKeyInfo,
        address
      );
    }

    // Strategy 2: Partial cleanup (unjoin available players only)
    return await this.executePartialCleanup(
      gamePda,
      gameAccount,
      playerKeyInfo,
      address
    );
  }

  private analyzePlayerKeys(
    gamePda: PublicKey,
    gameAccount: any,
    gameAddress: string
  ) {
    // Get players from database since contract no longer stores players array
    const dbParticipants = this.getGamePlayers(gameAddress);
    const participantTelegramIds = new Set(dbParticipants);
    const onChainTickets = Number(gameAccount.ticketsCount ?? 0);
    let creatorPubkey: PublicKey | null = null;
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
        creatorTelegramId =
          this.gameDb.getPlayerTelegramId?.(creatorPubkey.toBase58()) ?? null;
        if (creatorTelegramId) {
          participantTelegramIds.add(creatorTelegramId);
        } else {
          console.warn(
            "⚠️ Unable to resolve creator Telegram ID for orphaned game " + gameAddress
          );
        }
      } catch (error) {
        console.warn(
          "⚠️ Failed to look up creator Telegram ID for " + gameAddress + ":",
          error
        );
      }
    }

    const onChainParticipantHashes = Array.isArray(gameAccount.participantHashes)
      ? gameAccount.participantHashes.length
      : 0;

    const { unmatchedHashes } = this.recoverParticipantsFromHashes(
      gamePda,
      gameAccount,
      participantTelegramIds
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
        const isCreator =
          !!creatorPubkey && playerPubkey.equals(creatorPubkey);

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

    if (unmatchedHashes.length > 0) {
      for (const hash of unmatchedHashes) {
        unavailable.push("hash:" + hash);
      }
    }

    const totalParticipants = Math.max(
      participantTelegramIds.size,
      onChainParticipantHashes,
      onChainTickets,
      creatorPubkey ? 1 : 0
    );

    const nonCreators = available.filter((p) => !p.isCreator);
    const creator = available.find((p) => p.isCreator);
    const canCompleteCleanup =
      unavailable.length === 0 && creator !== undefined;

    return {
      available,
      unavailable,
      nonCreators,
      creator,
      canCompleteCleanup,
      total: totalParticipants,
      onChainTickets,
      onChainParticipantHashes,
      dbParticipantCount: dbParticipants.length,
      unmatchedHashes,
    };
  }

  private async executeCompleteCleanup(
    gamePda: PublicKey,
    gameAccount: any,
    playerKeyInfo: any,
    address: string
  ): Promise<boolean> {
    debugLog(
      "🔧 Strategy 1: Complete cleanup - unjoin all " + playerKeyInfo.available.length + " players, then cancel"
    );

    // Unjoin ALL players including creator for coinflip games
    const unjoinedCount = await this.unjoinPlayers(
      gamePda,
      gameAccount,
      playerKeyInfo.available,
      playerKeyInfo.creator?.telegramId
    );

    // Only proceed if all players were successfully unjoined
    if (unjoinedCount !== playerKeyInfo.available.length) {
      debugLog(
        "❌ Could only unjoin " + unjoinedCount + "/" + playerKeyInfo.available.length + " players from coinflip " + address + ", skipping cancellation"
      );
      return false;
    }

    // Cancel with creator
    return await this.cancelGameWithCreator(
      gamePda,
      gameAccount,
      playerKeyInfo.creator.telegramId,
      address,
      "coinflip"
    );
  }

  private async executePartialCleanup(
    gamePda: PublicKey,
    gameAccount: any,
    playerKeyInfo: any,
    address: string
  ): Promise<boolean> {
    debugLog(
      "🔧 Strategy 2: Partial cleanup - unjoin " + playerKeyInfo.available.length + " available players"
    );

    const unjoinedCount = await this.unjoinPlayers(
      gamePda,
      gameAccount,
      playerKeyInfo.available,
      playerKeyInfo.creator?.telegramId
    );
    debugLog(
      "📊 Unjoined " + unjoinedCount + "/" + playerKeyInfo.available.length + " players from coinflip " + address
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
    creatorTelegramId?: string
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
          error
        );
      }
    }

    const dbGame = this.gameDb.getGame(gameAddress);
    const resolvedTickerRaw =
      (dbGame?.token_ticker && dbGame.token_ticker.trim().length > 0
        ? dbGame.token_ticker
        : undefined) ??
      (tokenMintStr &&
      tokenMintStr.toLowerCase() === WSOL_MINT.toLowerCase()
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
              "⚠️ Player " + player.pubkey.toBase58() + " lacks SOL for unjoin: " + preparation.reason + (fallbackAvailable ? " Falling back to creator authority." : " Attempting with remaining balance.")
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
              { skipDbCheck: true }
            );
            debugLog(
              "➡️ Unjoined " + (player.isCreator ? "creator" : "player") + " " + player.pubkey.toBase58()
            );
            unjoinedCount++;
            playerSucceeded = true;
          } catch (error) {
            console.error(
              "Failed to unjoin " + player.pubkey.toBase58() + " with player authority:",
              error
            );
          }
        }
      } else {
        console.error(
          "Failed to unjoin " + player.pubkey.toBase58() + ": missing signing authority"
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
              "⚠️ Creator fallback lacks SOL for unjoin: " + creatorPrep.reason + " Attempting with current balance."
            );
          }
        }

        try {
          await this.unjoinPlayerFromGame(
            gamePda,
            creatorAuthority,
            player.pubkey,
            player.telegramId,
            { skipDbCheck: true }
          );
          debugLog(
            "➡️ Unjoined player " + player.pubkey.toBase58() + " using creator authority"
          );
          unjoinedCount++;
          continue;
        } catch (fallbackError) {
          console.error(
            "Failed to unjoin " + player.pubkey.toBase58() + " using creator authority:",
            fallbackError
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
    gameType: string
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
