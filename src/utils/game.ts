import { PublicKey } from "@solana/web3.js";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { WalletManager } from "./wallet";
import { GameDatabase } from "./game-database";
import { OracleClient } from "./oracle";
import { PDAManager } from "./pda";
import { formatUserFriendlyError } from "./errors";
import { DEFAULT_NULL_ADDRESS, ADDRESS_DISPLAY_LENGTH, GAME_INFO_LIMIT, GAME_EXPIRATION_BUFFER_TIME } from "./constants";
import type {
  GameMessage,
  GameCancellationResult,
  GameMessageFormat,
  GameCategory,
  GameType} from "../types";
import type { Coinflip } from "../../idl/idlType";

// ================================
// UTILITY FUNCTIONS
// ================================

const logAndFormatError = (error: any, operation: string, walletManager?: WalletManager): string => {
  console.error(`Error in ${operation}:`, error);
  return walletManager ? formatUserFriendlyError(error, walletManager) : error.message;
};

const formatGameTypeWithEmoji = (gameType: string): string => {
  switch (gameType.toLowerCase()) {
    case "coinflip":
      return "🪙 Coinflip";
    case "giveaway":
      return "🎁 Giveaway";
    case "dumbflip":
      return "🎲 Dumbflip";
    case "snowball":
      return "❄️ Snowball";
    default:
      return `🎮 ${gameType.charAt(0).toUpperCase() + gameType.slice(1)}`;
  }
};

const formatGameType = (gameType: Record<string, any>): string => {
  const keys = Object.keys(gameType);
  const firstKey = keys[0];
  if (!firstKey) return "Unknown";
  return formatGameTypeWithEmoji(firstKey);
};

const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
};

