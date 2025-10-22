import {
  PublicKey,
  Keypair,
  Connection,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { createHash } from "crypto";

import { WalletManager } from "./wallet";
import { GameDatabase } from "./game-database";
import { OracleClient } from "./oracle";
import { PDAManager } from "./pda";
import { formatUserFriendlyError } from "./errors";
import { formatUsdValue as formatUsdValueText } from "./format-amount";
import {
  DEFAULT_NULL_ADDRESS,
  ADDRESS_DISPLAY_LENGTH,
  GAME_INFO_LIMIT,
  GAME_EXPIRATION_BUFFER_TIME,
  MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
  WSOL_MINT,
  getCoinflipVideoId,
  getGiveawayVideoId,
} from "./constants";
import {
  editMediaWithFallback,
  isRecoverableMediaError,
  trySendVideoWithFallback,
} from "./media";
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
import { getPriceUSD } from "./prices";
import { NetworkDetector } from "./network-detector";
import { SwapManager } from "./swap-manager";

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

const WRAP_SOL_FEE_BUFFER_LAMPORTS = 15_000; // ~0.000015 SOL buffer to cover wrap transaction fees

// ================================
// UTILITY FUNCTIONS
// ================================

const logAndFormatError = (
  error: any,
  operation: string,
  walletManager?: WalletManager
): string => {
  console.error(`Error in ${operation}:`, error);
  return walletManager
    ? formatUserFriendlyError(error, walletManager)
    : error.message;
};

const formatGameTypeWithEmoji = (gameType: string): string => {
  switch (gameType.toLowerCase()) {
    case "coinflip":
      return "Coinflip";
    case "giveaway":
      return "Giveaway";

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
  private activeGameMessages = new Map<string, GameMessage>();
  private cachedConnection?: Connection;
  private tokenProgramCache = new Map<string, PublicKey>();

  private constructor(
    private program: anchor.Program<Timba>,
    private wallet: WalletManager,
    private gameDb: GameDatabase,
    private oracleClient: OracleClient,
    private swapManager: SwapManager
  ) {}

  public static getInstance(
    program: anchor.Program<Timba>,
    wallet: WalletManager,
    gameDb: GameDatabase
  ): GameManager {
    if (!GameManager.instance) {
      const oracleClient = OracleClient.getInstance(wallet);
      const maybeGetConnection = (wallet as any).getConnection;
      const connection =
        typeof maybeGetConnection === "function"
          ? maybeGetConnection.call(wallet)
          : (wallet as any).connection ??
            new Connection(
              process.env.SOLANA_NETWORK || "https://api.mainnet-beta.solana.com",
              "confirmed"
            );
      const swapManager = new SwapManager(connection, wallet);
      GameManager.instance = new GameManager(
        program,
        wallet,
        gameDb,
        oracleClient,
        swapManager
      );
      GameManager.instance.cachedConnection = connection;
    }
    return GameManager.instance;
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

  private async buildJoinAccounts(
    gamePda: PublicKey,
    gameAccount: any,
    player: PublicKey,
    oracleOperator?: PublicKey
  ): Promise<Record<string, PublicKey>> {
    const tokenMint = new PublicKey(gameAccount.tokenMint);
    const { tokenProgram, gameToken, gameVault, gameTokenAccount } =
      await this.resolveGameTokenAccounts(tokenMint);
    const playerTokenAccount = await this.deriveAta(
      tokenMint,
      player,
      tokenProgram
    );

    const accounts: Record<string, PublicKey> = {
      game: gamePda,
      player,
      tokenMint,
      gameToken,
      gameVault,
      playerTokenAccount,
      gameTokenAccount,
      oracle: this.getOraclePda(),
      systemProgram: SystemProgram.programId,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    };

    if (oracleOperator) {
      accounts["oracleOperator"] = oracleOperator;
    }

    return accounts;
  }

  private async buildUnjoinAccounts(
    gamePda: PublicKey,
    gameAccount: any,
    player: PublicKey,
    authority: PublicKey
  ): Promise<Record<string, PublicKey>> {
    const accounts = await this.buildJoinAccounts(gamePda, gameAccount, player);
    accounts["authority"] = authority;
    return accounts;
  }

  private async buildCloseGameAccounts(
    gamePda: PublicKey,
    gameAccount: any
  ): Promise<Record<string, PublicKey>> {
    const tokenMint = new PublicKey(gameAccount.tokenMint);
    const { tokenProgram, gameToken, gameVault, gameTokenAccount } =
      await this.resolveGameTokenAccounts(tokenMint);
    const creatorPubkey = new PublicKey(gameAccount.creator);
    const creatorTokenAccount = await this.deriveAta(
      tokenMint,
      creatorPubkey,
      tokenProgram
    );

    return {
      game: gamePda,
      creator: creatorPubkey,
      tokenMint,
      oracle: this.getOraclePda(),
      gameToken,
      gameVault,
      creatorTokenAccount,
      gameTokenAccount,
      systemProgram: SystemProgram.programId,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
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
  ): Array<{ telegramId: string; publicKey: string }> {
    const rawHashes = gameAccount.participantHashes;
    if (!Array.isArray(rawHashes) || rawHashes.length === 0) {
      return [];
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
      return [];
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
      return [];
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
          participant.publicKey
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
      console.log(
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

    return recovered;
  }

  private async resolveTokenFormattingInfo(
    gamePda: PublicKey,
    tokenTicker: string,
    tokenMintHint?: string | null
  ): Promise<{
    formatBalance: (value: number) => string;
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

    if (isSolToken) {
      return {
        formatBalance: (value: number) => this.wallet.formatSolBalance(value),
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
          formatBalance: (value: number) =>
            this.wallet.formatTokenBalance(value, decimals),
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
      formatBalance: (value: number) =>
        this.wallet.formatTokenBalance(value, fallbackDecimals),
      decimals: fallbackDecimals,
      tokenMint,
      isSol: false,
    };
  }

  private formatUsdValue(
    amount: number,
    decimals: number,
    price: number
  ): string | null {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (!Number.isFinite(price) || price <= 0) return null;

    const normalizedAmount = amount / Math.pow(10, decimals);
    const usdValue = normalizedAmount * price;
    if (!Number.isFinite(usdValue) || usdValue <= 0) {
      return null;
    }

    return formatUsdValueText(usdValue, { approximate: true });
  }

  private async getUsdApproximation(
    amount: number,
    decimals: number,
    tokenMint?: string,
    tokenTicker?: string,
    isSol?: boolean
  ): Promise<{ text: string; price: number } | null> {
    const reference = isSol ? "SOL" : tokenMint || tokenTicker;
    if (!reference) return null;
    if (!Number.isFinite(amount) || amount <= 0) return null;
    if (process.env.NODE_ENV === "test") return null;

    try {
      const price = await getPriceUSD(reference);
      if (!price || !isFinite(price) || price <= 0) {
        return null;
      }

      const usdText = this.formatUsdValue(amount, decimals, price);
      if (!usdText) {
        return null;
      }

      return { text: usdText, price };
    } catch (error) {
      console.warn(
        `Failed to compute USD pricing for ${reference}:`,
        error
      );
      return null;
    }
  }

  private async ensureWrappedSolBalance(
    telegramId: bigint,
    requiredLamports: number,
    currentTokenBalance: number,
    currentSolBalance: number,
    context: "create" | "join",
    tokenTicker: string
  ): Promise<
    | { success: true; tokenBalance: number; solBalance: number }
    | { success: false; error: string }
  > {
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

    const projectedRemaining =
      currentSolBalance - deficit - WRAP_SOL_FEE_BUFFER_LAMPORTS;
    if (projectedRemaining < MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS) {
      const formattedDeficit = this.wallet.formatSolBalance(deficit);
      const formattedBuffer = this.wallet.formatSolBalance(
        MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS
      );
      return {
        success: false,
        error: `Not enough SOL to wrap ${formattedDeficit} SOL automatically.\n\nKeep at least ${formattedBuffer} SOL for fees before attempting to ${
          context === "create" ? "create" : "join"
        } a ${tokenTicker} game.`,
      };
    }

    console.log(
      `🔄 Wrapping ${this.wallet.formatSolBalance(
        deficit
      )} SOL into WSOL for game ${context}...`
    );

    try {
      await this.wallet.wrapSol(telegramId, deficit);
    } catch (error) {
      const friendly = formatUserFriendlyError(error, this.wallet);
      return {
        success: false,
        error:
          `Failed to wrap SOL automatically before game ${
            context === "create" ? "creation" : "join"
          }.\n${friendly}`,
      };
    }

    const [updatedTokenBalance, updatedSolBalance] = await Promise.all([
      this.wallet.getTokenBalance(telegramId, WSOL_MINT, {
        createIfMissing: true,
      }),
      this.wallet.getBalance(telegramId),
    ]);

    if (updatedTokenBalance < requiredLamports) {
      return {
        success: false,
        error:
          "Wrap completed but WSOL balance is still below the required stake. Top up SOL and try again.",
      };
    }

    if (updatedSolBalance < MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS) {
      const formattedBuffer = this.wallet.formatSolBalance(
        MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS
      );
      return {
        success: false,
        error: `Wrap completed but SOL balance fell below the safety buffer (${formattedBuffer} SOL). Add SOL for fees and try again.`,
      };
    }

    console.log(
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

  // ================================
  // USERNAME UTILITIES
  // ================================

  /**
   * Format Solana address for display
   */
  private formatAddress(address: string): string {
    return address.length >= 8
      ? `${address.slice(0, 4)}...${address.slice(-4)}`
      : address.slice(0, ADDRESS_DISPLAY_LENGTH) + "...";
  }

  /**
   * Get username from Telegram ID with consistent error handling
   */
  public async getUsernameFromTelegramId(
    ctx: Context,
    telegramId: string
  ): Promise<string | null> {
    try {
      const numericId = parseInt(telegramId, 10);
      if (isNaN(numericId)) {
        throw new Error(`Invalid Telegram ID: ${telegramId}`);
      }

      const chatMember = await ctx.api.getChatMember(ctx.chat!.id, numericId);
      return chatMember.user.username || chatMember.user.first_name || null;
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
        return `@${username}`;
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
    console.log(`🔍 Getting username for publicKey: ${publicKey}`);
    
    const playerTelegramId = this.gameDb.getPlayerTelegramId(publicKey);
    console.log(`🔍 Found telegramId: ${playerTelegramId} for publicKey: ${publicKey}`);
    
    if (!playerTelegramId) {
      console.log(`⚠️ No telegram ID found for publicKey: ${publicKey}`);
      return this.formatAddress(publicKey);
    }

    const username = await this.getUsernameFromTelegramId(
      ctx,
      playerTelegramId
    );
    console.log(`🔍 Found username: ${username} for telegramId: ${playerTelegramId}`);
    
    if (!username) {
      console.log(`⚠️ No username found for telegramId: ${playerTelegramId}`);
      return this.formatAddress(publicKey);
    }

    return `@${username}`;
  }

  // ================================
  // GAME MESSAGE MANAGEMENT
  // ================================

  public getActiveGameMessage(gameAddress: string): GameMessage | undefined {
    return this.activeGameMessages.get(gameAddress);
  }

  private async getActiveGameStats(
    gamePda: PublicKey,
    amount: number,
    providedTotalPot?: number
  ) {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const currentTickets = gameAccount.ticketsCount;
      const maxTickets = gameAccount.maxTickets;
      const minTickets = gameAccount.minTickets;

      // Calculate totalPot based on game type
      let totalPot = providedTotalPot;
      if (!totalPot) {
        const gameType = this.getGameType(gameAccount);
        if (gameType === "giveaway") {
          // For giveaways, totalPot is just the amount (prize from creator)
          totalPot = Number(gameAccount.totalAmount || 0) || amount;
        } else {
          // For coinflips, totalPot = amount * participants
          totalPot = Number(gameAccount.totalAmount || 0) || amount * currentTickets;
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
        totalPot,
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
        totalPot: amount,
        expirationInfo: "",
        tokenMint: undefined,
      };
    }
  }

  private async getCompletedGameStats(
    gamePda: PublicKey,
    amount: number,
    providedTotalPot?: number
  ) {
    const gameAddress = gamePda.toBase58();
    const gameData = this.gameDb.getGame(gameAddress);
    const participants = this.getGamePlayers(gameAddress);
    const currentTickets = participants.length;
    
    // Get game type from database to calculate totalPot correctly
    let totalPot = providedTotalPot;
    if (!totalPot) {
      const gameType = gameData?.game_type || "coinflip"; // default to coinflip if not found
      
      if (gameType === "giveaway") {
        // For giveaways, totalPot is just the amount (prize from creator)
        totalPot = amount;
      } else {
        // For coinflips, totalPot = amount * participants
        totalPot = amount * currentTickets;
      }
    }

    return {
      currentTickets,
      maxTickets: currentTickets,
      minTickets: currentTickets,
      totalPot,
      expirationInfo: "",
      tokenMint: gameData?.token_mint || undefined,
    };
  }

  private async getWinnerInfo(
    ctx: Context,
    status: string,
    winnerAddress?: string,
    winnerSignature?: string
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
    const linkLine = solscanUrl
      ? `\n\n🔗 <a href="${solscanUrl}">View transaction</a>`
      : "";
    return `\n\nWinner: ${winnerUsername}${linkLine}`;
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

    return message;
  }

  public async formatGameMessage(
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
  ): Promise<GameMessageFormat> {
    const isCompleted = status.toLowerCase() === "completed";

    const gameStats = isCompleted
      ? await this.getCompletedGameStats(gamePda, amount, providedTotalPot)
      : await this.getActiveGameStats(gamePda, amount, providedTotalPot);

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
      amount,
      decimals,
      tokenMint,
      tokenTicker,
      isSol
    );

    const winnerInfo = await this.getWinnerInfo(
      ctx,
      status,
      winnerAddress,
      winnerSignature
    );

    const header = buildGameHeader(
      formatGameTypeWithEmoji(gameType),
      formatBalanceForDisplay(amount),
      tokenTicker,
      creatorUsername,
      currentTickets,
      maxTickets,
      usdApproximation?.text
    );
    let messageText = header;

    // Show current prize if different from base amount
    let prizeUsdApproximation: string | null = null;
    if (usdApproximation) {
      prizeUsdApproximation = this.formatUsdValue(
        totalPot,
        decimals,
        usdApproximation.price
      );
    } else if (currentTickets > 0 || totalPot !== amount) {
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
      currentTickets > 0 || totalPot !== amount,
      formatBalanceForDisplay(totalPot),
      tokenTicker,
      prizeUsdApproximation
    );
    messageText += prize;

    // Add list of players if any have joined
    if (currentTickets > 0) {
      try {
        const participants = this.getGamePlayers(gamePda.toBase58());
        if (participants.length > 0) {
          const playerNames = await Promise.all(
            participants.map(async (telegramId) => {
              try {
                const username = await this.getUsernameFromTelegramId(
                  ctx,
                  telegramId
                );
                return username ? `@${username}` : `Player ${telegramId.slice(0, 6)}...`;
              } catch (error) {
                return `Player ${telegramId.slice(0, 6)}...`;
              }
            })
          );
          const participantsList = buildParticipantsList(playerNames);
          if (participantsList) {
            messageText += participantsList;
            if (isCompleted && messageText.endsWith("\n")) {
              messageText = messageText.slice(0, -1);
            }
          }
        }
      } catch (error) {
        console.error("Error getting player list:", error);
      }
    }

    // Add status and expiration info for active games
    if (!isCompleted) {
      const statusText = buildGameStatus(currentTickets, minTickets, maxTickets);
      messageText += `\nStatus: ${statusText}${expirationInfo}`;
    }

    messageText += winnerInfo;

    const keyboard = this.generateGameKeyboard(status, gamePda);

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
    let message: any;
    let usesVideo = false;

    const sendText = async () =>
      ctx.reply(messageText, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
        reply_to_message_id: replyTo,
      });

    if (videoId) {
      const { result, usedFallback } = await trySendVideoWithFallback(
        () =>
          ctx.replyWithVideo(videoId, {
            caption: messageText,
            parse_mode: "HTML",
            reply_markup: replyMarkup,
            reply_to_message_id: replyTo,
          }),
        () => sendText(),
        { logLabel: "game video send" }
      );
      message = result;
      usesVideo = !usedFallback;
    } else {
      message = await sendText();
    }

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

      const inlineKeyboard =
        keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined;
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
      const gameAccount = await this.program.account.game.fetch(gamePda);
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
          : `<code>${creatorPubkey.slice(0, ADDRESS_DISPLAY_LENGTH)}...</code>`;

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
        Number(gameAccount.totalAmount) || undefined
      );

      return messageText;
    } catch (error: any) {
      return `Error fetching game: ${error.message}`;
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
      const amount = Number(gameData.amount);
      const playerCount = gameData.max_players || 2;
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
        ? `@${creatorUsername}`
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
        winnerLine = `Winner: @${winnerUsername}`;
      }

      let message =
        `${gameTypeText} • ${formatBalanceForDisplay(amount)} ${tokenTicker}` +
        `\n👤 Creator: ${creatorLabel} • ${playerCount} tickets`;

      try {
        const participantIds = this.gameDb.getGameParticipants(
          gameData.game_address
        );
        if (participantIds.length > 0) {
          const participantNames = await Promise.all(
            participantIds.map(async (telegramId) => {
              const username = await this.getUsernameFromTelegramId(
                ctx,
                telegramId
              );
              return username
                ? `@${username}`
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
        }
      } catch (participantError) {
        console.error(
          "Error retrieving participants for completed game:",
          participantError
        );
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

  // Helper method for transaction confirmation with timeout recovery
  private async confirmTransactionWithRecovery(
    signature: string,
    gamePda: PublicKey,
    operationType: "Game creation" | "Player join",
    playerPubkey?: PublicKey
  ): Promise<boolean> {
    try {
      await this.wallet.confirmTransaction(signature);
      console.log(`✅ ${operationType} transaction confirmed: ${signature}`);
      return true;
    } catch (confirmError: any) {
      console.warn(
        `⚠️ ${operationType} confirmation failed: ${confirmError.message}`
      );

      // Only try recovery for timeout errors
      if (
        confirmError.message?.includes("timeout") ||
        confirmError.message?.includes("not confirmed")
      ) {
        console.log(
          `🔍 Checking if ${operationType} succeeded despite timeout...`
        );

        await new Promise((resolve) => setTimeout(resolve, 2000));

        try {
          if (operationType === "Game creation") {
            const gameAccount = await this.program.account.game.fetchNullable(
              gamePda
            );

            if (gameAccount) {
              console.log(
                `✅ Game account confirmed after timeout - transaction ${signature}`
              );
              return true;
            }

            throw new Error("Game account not found after timeout");
          } else if (operationType === "Player join" && playerPubkey) {
            const isInGame = await this.isPlayerInGame(gamePda, playerPubkey);
            if (isInGame) {
              console.log(
                `✅ Player join confirmed despite timeout - tx: ${signature}`
              );
              return true;
            }
          }
        } catch (checkError) {
          console.error(
            `❌ ${operationType} verification failed, transaction ${signature} likely failed`
          );
          throw checkError;
        }
      }

      throw confirmError;
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
    chatId?: number
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

    const { tokenMint, tokenTicker, amount } = parsedAmount;
    const requestedSol = parsedAmount.requestedNativeSol === true;

    try {
      const metadata = await this.wallet.getTokenMetadata(tokenMint);
      const playerKp = this.wallet.getKeyPair(telegramId);
      let [tokenBalance, solBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, tokenMint, {
          createIfMissing: true,
        }),
        this.wallet.getBalance(telegramId),
      ]);

      if (requestedSol) {
        const ensured = await this.ensureWrappedSolBalance(
          telegramId,
          amount,
          tokenBalance,
          solBalance,
          "create",
          tokenTicker
        );

        if (!ensured.success) {
          return { success: false, error: ensured.error };
        }

        tokenBalance = ensured.tokenBalance;
        solBalance = ensured.solBalance;
      }

      if (tokenBalance < amount) {
        return {
          success: false,
          error: `Insufficient balance. You have ${this.wallet.formatTokenBalance(
            tokenBalance,
            metadata.decimals
          )} ${tokenTicker} but need ${this.wallet.formatTokenBalance(
            amount,
            metadata.decimals
          )} ${tokenTicker}`,
        };
      }

      const reservedTicketAmount = amount;
      const swapAllowanceRaw = Math.max(tokenBalance - reservedTicketAmount, 0);

      let lamportsBalance = solBalance;
      if (lamportsBalance < MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS) {
        if (swapAllowanceRaw <= 0) {
          const formattedStake = this.wallet.formatTokenBalance(
            reservedTicketAmount,
            metadata.decimals
          );

          return {
            success: false,
            error: `You have exactly ${formattedStake} ${tokenTicker} reserved for the ticket but no spare tokens to cover SOL fees. Add SOL manually or deposit more ${tokenTicker} before trying again.`,
          };
        }

        const jitResult = await this.swapManager.performJustInTimeSolSwap({
          userKeypair: playerKp,
          tokenMint,
          tokenDecimals: metadata.decimals,
          availableTokenAmountRaw: swapAllowanceRaw,
          desiredLamports: MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
          slippageBps: 300,
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

        tokenBalance = await this.wallet.getTokenBalance(
          telegramId,
          tokenMint,
          { createIfMissing: true }
        );

        if (tokenBalance < amount) {
          return {
            success: false,
            error: `Swap completed but only ${this.wallet.formatTokenBalance(
              tokenBalance,
              metadata.decimals
            )} ${tokenTicker} remain, which is below the required ${this.wallet.formatTokenBalance(
              amount,
              metadata.decimals
            )}. Please top up your tokens and try again.`,
          };
        }

        lamportsBalance = await this.wallet.getBalance(telegramId);
        if (lamportsBalance < MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS) {
          return {
            success: false,
            error:
              "Swap executed but SOL balance is still below the safety buffer. Add SOL manually and try again.",
          };
        }
      }

      const creatorPubkey = playerKp.publicKey.toBase58();
      this.gameDb.savePlayerMapping(creatorPubkey, telegramId.toString());

      // Check oracle and generate game secrets
      console.log("🔍 Checking Oracle health for game creation...");
      const isOracleHealthy = await this.oracleClient.isHealthy();
      
      let randomHash: string;
      let randomHashBuffer: Buffer;
      
      if (!isOracleHealthy) {
        return {
          success: false,
          error: "❌ Oracle service is unavailable. Please try again later.",
        };
      } else {
        console.log("✅ Oracle is healthy, generating proper random hash");
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
        isPrivate: true,
      };

      const tokenMintPubkey = new PublicKey(tokenMint);
      const gamePda = PDAManager.getGamePDA(
        randomHashBuffer,
        this.program.programId
      );
      const { tokenProgram, gameToken, gameVault, gameTokenAccount } =
        await this.resolveGameTokenAccounts(tokenMintPubkey);
      const creatorTokenAccount = await this.deriveAta(
        tokenMintPubkey,
        playerKp.publicKey,
        tokenProgram
      );
      const oraclePda = this.getOraclePda();

      const gameInstruction = await this.program.methods
        .initializeGame(gameConfig, Array.from(randomHashBuffer))
        .accounts(
          {
            game: gamePda,
            creator: playerKp.publicKey,
            oracle: oraclePda,
            tokenMint: tokenMintPubkey,
            gameToken,
            gameVault,
            creatorTokenAccount,
            gameTokenAccount,
            systemProgram: SystemProgram.programId,
            tokenProgram,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          } as any
        )
        .instruction();

      const tx = await this.wallet.sendTransaction(
        [gameInstruction],
        [playerKp]
      );

      console.log(`📍 Game address: ${gamePda.toBase58()}`);

      const gameCreationConfirmed = await this.confirmTransactionWithRecovery(
        tx,
        gamePda,
        "Game creation"
      );

      if (!gameCreationConfirmed) {
        return {
          success: false,
          error: "Game creation could not be confirmed",
        };
      }

      // Save game
      this.gameDb.saveGame(
        gamePda.toBase58(),
        telegramId.toString(),
        amount,
        gameType,
        tokenMint,
        tokenTicker,
        maxTickets,
        minTickets,
        chatId
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
        console.log(
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
      const userFriendlyError = logAndFormatError(
        error,
        `creating ${gameType} game`,
        this.wallet
      );
      return {
        success: false,
        error: userFriendlyError,
      };
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
    console.log(
      `🎮 Auto-joining creator to ${gameType} game ${gamePda.toBase58()}...`
    );

    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);

      let joinTx: string | undefined;
      let joinConfirmed = false;
      if (gameAccount.isPrivate) {
        console.log(`🔐 Game is private, using authorized join...`);
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
        joinConfirmed = true;
      } else {
        console.log(`🌐 Game is public, using regular join...`);
        const joinAccounts = await this.buildJoinAccounts(
          gamePda,
          gameAccount,
          playerKp.publicKey
        );
        const joinInstruction = await this.program.methods
          .joinGame()
          .accounts(joinAccounts as any)
          .instruction();
        joinTx = await this.wallet.sendTransaction(
          [joinInstruction],
          [playerKp]
        );

        joinConfirmed = await this.confirmTransactionWithRecovery(
          joinTx,
          gamePda,
          "Player join",
          playerKp.publicKey
        );
      }

      if (joinConfirmed) {
        this.gameDb.saveGameParticipant(
          gamePda.toBase58(),
          telegramId.toString(),
          creatorPubkey
        );
        return { success: true };
      } else {
        return {
          success: false,
          error: "Failed to confirm auto-join transaction",
        };
      }
    } catch (joinError: any) {
      const errorMsg = logAndFormatError(
        joinError,
        `auto-joining creator to ${gameType} game`
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
    const hasEnoughTickets =
      ticketsCount >= Number(gameAccount.minTickets || 0);

    if (!this.isGameExpiredWithBuffer(gameAccount)) {
      return false;
    }

    console.log(
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
        console.log(
          "⏳ Giveaway has participants; waiting for oracle to complete."
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
          console.log("✅ Game account already closed successfully");
        } else {
          console.error("Post-cleanup close attempt failed:", error);
        }
      }
      return false;
    }

    // Has enough tickets -> wait for oracle completion, do not attempt close
    console.log("⏳ Game has minimum tickets; waiting for oracle to complete.");
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
    chatId?: number
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
      const gameAccount = await this.program.account.game.fetch(gamePda);

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
        let [tokenBalance, solBalance] = await Promise.all([
          this.wallet.getTokenBalance(telegramId, gameData.token_mint, {
            createIfMissing: true,
          }),
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
            "join",
            gameData.token_ticker || "SOL"
          );

          if (!ensured.success) {
            return { success: false, error: ensured.error };
          }

          tokenBalance = ensured.tokenBalance;
          solBalance = ensured.solBalance;
        }

        if (tokenBalance < gameAmount) {
          return {
            success: false,
            error: `Insufficient balance. You have ${this.wallet.formatTokenBalance(
              tokenBalance,
              metadata.decimals
            )} ${
              gameData.token_ticker
            } but need ${this.wallet.formatTokenBalance(
              gameAmount,
              metadata.decimals
            )} ${gameData.token_ticker}`,
          };
        }

        const reservedTicketAmount = gameAmount;
        const swapAllowanceRaw = Math.max(tokenBalance - reservedTicketAmount, 0);

        let lamportsBalance = solBalance;
        if (lamportsBalance < MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS) {
          if (swapAllowanceRaw <= 0) {
            const formattedStake = this.wallet.formatTokenBalance(
              reservedTicketAmount,
              metadata.decimals
            );

            return {
              success: false,
              error: `You have exactly ${formattedStake} ${gameData.token_ticker} for the ticket but no spare tokens to cover SOL fees. Add SOL manually or deposit more ${gameData.token_ticker} before trying again.`,
            };
          }

          const jitResult = await this.swapManager.performJustInTimeSolSwap({
            userKeypair: playerKp,
            tokenMint: gameData.token_mint,
            tokenDecimals: metadata.decimals,
            availableTokenAmountRaw: swapAllowanceRaw,
            desiredLamports: MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
            slippageBps: 300,
            tokenTicker: gameData.token_ticker,
            logContext: `join ${gameAddress}`,
          });

          if (!jitResult.swapped && jitResult.error) {
            return { success: false, error: jitResult.error };
          }

          if (jitResult.swapped) {
            tokenBalance = await this.wallet.getTokenBalance(
              telegramId,
              gameData.token_mint,
              { createIfMissing: true }
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

            const refreshedLamports = await this.wallet.getBalance(telegramId);
            if (refreshedLamports < MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS) {
              return {
                success: false,
                error:
                  "Swap executed but SOL balance is still below the safety buffer. Add SOL manually and try again.",
              };
            }
          }
        }
      }

      // Execute join

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
      } else {
        const joinAccounts = await this.buildJoinAccounts(
          gamePda,
          gameAccount,
          playerKp.publicKey
        );
        const joinInstruction = await this.program.methods
          .joinGame()
          .accounts(joinAccounts as any)
          .instruction();

        const tx = await this.wallet.sendTransaction(
          [joinInstruction],
          [playerKp]
        );
        await this.wallet.confirmTransaction(tx);
      }

      // Update database
      const playerPubkey = playerKp.publicKey.toBase58();
      this.gameDb.savePlayerMapping(playerPubkey, telegramId.toString());
      this.gameDb.saveGameParticipant(
        gameAddress,
        telegramId.toString(),
        playerPubkey
      );

      return { success: true };
    } catch (error: any) {
      console.error(`Error joining game ${gameAddress}:`, error);
      return { success: false, error: error.message || "Failed to join game" };
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
      await this.unjoinPlayerFromGame(gamePda, playerKp, playerKp.publicKey);

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

  public async cancelGameWithPlayerKeys(
    gamePda: PublicKey,
    gameType: string
  ): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const gameAddress = gamePda.toBase58();
      console.log(
        `Attempting to close ${gameType} game ${gameAddress} with cleanup`
      );

      // Step 2: Close the game using creator's key to recover remaining rent
      const creatorPubkey = gameAccount.creator.toBase58();
      const creatorTelegramId = this.gameDb.getPlayerTelegramId(creatorPubkey);

      if (!creatorTelegramId) {
        console.log(
          `No telegram ID found for creator ${creatorPubkey}, cannot close game`
        );
        return { success: false, error: "Creator not found in database" };
      }

      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const closeAccounts = await this.buildCloseGameAccounts(
        gamePda,
        gameAccount
      );
      const closeInstruction = await this.program.methods
        .closeGame()
        .accounts(closeAccounts as any)
        .instruction();

      const tx = await this.wallet.sendTransaction(
        [closeInstruction],
        [creatorKp]
      );
      await this.wallet.confirmTransaction(tx);
      console.log(
        `✅ Successfully closed ${gameType} game ${gameAddress} with tx: ${tx}`
      );

      return { success: true, tx };
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
    playerPubkey: PublicKey
  ): Promise<void> {
    // Get the last player from game participants in database
    const participantIds = this.gameDb.getGameParticipants(gamePda.toBase58());

    if (participantIds.length === 0) {
      throw new Error("No participants found in game");
    }

    // Ensure player is tracked for this game (defensive check)
    const isTracked = participantIds.some((id) => {
      const mapped = this.gameDb.getPlayerPublicKey(id);
      return mapped === playerPubkey.toBase58();
    });
    if (!isTracked) {
      throw new Error("Player not found in game participants");
    }

    const gameAccount = await this.program.account.game.fetch(gamePda);
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

    const tx = await this.wallet.sendTransaction(
      [unjoinInstruction],
      [authorityKp]
    );
    await this.wallet.confirmTransaction(tx);

    // Remove participant from database tracking
    const playerTelegramId = this.gameDb.getPlayerTelegramId(
      playerPubkey.toBase58()
    );
    if (playerTelegramId) {
      this.gameDb.removeGameParticipant(gamePda.toBase58(), playerTelegramId);
      console.log(
        `Unjoined player ${playerTelegramId} from game participants tracking`
      );
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
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const joinAccounts = await this.buildJoinAccounts(
        gamePda,
        gameAccount,
        playerKp.publicKey,
        adminKp.publicKey
      );

      const joinInstruction = await this.program.methods
        .joinGame()
        .accounts(joinAccounts as any)
        .instruction();

      const tx = await this.wallet.sendTransaction(
        [joinInstruction],
        [playerKp, adminKp]
      );

      const joinConfirmed = await this.confirmTransactionWithRecovery(
        tx,
        gamePda,
        "Player join",
        playerKp.publicKey
      );

      if (!joinConfirmed) {
        return {
          success: false,
          error: "Join transaction could not be confirmed",
        };
      }

      return { success: true, tx };
    } catch (error: any) {
      console.error(`Error joining private game:`, error);
      return { success: false, error: error.message || "Unknown error" };
    }
  }

  // ================================
  // USER GAMES
  // ================================

  public async getUserGames(
    ctx: Context,
    telegramId: bigint
  ): Promise<{
    activeGames: string;
    recentGames: string;
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
        ? "<b>Active Games</b>\n\n" + validActiveGames.join("\n\n")
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
      formatSection(categories.won, "<b>Won Games</b>"),
      formatSection(categories.lost, "<b>Lost Games</b>"),
      formatSection(categories.created, "<b>Created Games</b>"),
      formatSection(categories.cancelled, "<b>Cancelled Games</b>"),
    ]
      .filter((section) => section !== "")
      .join("\n");

    return {
      activeGames: activeGamesSection,
      recentGames: recentGamesSections,
    };
  }

  private async processActiveGames(
    ctx: Context,
    activeGamesData: any[]
  ): Promise<string[]> {
    const activeGames = await Promise.all(
      activeGamesData.map(async (gameData) => {
        try {
          if (!gameData.game_address) {
            console.error(`Game data missing address:`, gameData);
            return null;
          }
          
          let gamePda: PublicKey;
          try {
            gamePda = new PublicKey(gameData.game_address);
          } catch (pkError) {
            console.error(`Invalid game address format: ${gameData.game_address}`);
            return null;
          }
          
          return this.getGameInfo(ctx, gamePda);
        } catch (error) {
          console.error(`Error fetching game ${gameData.game_address}:`, error);
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
            `Error processing game ${gameData.game_address}:`,
            error
          );
          return null;
        }
      })
    );

    return recentGames.filter((game): game is any => game !== null);
  }

  private formatGameSection(games: any[], title: string): string {
    if (games.length === 0) return "";
    let section = `${title}\n\n`;
    for (const game of games) {
      section += `${game.gameInfo}\n`;
      if (game.completedAt) {
        section += `📅 ${formatDate(game.completedAt)}\n\n`;
      } else {
        section += "\n";
      }
    }
    return section;
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
      console.log(`Reloaded ${this.activeGameMessages.size} game messages`);
    } catch (error) {
      console.error("Error reloading game messages:", error);
    }
  }

  // ================================
  // BLOCKCHAIN SCANNING
  // ================================

  public async scanBlockchainForOrphanedGames(): Promise<void> {
    try {
      console.log("🔍 Starting blockchain scan for orphaned games...");

      const orphanedGames = await this.findOrphanedGames();
      console.log(`🚨 Found ${orphanedGames.length} orphaned games`);

      let cancelledCount = 0;
      for (const { address } of orphanedGames) {
        const cancelled = await this.cancelOrphanedGame(address);
        if (cancelled) cancelledCount++;
      }

      console.log(
        `🏁 Blockchain scan completed. Cancelled ${cancelledCount}/${orphanedGames.length} orphaned games`
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
          console.log(
            `🔍 Found orphaned game: ${gameAddress} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`
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

      if (!this.isGameExpiredWithBuffer(gameAccount)) {
        console.log(
          `⏰ Game ${address} hasn't passed buffer time yet, skipping`
        );
        return false;
      }

      const gameType = this.getGameType(gameAccount);
      console.log(
        `🔄 Processing expired ${gameType} game ${address} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`
      );

      return gameType === "giveaway"
        ? await this.handleExpiredGiveaway(gamePda, gameAccount, address)
        : await this.handleExpiredCoinflip(gamePda, gameAccount, address);
    } catch (error: any) {
      return this.handleGameProcessingError(error, address);
    }
  }

  private isGameExpiredWithBuffer(gameAccount: any): boolean {
    const currentTime = Math.floor(Date.now() / 1000);
    const createdAt = Number(gameAccount.createdAt);
    const timeout = Number(gameAccount.timeout);
    const expiresAt = createdAt + timeout;
    return currentTime > expiresAt + GAME_EXPIRATION_BUFFER_TIME;
  }

  private getGameType(gameAccount: any): string {
    const gameTypeKeys = Object.keys(gameAccount.gameType);
    return gameTypeKeys[0] || "unknown";
  }

  private handleGameProcessingError(error: any, address: string): boolean {
    if (error.message?.includes("Account does not exist")) {
      console.log(`ℹ️ Orphaned game ${address} was already closed`);
      return true;
    } else {
      console.error(
        `❌ Error processing orphaned game ${address}:`,
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

    if (this.isGameExpiredWithBuffer(gameAccount)) {
      console.log(
        `🔄 Processing expired ${gameType} game ${address} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`
      );

      const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
      if (result.success) {
        console.log(`✅ Successfully handled expired giveaway: ${address}`);
        return true;
      }
    }

    return false;
  }

  private async handleExpiredCoinflip(
    gamePda: PublicKey,
    gameAccount: any,
    address: string
  ): Promise<boolean> {
    const playerKeyInfo = this.analyzePlayerKeys(gamePda, gameAccount, address);
    console.log(
      `🪙 Coinflip ${address}: ${playerKeyInfo.available.length}/${playerKeyInfo.total} player keys available`
    );

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
    return await this.executePartialCleanup(gamePda, playerKeyInfo, address);
  }

  private analyzePlayerKeys(
    gamePda: PublicKey,
    gameAccount: any,
    gameAddress: string
  ) {
    // Get players from database since contract no longer stores players array
    const participantTelegramIds = new Set(this.getGamePlayers(gameAddress));
    this.recoverParticipantsFromHashes(gamePda, gameAccount, participantTelegramIds);

    let creatorPubkey: PublicKey | null = null;
    try {
      creatorPubkey =
        gameAccount.creator instanceof PublicKey
          ? gameAccount.creator
          : new PublicKey(gameAccount.creator);
    } catch (_) {
      creatorPubkey = null;
    }

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
      total: participantTelegramIds.size,
    };
  }

  private async executeCompleteCleanup(
    gamePda: PublicKey,
    gameAccount: any,
    playerKeyInfo: any,
    address: string
  ): Promise<boolean> {
    console.log(
      `🔧 Strategy 1: Complete cleanup - unjoin all ${playerKeyInfo.available.length} players, then cancel`
    );

    // Unjoin ALL players including creator for coinflip games
    const unjoinedCount = await this.unjoinPlayers(
      gamePda,
      playerKeyInfo.available,
      playerKeyInfo.creator?.telegramId
    );

    // Only proceed if all players were successfully unjoined
    if (unjoinedCount !== playerKeyInfo.available.length) {
      console.log(
        `❌ Could only unjoin ${unjoinedCount}/${playerKeyInfo.available.length} players from coinflip ${address}, skipping cancellation`
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
    playerKeyInfo: any,
    address: string
  ): Promise<boolean> {
    console.log(
      `🔧 Strategy 2: Partial cleanup - unjoin ${playerKeyInfo.available.length} available players`
    );

    const unjoinedCount = await this.unjoinPlayers(
      gamePda,
      playerKeyInfo.available,
      playerKeyInfo.creator?.telegramId
    );
    console.log(
      `📊 Unjoined ${unjoinedCount}/${playerKeyInfo.available.length} players from coinflip ${address}`
    );

    return unjoinedCount > 0;
  }

  private async unjoinPlayers(
    gamePda: PublicKey,
    players: Array<{
      pubkey: PublicKey;
      telegramId: string;
      isCreator: boolean;
    }>,
    creatorTelegramId?: string
  ): Promise<number> {
    let unjoinedCount = 0;

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
      let authorityKp = tryGetKeyPair(player.telegramId);
      let usedCreatorFallback = false;

      if (!authorityKp && creatorAuthority) {
        authorityKp = creatorAuthority;
        usedCreatorFallback = !player.isCreator;
      }

      if (!authorityKp) {
        console.error(
          `Failed to unjoin ${player.pubkey.toBase58()}: missing signing authority`
        );
        continue;
      }

      try {
        await this.unjoinPlayerFromGame(gamePda, authorityKp, player.pubkey);
        console.log(
          `➡️ Unjoined ${
            player.isCreator ? "creator" : "player"
          } ${player.pubkey.toBase58()}${
            usedCreatorFallback ? " using creator authority" : ""
          }`
        );
        unjoinedCount++;
      } catch (error) {
        console.error(`Failed to unjoin ${player.pubkey.toBase58()}:`, error);
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
    try {
      console.log(`🎁 Closing expired ${gameType} ${address} with cleanup`);

      // Step 2: Close the game
      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const closeAccounts = await this.buildCloseGameAccounts(
        gamePda,
        gameAccount
      );
      const closeInstruction = await this.program.methods
        .closeGame()
        .accounts(closeAccounts as any)
        .instruction();

      const tx = await this.wallet.sendTransaction(
        [closeInstruction],
        [creatorKp]
      );
      await this.wallet.confirmTransaction(tx);
      console.log(
        `✅ Successfully closed expired ${gameType} ${address} with tx: ${tx}`
      );
      return true;
    } catch (error: any) {
      console.error(
        `❌ Failed to close expired ${gameType} ${address}:`,
        error.message
      );
      return false;
    }
  }
}
