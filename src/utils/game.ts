import { PublicKey } from "@solana/web3.js";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { WalletManager } from "./wallet";
import { GameDatabase } from "./database";
import { OracleManager } from "./oracle";
import { formatUserFriendlyError } from "./errors";
import { GAME_ACCOUNT_CACHE_DURATION } from "./constants";
import type { GameMessage, GameCancellationResult, GameMessageFormat, GameCategory, GameInfo, GameBasicInfo } from "../types/game";
import type { Coinflip } from "../../idl/idlType";

// ================================
// HELPER FUNCTIONS
// ================================

const formatGameType = (gameType: any): string => {
  return Object.keys(gameType)[0].charAt(0).toUpperCase() + Object.keys(gameType)[0].slice(1);
};

const formatGameStatus = (status: string): string => {
  return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
};

const formatDate = (timestamp: number): string => {
  return new Date(timestamp * 1000).toLocaleString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
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
  private activeGameMessages: Map<string, GameMessage>;
  private gameAccountCache: Map<string, { account: any; timestamp: number }>;
  private readonly CACHE_DURATION = GAME_ACCOUNT_CACHE_DURATION;
  private pdaCache: Map<string, PublicKey>;

  private readonly PDA_SEEDS = {
    PLAYER_BALANCE: Buffer.from("player_balance"),
    GAME: Buffer.from("game")
  };

  private constructor(
    private program: anchor.Program<Coinflip>,
    private wallet: WalletManager,
    private gameDb: GameDatabase,
    private oracleManager: OracleManager,
    private tokenMint: string,
    private ticker: string
  ) {
    this.activeGameMessages = new Map();
    this.gameAccountCache = new Map();
    this.pdaCache = new Map();
  }

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

  private getPda(seeds: Buffer[], programId: PublicKey): PublicKey {
    const key = seeds.map(s => s.toString('hex')).join('_') + programId.toBase58();
    if (!this.pdaCache.has(key)) {
      const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
      this.pdaCache.set(key, pda);
    }
    return this.pdaCache.get(key)!;
  }

  private getPlayerBalancePda(playerPubkey: PublicKey): PublicKey {
    return this.getPda(
      [this.PDA_SEEDS.PLAYER_BALANCE, playerPubkey.toBuffer(), new PublicKey(this.tokenMint).toBuffer()],
      this.program.programId
    );
  }

  private getGamePda(randomHash: Buffer): PublicKey {
    return this.getPda([this.PDA_SEEDS.GAME, randomHash], this.program.programId);
  }

  private async calculateExpirationTime(gameAccount: any): Promise<string> {
    try {
      const blockTime = await this.wallet.getBlockchainTime();
      if (!blockTime) return "";

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const timeLeft = expiresAt - blockTime;

      if (timeLeft > 0) {
        const hours = Math.floor(timeLeft / 3600);
        const minutes = Math.floor((timeLeft % 3600) / 60);
        return `\n⏰ Expires in: ${hours}h ${minutes}m`;
      } else {
        return "\n⚠️ Expired";
      }
    } catch (error) {
      console.error("Error calculating expiration time:", error);
      return "";
    }
  }

  public async ensurePlayerBalance(playerKeypair: anchor.web3.Keypair): Promise<PublicKey> {
    const playerBalancePda = this.getPlayerBalancePda(playerKeypair.publicKey);

    try {
      await this.program.account.playerBalance.fetch(playerBalancePda);
    } catch (error) {
      const playerTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(this.tokenMint),
        playerKeypair.publicKey
      );

      try {
        await this.wallet.getTokenAccountBalance(playerTokenAccount);
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

      const tx = await this.program.methods
        .initializePlayerBalance()
        .accounts({
          player: playerKeypair.publicKey,
          tokenMint: new PublicKey(this.tokenMint),
        })
        .signers([playerKeypair])
        .rpc();

      await this.wallet.confirmTransaction(tx);
    }

    return playerBalancePda;
  }

  private async getCachedGameAccount(gamePda: PublicKey, forceFresh: boolean = false): Promise<any> {
    const cacheKey = gamePda.toBase58();
    const cached = this.gameAccountCache.get(cacheKey);
    const now = Date.now();

    if (!forceFresh && cached && now - cached.timestamp < this.CACHE_DURATION) {
      return cached.account;
    }

    const account = await this.program.account.game.fetch(gamePda);
    this.gameAccountCache.set(cacheKey, { account, timestamp: now });
    return account;
  }

  /**
   * Clear the game account cache for a specific game
   */
  private clearGameAccountCache(gamePda: PublicKey): void {
    this.gameAccountCache.delete(gamePda.toBase58());
  }

  /**
   * Get the active game message for a given game address
   */
  public getActiveGameMessage(gameAddress: string): GameMessage | undefined {
    return this.activeGameMessages.get(gameAddress);
  }

  private async getGameStatusInfo(gameAccount: any): Promise<GameInfo> {
    const status = Object.keys(gameAccount.status)[0].toLowerCase();
    const createdAt = Number(gameAccount.createdAt);
    const timeout = Number(gameAccount.timeout);
    const expiresAt = createdAt + timeout;
    const blockTime = await this.wallet.getBlockchainTime();
    const isExpired = blockTime > expiresAt;
    const hasEnoughPlayers = gameAccount.players.length >= gameAccount.minPlayers;

    return { status, isExpired, hasEnoughPlayers };
  }

  private async getGameBasicInfo(gameAccount: any): Promise<GameBasicInfo> {
    return {
      amount: Number(gameAccount.amount),
      maxPlayers: gameAccount.maxPlayers,
      minPlayers: gameAccount.minPlayers,
      currentPlayers: gameAccount.players.length,
      creatorPubkey: gameAccount.creator.toString(),
      status: Object.keys(gameAccount.status)[0],
      gameType: formatGameType(gameAccount.gameType)
    };
  }

  private async getPlayerInfo(ctx: Context, gameAccount: any): Promise<string> {
    if (gameAccount.players.length === 0) return "";

    let playerInfo = "\n";
    for (const playerPubkey of gameAccount.players) {
      const username = await this.getPlayerUsername(ctx, playerPubkey.toBase58());
      playerInfo += `• @${username}\n`;
    }
    return playerInfo;
  }

  private async getWinnerInfo(ctx: Context, gameAccount: any): Promise<string> {
    if (!gameAccount.winner || gameAccount.winner.toString() === "11111111111111111111111111111111") {
      return "";
    }
    const winnerUsername = await this.getPlayerUsername(ctx, gameAccount.winner.toString());
    return `\n🏆 Winner: @${winnerUsername}`;
  }

  private async getCreatorInfo(ctx: Context, gamePda: PublicKey, creatorPubkey: string): Promise<string> {
    const creatorTelegramId = await this.gameDb.getCreatorTelegramId(gamePda.toBase58());
    if (creatorTelegramId) {
      const creatorUsername = await this.getUsernameFromTelegramId(ctx, creatorTelegramId);
      if (creatorUsername !== "Unknown") {
        return `@${creatorUsername}`;
      }
    }
    return `<code>${creatorPubkey.slice(0, 8)}...</code>`;
  }

  public async handleGameCompletion(
    ctx: Context,
    gamePda: PublicKey,
  ): Promise<boolean> {
    try {
      console.log(`🎯 Starting game completion for ${gamePda.toBase58()}`);
      const result = await this.oracleManager.completeGame(gamePda);

      if (!result.success) {
        console.log(`❌ Oracle completion failed: ${result.error}`);
        throw new Error(result.error || "Failed to complete game");
      }

      console.log(`✅ Oracle completion successful, winner: ${result.winnerAddress}`);

      const blockTime = await this.wallet.getBlockchainTime();
      const completedAt = blockTime * 1000;

      this.gameDb.completeGame(gamePda.toBase58(), result.winnerAddress!, completedAt);
      console.log(`💾 Saved game completion to database`);

      await this.updateGameMessageWithWinner(ctx, gamePda, result.winnerAddress!);
      console.log(`📝 Updated game message with winner`);

      return true;
    } catch (error: any) {
      console.error(`Error completing game ${gamePda.toBase58()}:`, error);
      if (error.message.includes("GameReadyForOracle")) {
        ctx.reply(`Game is already being completed by the oracle. Please wait for it to finish.`);
        return true;
      }
      throw error;
    }
  }

  public async handleExpiredGame(ctx: Context, gamePda: PublicKey, gameAccount: any): Promise<GameCancellationResult | false> {
    try {
      const { isExpired, hasEnoughPlayers } = await this.getGameStatusInfo(gameAccount);
      if (!isExpired) return false;

      const adminKp = this.wallet.getAdminKeypair();
      const creatorTelegramId = this.gameDb.getCreatorTelegramId(gamePda.toBase58());
      if (!creatorTelegramId) return false;

      if (hasEnoughPlayers) {
        try {
          const completed = await this.handleGameCompletion(ctx, gamePda);
          return completed ? false : false;
        } catch (error: any) {
          console.error(`Oracle completion failed: ${error.message}`);
          if (error.message.includes("GameNotReadyForOracle")) {
            // Fall through to cancellation logic
          } else {
            throw error;
          }
        }
      }

      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      try {
        const tx = await this.program.methods
          .cancelGame()
          .accounts({
            game: gamePda,
            player: gameAccount.creator,
          })
          .signers([adminKp, creatorKp])
          .rpc();

        const blockTime = await this.wallet.getBlockchainTime();
        const completedAt = blockTime * 1000;

        this.gameDb.completeGame(gamePda.toBase58(), "cancelled", completedAt);

        // Send cancellation notification
        await this.sendCancellationNotification(ctx, gameAccount, gamePda.toBase58());

        return {
          cancelled: true,
          amount: Number(gameAccount.amount),
          creator: gameAccount.creator.toString(),
          tx
        };
      } catch (error: any) {
        if (error.message.includes("GameReadyForOracle")) {
          const completed = await this.handleGameCompletion(ctx, gamePda);
          return completed ? false : false;
        }
        throw error;
      }
    } catch (error) {
      console.error(`Error handling expired game ${gamePda.toBase58()}:`, error);
      return false;
    }
  }

  public async autoCompleteGame(ctx: Context, gamePda: PublicKey): Promise<boolean> {
    try {
      const gameInfo = this.activeGameMessages.get(gamePda.toBase58());
      if (!gameInfo) return false;
      return await this.handleGameCompletion(ctx, gamePda);
    } catch (error) {
      console.error('Error auto-completing game:', error);
      return false;
    }
  }

  private async updateGameMessageWithWinner(
    ctx: Context,
    gamePda: PublicKey,
    winnerPubkeyStr: string
  ): Promise<void> {
    const gameMessage = this.activeGameMessages.get(gamePda.toBase58());
    if (!gameMessage) return;

    // Clear cache to ensure we get the latest game state with all players
    this.clearGameAccountCache(gamePda);

    const gameAccount = await this.getCachedGameAccount(gamePda, true);
    const creatorTelegramId = this.gameDb.getCreatorTelegramId(gamePda.toBase58());
    if (!creatorTelegramId) return;

    const creatorUsername = await this.getUsernameFromTelegramId(ctx, creatorTelegramId);
    const gameType = Object.keys(gameAccount.gameType)[0].charAt(0).toUpperCase() + Object.keys(gameAccount.gameType)[0].slice(1);

    await this.updateGameMessage(
      ctx,
      gamePda.toBase58(),
      gameType,
      Number(gameAccount.amount),
      creatorUsername,
      "Completed",
      winnerPubkeyStr
    );

    // Send a completion notification reply
    await this.sendCompletionNotification(ctx, gameAccount, winnerPubkeyStr, gameType, gameMessage.messageId);
  }

  /**
   * Send a completion notification when a game finishes
   */
  private async sendCompletionNotification(
    ctx: Context,
    gameAccount: any,
    winnerPubkeyStr: string,
    gameType: string,
    replyToMessageId: number
  ): Promise<void> {
    try {
      console.log(`🎉 Sending completion notification for ${gameType} game, winner: ${winnerPubkeyStr}`);
      const metadata = await this.wallet.getTokenMetadata(this.tokenMint);
      const winnerUsername = await this.getPlayerUsername(ctx, winnerPubkeyStr);
      const entryAmount = Number(gameAccount.amount);
      const playerCount = gameAccount.players.length;
      const totalPrize = entryAmount * playerCount; // Winner gets total from all players

      await ctx.reply(
        `🎉 <b>${gameType} Completed!</b>\n\n` +
        `🏆 Winner: @${winnerUsername}\n` +
        `💰 Prize: ${this.wallet.formatTokenBalance(totalPrize, metadata.decimals)} ${this.ticker}\n` +
        `👥 Players: ${playerCount}`,
        {
          parse_mode: "HTML",
          reply_to_message_id: replyToMessageId
        }
      );
      console.log(`✅ Completion notification sent successfully`);
    } catch (error) {
      console.error("Error sending completion notification:", error);
    }
  }

  /**
   * Send a cancellation notification when a game is cancelled
   */
  private async sendCancellationNotification(
    ctx: Context,
    gameAccount: any,
    gameAddress: string
  ): Promise<void> {
    try {
      const gameMessage = this.activeGameMessages.get(gameAddress);
      if (!gameMessage) return;

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
    } catch (error) {
      console.error("Error sending cancellation notification:", error);
    }
  }

  public async unjoinGame(ctx: Context, gamePda: PublicKey, playerKp: anchor.web3.Keypair): Promise<boolean> {
    try {
      const gameAccount = await this.getCachedGameAccount(gamePda);
      const status = Object.keys(gameAccount.status)[0].toLowerCase();

      if (status !== 'active') {
        throw new Error("Game is not active");
      }

      const isInGame = gameAccount.players.some((p: PublicKey) => p.equals(playerKp.publicKey));
      if (!isInGame) {
        throw new Error("You are not in this game");
      }

      if (gameAccount.creator.equals(playerKp.publicKey)) {
        throw new Error("Game creator cannot unjoin");
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
      if (!creatorTelegramId) {
        throw new Error("Could not find game creator");
      }

      const creatorUsername = await this.getUsernameFromTelegramId(ctx, creatorTelegramId);

      await this.updateGameMessage(
        ctx,
        gamePda.toBase58(),
        Object.keys(gameAccount.gameType)[0].charAt(0).toUpperCase() + Object.keys(gameAccount.gameType)[0].slice(1),
        Number(gameAccount.amount),
        creatorUsername,
        "Active"
      );

      return true;
    } catch (error: any) {
      console.error(`Error unjoining game ${gamePda.toBase58()}:`, error);
      throw error;
    }
  }

  /**
   * Joins a player to a private game with oracle authorization
   */
  public async joinPrivateGame(
    gamePda: PublicKey,
    playerKp: anchor.web3.Keypair,
    chatId: number
  ): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      // Verify oracle authorization
      const authResult = await this.oracleManager.authorizePlayer(gamePda, chatId);

      if (!authResult.authorized) {
        return { success: false, error: authResult.error || "Not authorized to join this private game" };
      }

      const adminKp = authResult.adminKeypair!;

      // Ensure player has balance account
      await this.ensurePlayerBalance(playerKp);

      // Execute transaction with oracle authorization (simplified)
      const tx = await this.program.methods
        .joinGame()
        .accounts({
          game: gamePda,
          player: playerKp.publicKey,
          authority: adminKp.publicKey, // Oracle authority for private games
        })
        .signers([playerKp, adminKp]) // Include both player and oracle authority
        .rpc();

      await this.wallet.confirmTransaction(tx);

      return { success: true, tx };
    } catch (error: any) {
      console.error(`Error joining private game:`, error);
      return { success: false, error: error.message || "Unknown error" };
    }
  }

  private getGameStatusText(status: string, currentPlayers: number, minPlayers: number, maxPlayers: number): string {
    if (status.toLowerCase() !== "active") {
      return formatGameStatus(status);
    }

    if (currentPlayers < minPlayers) {
      const needed = minPlayers - currentPlayers;
      return `${needed} more until minimum`;
    } else if (currentPlayers < maxPlayers) {
      const needed = maxPlayers - currentPlayers;
      return `Ready to start (${needed} more until full)`;
    } else {
      return `Full - starting soon!`;
    }
  }

  private async formatGameMessage(
    ctx: Context,
    gamePda: PublicKey,
    gameType: string,
    amount: number,
    creatorUsername: string,
    status: string,
    winnerAddress?: string,
    txHash?: string,
    forceFresh: boolean = false
  ): Promise<GameMessageFormat> {
    const metadata = await this.wallet.getTokenMetadata(this.tokenMint);
    const gameAccount = await this.getCachedGameAccount(gamePda, forceFresh);
    const { currentPlayers, maxPlayers, minPlayers } = await this.getGameBasicInfo(gameAccount);

    const playerInfo = await this.getPlayerInfo(ctx, gameAccount);
    const expirationInfo = status.toLowerCase() === "active" ? await this.calculateExpirationTime(gameAccount) : "";
    const statusText = this.getGameStatusText(status, currentPlayers, minPlayers, maxPlayers);

    let winnerInfo = "";
    if (status.toLowerCase() === "completed") {
      if (winnerAddress) {
        const winnerUsername = await this.getPlayerUsername(ctx, winnerAddress);
        winnerInfo = `\n🏆 Winner: @${winnerUsername}`;
      } else {
        winnerInfo = await this.getWinnerInfo(ctx, gameAccount);
      }
    }

    let messageText = `<b>🪙 ${gameType} Game</b>\n\n` +
      `💰 Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
      `👤 Creator: @${creatorUsername}\n` +
      `👥 Players: ${currentPlayers}/${maxPlayers}${playerInfo}\n`;

    if (status.toLowerCase() !== "completed") {
      messageText += `Status: ${statusText}${expirationInfo}`;
    }

    messageText += winnerInfo;

    if (txHash) {
      messageText += `\n\nTransaction: <code>${txHash}</code>`;
    }

    const keyboard = [];
    if (status.toLowerCase() !== "completed") {
      keyboard.push([
        { text: "🎮 Join", callback_data: `join_${gamePda.toBase58()}` },
        { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` }
      ]);

      if (gameAccount.players.length > 0) {
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
      const gamePda = new PublicKey(gameAddress);
      // Force fresh data when showing winner to ensure we have the correct player list
      const forceFresh = status.toLowerCase() === "completed";
      const { messageText, keyboard } = await this.formatGameMessage(
        ctx,
        gamePda,
        gameType,
        amount,
        creatorUsername,
        status,
        winnerAddress,
        undefined,
        forceFresh
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
        try {
          const newMessage = await ctx.reply(messageText, {
            parse_mode: "HTML",
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
          });
          this.activeGameMessages.set(gameAddress, {
            messageId: newMessage.message_id,
            chatId: ctx.chat?.id || 0
          });
          this.gameDb.saveGameMessage(gameAddress, newMessage.message_id, ctx.chat?.id || 0);
        } catch (retryError) {
          console.error("Error creating new game message:", retryError);
        }
      }
    } catch (error) {
      console.error("Error in updateGameMessage:", error);
    }
  }

  public async getGameInfo(ctx: Context, gamePda: PublicKey): Promise<string> {
    try {
      const gameAccount = await this.getCachedGameAccount(gamePda);
      const metadata = await this.wallet.getTokenMetadata(this.tokenMint);
      const { amount, maxPlayers, minPlayers, currentPlayers, creatorPubkey, status, gameType } = await this.getGameBasicInfo(gameAccount);

      const creatorInfo = await this.getCreatorInfo(ctx, gamePda, creatorPubkey);
      const expirationInfo = status.toLowerCase() === "active" ? await this.calculateExpirationTime(gameAccount) : "";
      const winnerInfo = status.toLowerCase() === "completed" ? await this.getWinnerInfo(ctx, gameAccount) : "";
      const statusText = this.getGameStatusText(status, currentPlayers, minPlayers, maxPlayers);

      return `Type: ${gameType}\n` +
             `Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
             `Creator: ${creatorInfo}\n` +
             `Players: ${currentPlayers}/${maxPlayers}\n` +
             `Status: ${statusText}${expirationInfo}${winnerInfo}`;
    } catch (error: any) {
      return `Error fetching game: ${error.message}`;
    }
  }

  private async formatGameSection(
    ctx: Context,
    games: any[],
    sectionTitle: string,
    gameInfoCache: Map<string, string>
  ): Promise<string> {
    if (games.length === 0) return "";

    let section = `${sectionTitle}\n\n`;
    for (const game of games) {
      let gameInfo = gameInfoCache.get(game.game_address);
      if (!gameInfo) {
        const gamePda = new PublicKey(game.game_address);
        gameInfo = await this.getGameInfo(ctx, gamePda);
        gameInfoCache.set(game.game_address, gameInfo);
      }
      section += `${gameInfo}\n`;
      if (game.completed_at) {
        section += `Completed: ${formatDate(game.completed_at)}\n\n`;
      }
    }
    return section;
  }

  private async batchFetchGameAccounts(gameDataList: any[]): Promise<Map<string, any>> {
    const gameAccounts = new Map();
    const gamePromises = gameDataList.map(async (gameData) => {
      try {
        const gamePda = new PublicKey(gameData.game_address);
        const gameAccount = await this.getCachedGameAccount(gamePda);
        gameAccounts.set(gameData.game_address, gameAccount);
      } catch (error) {
        console.error(`Error fetching game ${gameData.game_address}:`, error);
      }
    });
    await Promise.all(gamePromises);
    return gameAccounts;
  }

  private async processActiveGames(
    ctx: Context,
    activeGamesData: any[],
    gameAccounts: Map<string, any>
  ): Promise<{ games: string[], totalTokens: number }> {
    let totalTokensInGames = 0;
    const activeGames = await Promise.all(activeGamesData.map(async (gameData) => {
      const gameAccount = gameAccounts.get(gameData.game_address);
      if (!gameAccount) return null;

      totalTokensInGames += Number(gameAccount.amount);
      const gamePda = new PublicKey(gameData.game_address);
      return this.getGameInfo(ctx, gamePda);
    }));

    return {
      games: activeGames.filter((game): game is string => game !== null),
      totalTokens: totalTokensInGames
    };
  }

  private async categorizeRecentGames(
    recentGamesData: any[],
    gameAccounts: Map<string, any>,
    telegramIdStr: string,
    playerPublicKey: string
  ): Promise<GameCategory> {
    const recentGames = await Promise.all(recentGamesData.map(async (gameData) => {
      const gameAccount = gameAccounts.get(gameData.game_address);
      if (!gameAccount) return null;

      const category = categorizeGame(gameData, telegramIdStr, playerPublicKey);
      return { ...gameData, gameAccount, category };
    })).then(games => games.filter(Boolean));

    return {
      won: recentGames.filter(game => game?.category === 'won'),
      lost: recentGames.filter(game => game?.category === 'lost'),
      cancelled: recentGames.filter(game => game?.category === 'cancelled'),
      created: recentGames.filter(game => game?.category === 'created')
    };
  }

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
      this.gameDb.getRecentGames(telegramIdStr)
    ]);

    const last5RecentGames = recentGamesData.slice(0, 5);
    const gameAccounts = await this.batchFetchGameAccounts([...activeGamesData, ...last5RecentGames]);

    const { games: activeGames, totalTokens } = await this.processActiveGames(ctx, activeGamesData, gameAccounts);
    const categories = await this.categorizeRecentGames(last5RecentGames, gameAccounts, telegramIdStr, playerPublicKey);

    const activeGamesSection = activeGames.length > 0
      ? "🎮 <b>Active Games</b>\n\n" + activeGames.join("\n\n")
      : "";

    const recentGamesSections = await Promise.all([
      this.formatGameSection(ctx, categories.won, "🏆 <b>Won Games</b>", new Map()),
      this.formatGameSection(ctx, categories.lost, "😢 <b>Lost Games</b>", new Map()),
      this.formatGameSection(ctx, categories.created, "🎮 <b>Created Games</b>", new Map()),
      this.formatGameSection(ctx, categories.cancelled, "❌ <b>Cancelled Games</b>", new Map())
    ]);

    const recentGamesSection = recentGamesSections.filter(section => section !== "").join("\n");

    return {
      activeGames: activeGamesSection,
      recentGames: recentGamesSection,
      totalTokensInGames: totalTokens
    };
  }

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

  public async createGame(
    ctx: Context,
    gameType: "coinflip" | "giveaway",
    amount: number,
    maxPlayers: number,
    minPlayers: number,
    timeout: number
  ): Promise<void> {
    const telegramId = BigInt(ctx.from?.id || 0);
    const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

    try {
      const playerKp = this.wallet.getKeyPair(telegramId);
      const tokenBalance = await this.wallet.getTokenBalance(telegramId, this.tokenMint);
      const playerBalancePda = this.getPlayerBalancePda(playerKp.publicKey);

      let gameBalance = 0;
      try {
        const playerBalance = await this.program.account.playerBalance.fetch(playerBalancePda);
        gameBalance = Number(playerBalance.amount);
      } catch (error) {
        // Player balance account not found
      }

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
      const gamePda = this.getGamePda(randomHash);

      this.gameDb.saveGameParticipant(gamePda.toBase58(), telegramId.toString(), creatorPubkey);
      await this.ensurePlayerBalance(playerKp);

      const tx = await this.program.methods
        .initializeGame(
          { [gameType]: {} },
          new anchor.BN(amount),
          maxPlayers,
          minPlayers,
          timeout,
          true,
          [...randomHash]
        )
        .accounts({
          player: playerKp.publicKey,
          tokenMint: new PublicKey(this.tokenMint),
        })
        .signers([playerKp])
        .rpc();

      try {
        await this.getCachedGameAccount(gamePda);
      } catch (error) {
        throw new Error("Game creation failed");
      }

      this.gameDb.saveGame(
        gamePda.toBase58(),
        telegramId.toString(),
        amount
      );

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

  private async getUsernameFromTelegramId(ctx: Context, telegramId: string): Promise<string> {
    try {
      const numericId = parseInt(telegramId);
      if (isNaN(numericId)) {
        return telegramId.slice(0, 8) + "...";
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
      return publicKey.slice(0, 8) + "...";
    }
    return this.getUsernameFromTelegramId(ctx, playerTelegramId);
  }
}