const formatExpirationTime = async (expiresAt: number, walletManager?: WalletManager, prefix: string = "⏰ "): Promise<string> => {
  const blockTime = walletManager ? await walletManager.getBlockchainTime() : Math.floor(Date.now() / 1000);
  const timeRemaining = Math.max(0, expiresAt - blockTime);

  if (timeRemaining <= 0) {
    return `${prefix}Expired`;
  }

  const hours = Math.floor(timeRemaining / 3600);
  const minutes = Math.floor((timeRemaining % 3600) / 60);

  if (hours > 0) {
    return `${prefix}Expires in: ${hours}h ${minutes}m`;
  } else {
    return `${prefix}Expires in: ${minutes}m`;
  }
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

  private constructor(
    private program: anchor.Program<Coinflip>,
    private wallet: WalletManager,
    private gameDb: GameDatabase,
    private oracleClient: OracleClient,
  ) {}

  public static getInstance(
    program: anchor.Program<Coinflip>,
    wallet: WalletManager,
    gameDb: GameDatabase
  ): GameManager {
    if (!GameManager.instance) {
      const oracleClient = OracleClient.getInstance(wallet);
      GameManager.instance = new GameManager(program, wallet, gameDb, oracleClient);
    }
    return GameManager.instance;
  }

  // ================================
  // PLAYER UTILITIES
  // ================================

  /**
   * Helper method to check if a player is in a game by checking database records
   * Since the contract no longer has PlayerParticipation accounts
   */
  private async isPlayerInGame(gamePda: PublicKey, playerPubkey: PublicKey): Promise<boolean> {
    try {
      const participants = this.gameDb.getGameParticipants(gamePda.toBase58());
      return participants.includes(playerPubkey.toBase58());
    } catch (error) {
      return false;
    }
  }

  /**
   * Helper method to get all players in a game from the database
   * Since the contract no longer stores players array, we use our database tracking
   */
  private getGamePlayers(gameAddress: string): string[] {
    return this.gameDb.getGameParticipants(gameAddress);
  }

  // ================================
  // PLAYER BALANCE MANAGEMENT
  // ================================

  public async ensurePlayerBalance(playerKeypair: anchor.web3.Keypair, tokenMint: string): Promise<PublicKey> {
    const playerBalancePda = PDAManager.getPlayerBalancePDA(
      playerKeypair.publicKey,
      new PublicKey(tokenMint),
      this.program.programId
    );

    try {
      await this.program.account.playerBalance.fetch(playerBalancePda);
      return playerBalancePda;
    } catch (error) {
      // Create token account if needed
      const playerTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(tokenMint),
        playerKeypair.publicKey
      );

      try {
        await this.wallet.getConnection().getAccountInfo(playerTokenAccount);
      } catch (error) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          playerKeypair.publicKey,
          playerTokenAccount,
          playerKeypair.publicKey,
          new PublicKey(tokenMint)
        );
        const tx = await this.wallet.sendTransaction([createAtaIx], [playerKeypair]);
        await this.wallet.confirmTransaction(tx);
      }

      // Initialize player balance
      const initInstruction = await this.program.methods
        .initializePlayerBalance()
        .accounts({
          player: playerKeypair.publicKey,
          tokenMint: new PublicKey(tokenMint),
        })
        .instruction();

      const tx = await this.wallet.sendTransaction([initInstruction], [playerKeypair]);
      await this.wallet.confirmTransaction(tx);
      return playerBalancePda;
    }
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
  public async getUsernameFromTelegramId(ctx: Context, telegramId: string): Promise<string | null> {
    try {
      const numericId = parseInt(telegramId, 10);
      if (isNaN(numericId)) {
        throw new Error(`Invalid Telegram ID: ${telegramId}`);
      }

      const chatMember = await ctx.api.getChatMember(ctx.chat!.id, numericId);
      return chatMember.user.username || chatMember.user.first_name || null;
    } catch (error) {
      console.warn(`Error getting username for Telegram ID ${telegramId}:`, error);
      return null;
    }
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
    if (creatorInfo.telegramId) {
      const username = await this.getUsernameFromTelegramId(ctx, creatorInfo.telegramId);
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
  public async getPlayerUsername(ctx: Context, publicKey: string): Promise<string> {
    const playerTelegramId = this.gameDb.getPlayerTelegramId(publicKey);
    if (!playerTelegramId) {
      return this.formatAddress(publicKey);
    }

    const username = await this.getUsernameFromTelegramId(ctx, playerTelegramId);
    if (!username) {
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

  private async getActiveGameStats(gamePda: PublicKey, amount: number, providedTotalPot?: number) {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const currentTickets = gameAccount.ticketsCount;
      const maxTickets = gameAccount.maxTickets;
      const minTickets = gameAccount.minTickets;

      const totalPot = providedTotalPot ?? (Number(gameAccount.totalAmount || 0) || (amount * currentTickets));

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const expirationInfo = await formatExpirationTime(expiresAt, this.wallet, "\n⏰ ");

      return { currentTickets, maxTickets, minTickets, totalPot, expirationInfo };
    } catch (error) {
      console.warn(`Warning: Could not fetch game account for ${gamePda.toBase58()}:`, error);
      return { currentTickets: 0, maxTickets: 0, minTickets: 0, totalPot: amount, expirationInfo: "" };
    }
  }

  private async getCompletedGameStats(gamePda: PublicKey, amount: number, providedTotalPot?: number) {
    const participants = this.getGamePlayers(gamePda.toBase58());
    const currentTickets = participants.length;
    const totalPot = providedTotalPot ?? (amount * currentTickets);

    return {
      currentTickets,
      maxTickets: currentTickets,
      minTickets: currentTickets,
      totalPot,
      expirationInfo: ""
    };
  }

  private async getWinnerInfo(ctx: Context, status: string, winnerAddress?: string): Promise<string> {
    if (status.toLowerCase() !== "completed" || !winnerAddress) return "";

    if (winnerAddress === "cancelled" || winnerAddress === DEFAULT_NULL_ADDRESS) {
      return `\nStatus: Cancelled`;
    }

    const winnerUsername = await this.getPlayerUsername(ctx, winnerAddress);
    return `\nWinner: ${winnerUsername}`;
  }

  private generateGameKeyboard(status: string, gameType: string, gamePda: PublicKey) {
    if (status.toLowerCase() === "completed") return [];

    let joinButtonText: string;
    switch (gameType.toLowerCase()) {
      case "dumbflip":
        joinButtonText = "🎲 Roll";
        break;
      case "snowball":
        joinButtonText = "❄️ Roll";
        break;
      default:
        joinButtonText = "🎮 Join";
        break;
    }

    const keyboard = [[
      { text: joinButtonText, callback_data: `join_${gamePda.toBase58()}` },
      { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` }
    ]];

    return keyboard;
  }

  private async formatGameMessage(
    ctx: Context,
    gamePda: PublicKey,
    gameType: string,
    amount: number,
    creatorUsername: string,
    status: string,
    _tokenMint: string,
    tokenTicker: string,
    winnerAddress?: string,
    providedTotalPot?: number
  ): Promise<GameMessageFormat> {
    const isCompleted = status.toLowerCase() === "completed";

    const gameStats = isCompleted
      ? await this.getCompletedGameStats(gamePda, amount, providedTotalPot)
      : await this.getActiveGameStats(gamePda, amount, providedTotalPot);

    const { currentTickets, maxTickets, minTickets, totalPot, expirationInfo } = gameStats;

    const winnerInfo = await this.getWinnerInfo(ctx, status, winnerAddress);

    let messageText = `<b>${formatGameTypeWithEmoji(gameType)} • ${this.wallet.formatTokenBalance(amount, 9)} ${tokenTicker}</b>\n` +
      `👤 Creator: ${creatorUsername} • ${currentTickets}/${maxTickets} tickets`;

    // Show current prize if different from base amount
    if (currentTickets > 0 || totalPot !== amount) {
      messageText += `\n🏆 Current Prize: ${this.wallet.formatTokenBalance(totalPot, 9)} ${tokenTicker}`;
    }

    // Add list of players if any have joined
    if (currentTickets > 0 && status.toLowerCase() !== "completed") {
      try {
        const participants = this.getGamePlayers(gamePda.toBase58());
        if (participants.length > 0) {
          const playerNames = await Promise.all(
            participants.map(async (telegramId, index) => {
              try {
                const username = await this.getUsernameFromTelegramId(ctx, telegramId);
                return `${index + 1}. @${username}`;
              } catch (error) {
                return `${index + 1}. Player ${telegramId.slice(0, 6)}...`;
              }
            })
          );
          messageText += `\n${playerNames.join('\n')}\n`;
        }
      } catch (error) {
        console.error('Error getting player list:', error);
      }
    }

    // Add status and expiration info for active games
    if (status.toLowerCase() !== "completed") {
      let statusText: string;
      if (currentTickets < minTickets) {
        const neededForMin = minTickets - currentTickets;
        statusText = `${neededForMin} more until minimum`;
      } else if (currentTickets < maxTickets) {
        const neededForMax = maxTickets - currentTickets;
        statusText = `Minimum reached, ${neededForMax} more until full`;
      } else {
        statusText = "Full - starting soon!";
      }
      messageText += `\nStatus: ${statusText}${expirationInfo}`;

      // Add expected winner info for dumbflip and snowball games
      const expectedWinnerInfo = await this.getExpectedWinnerInfo(ctx, gamePda.toBase58(), gameType.toLowerCase());
      messageText += expectedWinnerInfo;
    }

    messageText += winnerInfo;

    const keyboard = this.generateGameKeyboard(status, gameType, gamePda);

    return { messageText, keyboard };
  }

  public async createGameMessage(
    ctx: Context,
    gameAddress: string,
    gameType: string,
    amount: number,
    creatorUsername: string,
    tokenMint: string,
    tokenTicker: string,
    status: string = "Active"
  ): Promise<number> {
    const { messageText, keyboard } = await this.formatGameMessage(
      ctx,
      new PublicKey(gameAddress),
      gameType,
      amount,
      creatorUsername,
      status,
      tokenMint,
      tokenTicker,
      undefined
    );

    const message = await ctx.reply(messageText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
      reply_to_message_id: ctx.message?.message_id
    });

    this.gameDb.saveGameMessage(gameAddress, message.message_id, message.chat.id);
    this.activeGameMessages.set(gameAddress, {
      messageId: message.message_id,
      chatId: message.chat.id
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
    tokenMint: string,
    tokenTicker: string,
    winnerAddress?: string,
    totalPot?: number
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
        tokenMint,
        tokenTicker,
        winnerAddress,
        totalPot
      );

      try {
        await ctx.api.editMessageText(
          gameMessage.chatId,
          gameMessage.messageId,
          messageText,
          {
            parse_mode: "HTML",
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
          }
        );
      } catch (error: any) {
        if (error.description?.includes("message is not modified")) {
          return;
        }
        console.error("Error updating game message:", error);
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
    totalPot?: number
  ): Promise<void> {
    try {
      const gameData = this.gameDb.getGame(gameAddress);
      if (!gameData) {
        console.warn(`No game data found for ${gameAddress}`);
        return;
      }

      const creatorUsername = await this.getGameCreatorUsername(ctx, gameAddress);
      const gameType = gameData.game_type ?
        gameData.game_type.charAt(0).toUpperCase() + gameData.game_type.slice(1) : "Game";

      await this.updateGameMessage(
        ctx,
        gameAddress,
        gameType,
        gameData.amount,
        creatorUsername,
        status,
        gameData.token_mint || "",
        gameData.token_ticker || "",
        winnerAddress,
        totalPot
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
      const currentTickets = gameAccount.ticketsCount;

      // Get token info from database
      const gameData = this.gameDb.getGame(gamePda.toBase58());
      if (!gameData?.token_mint || !gameData?.token_ticker) {
        return `Error: Game token information not found`;
      }

      const tokenMint = gameData.token_mint;
      const tokenTicker = gameData.token_ticker;

      const metadata = await this.wallet.getTokenMetadata(tokenMint);

      const maxTickets = gameAccount.maxTickets;
      const creatorPubkey = gameAccount.creator.toString();
      const gameType = formatGameType(gameAccount.gameType);

      const creatorUsername = await this.getGameCreatorUsername(ctx, gamePda.toBase58());
      const creatorInfo = creatorUsername !== "Unknown"
        ? creatorUsername
        : `<code>${creatorPubkey.slice(0, ADDRESS_DISPLAY_LENGTH)}...</code>`;

      // Add expiration info
      const expiresAt = Number(gameAccount.createdAt) + Number(gameAccount.timeout);
      const expirationInfo = "\n" + await formatExpirationTime(expiresAt, this.wallet);

      let winnerInfo = "";
      if (gameData && gameData.winner_address && gameData.winner_address !== "cancelled" && gameData.winner_address !== DEFAULT_NULL_ADDRESS) {
        const winnerUsername = await this.getPlayerUsername(ctx, gameData.winner_address);
        winnerInfo = `\nWinner: @${winnerUsername}`;
      }

      return `${gameType} • ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${tokenTicker}\n` +
             `👤 Creator: ${creatorInfo} • ${currentTickets}/${maxTickets} tickets${expirationInfo}${winnerInfo}`;
    } catch (error: any) {
      return `Error fetching game: ${error.message}`;
    }
  }

  // Helper method to get game info for completed games from database
  public async getCompletedGameInfo(ctx: Context, gameData: any): Promise<string> {
    try {
      const creatorUsername = await this.getUsernameFromTelegramId(ctx, gameData.creator_telegram_id);
      const amount = Number(gameData.amount);
      const playerCount = gameData.max_players || 2;
      const gameTypeText = formatGameTypeWithEmoji(gameData.game_type);

      // Handle different winner states
      let winnerLine = "";
      if (gameData.winner_address === "cancelled" || gameData.winner_address === DEFAULT_NULL_ADDRESS) {
        winnerLine = "";
      } else {
        const winnerUsername = await this.getPlayerUsername(ctx, gameData.winner_address);
        winnerLine = `🏆 Winner: @${winnerUsername}`;
      }

      const lines = [
        `${gameTypeText} • ${this.wallet.formatTokenBalance(amount, 9)} ${gameData.token_ticker || "WSOL"}`,
        `👤 Creator: @${creatorUsername} • ${playerCount} tickets`
      ];

      if (winnerLine) {
        lines.push(winnerLine);
      }

      return lines.join("\n");
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
      console.warn(`⚠️ ${operationType} confirmation failed: ${confirmError.message}`);

      // Only try recovery for timeout errors
      if (confirmError.message?.includes('timeout') || confirmError.message?.includes('not confirmed')) {
        console.log(`🔍 Checking if ${operationType} succeeded despite timeout...`);

        await new Promise(resolve => setTimeout(resolve, 2000));

        try {
          if (operationType === "Game creation") {
            await this.program.account.game.fetch(gamePda);
            console.log(`✅ Game account found - transaction ${signature} succeeded despite timeout`);
            return true;
          } else if (operationType === "Player join" && playerPubkey) {
            const isInGame = await this.isPlayerInGame(gamePda, playerPubkey);
            if (isInGame) {
              console.log(`✅ Player join confirmed despite timeout - tx: ${signature}`);
              return true;
            }
          }
        } catch (checkError) {
          console.error(`❌ ${operationType} verification failed, transaction ${signature} likely failed`);
        }
      }

      throw confirmError;
    }
  }

  public async createGame(
    gameType: GameType,
    parsedAmount: { amount: number; tokenMint: string; tokenTicker: string; isSol: boolean },
    maxTickets: number,
    minTickets: number,
    timeout: number,
    telegramId: bigint,
    chatId?: number
  ): Promise<{ success: boolean; error?: string; gameAddress?: string; autoJoinResult?: { success: boolean; error?: string } }> {

    // Validate that SOL is not used for games
    if (parsedAmount.isSol) {
      return {
        success: false,
        error: `❌ Native SOL games are not supported!\n\n` +
               `💡 Supported tokens for games:\n` +
               `• Use approved SPL tokens (check with /balance)\n` +
               `• For SOL-based games, use WSOL instead\n` +
               `• You can wrap SOL to WSOL using /wrap command\n\n` +
               `Example: /cf 1000 WSOL 2`
      };
    }

    const { tokenMint, tokenTicker, amount } = parsedAmount;

    try {
      const metadata = await this.wallet.getTokenMetadata(tokenMint);
      const playerKp = this.wallet.getKeyPair(telegramId);
      const [tokenBalance, gameBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, tokenMint),
        this.getPlayerGameBalance(playerKp.publicKey, tokenMint)
      ]);

      const totalBalance = tokenBalance + gameBalance;
      if (totalBalance < amount) {
        return {
          success: false,
          error: `Insufficient balance. You have ${this.wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${tokenTicker} but need ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${tokenTicker}`
        };
      }

      const creatorPubkey = playerKp.publicKey.toBase58();
      this.gameDb.savePlayerMapping(creatorPubkey, telegramId.toString());

      // Check oracle and generate game secrets
      const isOracleHealthy = await this.oracleClient.isHealthy();
      if (!isOracleHealthy) {
        return {
          success: false,
          error: "❌ Oracle service is unavailable. Please try again later."
        };
      }

      const { randomHash } = await this.oracleClient.generateGameSecrets();
      const randomHashBuffer = this.oracleClient.hexToBuffer(randomHash);

      await this.ensurePlayerBalance(playerKp, tokenMint);

      // Create game
      const gameConfig = {
        gameType: { [gameType]: {} },
        // u64 must be BN
        amount: new anchor.BN(amount),
        // u32 are fine as numbers, but field names must match IDL
        maxTickets: maxTickets,
        minTickets: minTickets,
        // u64 must be BN
        timeout: new anchor.BN(timeout),
        isPrivate: true
      };

      const gameInstruction = await this.program.methods
        .initializeGame(gameConfig, Array.from(randomHashBuffer))
        .accounts({
          creator: playerKp.publicKey,
          tokenMint: new PublicKey(tokenMint),
        })
        .instruction();

      const tx = await this.wallet.sendTransaction([gameInstruction], [playerKp]);

      // Game PDA is now derived directly from random hash (no nonce needed)
      const gamePda = PDAManager.getGamePDA(randomHashBuffer, this.program.programId);

      console.log(`📍 Game address: ${gamePda.toBase58()}`);

      const gameCreationConfirmed = await this.confirmTransactionWithRecovery(tx, gamePda, "Game creation");

      if (!gameCreationConfirmed) {
        return {
          success: false,
          error: "Game creation could not be confirmed"
        };
      }

      // Save game
      this.gameDb.saveGame(gamePda.toBase58(), telegramId.toString(), amount, gameType, tokenMint, tokenTicker, maxTickets, minTickets, chatId);

      // Auto-join logic based on game type
      let autoJoinResult: { success: boolean; error?: string } | undefined;
      if (gameType === "coinflip" || gameType === "dumbflip" || gameType === "snowball") {
        autoJoinResult = await this.handleGameAutoJoinPure(gamePda, playerKp, telegramId, creatorPubkey, gameType, chatId || 0);
      } else {
        console.log(`🎁 ${gameType.charAt(0).toUpperCase() + gameType.slice(1)} game ${gamePda.toBase58()} created - creator not auto-joined`);
      }

      return {
        success: true,
        gameAddress: gamePda.toBase58(),
        autoJoinResult
      };

    } catch (error: any) {
      const userFriendlyError = logAndFormatError(error, `creating ${gameType} game`, this.wallet);
      return {
        success: false,
        error: userFriendlyError
      };
    }
  }


  private async handleGameAutoJoinPure(
    gamePda: PublicKey,
    playerKp: anchor.web3.Keypair,
    telegramId: bigint,
    creatorPubkey: string,
    gameType: string,
    chatId?: number
  ): Promise<{ success: boolean; error?: string }> {
    console.log(`🎮 Auto-joining creator to ${gameType} game ${gamePda.toBase58()}...`);

    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);

      let joinTx: string;
      if (gameAccount.isPrivate) {
        console.log(`🔐 Game is private, using authorized join...`);
        const result = await this.joinPrivateGame(gamePda, playerKp, chatId || 0);
        if (!result.success) {
          return { success: false, error: result.error || "Failed to join private game" };
        }
        joinTx = result.tx!;
      } else {
        console.log(`🌐 Game is public, using regular join...`);
        const joinInstruction = await this.program.methods
          .joinGame()
          .accounts({
            game: gamePda,
            player: playerKp.publicKey,
          })
          .instruction();
        joinTx = await this.wallet.sendTransaction([joinInstruction], [playerKp]);
      }

      // Confirm join with timeout recovery
      const joinConfirmed = await this.confirmTransactionWithRecovery(joinTx, gamePda, "Player join", playerKp.publicKey);

      if (joinConfirmed) {
        this.gameDb.saveGameParticipant(gamePda.toBase58(), telegramId.toString(), creatorPubkey);
        return { success: true };
      } else {
        return { success: false, error: "Failed to confirm auto-join transaction" };
      }

    } catch (joinError: any) {
      const errorMsg = logAndFormatError(joinError, `auto-joining creator to ${gameType} game`);
      return {
        success: false,
        error: `⚠️ Game created successfully, but failed to auto-join creator!\n\nPlease manually join the game using the "🎮 Join" button.\n\nError: ${errorMsg}`
      };
    }
  }

  // ================================
  // HELPER METHODS
  // ================================

  private async getPlayerGameBalance(playerPubkey: PublicKey, tokenMint: string): Promise<number> {
    try {
      const playerBalancePda = PDAManager.getPlayerBalancePDA(
        playerPubkey,
        new PublicKey(tokenMint),
        this.program.programId
      );
      const playerBalance = await this.program.account.playerBalance.fetch(playerBalancePda);
      return Number(playerBalance.amount);
    } catch (error) {
      return 0;
    }
  }

  /**
   * Get expected winner for dumbflip and snowball games using oracle API
   */
  private async getExpectedWinner(gameAddress: string, participants: string[]): Promise<string | null> {
    try {
      if (participants.length === 0) {
        return null;
      }

      const result = await this.oracleClient.getCurrentWinner(gameAddress);
      if (!result.success || !result.winner) {
        console.warn(`Failed to get winner from oracle for game ${gameAddress}: ${result.error}`);
        return null;
      }

      // Oracle returns Solana address, try to convert to Telegram ID
      const telegramId = this.gameDb.getPlayerTelegramId(result.winner);
      if (telegramId) {
        return telegramId;
      }

      // No Telegram mapping found - player joined via blockchain directly
      // Return the Solana address for display
      return result.winner;
    } catch (error) {
      console.error('Error getting expected winner from oracle:', error);
      return null;
    }
  }


  /**
   * Get expected winner info for display in game messages
   */
  private async getExpectedWinnerInfo(ctx: Context, gameAddress: string, gameType: string): Promise<string> {
    if (gameType !== "dumbflip" && gameType !== "snowball") {
      return "";
    }

    try {
      const participants = this.gameDb.getGameParticipants(gameAddress);
      if (participants.length === 0) {
        return "\n🎯 Expected winner: No tickets yet";
      }

      const expectedWinner = await this.getExpectedWinner(gameAddress, participants);
      if (!expectedWinner) {
        return "\n🎯 Expected winner: Calculating...";
      }

      // Check if it's a Telegram ID (numeric) or Solana address
      const numericId = parseInt(expectedWinner, 10);
      if (!isNaN(numericId)) {
        // It's a Telegram ID - get the username
        const expectedWinnerUsername = await this.getUsernameFromTelegramId(ctx, expectedWinner);
        if (expectedWinnerUsername) {
          return `\n🎯 Expected winner: @${expectedWinnerUsername}`;
        }
        // Username resolution failed, fall back to User + partial ID
        return `\n🎯 Expected winner: User${expectedWinner.slice(0, 6)}`;
      } else {
        // It's a Solana address - format it nicely
        return `\n🎯 Expected winner: ${this.formatAddress(expectedWinner)}`;
      }
    } catch (error) {
      console.error('Error getting expected winner info:', error);
      // Return a fallback message instead of empty string to show there was an issue
      return "\n🎯 Expected winner: Error calculating";
    }
  }

  // ================================
  // EXPIRATION HANDLING
  // ================================

  public async handleExpiredGame(gamePda: PublicKey, gameAccount: any): Promise<GameCancellationResult | false> {
    const gameType = this.getGameType(gameAccount);
    const ticketsCount = Number(gameAccount.ticketsCount || 0);
    const hasEnoughTickets = ticketsCount >= Number(gameAccount.minTickets || 0);

    if (!this.isGameExpiredWithBuffer(gameAccount)) {
      return false;
    }

    console.log(`🔄 Processing expired ${gameType} game ${gamePda.toBase58()} (${ticketsCount}/${gameAccount.maxTickets})`);

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
              tx: result.tx!
            };
          }
        } catch (error) {
          console.error(`Error closing expired giveaway:`, error);
        }
      } else {
        console.log("⏳ Giveaway has participants; waiting for oracle to complete.");
      }
      return false;
    }

    // Competitive games (coinflip/dumbflip/snowball):
    // If there are no participants, we can close directly.
    if (ticketsCount === 0) {
      try {
        const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
        if (result.success) {
          return {
            cancelled: true,
            amount: Number(gameAccount.ticketAmount),
            creator: gameAccount.creator.toBase58(),
            tx: result.tx!
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
              tx: result.tx!
            };
          }
        }
      } catch (error) {
        console.error("Post-cleanup close attempt failed:", error);
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
        return { success: false, error: "Game data incomplete - please contact support" };
      }

      // Fetch blockchain game state
      const gameAccount = await this.program.account.game.fetch(gamePda);

      // Check if player already in game
      const isInGame = await this.isPlayerInGame(gamePda, playerKp.publicKey);

      // Handle special case: rolling for snowball/dumbflip games
      if (isInGame && (gameData.game_type === "snowball" || gameData.game_type === "dumbflip")) {
        return { success: true, isRoll: true };
      }

      if (isInGame) {
        return { success: false, error: "You have already joined this game!" };
      }

      if (gameAccount.ticketsCount >= gameAccount.maxTickets) {
        return { success: false, error: "This game is already full!" };
      }

      // Balance validation for paid games
      const currentGameType = Object.keys(gameAccount.gameType)[0];
      if (currentGameType === "coinflip" || currentGameType === "dumbflip" || currentGameType === "snowball") {
        const gameAmount = Number(gameAccount.ticketAmount);
        const [tokenBalance, gameBalance] = await Promise.all([
          this.wallet.getTokenBalance(telegramId, gameData.token_mint),
          this.getPlayerGameBalance(playerKp.publicKey, gameData.token_mint)
        ]);

        const totalBalance = tokenBalance + gameBalance;
        if (totalBalance < gameAmount) {
          const metadata = await this.wallet.getTokenMetadata(gameData.token_mint);
          return {
            success: false,
            error: `Insufficient balance. You have ${this.wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${gameData.token_ticker} but need ${this.wallet.formatTokenBalance(gameAmount, metadata.decimals)} ${gameData.token_ticker}`
          };
        }
      }

      // Ensure player balance and execute join
      await this.ensurePlayerBalance(playerKp, gameData.token_mint);

      if (gameAccount.isPrivate) {
        const result = await this.joinPrivateGame(gamePda, playerKp, chatId || 0);
        if (!result.success) {
          return { success: false, error: result.error || "Failed to join private game" };
        }
      } else {
        const joinInstruction = await this.program.methods
          .joinGame()
          .accounts({
            game: gamePda,
            player: playerKp.publicKey,
          })
          .instruction();

        const tx = await this.wallet.sendTransaction([joinInstruction], [playerKp]);
        await this.wallet.confirmTransaction(tx);
      }

      // Update database
      const playerPubkey = playerKp.publicKey.toBase58();
      this.gameDb.savePlayerMapping(playerPubkey, telegramId.toString());
      this.gameDb.saveGameParticipant(gameAddress, telegramId.toString(), playerPubkey);

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

      // Fetch current game state
      const gameAccount = await this.program.account.game.fetch(gamePda);

      // Snowball-specific restriction
      if (gameData.game_type === "snowball" && gameAccount.ticketsCount > 1) {
        return { success: false, error: "❄️ Cannot leave snowball games once there are 2+ tickets!" };
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
      return { success: false, error: error.message || "Failed to unjoin game" };
    }
  }


  // ================================
  // GAME CLOSURE AND CLEANUP
  // ================================

  public async cancelGameWithPlayerKeys(gamePda: PublicKey, gameType: string): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const gameAddress = gamePda.toBase58();
      console.log(`Attempting to close ${gameType} game ${gameAddress} with cleanup`);

      // Note: PlayerParticipation cleanup no longer needed in new contract architecture

      // Step 2: Close the game using creator's key to recover remaining rent
      const creatorPubkey = gameAccount.creator.toBase58();
      const creatorTelegramId = this.gameDb.getPlayerTelegramId(creatorPubkey);

      if (!creatorTelegramId) {
        console.log(`No telegram ID found for creator ${creatorPubkey}, cannot close game`);
        return { success: false, error: "Creator not found in database" };
      }

      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const closeInstruction = await this.program.methods
        .closeGame()
        .accounts({
          game: gamePda,
          creator: gameAccount.creator,
        })
        .instruction();

      const tx = await this.wallet.sendTransaction([closeInstruction], [creatorKp]);
      await this.wallet.confirmTransaction(tx);
      console.log(`✅ Successfully closed ${gameType} game ${gameAddress} with tx: ${tx}`);

      return { success: true, tx };
    } catch (error: any) {
      console.error(`❌ Error closing ${gameType} game ${gamePda.toBase58()}:`, error);
      return { success: false, error: error.message };
    }
  }

  private async unjoinPlayerFromGame(gamePda: PublicKey, playerKp: any, playerPubkey: PublicKey): Promise<void> {
    // Get the last player from game participants in database
    const participantIds = this.gameDb.getGameParticipants(gamePda.toBase58());

    if (participantIds.length === 0) {
      throw new Error('No participants found in game');
    }

    // Note: The new contract architecture doesn't require last player tracking

    // For the new contract architecture, we need to provide the ticket index
    // For now, we'll use 0 as the ticket index (this may need to be dynamic based on game state)
    const ticketIndex = 0;

    const unjoinInstruction = await this.program.methods
      .unjoinGame(ticketIndex)
      .accounts({
        game: gamePda,
        player: playerPubkey,
      })
      .instruction();

    const tx = await this.wallet.sendTransaction([unjoinInstruction], [playerKp]);
    await this.wallet.confirmTransaction(tx);

    // Remove participant from database tracking
    const playerTelegramId = this.gameDb.getPlayerTelegramId(playerPubkey.toBase58());
    if (playerTelegramId) {
      this.gameDb.removeGameParticipant(gamePda.toBase58(), playerTelegramId);
      console.log(`Removed player ${playerTelegramId} from game participants tracking`);
    }
  }

  // ================================
  // PRIVATE GAME FUNCTIONALITY
  // ================================

  public async joinPrivateGame(
    gamePda: PublicKey,
    playerKp: anchor.web3.Keypair,
    chatId: number
  ): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      const authResult = await this.oracleClient.authorizePlayer(gamePda, chatId);

      if (!authResult.authorized) {
        return { success: false, error: authResult.error || "Not authorized to join this private game" };
      }

      // Get game data to determine the token mint
      const gameData = this.gameDb.getGame(gamePda.toBase58());
      if (!gameData?.token_mint) {
        return { success: false, error: "Game data incomplete - token info missing" };
      }

      const tokenMint = gameData.token_mint;

      const adminKp = authResult.adminKeypair!;
      await this.ensurePlayerBalance(playerKp, tokenMint);

      const joinInstruction = await this.program.methods
        .joinGame()
        .accounts({
          game: gamePda,
          player: playerKp.publicKey,
          oracleOperator: adminKp.publicKey,
        })
        .instruction();

      const tx = await this.wallet.sendTransaction([joinInstruction], [playerKp, adminKp]);
      await this.wallet.confirmTransaction(tx);
      return { success: true, tx };
    } catch (error: any) {
      console.error(`Error joining private game:`, error);
      return { success: false, error: error.message || "Unknown error" };
    }
  }

  // ================================
  // USER GAMES
  // ================================

  public async getUserGames(ctx: Context, telegramId: bigint): Promise<{
    activeGames: string;
    recentGames: string;
  }> {
    const telegramIdStr = telegramId.toString();
    const playerKp = this.wallet.getKeyPair(telegramId);
    const playerPublicKey = playerKp.publicKey.toString();

    const [activeGamesData, recentGamesData] = await Promise.all([
      this.gameDb.getActiveGames(telegramIdStr),
      this.gameDb.getRecentGames(telegramIdStr, GAME_INFO_LIMIT)
    ]);

    // Active games
    const validActiveGames = await this.processActiveGames(ctx, activeGamesData);
    const activeGamesSection = validActiveGames.length > 0
      ? "🎮 <b>Active Games</b>\n\n" + validActiveGames.join("\n\n")
      : "";

    // Recent games
    const validRecentGames = await this.processRecentGames(ctx, recentGamesData, telegramIdStr, playerPublicKey);

    // Categorize recent games
    const categories: GameCategory = {
      won: validRecentGames.filter(g => g.category === 'won'),
      lost: validRecentGames.filter(g => g.category === 'lost'),
      cancelled: validRecentGames.filter(g => g.category === 'cancelled'),
      created: validRecentGames.filter(g => g.category === 'created')
    };

    const formatSection = this.formatGameSection.bind(this);

    const recentGamesSections = [
      formatSection(categories.won, "🏆 <b>Won Games</b>"),
      formatSection(categories.lost, "😢 <b>Lost Games</b>"),
      formatSection(categories.created, "🎮 <b>Created Games</b>"),
      formatSection(categories.cancelled, "❌ <b>Cancelled Games</b>")
    ].filter(section => section !== "").join("\n");

    return {
      activeGames: activeGamesSection,
      recentGames: recentGamesSections
    };
  }

  private async processActiveGames(ctx: Context, activeGamesData: any[]): Promise<string[]> {
    const activeGames = await Promise.all(activeGamesData.map(async (gameData) => {
      try {
        const gamePda = new PublicKey(gameData.game_address);
        await this.program.account.game.fetch(gamePda);
        return this.getGameInfo(ctx, gamePda);
      } catch (error) {
        console.error(`Error fetching game ${gameData.game_address}:`, error);
        return null;
      }
    }));

    return activeGames.filter((game): game is string => game !== null);
  }

  private async processRecentGames(ctx: Context, recentGamesData: any[], telegramIdStr: string, playerPublicKey: string): Promise<any[]> {
    const recentGames = await Promise.all(recentGamesData.map(async (gameData) => {
      try {
        const category = categorizeGame(gameData, telegramIdStr, playerPublicKey);
        const gameInfo = await this.getCompletedGameInfo(ctx, gameData);
        return { category, gameInfo, completedAt: gameData.completed_at };
      } catch (error) {
        console.error(`Error processing game ${gameData.game_address}:`, error);
        return null;
      }
    }));

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
            chatId: game.chat_id
          });
        }
      }
      console.log(`Reloaded ${this.activeGameMessages.size} game messages`);
    } catch (error) {
      console.error('Error reloading game messages:', error);
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

      console.log(`🏁 Blockchain scan completed. Cancelled ${cancelledCount}/${orphanedGames.length} orphaned games`);

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
          console.log(`🔍 Found orphaned game: ${gameAddress} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`);
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
        console.log(`⏰ Game ${address} hasn't passed buffer time yet, skipping`);
        return false;
      }

      const gameType = this.getGameType(gameAccount);
      console.log(`🔄 Processing expired ${gameType} game ${address} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`);

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
    return currentTime > (expiresAt + GAME_EXPIRATION_BUFFER_TIME);
  }

  private getGameType(gameAccount: any): string {
    const gameTypeKeys = Object.keys(gameAccount.gameType);
    return gameTypeKeys[0] || "unknown";
  }

  private handleGameProcessingError(error: any, address: string): boolean {
    if (error.message?.includes('Account does not exist')) {
      console.log(`ℹ️ Orphaned game ${address} was already closed`);
      return true;
    } else {
      console.error(`❌ Error processing orphaned game ${address}:`, error.message);
      return false;
    }
  }

  private async handleExpiredGiveaway(gamePda: PublicKey, gameAccount: any, address: string): Promise<boolean> {
    const gameType = this.getGameType(gameAccount);

    if (this.isGameExpiredWithBuffer(gameAccount)) {
      console.log(`🔄 Processing expired ${gameType} game ${address} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`);

      const result = await this.cancelGameWithPlayerKeys(gamePda, gameType);
      if (result.success) {
        console.log(`✅ Successfully handled expired giveaway: ${address}`);
        return true;
      }
    }

    return false;
  }

  private async handleExpiredCoinflip(gamePda: PublicKey, gameAccount: any, address: string): Promise<boolean> {
    const playerKeyInfo = this.analyzePlayerKeys(gameAccount, address);
    console.log(`🪙 Coinflip ${address}: ${playerKeyInfo.available.length}/${playerKeyInfo.total} player keys available`);

    // Strategy 1: Complete cleanup (unjoin all non-creators, then cancel)
    if (playerKeyInfo.canCompleteCleanup) {
      return await this.executeCompleteCleanup(gamePda, gameAccount, playerKeyInfo, address);
    }

    // Strategy 2: Partial cleanup (unjoin available players only)
    return await this.executePartialCleanup(gamePda, playerKeyInfo, address);
  }

  private analyzePlayerKeys(gameAccount: any, gameAddress: string) {
    // Get players from database since contract no longer stores players array
    const participantTelegramIds = this.getGamePlayers(gameAddress);
    const creatorPubkey = gameAccount.creator;
    const available: Array<{pubkey: PublicKey, telegramId: string, isCreator: boolean}> = [];
    const unavailable: string[] = [];

    for (const telegramId of participantTelegramIds) {
      try {
        const playerPubkeyStr = this.gameDb.getPlayerPublicKey(telegramId);
        if (playerPubkeyStr) {
          const playerPubkey = new PublicKey(playerPubkeyStr);
          available.push({
            pubkey: playerPubkey,
            telegramId,
            isCreator: playerPubkey.equals(creatorPubkey)
          });
        } else {
          unavailable.push(telegramId);
        }
      } catch (error) {
        unavailable.push(telegramId);
      }
    }

    const nonCreators = available.filter(p => !p.isCreator);
    const creator = available.find(p => p.isCreator);
    const canCompleteCleanup = unavailable.length === 0 && creator !== undefined;

    return {
      available,
      unavailable,
      nonCreators,
      creator,
      canCompleteCleanup,
      total: participantTelegramIds.length
    };
  }

  private async executeCompleteCleanup(gamePda: PublicKey, gameAccount: any, playerKeyInfo: any, address: string): Promise<boolean> {
    console.log(`🔧 Strategy 1: Complete cleanup - unjoin all ${playerKeyInfo.available.length} players, then cancel`);

    // Unjoin ALL players including creator for coinflip games
    const unjoinedCount = await this.unjoinPlayers(gamePda, playerKeyInfo.available);

    // Only proceed if all players were successfully unjoined
    if (unjoinedCount !== playerKeyInfo.available.length) {
      console.log(`❌ Could only unjoin ${unjoinedCount}/${playerKeyInfo.available.length} players from coinflip ${address}, skipping cancellation`);
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

  private async executePartialCleanup(gamePda: PublicKey, playerKeyInfo: any, address: string): Promise<boolean> {
    console.log(`🔧 Strategy 2: Partial cleanup - unjoin ${playerKeyInfo.available.length} available players`);

    const unjoinedCount = await this.unjoinPlayers(gamePda, playerKeyInfo.available);
    console.log(`📊 Unjoined ${unjoinedCount}/${playerKeyInfo.available.length} players from coinflip ${address}`);

    return unjoinedCount > 0;
  }

  private async unjoinPlayers(gamePda: PublicKey, players: Array<{pubkey: PublicKey, telegramId: string, isCreator: boolean}>): Promise<number> {
    let unjoinedCount = 0;

    for (const player of players) {
      try {
        const playerKp = this.wallet.getKeyPair(BigInt(player.telegramId));
        await this.unjoinPlayerFromGame(gamePda, playerKp, player.pubkey);
        console.log(`➡️ Unjoined ${player.isCreator ? 'creator' : 'player'} ${player.pubkey.toBase58().slice(0, 8)}...`);
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

      // Note: PlayerParticipation cleanup no longer needed in new contract architecture

      // Step 2: Close the game
      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const closeInstruction = await this.program.methods
        .closeGame()
        .accounts({
          game: gamePda,
          creator: gameAccount.creator,
        })
        .instruction();

      const tx = await this.wallet.sendTransaction([closeInstruction], [creatorKp]);
      await this.wallet.confirmTransaction(tx);
      console.log(`✅ Successfully closed expired ${gameType} ${address} with tx: ${tx}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to close expired ${gameType} ${address}:`, error.message);
      return false;
    }
  }
}
