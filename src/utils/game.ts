import { PublicKey } from "@solana/web3.js";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { WalletManager } from "./wallet";
import { GameDatabase } from "./game-database";
import { OracleClient } from "./oracle";
import { PDAManager } from "./pda";
import { formatUserFriendlyError } from "./errors";
import { DEFAULT_NULL_ADDRESS, ADDRESS_DISPLAY_LENGTH, GAME_INFO_LIMIT, GAME_EXPIRATION_BUFFER_TIME, PLAYER_CLEANUP_DELAY_MS } from "./constants";
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
   * Helper method to check if a player is in a game by checking PlayerParticipation account
   */
  private async isPlayerInGame(gamePda: PublicKey, playerPubkey: PublicKey): Promise<boolean> {
    try {
      const playerParticipationPda = PDAManager.getPlayerParticipationPDA(
        gamePda,
        playerPubkey,
        this.program.programId
      );
      await this.program.account.playerParticipation.fetch(playerParticipationPda);
      return true;
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
      const currentPlayers = gameAccount.playersCount;
      const maxPlayers = gameAccount.maxPlayers;
      const minPlayers = gameAccount.minPlayers;

      const totalPot = providedTotalPot ?? (Number(gameAccount.totalAmount || 0) || (amount * currentPlayers));

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const expirationInfo = await formatExpirationTime(expiresAt, this.wallet, "\n⏰ ");

      return { currentPlayers, maxPlayers, minPlayers, totalPot, expirationInfo };
    } catch (error) {
      console.warn(`Warning: Could not fetch game account for ${gamePda.toBase58()}:`, error);
      return { currentPlayers: 0, maxPlayers: 0, minPlayers: 0, totalPot: amount, expirationInfo: "" };
    }
  }

  private async getCompletedGameStats(gamePda: PublicKey, amount: number, providedTotalPot?: number) {
    const participants = this.getGamePlayers(gamePda.toBase58());
    const currentPlayers = participants.length;
    const totalPot = providedTotalPot ?? (amount * currentPlayers);

    return {
      currentPlayers,
      maxPlayers: currentPlayers,
      minPlayers: currentPlayers,
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

  private generateGameKeyboard(status: string, gameType: string, currentPlayers: number, gamePda: PublicKey) {
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

    // Add unjoin button with specific rules for different game types
    if (currentPlayers > 0) {
      const canUnjoin = !(gameType.toLowerCase() === "snowball" && currentPlayers >= 2);
      if (canUnjoin) {
        keyboard[0]?.push({ text: "❌ Unjoin", callback_data: `unjoin_${gamePda.toBase58()}` });
      }
    }

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
    txHash?: string,
    providedTotalPot?: number
  ): Promise<GameMessageFormat> {
    const isCompleted = status.toLowerCase() === "completed";

    const gameStats = isCompleted
      ? await this.getCompletedGameStats(gamePda, amount, providedTotalPot)
      : await this.getActiveGameStats(gamePda, amount, providedTotalPot);

    const { currentPlayers, maxPlayers, minPlayers, totalPot, expirationInfo } = gameStats;

    const winnerInfo = await this.getWinnerInfo(ctx, status, winnerAddress);

    let messageText = `<b>${formatGameTypeWithEmoji(gameType)} • ${this.wallet.formatTokenBalance(amount, 9)} ${tokenTicker}</b>\n` +
      `👤 Creator: ${creatorUsername} • ${currentPlayers}/${maxPlayers} players`;

    // Show current prize if different from base amount
    if (currentPlayers > 0 || totalPot !== amount) {
      messageText += `\n🏆 Current Prize: ${this.wallet.formatTokenBalance(totalPot, 9)} ${tokenTicker}`;
    }

    // Add list of players if any have joined
    if (currentPlayers > 0 && status.toLowerCase() !== "completed") {
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
      if (currentPlayers < minPlayers) {
        const neededForMin = minPlayers - currentPlayers;
        statusText = `${neededForMin} more until minimum`;
      } else if (currentPlayers < maxPlayers) {
        const neededForMax = maxPlayers - currentPlayers;
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

    if (txHash) {
      messageText += `\n\nTransaction: <code>${txHash}</code>`;
    }

    const keyboard = this.generateGameKeyboard(status, gameType, currentPlayers, gamePda);

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
    status: string = "Active",
    txHash?: string
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
      undefined,
      txHash
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
        undefined,
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

  // ================================
  // GAME OPERATIONS
  // ================================

  // ================================
  // CLEANUP UTILITIES
  // ================================

  /**
   * Clean up PlayerParticipation accounts for all players in a game
   * This should be called before closing a game to recover rent
   */
  private async cleanupAllPlayerParticipations(
    gamePda: PublicKey,
    gameAddress: string,
    skipWinner?: string
  ): Promise<{ cleaned: number; failed: number }> {
    console.log(`🧹 Starting PlayerParticipation cleanup for game ${gameAddress}`);

    const participants = this.getGamePlayers(gameAddress);
    let cleanedCount = 0;
    let failedCount = 0;

    for (const telegramId of participants) {
      try {
        const playerPubkey = this.gameDb.getPlayerPublicKey(telegramId);
        if (!playerPubkey) {
          console.warn(`No public key found for participant ${telegramId} in game ${gameAddress}`);
          continue;
        }

        const playerPubkeyObj = new PublicKey(playerPubkey);

        // Skip the winner if specified - their PlayerParticipation account is already closed by completeGame instruction
        if (skipWinner && playerPubkeyObj.equals(new PublicKey(skipWinner))) {
          console.log(`⏭️ Skipping cleanup for winner ${playerPubkey.slice(0, 8)}...`);
          continue;
        }

        // Get the player's keypair for signing the cleanup transaction
        const playerKp = this.wallet.getKeyPair(BigInt(telegramId));

        // Execute cleanup instruction
        const cleanupInstruction = await this.program.methods
          .cleanPlayerParticipation()
          .accounts({
            game: gamePda,
            player: playerPubkeyObj,
          })
          .instruction();

        const tx = await this.wallet.sendTransaction([cleanupInstruction], [playerKp]);
        await this.wallet.confirmTransaction(tx);
        cleanedCount++;

        console.log(`🧹 Cleaned up PlayerParticipation for ${playerPubkey.slice(0, 8)}... - tx: ${tx.slice(0, 8)}...`);

        // Small delay to avoid overwhelming the RPC
        await new Promise(resolve => setTimeout(resolve, PLAYER_CLEANUP_DELAY_MS));

      } catch (error: any) {
        // Check if the account doesn't exist (already cleaned up) vs other errors
        if (error.message?.includes('Account does not exist') || error.message?.includes('could not find account')) {
          console.log(`✅ PlayerParticipation account already cleaned up for participant ${telegramId}`);
          // Don't increment failed count for accounts that are already cleaned up
        } else {
          failedCount++;
          console.error(`❌ Failed to cleanup PlayerParticipation for participant ${telegramId}:`, error.message || error);
        }
      }
    }

    console.log(`🧹 PlayerParticipation cleanup completed for game ${gameAddress}: ${cleanedCount} successful, ${failedCount} failed`);
    return { cleaned: cleanedCount, failed: failedCount };
  }

  /**
   * Public method to clean up PlayerParticipation accounts for completed games
   * This should be called after a game is completed to recover rent
   */
  public async cleanupCompletedGameParticipations(
    gameAddress: string,
    winnerAddress: string
  ): Promise<{ cleaned: number; failed: number }> {
    try {
      const gamePda = new PublicKey(gameAddress);
      return await this.cleanupAllPlayerParticipations(gamePda, gameAddress, winnerAddress);
    } catch (error) {
      console.error(`❌ Error during completed game PlayerParticipation cleanup for ${gameAddress}:`, error);
      return { cleaned: 0, failed: 0 };
    }
  }

  public async getGameInfo(ctx: Context, gamePda: PublicKey): Promise<string> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const amount = Number(gameAccount.ticketAmount);
      const currentPlayers = gameAccount.playersCount;

      // Get token info from database
      const gameData = this.gameDb.getGame(gamePda.toBase58());
      if (!gameData?.token_mint || !gameData?.token_ticker) {
        return `Error: Game token information not found`;
      }

      const tokenMint = gameData.token_mint;
      const tokenTicker = gameData.token_ticker;

      const metadata = await this.wallet.getTokenMetadata(tokenMint);

      const maxPlayers = gameAccount.maxPlayers;
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
             `👤 Creator: ${creatorInfo} • ${currentPlayers}/${maxPlayers} players${expirationInfo}${winnerInfo}`;
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
        `👤 Creator: @${creatorUsername} • ${playerCount} players`
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
    ctx: Context,
    gameType: GameType,
    parsedAmount: { amount: number; tokenMint: string; tokenTicker: string; isSol: boolean },
    maxPlayers: number,
    minPlayers: number,
    timeout: number
  ): Promise<void> {
    const telegramId = BigInt(ctx.from?.id || 0);

    // Validate that SOL is not used for games
    if (parsedAmount.isSol) {
      await ctx.reply(
        `❌ Native SOL games are not supported!\n\n` +
        `💡 Supported tokens for games:\n` +
        `• Use approved SPL tokens (check with /balance)\n` +
        `• For SOL-based games, use WSOL instead\n` +
        `• You can wrap SOL to WSOL using /wrap command\n\n` +
        `Example: /cf 1000 WSOL 2`,
        { reply_to_message_id: ctx.message?.message_id }
      );
      return;
    }

    const { tokenMint, tokenTicker, amount } = parsedAmount;
    const metadata = await this.wallet.getTokenMetadata(tokenMint);

    try {
      const playerKp = this.wallet.getKeyPair(telegramId);
      const [tokenBalance, gameBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, tokenMint),
        this.getPlayerGameBalance(playerKp.publicKey, tokenMint)
      ]);

      const totalBalance = tokenBalance + gameBalance;
      if (totalBalance < amount) {
        await ctx.reply(
          `Insufficient balance. You have ${this.wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${tokenTicker} but need ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${tokenTicker}`,
          { reply_to_message_id: ctx.message?.message_id }
        );
        return;
      }

      const creatorPubkey = playerKp.publicKey.toBase58();
      this.gameDb.savePlayerMapping(creatorPubkey, telegramId.toString());

      // Check oracle and generate game secrets
      const isOracleHealthy = await this.oracleClient.isHealthy();
      if (!isOracleHealthy) {
        await ctx.reply("❌ Oracle service is unavailable. Please try again later.",
          { reply_to_message_id: ctx.message?.message_id });
        return;
      }

      const { randomHash } = await this.oracleClient.generateGameSecrets();
      const randomHashBuffer = this.oracleClient.hexToBuffer(randomHash);

      await this.ensurePlayerBalance(playerKp, tokenMint);

      // Create game
      const gameConfig = {
        gameType: { [gameType]: {} },
        amount: new anchor.BN(amount),
        maxPlayers,
        minPlayers,
        timeout,
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
        throw new Error("Game creation could not be confirmed");
      }

      // Save game and create message
      this.gameDb.saveGame(gamePda.toBase58(), telegramId.toString(), amount, gameType, tokenMint, tokenTicker, maxPlayers, minPlayers);

      const creatorUsername = await this.getGameCreatorUsername(ctx, gamePda.toBase58());
      await this.createGameMessage(ctx, gamePda.toBase58(), gameType.charAt(0).toUpperCase() + gameType.slice(1), amount, creatorUsername, tokenMint, tokenTicker, "Active", tx);

      // Auto-join logic based on game type
      if (gameType === "coinflip" || gameType === "dumbflip" || gameType === "snowball") {
        await this.handleGameAutoJoin(ctx, gamePda, playerKp, telegramId, creatorPubkey, gameType, amount, tokenMint, tokenTicker);
      } else {
        console.log(`🎁 ${gameType.charAt(0).toUpperCase() + gameType.slice(1)} game ${gamePda.toBase58()} created - creator not auto-joined`);
      }

    } catch (error: any) {
      const userFriendlyError = logAndFormatError(error, `creating ${gameType} game`, this.wallet);
      await ctx.reply(userFriendlyError, { reply_to_message_id: ctx.message?.message_id });
    }
  }

  private async handleGameAutoJoin(
    ctx: Context,
    gamePda: PublicKey,
    playerKp: anchor.web3.Keypair,
    telegramId: bigint,
    creatorPubkey: string,
    gameType: string,
    amount: number,
    tokenMint: string,
    tokenTicker: string
  ): Promise<void> {
    console.log(`🎮 Auto-joining creator to ${gameType} game ${gamePda.toBase58()}...`);

    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);

      let joinTx: string;
      if (gameAccount.isPrivate) {
        console.log(`🔐 Game is private, using authorized join...`);
        const result = await this.joinPrivateGame(gamePda, playerKp, ctx.chat?.id || 0);
        if (!result.success) {
          throw new Error(result.error || "Failed to join private game");
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
        const creatorUsername = await this.getGameCreatorUsername(ctx, gamePda.toBase58());
        await this.updateGameMessage(ctx, gamePda.toBase58(), gameType.charAt(0).toUpperCase() + gameType.slice(1), amount, creatorUsername, "Active", tokenMint, tokenTicker);
      }

    } catch (joinError: any) {
      const errorMsg = logAndFormatError(joinError, `auto-joining creator to ${gameType} game`);
      await ctx.reply(
        `⚠️ <b>Game created successfully, but failed to auto-join creator!</b>\n\n` +
        `Please manually join the game using the "🎮 Join" button.\n\n` +
        `Error: ${errorMsg}`,
        { parse_mode: "HTML", reply_to_message_id: ctx.message?.message_id }
      );
    }
  }

  // ================================
  // EVENT LISTENING
  // ================================

  // This method is no longer needed since game PDA is derived directly from random hash
  // Removed waitForGameInitializedEvent method

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
        return "\n🎯 Expected winner: No players yet";
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
    const hasEnoughPlayers = gameAccount.playersCount >= gameAccount.minPlayers;

    if (!this.isGameExpiredWithBuffer(gameAccount)) {
      return false;
    }

    console.log(`🔄 Processing expired ${gameType} game ${gamePda.toBase58()} (${gameAccount.playersCount}/${gameAccount.maxPlayers})`);

    // For giveaways and expired games with enough players, complete the game
    if (gameType === "giveaway" || hasEnoughPlayers) {
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
        console.error(`Error completing expired ${gameType} game:`, error);
      }
    }

    // For other expired games, cancel and refund
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
      console.error(`Error cancelling expired game:`, error);
    }

    return false;
  }

  // ================================
  // UNJOIN FUNCTIONALITY
  // ================================

  public async unjoinGame(ctx: Context, gamePda: PublicKey, playerKp: anchor.web3.Keypair): Promise<boolean> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);

      const isInGame = await this.isPlayerInGame(gamePda, playerKp.publicKey);
      if (!isInGame) {
        throw new Error("You are not in this game");
      }

      await this.unjoinPlayerFromGame(gamePda, playerKp, playerKp.publicKey);

      const creatorUsername = await this.getGameCreatorUsername(ctx, gamePda.toBase58());

      // Get token info from database
      const gameData = this.gameDb.getGame(gamePda.toBase58());
      if (!gameData?.token_mint || !gameData?.token_ticker) {
        console.error(`Missing token info for game ${gamePda.toBase58()}`);
        throw new Error("Game data incomplete - please contact support");
      }

      await this.updateGameMessage(
        ctx,
        gamePda.toBase58(),
        formatGameType(gameAccount.gameType),
        Number(gameAccount.ticketAmount),
        creatorUsername,
        "Active",
        gameData.token_mint,
        gameData.token_ticker
      );

      return true;
    } catch (error: any) {
      console.error(`Error unjoining game ${gamePda.toBase58()}:`, error);
      throw error;
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

      // Step 1: Clean up all PlayerParticipation accounts first to recover rent
      const participants = this.getGamePlayers(gameAddress);
      if (participants.length > 0) {
        console.log(`🧹 Cleaning up PlayerParticipation accounts for ${participants.length} players before closing game`);

        try {
          const cleanupResult = await this.cleanupAllPlayerParticipations(gamePda, gameAddress);
          console.log(`🧹 PlayerParticipation cleanup result: ${cleanupResult.cleaned} cleaned, ${cleanupResult.failed} failed`);

          // Continue even if some cleanups failed - we'll still try to close the game
        } catch (error) {
          console.error(`❌ Error during PlayerParticipation cleanup for ${gameType} ${gameAddress}:`, error);
          // Continue with game closure even if cleanup fails
        }
      }

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

    const lastPlayerTelegramId = participantIds[participantIds.length - 1];

    if (!lastPlayerTelegramId) {
      throw new Error('Last player telegram ID not found');
    }

    const lastPlayerPublicKey = this.gameDb.getPlayerPublicKey(lastPlayerTelegramId);

    if (!lastPlayerPublicKey) {
      throw new Error('Could not find last player public key');
    }

    const lastPlayerPubkey = new PublicKey(lastPlayerPublicKey);

    const unjoinInstruction = await this.program.methods
      .unjoinGame()
      .accounts({
        game: gamePda,
        player: playerPubkey,
        lastPlayer: lastPlayerPubkey,
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
          authority: adminKp.publicKey,
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
          console.log(`🔍 Found orphaned game: ${gameAddress} (${gameAccount.playersCount}/${gameAccount.maxPlayers})`);
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
      console.log(`🔄 Processing expired ${gameType} game ${address} (${gameAccount.playersCount}/${gameAccount.maxPlayers})`);

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
      console.log(`🔄 Processing expired ${gameType} game ${address} (${gameAccount.playersCount}/${gameAccount.maxPlayers})`);

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

      // Step 1: Clean up PlayerParticipation accounts first
      const participants = this.getGamePlayers(address);
      if (participants.length > 0) {
        console.log(`🧹 Cleaning up PlayerParticipation accounts for ${participants.length} players before closing`);

        try {
          const cleanupResult = await this.cleanupAllPlayerParticipations(gamePda, address);
          console.log(`🧹 PlayerParticipation cleanup result: ${cleanupResult.cleaned} cleaned, ${cleanupResult.failed} failed`);
        } catch (error) {
          console.error(`❌ Error during PlayerParticipation cleanup for expired ${gameType} ${address}:`, error);
          // Continue with game closure even if cleanup fails
        }
      }

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
