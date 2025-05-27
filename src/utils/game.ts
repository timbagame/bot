import { PublicKey } from "@solana/web3.js";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { WalletManager } from "./wallet";
import { GameDatabase } from "./database";
import { OracleManager } from "./oracle";
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

const formatGameType = (gameType: any): string => {
  return Object.keys(gameType)[0].charAt(0).toUpperCase() + Object.keys(gameType)[0].slice(1);
};

const formatDate = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
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

const categorizeGame = (gameData: any, telegramIdStr: string, playerPublicKey: string): string => {
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
    private oracleManager: OracleManager,
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
      const oracleManager = OracleManager.getInstance(program, wallet);
      GameManager.instance = new GameManager(program, wallet, gameDb, oracleManager, tokenMint, ticker);
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
      const numericId = parseInt(telegramId);
      if (isNaN(numericId)) {
        return telegramId.slice(0, ADDRESS_DISPLAY_LENGTH) + "...";
      }

      const chatMember = await ctx.api.getChatMember(ctx.chat!.id, numericId);
      return chatMember.user.username || chatMember.user.first_name;
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
    let playerInfo = "";
    let expirationInfo = "";

    if (status.toLowerCase() === "completed") {
      // For completed games, use database info
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
      // For active games, fetch the game account
      gameAccount = await this.program.account.game.fetch(gamePda);
      currentPlayers = gameAccount.players.length;
      maxPlayers = gameAccount.maxPlayers;

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
    }

    // Winner info
    let winnerInfo = "";
    if (status.toLowerCase() === "completed" && winnerAddress) {
      const winnerUsername = await this.getPlayerUsername(ctx, winnerAddress);
      winnerInfo = `\nWinner: @${winnerUsername}`;
    }

    let messageText = `<b>🪙 ${gameType} Game</b>\n\n` +
      `💰 Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
      `👤 Creator: @${creatorUsername}\n` +
      `👥 Players: ${currentPlayers}/${maxPlayers}${playerInfo}`;

    if (status.toLowerCase() !== "completed") {
      const statusText = currentPlayers < maxPlayers ?
        `${maxPlayers - currentPlayers} more needed` :
        "Full - starting soon!";
      messageText += `\nStatus: ${statusText}${expirationInfo}`;
    }

    messageText += winnerInfo;

    if (txHash) {
      messageText += `\n\nTransaction: <code>${txHash}</code>`;
    }

    // Keyboard
    const keyboard = [];
    if (status.toLowerCase() !== "completed") {
      keyboard.push([
        { text: "🎮 Join", callback_data: `join_${gamePda.toBase58()}` },
        { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` }
      ]);

      if (currentPlayers > 0) {
        keyboard[0].push({ text: "❌ Unjoin", callback_data: `unjoin_${gamePda.toBase58()}` });
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

      const { randomHash } = this.oracleManager.generateGameSecrets();
      const gamePda = PDAManager.getGamePDA(randomHash, this.program.programId);

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
        .initializeGame(gameConfig, [...randomHash])
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
  // COMPLETION AND EXPIRATION
  // ================================

  public async handleGameCompletion(ctx: Context, gamePda: PublicKey): Promise<boolean> {
    try {
      console.log(`🎯 Starting game completion for ${gamePda.toBase58()}`);
      const result = await this.oracleManager.completeGame(gamePda);

      if (!result.success) {
        console.log(`❌ Oracle completion failed: ${result.error}`);
        throw new Error(result.error || "Failed to complete game");
      }

      if (!result.event) {
        throw new Error("No event data received from completion");
      }

      const event = result.event;
      const winnerAddress = event.winner.toString();
      const blockTime = await this.wallet.getBlockchainTime();
      const completedAt = blockTime * 1000;

      this.gameDb.completeGame(gamePda.toBase58(), winnerAddress, completedAt);

      const creatorTelegramId = this.gameDb.getCreatorTelegramId(gamePda.toBase58());
      if (creatorTelegramId) {
        const creatorUsername = await this.getUsernameFromTelegramId(ctx, creatorTelegramId);
        const gameType = formatGameType(event.gameType);

        await this.updateGameMessage(
          ctx,
          gamePda.toBase58(),
          gameType,
          Number(event.amount),
          creatorUsername,
          "Completed",
          winnerAddress
        );
      }

      return true;
    } catch (error: any) {
      console.error(`Error completing game ${gamePda.toBase58()}:`, error);
      throw error;
    }
  }

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
        try {
          const completed = await this.handleGameCompletion(ctx, gamePda);
          return completed ? false : false;
        } catch (error: any) {
          console.error(`Oracle completion failed: ${error.message}`);
        }
      }

      // Cancel the game
      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const tx = await this.program.methods
        .cancelGame()
        .accounts({
          game: gamePda,
          creator: gameAccount.creator,
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

  public async autoCompleteGame(gamePda: PublicKey): Promise<boolean> {
    try {
      const result = await this.oracleManager.completeGame(gamePda);

      if (!result.success) {
        console.log(`❌ Auto-completion failed: ${result.error}`);
        return false;
      }

      if (result.event) {
        const winnerAddress = result.event.winner.toString();
        const blockTime = await this.wallet.getBlockchainTime();
        const completedAt = blockTime * 1000;
        this.gameDb.completeGame(gamePda.toBase58(), winnerAddress, completedAt);
      }

      return true;
    } catch (error) {
      console.error('Error auto-completing game:', error);
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
  // PRIVATE GAME FUNCTIONALITY
  // ================================

  public async joinPrivateGame(
    gamePda: PublicKey,
    playerKp: anchor.web3.Keypair,
    chatId: number
  ): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      const authResult = await this.oracleManager.authorizePlayer(gamePda, chatId);

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

      // Get all game accounts from the blockchain
      const connection = this.wallet.getConnection();

      const programAccounts = await connection.getProgramAccounts(this.program.programId, {
        // Remove the dataSize filter since it varies based on max_players
        // Game space = 100 + (32 * max_players) bytes
        // We'll rely on parsing to identify valid game accounts
      });

      console.log(`📊 Found ${programAccounts.length} program accounts on blockchain`);

      const orphanedGames: { address: string; account: any }[] = [];
      let validGameAccounts = 0;

      for (const { pubkey } of programAccounts) {
        try {
          // Try to parse as a game account - this will throw if it's not a valid game account
          const gameAccount = await this.program.account.game.fetch(pubkey);
          validGameAccounts++;

          const gameAddress = pubkey.toBase58();

          // Check if this game exists in our database
          if (!this.gameDb.gameExists(gameAddress)) {
            // This is an orphaned game - exists on blockchain but not in database
            orphanedGames.push({ address: gameAddress, account: gameAccount });
            console.log(`🔍 Found orphaned game: ${gameAddress} (max_players: ${gameAccount.maxPlayers})`);
          }
        } catch (error) {
          // Skip accounts that can't be parsed as game accounts
          // This is expected for other account types in the program
          continue;
        }
      }

      console.log(`🎮 Found ${validGameAccounts} valid game accounts on blockchain`);
      console.log(`🚨 Found ${orphanedGames.length} orphaned games`);

      // Process orphaned games
      let processedCount = 0;
      for (const { address, account } of orphanedGames) {
        try {
          const gamePda = new PublicKey(address);
          const blockTime = await this.wallet.getBlockchainTime();
          const createdAt = Number(account.createdAt);
          const timeout = Number(account.timeout);
          const expiresAt = createdAt + timeout;
          const isExpired = blockTime > expiresAt;
          const gameType = Object.keys(account.gameType)[0];

          console.log(`📋 Orphaned game ${address}: players=${account.players.length}/${account.maxPlayers}, expired=${isExpired}, type=${gameType}`);

          // Only handle games that are expired and have insufficient players
          if (isExpired && account.players.length < account.minPlayers) {
            console.log(`🔄 Processing expired orphaned game: ${address}`);

            // Try to cancel the game if we can
            try {
              const creatorKp = this.wallet.getAdminKeypair(); // Use admin for orphaned games

              const tx = await this.program.methods
                .cancelGame()
                .accounts({
                  game: gamePda,
                  creator: account.creator,
                })
                .signers([creatorKp])
                .rpc();

              console.log(`✅ Successfully cancelled orphaned game ${address} with tx: ${tx}`);
              processedCount++;

              // Add entry to database to track this processed game
              this.gameDb.saveOrphanedGame(address, Number(account.amount), gameType, 'completed');
              this.gameDb.completeGame(address, "cancelled", blockTime * 1000);

            } catch (cancelError: any) {
              console.error(`❌ Failed to cancel orphaned game ${address}:`, cancelError.message);

              // If we can't cancel, check if the game was already completed
              if (cancelError.message?.includes('Account does not exist')) {
                console.log(`ℹ️ Orphaned game ${address} was already completed/closed`);
                // Still track it in our database as processed
                this.gameDb.saveOrphanedGame(address, Number(account.amount), gameType, 'completed');
                this.gameDb.completeGame(address, "unknown", blockTime * 1000);
              } else {
                // Track failed attempts to avoid retrying immediately
                this.gameDb.saveOrphanedGame(address, Number(account.amount), gameType, 'failed');
              }
            }
          } else if (!isExpired) {
            console.log(`⏰ Orphaned game ${address} is not yet expired`);
            // Track active orphaned games in database
            this.gameDb.saveOrphanedGame(address, Number(account.amount), gameType, 'active');
          } else if (account.players.length >= account.minPlayers) {
            console.log(`👥 Orphaned game ${address} has enough players, attempting completion`);

            // Try to complete the game if it has enough players
            try {
              const result = await this.oracleManager.completeGame(gamePda);
              if (result.success) {
                console.log(`✅ Successfully completed orphaned game ${address}`);
                processedCount++;

                // Add to database
                const winnerAddress = result.event?.winner.toString() || "unknown";
                this.gameDb.saveOrphanedGame(address, Number(account.amount), gameType, 'completed');
                this.gameDb.completeGame(address, winnerAddress, blockTime * 1000);
              } else {
                console.log(`❌ Oracle completion failed for orphaned game ${address}`);
                this.gameDb.saveOrphanedGame(address, Number(account.amount), gameType, 'failed');
              }
            } catch (completeError: any) {
              console.error(`❌ Failed to complete orphaned game ${address}:`, completeError.message);
              if (completeError.message?.includes('Account does not exist')) {
                console.log(`ℹ️ Orphaned game ${address} was already completed/closed`);
                this.gameDb.saveOrphanedGame(address, Number(account.amount), gameType, 'completed');
                this.gameDb.completeGame(address, "unknown", blockTime * 1000);
              } else {
                this.gameDb.saveOrphanedGame(address, Number(account.amount), gameType, 'failed');
              }
            }
          }

        } catch (error: any) {
          console.error(`❌ Error processing orphaned game ${address}:`, error.message);
        }
      }

      console.log(`🏁 Blockchain scan completed. Processed ${processedCount}/${orphanedGames.length} orphaned games`);

      // Log statistics
      const stats = this.gameDb.getOrphanedGameStats();
      console.log(`📊 Orphaned game statistics - Total: ${stats.total}, Active: ${stats.active}, Completed: ${stats.completed}, Failed: ${stats.failed}`);

    } catch (error) {
      console.error("❌ Error during blockchain scan:", error);
    }
  }
}
