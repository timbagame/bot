import { PublicKey } from "@solana/web3.js";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { WalletManager } from "./wallet";
import { GameDatabase } from "./database";
import { OracleClient } from "./oracle";
import { PDAManager } from "./pda";
import { formatUserFriendlyError } from "./errors";
import { DEFAULT_NULL_ADDRESS, ADDRESS_DISPLAY_LENGTH, GAME_INFO_LIMIT } from "./constants";
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

const formatGameType = (gameType: Record<string, any>): string => {
  const keys = Object.keys(gameType);
  const firstKey = keys[0];
  if (!firstKey) return "Unknown";
  return firstKey.charAt(0).toUpperCase() + firstKey.slice(1);
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

const formatExpirationTime = (createdAt: number, timeout: number, prefix: string = "⏰ "): string => {
  const expiresAt = createdAt + timeout;
  const expirationDate = new Date(expiresAt * 1000);
  const now = new Date();
  const timeUntilExpiry = expirationDate.getTime() - now.getTime();

  if (timeUntilExpiry > 0) {
    const minutesLeft = Math.floor(timeUntilExpiry / (1000 * 60));
    const hoursLeft = Math.floor(minutesLeft / 60);
    const remainingMinutes = minutesLeft % 60;

    if (hoursLeft > 0) {
      return `${prefix}Expires in: ${hoursLeft}h ${remainingMinutes}m`;
    } else {
      return `${prefix}Expires in: ${minutesLeft}m`;
    }
  } else {
    return `${prefix}Expired`;
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
    private tokenMint: string,
    private ticker: string
  ) {}

  public static getInstance(
    program: anchor.Program<Coinflip>,
    wallet: WalletManager,
    gameDb: GameDatabase,
    tokenMint: string,
    ticker: string
  ): GameManager {
    if (!GameManager.instance) {
      const oracleClient = OracleClient.getInstance(wallet);
      GameManager.instance = new GameManager(program, wallet, gameDb, oracleClient, tokenMint, ticker);
    }
    return GameManager.instance;
  }

  // ================================
  // PLAYER BALANCE MANAGEMENT
  // ================================

  public async ensurePlayerBalance(playerKeypair: anchor.web3.Keypair): Promise<PublicKey> {
    const playerBalancePda = PDAManager.getPlayerBalancePDA(
      playerKeypair.publicKey,
      new PublicKey(this.tokenMint),
      this.program.programId
    );

    try {
      await this.program.account.playerBalance.fetch(playerBalancePda);
      return playerBalancePda;
    } catch (error) {
      // Create token account if needed
      const playerTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(this.tokenMint),
        playerKeypair.publicKey
      );

      try {
        await this.wallet.getConnection().getAccountInfo(playerTokenAccount);
      } catch (error) {
        const createAtaIx = createAssociatedTokenAccountInstruction(
          playerKeypair.publicKey,
          playerTokenAccount,
          playerKeypair.publicKey,
          new PublicKey(this.tokenMint)
        );
        const tx = await this.wallet.signAndSend([createAtaIx], [playerKeypair]);
        await this.wallet.confirmTransaction(tx);
      }

      // Initialize player balance
      const tx = await this.program.methods
        .initializePlayerBalance()
        .accounts({
          player: playerKeypair.publicKey,
          tokenMint: new PublicKey(this.tokenMint),
        })
        .signers([playerKeypair])
        .rpc();

      await this.wallet.confirmTransaction(tx);
      return playerBalancePda;
    }
  }

  // ================================
  // USERNAME UTILITIES
  // ================================

  public async getUsernameFromTelegramId(ctx: Context, telegramId: string): Promise<string> {
    try {
      const numericId = parseInt(telegramId, 10);
      if (isNaN(numericId)) {
        return telegramId.slice(0, ADDRESS_DISPLAY_LENGTH) + "...";
      }

      const chatMember = await ctx.api.getChatMember(ctx.chat!.id, numericId);
      return chatMember.user.username || chatMember.user.first_name || "Unknown User";
    } catch (error) {
      console.error(`Error getting username for Telegram ID ${telegramId}:`, error);
      return "Unknown";
    }
  }

  public async getGameCreatorUsername(ctx: Context, gameAddress: string): Promise<string> {
    const creatorTelegramId = this.gameDb.getCreatorTelegramId(gameAddress);
    if (!creatorTelegramId) {
      console.error(`No creator telegram ID found for game ${gameAddress}`);
      return "Unknown";
    }
    return this.getUsernameFromTelegramId(ctx, creatorTelegramId);
  }

  public async getPlayerUsername(ctx: Context, publicKey: string): Promise<string> {
    const playerTelegramId = this.gameDb.getPlayerTelegramId(publicKey);
    if (!playerTelegramId) {
      return publicKey.slice(0, ADDRESS_DISPLAY_LENGTH) + "...";
    }
    return this.getUsernameFromTelegramId(ctx, playerTelegramId);
  }

  // ================================
  // GAME MESSAGE MANAGEMENT
  // ================================

  public getActiveGameMessage(gameAddress: string): GameMessage | undefined {
    return this.activeGameMessages.get(gameAddress);
  }

  private async formatGameMessage(
    ctx: Context,
    gamePda: PublicKey,
    gameType: string,
    amount: number,
    creatorUsername: string,
    status: string,
    winnerAddress?: string,
    txHash?: string
  ): Promise<GameMessageFormat> {
    const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

    let gameAccount: any;
    let currentPlayers = 0;
    let maxPlayers = 2;
    let minPlayers = 1;
    let playerInfo = "";
    let expirationInfo = "";

    if (status.toLowerCase() === "completed") {
      // For completed games, use database info since the account is closed
      const participants = this.gameDb.getGameParticipants(gamePda.toBase58());
      currentPlayers = participants.length;

      if (participants.length > 0) {
        playerInfo = "\n";
        for (const telegramId of participants) {
          const username = await this.getUsernameFromTelegramId(ctx, telegramId);
          playerInfo += `• @${username}\n`;
        }
      }
    } else {
      // For active games, try to fetch the game account, but handle the case where it might be closed
      try {
        gameAccount = await this.program.account.game.fetch(gamePda);
        currentPlayers = gameAccount.players.length;
        maxPlayers = gameAccount.maxPlayers;
        minPlayers = gameAccount.minPlayers;

        if (currentPlayers > 0) {
          playerInfo = "\n";
          for (const playerPubkey of gameAccount.players) {
            const username = await this.getPlayerUsername(ctx, playerPubkey.toBase58());
            playerInfo += `• @${username}\n`;
          }
        }

        // Add expiration info for active games
        if (gameAccount) {
          const createdAt = Number(gameAccount.createdAt);
          const timeout = Number(gameAccount.timeout);
          expirationInfo = "\n" + formatExpirationTime(createdAt, timeout);
        }
      } catch (error: any) {
        // If we can't fetch the account, it's likely been closed due to completion
        if (error.message?.includes('Account does not exist')) {
          console.log(`Game account ${gamePda.toBase58()} no longer exists, likely completed`);

          // Update the status to completed and use database info
          status = "completed";
          const participants = this.gameDb.getGameParticipants(gamePda.toBase58());
          currentPlayers = participants.length;

          if (participants.length > 0) {
            playerInfo = "\n";
            for (const telegramId of participants) {
              const username = await this.getUsernameFromTelegramId(ctx, telegramId);
              playerInfo += `• @${username}\n`;
            }
          }
        } else {
          throw error; // Re-throw if it's a different error
        }
      }
    }

    // Winner info
    let winnerInfo = "";
    if (status.toLowerCase() === "completed" && winnerAddress) {
      if (winnerAddress === "cancelled" || winnerAddress === DEFAULT_NULL_ADDRESS) {
        winnerInfo = `\nStatus: Cancelled`;
      } else {
        const winnerUsername = await this.getPlayerUsername(ctx, winnerAddress);
        winnerInfo = `\nWinner: @${winnerUsername}`;
      }
    }

    let messageText = `<b>🪙 ${gameType} Game</b>\n\n` +
      `💰 Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
      `👤 Creator: @${creatorUsername}\n` +
      `👥 Players: ${currentPlayers}/${maxPlayers}${playerInfo}`;

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
    }

    messageText += winnerInfo;

    if (txHash) {
      messageText += `\n\nTransaction: <code>${txHash}</code>`;
    }

    // Keyboard - only show buttons for active games
    const keyboard = [];
    if (status.toLowerCase() !== "completed") {
      keyboard.push([
        { text: "🎮 Join", callback_data: `join_${gamePda.toBase58()}` },
        { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` }
      ]);

      if (currentPlayers > 0) {
        keyboard[0]?.push({ text: "❌ Unjoin", callback_data: `unjoin_${gamePda.toBase58()}` });
      }
    }

    return { messageText, keyboard };
  }

  public async createGameMessage(
    ctx: Context,
    gameAddress: string,
    gameType: string,
    amount: number,
    creatorUsername: string,
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
      undefined,
      txHash
    );

    const message = await ctx.reply(messageText, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
      reply_to_message_id: ctx.message?.message_id
    });

    await this.gameDb.saveGameMessage(gameAddress, message.message_id, message.chat.id);
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
    winnerAddress?: string
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
        winnerAddress
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

  public async getGameInfo(ctx: Context, gamePda: PublicKey): Promise<string> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

      const amount = Number(gameAccount.amount);
      const maxPlayers = gameAccount.maxPlayers;
      const currentPlayers = gameAccount.players.length;
      const creatorPubkey = gameAccount.creator.toString();
      const gameType = formatGameType(gameAccount.gameType);

      const creatorTelegramId = this.gameDb.getCreatorTelegramId(gamePda.toBase58());
      const creatorInfo = creatorTelegramId
        ? `@${await this.getUsernameFromTelegramId(ctx, creatorTelegramId)}`
        : `<code>${creatorPubkey.slice(0, ADDRESS_DISPLAY_LENGTH)}...</code>`;

      // Add expiration info
      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expirationInfo = "\n" + formatExpirationTime(createdAt, timeout);

      let winnerInfo = "";
      const gameData = this.gameDb.getGame(gamePda.toBase58());
      if (gameData && gameData.winner_address && gameData.winner_address !== "cancelled" && gameData.winner_address !== DEFAULT_NULL_ADDRESS) {
        const winnerUsername = await this.getPlayerUsername(ctx, gameData.winner_address);
        winnerInfo = `\nWinner: @${winnerUsername}`;
      }

      return `Type: ${gameType}\n` +
             `Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
             `Creator: ${creatorInfo}\n` +
             `Players: ${currentPlayers}/${maxPlayers}${expirationInfo}${winnerInfo}`;
    } catch (error: any) {
      return `Error fetching game: ${error.message}`;
    }
  }

  // Helper method to get game info for completed games from database
  public async getCompletedGameInfo(ctx: Context, gameData: any): Promise<string> {
    try {
      const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

      // For completed games, use stored game type from database
      const participants = this.gameDb.getGameParticipants(gameData.game_address);
      const gameType = gameData.game_type.charAt(0).toUpperCase() + gameData.game_type.slice(1);

      const creatorTelegramId = gameData.creator_telegram_id;
      const creatorInfo = creatorTelegramId
        ? `@${await this.getUsernameFromTelegramId(ctx, creatorTelegramId)}`
        : "Unknown";

      let winnerInfo = "";
      if (gameData.winner_address && gameData.winner_address !== "cancelled" && gameData.winner_address !== DEFAULT_NULL_ADDRESS) {
        const winnerUsername = await this.getPlayerUsername(ctx, gameData.winner_address);
        winnerInfo = `\nWinner: @${winnerUsername}`;
      } else if (gameData.winner_address === "cancelled") {
        winnerInfo = `\nStatus: Cancelled`;
      }

      return `Type: ${gameType}\n` +
             `Amount: ${this.wallet.formatTokenBalance(gameData.amount, metadata.decimals)} ${this.ticker}\n` +
             `Creator: ${creatorInfo}\n` +
             `Players: ${participants.length}${winnerInfo}`;
    } catch (error: any) {
      return `Error getting game info: ${error.message}`;
    }
  }

  public async createGame(
    ctx: Context,
    gameType: GameType,
    amount: number,
    maxPlayers: number,
    minPlayers: number,
    timeout: number
  ): Promise<void> {
    const telegramId = BigInt(ctx.from?.id || 0);
    const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

    try {
      const playerKp = this.wallet.getKeyPair(telegramId);
      const [tokenBalance, gameBalance] = await Promise.all([
        this.wallet.getTokenBalance(telegramId, this.tokenMint),
        this.getPlayerGameBalance(playerKp.publicKey)
      ]);

      const totalBalance = tokenBalance + gameBalance;
      if (totalBalance < amount) {
        await ctx.reply(
          `Insufficient balance. You have ${this.wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${this.ticker} but need ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}`,
          { reply_to_message_id: ctx.message?.message_id }
        );
        return;
      }

      const creatorPubkey = playerKp.publicKey.toBase58();
      this.gameDb.savePlayerMapping(creatorPubkey, telegramId.toString());

      // Check if oracle is available
      const isOracleHealthy = await this.oracleClient.isHealthy();
      if (!isOracleHealthy) {
        await ctx.reply(
          "❌ Oracle service is unavailable. Please try again later.",
          { reply_to_message_id: ctx.message?.message_id }
        );
        return;
      }

      const { randomHash, gameAddress } = await this.oracleClient.generateGameSecrets();
      const randomHashBuffer = this.oracleClient.hexToBuffer(randomHash);
      const gamePda = new PublicKey(gameAddress);

      this.gameDb.saveGameParticipant(gamePda.toBase58(), telegramId.toString(), creatorPubkey);
      await this.ensurePlayerBalance(playerKp);

      const gameConfig = {
        gameType: { [gameType]: {} },
        amount: new anchor.BN(amount),
        maxPlayers,
        minPlayers,
        timeout,
        isPrivate: true
      };

      const tx = await this.program.methods
        .initializeGame(gameConfig, [...randomHashBuffer])
        .accounts({
          player: playerKp.publicKey,
          tokenMint: new PublicKey(this.tokenMint),
        })
        .signers([playerKp])
        .rpc();

      this.gameDb.saveGame(gamePda.toBase58(), telegramId.toString(), amount, gameType);

      await this.createGameMessage(
        ctx,
        gamePda.toBase58(),
        gameType.charAt(0).toUpperCase() + gameType.slice(1),
        amount,
        ctx.from?.username || "Unknown",
        "Active",
        tx
      );

    } catch (error: any) {
      console.error(`Error creating ${gameType} game:`, error);
      const userFriendlyError = formatUserFriendlyError(error, this.wallet);
      await ctx.reply(userFriendlyError, {
        reply_to_message_id: ctx.message?.message_id
      });
    }
  }

  // ================================
  // HELPER METHODS
  // ================================

  private async getPlayerGameBalance(playerPubkey: PublicKey): Promise<number> {
    try {
      const playerBalancePda = PDAManager.getPlayerBalancePDA(
        playerPubkey,
        new PublicKey(this.tokenMint),
        this.program.programId
      );
      const playerBalance = await this.program.account.playerBalance.fetch(playerBalancePda);
      return Number(playerBalance.amount);
    } catch (error) {
      return 0;
    }
  }

  // ================================
  // EXPIRATION HANDLING
  // ================================

  public async handleExpiredGame(ctx: Context, gamePda: PublicKey, gameAccount: any): Promise<GameCancellationResult | false> {
    try {
      const blockTime = await this.wallet.getBlockchainTime();
      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const isExpired = blockTime > expiresAt;

      if (!isExpired) return false;

      const hasEnoughPlayers = gameAccount.players.length >= gameAccount.minPlayers;
      const creatorTelegramId = this.gameDb.getCreatorTelegramId(gamePda.toBase58());

      if (!creatorTelegramId) return false;

      if (hasEnoughPlayers) {
        // Game has enough players and is expired, let the oracle complete it
        console.log(`🎯 Game ${gamePda.toBase58()} is ready for oracle completion (expired with enough players)`);
        return false; // Don't cancel, let oracle complete
      }

      // Cancel the game if it doesn't have enough players
      if (creatorTelegramId === "orphaned") {
        // For orphaned games, try to cancel using player keys if available
        const result = await this.cancelGameWithPlayerKeys(gamePda);
        if (!result.success) {
          console.log(`Failed to cancel orphaned game with player keys: ${result.error}`);
          // Mark as completed since we can't process it
          const completedAt = blockTime * 1000;
          this.gameDb.completeGame(gamePda.toBase58(), "cancelled", completedAt);
          return {
            cancelled: true,
            amount: Number(gameAccount.amount),
            creator: gameAccount.creator.toString(),
            tx: "marked_cancelled"
          };
        }
        const completedAt = blockTime * 1000;
        this.gameDb.completeGame(gamePda.toBase58(), "cancelled", completedAt);
        return {
          cancelled: true,
          amount: Number(gameAccount.amount),
          creator: gameAccount.creator.toString(),
          tx: result.tx || "player_cancelled"
        };
      }

      // For regular games, use creator cancellation
      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const tx = await this.program.methods
        .cancelGame()
        .accounts({
          game: gamePda,
          creator: gameAccount.creator,
          authority: creatorKp.publicKey,
        })
        .signers([creatorKp])
        .rpc();

      const completedAt = blockTime * 1000;
      this.gameDb.completeGame(gamePda.toBase58(), "cancelled", completedAt);

      // Send cancellation notification
      const gameMessage = this.activeGameMessages.get(gamePda.toBase58());
      if (gameMessage) {
        const metadata = await this.wallet.getTokenMetadata(this.tokenMint);
        const gameType = formatGameType(gameAccount.gameType);
        const amount = Number(gameAccount.amount);
        const playerCount = gameAccount.players.length;

        await ctx.reply(
          `❌ <b>${gameType} Cancelled!</b>\n\n` +
          `⏰ Game expired with insufficient players\n` +
          `💰 Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
          `👥 Players: ${playerCount}/${gameAccount.maxPlayers}\n\n` +
          `💸 Funds have been returned to players`,
          {
            parse_mode: "HTML",
            reply_to_message_id: gameMessage.messageId
          }
        );
      }

      return {
        cancelled: true,
        amount: Number(gameAccount.amount),
        creator: gameAccount.creator.toString(),
        tx
      };
    } catch (error) {
      console.error(`Error handling expired game ${gamePda.toBase58()}:`, error);
      return false;
    }
  }

  // ================================
  // UNJOIN FUNCTIONALITY
  // ================================

  public async unjoinGame(ctx: Context, gamePda: PublicKey, playerKp: anchor.web3.Keypair): Promise<boolean> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);

      const isInGame = gameAccount.players.some((p: PublicKey) => p.equals(playerKp.publicKey));
      if (!isInGame) {
        throw new Error("You are not in this game");
      }

      const tx = await this.program.methods
        .unjoinGame()
        .accounts({
          game: gamePda,
          player: playerKp.publicKey,
          authority: playerKp.publicKey,
        })
        .signers([playerKp])
        .rpc();

      await this.wallet.confirmTransaction(tx);

      const creatorTelegramId = await this.gameDb.getCreatorTelegramId(gamePda.toBase58());
      if (creatorTelegramId) {
        const creatorUsername = await this.getUsernameFromTelegramId(ctx, creatorTelegramId);
        await this.updateGameMessage(
          ctx,
          gamePda.toBase58(),
          formatGameType(gameAccount.gameType),
          Number(gameAccount.amount),
          creatorUsername,
          "Active"
        );
      }

      return true;
    } catch (error: any) {
      console.error(`Error unjoining game ${gamePda.toBase58()}:`, error);
      throw error;
    }
  }

  // ================================
  // PLAYER-BASED GAME CANCELLATION
  // ================================

  public async cancelGameWithPlayerKeys(gamePda: PublicKey): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      console.log(`Attempting to cancel game ${gamePda.toBase58()} using player keys`);

      // Check if there are any non-creator players to unjoin first
      const nonCreatorPlayers = gameAccount.players.filter((player: any) => !player.equals(gameAccount.creator));

      if (nonCreatorPlayers.length > 0) {
        console.log(`Game has ${nonCreatorPlayers.length} non-creator players, unjoining them first`);
        await this.unjoinAllPlayersWithKeys(gamePda, gameAccount);
      }

      // Now cancel the game using creator's key
      const creatorPubkey = gameAccount.creator.toBase58();
      const creatorTelegramId = this.gameDb.getPlayerTelegramId(creatorPubkey);

      if (!creatorTelegramId) {
        console.log(`No telegram ID found for creator ${creatorPubkey}, cannot cancel game`);
        return { success: false, error: "Creator not found in database" };
      }

      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const tx = await this.program.methods
        .cancelGame()
        .accounts({
          game: gamePda,
          creator: gameAccount.creator,
          authority: creatorKp.publicKey,
        })
        .signers([creatorKp])
        .rpc();

      await this.wallet.confirmTransaction(tx);
      console.log(`Successfully cancelled game ${gamePda.toBase58()} with tx: ${tx}`);

      return { success: true, tx };
    } catch (error: any) {
      console.error(`Error cancelling game with player keys ${gamePda.toBase58()}:`, error);
      return { success: false, error: error.message };
    }
  }

  private async unjoinAllPlayersWithKeys(gamePda: PublicKey, gameAccount: any): Promise<void> {
    for (const playerPubkey of gameAccount.players) {
      try {
        // Skip the creator - they can cancel with players in the game
        if (playerPubkey.equals(gameAccount.creator)) {
          console.log(`Skipping creator ${playerPubkey.toBase58()} - they can cancel with players`);
          continue;
        }

        // Look up player's telegram ID from database
        const playerTelegramId = this.gameDb.getPlayerTelegramId(playerPubkey.toBase58());
        if (!playerTelegramId) {
          console.log(`No telegram ID found for player ${playerPubkey.toBase58()}, skipping unjoin`);
          continue;
        }

        console.log(`Unjoining player ${playerPubkey.toBase58()} from game ${gamePda.toBase58()}`);

        const playerKp = this.wallet.getKeyPair(BigInt(playerTelegramId));

        const tx = await this.program.methods
          .unjoinGame()
          .accounts({
            game: gamePda,
            player: playerPubkey,
            authority: playerKp.publicKey,
          })
          .signers([playerKp])
          .rpc();

        await this.wallet.confirmTransaction(tx);
        console.log(`Successfully unjoined player ${playerPubkey.toBase58()}`);

      } catch (error) {
        console.error(`Failed to unjoin player ${playerPubkey.toBase58()}:`, error);
        // Continue with other players even if one fails
      }
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

      const adminKp = authResult.adminKeypair!;
      await this.ensurePlayerBalance(playerKp);

      const tx = await this.program.methods
        .joinGame()
        .accounts({
          game: gamePda,
          player: playerKp.publicKey,
          authority: adminKp.publicKey,
        })
        .signers([playerKp, adminKp])
        .rpc();

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
    totalTokensInGames: number;
  }> {
    const telegramIdStr = telegramId.toString();
    const playerKp = this.wallet.getKeyPair(telegramId);
    const playerPublicKey = playerKp.publicKey.toString();

    const [activeGamesData, recentGamesData] = await Promise.all([
      this.gameDb.getActiveGames(telegramIdStr),
      this.gameDb.getRecentGames(telegramIdStr, GAME_INFO_LIMIT)
    ]);

    // Active games
    let totalTokensInGames = 0;
    const activeGames = await Promise.all(activeGamesData.map(async (gameData) => {
      try {
        const gamePda = new PublicKey(gameData.game_address);
        const gameAccount = await this.program.account.game.fetch(gamePda);
        totalTokensInGames += Number(gameAccount.amount);
        return this.getGameInfo(ctx, gamePda);
      } catch (error) {
        console.error(`Error fetching game ${gameData.game_address}:`, error);
        return null;
      }
    }));

    const validActiveGames = activeGames.filter((game): game is string => game !== null);
    const activeGamesSection = validActiveGames.length > 0
      ? "🎮 <b>Active Games</b>\n\n" + validActiveGames.join("\n\n")
      : "";

    // Recent games
    const recentGames = await Promise.all(recentGamesData.map(async (gameData) => {
      try {
        const category = categorizeGame(gameData, telegramIdStr, playerPublicKey);
        // For completed games, use database info instead of trying to fetch from blockchain
        // since completed game accounts are closed to reclaim rent
        const gameInfo = await this.getCompletedGameInfo(ctx, gameData);
        return { category, gameInfo, completedAt: gameData.completed_at };
      } catch (error) {
        console.error(`Error processing game ${gameData.game_address}:`, error);
        return null;
      }
    }));

    const validRecentGames = recentGames.filter((game): game is any => game !== null);

    // Categorize recent games
    const categories: GameCategory = {
      won: validRecentGames.filter(g => g.category === 'won'),
      lost: validRecentGames.filter(g => g.category === 'lost'),
      cancelled: validRecentGames.filter(g => g.category === 'cancelled'),
      created: validRecentGames.filter(g => g.category === 'created')
    };

    const formatSection = (games: any[], title: string): string => {
      if (games.length === 0) return "";
      let section = `${title}\n\n`;
      for (const game of games) {
        section += `${game.gameInfo}\n`;
        if (game.completedAt) {
          section += `Completed: ${formatDate(game.completedAt)}\n\n`;
        }
      }
      return section;
    };

    const recentGamesSections = [
      formatSection(categories.won, "🏆 <b>Won Games</b>"),
      formatSection(categories.lost, "😢 <b>Lost Games</b>"),
      formatSection(categories.created, "🎮 <b>Created Games</b>"),
      formatSection(categories.cancelled, "❌ <b>Cancelled Games</b>")
    ].filter(section => section !== "").join("\n");

    return {
      activeGames: activeGamesSection,
      recentGames: recentGamesSections,
      totalTokensInGames
    };
  }

  // ================================
  // RELOAD FUNCTIONALITY
  // ================================

  public async reloadGameMessages(): Promise<void> {
    const allGames = await this.gameDb.getAllGames();
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
    const connection = this.wallet.getConnection();
    const programAccounts = await connection.getProgramAccounts(this.program.programId);

    console.log(`📊 Found ${programAccounts.length} program accounts on blockchain`);

    const orphanedGames: { address: string; account: any }[] = [];
    let validGameAccounts = 0;

    for (const { pubkey } of programAccounts) {
      try {
        const gameAccount = await this.program.account.game.fetch(pubkey);
        validGameAccounts++;

        const gameAddress = pubkey.toBase58();
        if (!this.gameDb.gameExists(gameAddress)) {
          orphanedGames.push({ address: gameAddress, account: gameAccount });
          console.log(`🔍 Found orphaned game: ${gameAddress} (${gameAccount.players.length}/${gameAccount.maxPlayers})`);
        }
      } catch (error) {
        // Skip non-game accounts
        continue;
      }
    }

    console.log(`🎮 Found ${validGameAccounts} valid game accounts on blockchain`);
    return orphanedGames;
  }

  private async cancelOrphanedGame(address: string): Promise<boolean> {
    try {
      const gamePda = new PublicKey(address);
      console.log(`🔄 Attempting to cancel orphaned game ${address}`);

      const result = await this.cancelGameWithPlayerKeys(gamePda);
      if (result.success) {
        console.log(`✅ Successfully cancelled orphaned game ${address}`);
        return true;
      } else {
        console.log(`❌ Failed to cancel orphaned game ${address}: ${result.error}`);
        return false;
      }
    } catch (error: any) {
      if (error.message?.includes('Account does not exist')) {
        console.log(`ℹ️ Orphaned game ${address} was already closed`);
        return true;
      } else {
        console.error(`❌ Error cancelling orphaned game ${address}:`, error.message);
        return false;
      }
    }
  }
}
