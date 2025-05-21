import { PublicKey } from "@solana/web3.js";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { WalletManager } from "./wallet";
import { GameDatabase } from "./database";
import { OracleManager } from "./oracle";
import type { GameMessage, GameCancellationResult, GameAccounts, GameMessageFormat } from "../types/game";
import type { Coinflip } from "../../idl/idlType";

export class GameManager {
  private static instance: GameManager;
  private activeGameMessages: Map<string, GameMessage>;
  private gameAccountCache: Map<string, { account: any; timestamp: number }>;
  private readonly CACHE_DURATION = 30 * 1000; // 30 seconds
  private pdaCache: Map<string, PublicKey>;

  // Common PDA seeds
  private readonly PDA_SEEDS = {
    ORACLE: Buffer.from("oracle"),
    GAME_TOKEN: Buffer.from("game_token"),
    GAME_VAULT: Buffer.from("game_vault"),
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

  // Helper function to get cached PDA
  private getPda(seeds: Buffer[], programId: PublicKey): PublicKey {
    const key = seeds.map(s => s.toString('hex')).join('_') + programId.toBase58();
    if (!this.pdaCache.has(key)) {
      const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
      this.pdaCache.set(key, pda);
    }
    return this.pdaCache.get(key)!;
  }

  // Helper function to get common PDAs
  private getCommonPdas(): { oraclePda: PublicKey; gameTokenPda: PublicKey; gameVaultPda: PublicKey } {
    const tokenMintBuffer = new PublicKey(this.tokenMint).toBuffer();
    return {
      oraclePda: this.getPda([this.PDA_SEEDS.ORACLE], this.program.programId),
      gameTokenPda: this.getPda([this.PDA_SEEDS.GAME_TOKEN, tokenMintBuffer], this.program.programId),
      gameVaultPda: this.getPda([this.PDA_SEEDS.GAME_VAULT, tokenMintBuffer], this.program.programId)
    };
  }

  // Helper function to get player balance PDA
  private getPlayerBalancePda(playerPubkey: PublicKey): PublicKey {
    return this.getPda(
      [this.PDA_SEEDS.PLAYER_BALANCE, playerPubkey.toBuffer(), new PublicKey(this.tokenMint).toBuffer()],
      this.program.programId
    );
  }

  // Helper function to get game PDA
  private getGamePda(randomHash: Buffer): PublicKey {
    return this.getPda([this.PDA_SEEDS.GAME, randomHash], this.program.programId);
  }

  // Helper function to calculate expiration time
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

  // Helper function to get all required PDAs and accounts for a game
  public async getGameAccounts(playerKp: anchor.web3.Keypair): Promise<GameAccounts> {
    const { oraclePda, gameTokenPda, gameVaultPda } = this.getCommonPdas();
    const playerBalancePda = await this.ensurePlayerBalance(playerKp);
    const playerTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(this.tokenMint),
      playerKp.publicKey
    );
    const gameTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(this.tokenMint),
      gameVaultPda,
      true
    );

    return {
      oraclePda,
      gameTokenPda,
      gameVaultPda,
      playerBalancePda,
      playerTokenAccount,
      gameTokenAccount
    };
  }

  // Helper function to ensure player balance PDA exists
  public async ensurePlayerBalance(playerKeypair: anchor.web3.Keypair): Promise<PublicKey> {
    const playerBalancePda = this.getPlayerBalancePda(playerKeypair.publicKey);

    try {
      await this.program.account.playerBalance.fetch(playerBalancePda);
      console.log("Player balance already exists");
    } catch (error) {
      console.log("Creating player balance account");

      // First ensure the player's token account exists
      const playerTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(this.tokenMint),
        playerKeypair.publicKey
      );

      try {
        await this.wallet.connection.getTokenAccountBalance(playerTokenAccount);
        console.log("Player token account already exists");
      } catch (error) {
        console.log("Creating player token account");
        const createAtaIx = createAssociatedTokenAccountInstruction(
          playerKeypair.publicKey,
          playerTokenAccount,
          playerKeypair.publicKey,
          new PublicKey(this.tokenMint)
        );

        const tx = await this.wallet.signAndSend([createAtaIx], [playerKeypair]);
        // Wait for confirmation
        await this.wallet.connection.confirmTransaction({
          signature: tx,
          blockhash: (await this.wallet.connection.getLatestBlockhash()).blockhash,
          lastValidBlockHeight: (await this.wallet.connection.getLatestBlockhash()).lastValidBlockHeight
        });
        console.log("Player token account created");
      }

      const { gameTokenPda } = this.getCommonPdas();

      // Call the contract to initialize player balance
      const tx = await this.program.methods
        .initializePlayerBalance()
        .accounts({
          gameToken: gameTokenPda,
          player: playerKeypair.publicKey,
        })
        .signers([playerKeypair])
        .rpc();

      // Wait for confirmation
      await this.wallet.connection.confirmTransaction({
        signature: tx,
        blockhash: (await this.wallet.connection.getLatestBlockhash()).blockhash,
        lastValidBlockHeight: (await this.wallet.connection.getLatestBlockhash()).lastValidBlockHeight
      });
      console.log("Player balance created");
    }

    return playerBalancePda;
  }

  // Helper function to get cached game account
  private async getCachedGameAccount(gamePda: PublicKey): Promise<any> {
    const cached = this.gameAccountCache.get(gamePda.toBase58());
    const now = Date.now();

    if (cached && now - cached.timestamp < this.CACHE_DURATION) {
      return cached.account;
    }

    const account = await this.program.account.game.fetch(gamePda);
    this.gameAccountCache.set(gamePda.toBase58(), { account, timestamp: now });
    return account;
  }

  // Helper function to get game status info
  private async getGameStatusInfo(gameAccount: any): Promise<{ status: string; isExpired: boolean; hasEnoughPlayers: boolean }> {
    const status = Object.keys(gameAccount.status)[0].toLowerCase();
    const createdAt = Number(gameAccount.createdAt);
    const timeout = Number(gameAccount.timeout);
    const expiresAt = createdAt + timeout;
    const blockTime = await this.wallet.getBlockchainTime();
    const isExpired = blockTime > expiresAt;
    const hasEnoughPlayers = gameAccount.players.length >= gameAccount.minPlayers;

    return { status, isExpired, hasEnoughPlayers };
  }

  // Helper function to get game basic info
  private async getGameBasicInfo(gameAccount: any): Promise<{
    amount: number;
    maxPlayers: number;
    currentPlayers: number;
    creatorPubkey: string;
    status: string;
    gameType: string;
  }> {
    const amount = Number(gameAccount.amount);
    const maxPlayers = gameAccount.maxPlayers;
    const currentPlayers = gameAccount.players.length;
    const creatorPubkey = gameAccount.creator.toString();
    const status = Object.keys(gameAccount.status)[0];
    const gameType = this.formatGameType(gameAccount.gameType);

    return {
      amount,
      maxPlayers,
      currentPlayers,
      creatorPubkey,
      status,
      gameType
    };
  }

  // Helper function to get player info
  private async getPlayerInfo(ctx: Context, gameAccount: any): Promise<string> {
    let playerInfo = "";
    if (gameAccount.players.length > 0) {
      playerInfo = "\n👥 Players:\n";
      for (const playerBalancePda of gameAccount.players) {
        const username = await this.getPlayerUsername(ctx, playerBalancePda.toBase58());
        playerInfo += `• @${username}\n`;
      }
    }
    return playerInfo;
  }

  // Helper function to get winner info
  private async getWinnerInfo(ctx: Context, gameAccount: any): Promise<string> {
    if (gameAccount.winner && gameAccount.winner.toString() !== "11111111111111111111111111111111") {
      const winnerUsername = await this.getPlayerUsername(ctx, gameAccount.winner.toString());
      return `\n🏆 Winner: @${winnerUsername}`;
    }
    return "";
  }

  // Helper function to get creator info
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

  // Helper function to format game type
  private formatGameType(gameType: string): string {
    return Object.keys(gameType)[0].charAt(0).toUpperCase() + Object.keys(gameType)[0].slice(1);
  }

  // Helper function to format game status
  private formatGameStatus(status: string): string {
    return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  }

  // Helper function to format date
  private formatDate(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  // Helper function to handle game completion
  public async handleGameCompletion(
    ctx: Context,
    gamePda: PublicKey,
  ): Promise<boolean> {
    try {
      const result = await this.oracleManager.completeGame(gamePda);

      if (!result.success) {
        throw new Error(result.error || "Failed to complete game");
      }

      // Get the block time for the completion transaction
      const blockTime = await this.wallet.getBlockchainTime();
      const completedAt = blockTime * 1000;

      // Store the completion time in the database
      await this.gameDb.completeGame(gamePda.toBase58(), result.winnerAddress!, completedAt);

      // Update game message with winner info
      await this.updateGameMessageWithWinner(ctx, gamePda, result.winnerAddress!);

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

  // Helper function to handle expired games
  public async handleExpiredGame(ctx: Context, gamePda: PublicKey, gameAccount: any): Promise<GameCancellationResult | false> {
    try {
      const { status, isExpired, hasEnoughPlayers } = await this.getGameStatusInfo(gameAccount);
      if (!isExpired) return false;

      // Log detailed game state
      console.log(`\n=== Expired Game State for ${gamePda.toBase58()} ===`);
      console.log(`Status: ${status}`);
      console.log(`Players: ${gameAccount.players.length}/${gameAccount.maxPlayers}`);
      console.log(`Min Players: ${gameAccount.minPlayers}`);
      console.log(`Created At: ${this.formatDate(Number(gameAccount.createdAt))}`);
      console.log(`Timeout: ${gameAccount.timeout} seconds`);
      console.log(`Creator: ${gameAccount.creator.toBase58()}`);
      console.log(`Winner: ${gameAccount.winner?.toBase58() || 'Not set'}`);
      console.log(`Game Type: ${this.formatGameType(gameAccount.gameType)}`);
      console.log(`Amount: ${gameAccount.amount}`);
      console.log(`Is Expired: ${isExpired}`);
      console.log(`Has Enough Players: ${hasEnoughPlayers}`);
      console.log('================================\n');

      const adminKp = await this.wallet.getAdminKeypair();
      const creatorTelegramId = await this.gameDb.getCreatorTelegramId(gamePda.toBase58());
      if (!creatorTelegramId) return false;

      if (hasEnoughPlayers) {
        const completed = await this.handleGameCompletion(ctx, gamePda);
        return completed ? false : false;
      }

      const creatorKp = await this.wallet.getKeyPair(BigInt(creatorTelegramId));
      const accounts = await this.getGameAccounts(creatorKp);

      try {
        const tx = await this.program.methods
          .cancelGame()
          .accounts({
            game: gamePda,
            oracle: accounts.oraclePda,
            gameToken: accounts.gameTokenPda,
            gameTokenAccount: accounts.gameTokenAccount,
            gameVault: accounts.gameVaultPda,
            player: gameAccount.creator,
            playerBalance: accounts.playerBalancePda,
            playerTokenAccount: accounts.playerTokenAccount,
          })
          .signers([adminKp, creatorKp])
          .rpc();

        const blockTime = await this.wallet.getBlockchainTime();
        const completedAt = blockTime * 1000;

        await this.gameDb.completeGame(gamePda.toBase58(), "cancelled", completedAt);

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

  // Helper function to automatically complete a game when it's full
  public async autoCompleteGame(ctx: Context, gamePda: PublicKey): Promise<boolean> {
    try {
      const gameInfo = this.activeGameMessages.get(gamePda.toBase58());
      if (!gameInfo) {
        console.log(`No message found for game ${gamePda.toBase58()}`);
        return false;
      }

      return await this.handleGameCompletion(ctx, gamePda);
    } catch (error) {
      console.error('Error auto-completing game:', error);
      return false;
    }
  }

  // Helper function to update game message with winner info
  private async updateGameMessageWithWinner(
    ctx: Context,
    gamePda: PublicKey,
    winnerPubkeyStr: string
  ): Promise<void> {
    const gameMessage = this.activeGameMessages.get(gamePda.toBase58());
    if (!gameMessage) return;

    const gameAccount = await this.getCachedGameAccount(gamePda);
    const creatorTelegramId = await this.gameDb.getCreatorTelegramId(gamePda.toBase58());
    if (!creatorTelegramId) return;

    const creatorUsername = await this.getUsernameFromTelegramId(ctx, creatorTelegramId);

    await this.updateGameMessage(
      ctx,
      gamePda.toBase58(),
      Object.keys(gameAccount.gameType)[0].charAt(0).toUpperCase() + Object.keys(gameAccount.gameType)[0].slice(1),
      Number(gameAccount.amount),
      creatorUsername,
      "Completed",
      winnerPubkeyStr
    );
  }

  // Helper function to unjoin a game
  public async unjoinGame(ctx: Context, gamePda: PublicKey, playerKp: anchor.web3.Keypair): Promise<boolean> {
    try {
      const gameAccount = await this.getCachedGameAccount(gamePda);
      const status = Object.keys(gameAccount.status)[0].toLowerCase();

      // Check if game is active
      if (status !== 'active') {
        throw new Error("Game is not active");
      }

      // Get player's balance PDA
      const playerBalancePda = this.getPlayerBalancePda(playerKp.publicKey);

      // Check if player is in the game
      const isInGame = gameAccount.players.some((p: PublicKey) => p.equals(playerBalancePda));
      if (!isInGame) {
        throw new Error("You are not in this game");
      }

      // Check if player is the creator
      if (gameAccount.creator.equals(playerKp.publicKey)) {
        throw new Error("Game creator cannot unjoin");
      }

      // Get all required PDAs and accounts
      const accounts = await this.getGameAccounts(playerKp);

      // Call the contract to unjoin the game
      const tx = await this.program.methods
        .unjoinGame()
        .accounts({
          game: gamePda,
          player: playerKp.publicKey,
          playerBalance: playerBalancePda,
          oracle: accounts.oraclePda,
          gameToken: accounts.gameTokenPda,
          gameVault: accounts.gameVaultPda,
          playerTokenAccount: accounts.playerTokenAccount,
          gameTokenAccount: accounts.gameTokenAccount,
        })
        .signers([playerKp])
        .rpc();

      // Wait for transaction confirmation
      await this.wallet.connection.confirmTransaction({
        signature: tx,
        blockhash: (await this.wallet.connection.getLatestBlockhash()).blockhash,
        lastValidBlockHeight: (await this.wallet.connection.getLatestBlockhash()).lastValidBlockHeight
      });

      // Update game message
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

  // Helper function to format game message
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
    const gameAccount = await this.getCachedGameAccount(gamePda);
    const { currentPlayers, maxPlayers } = await this.getGameBasicInfo(gameAccount);

    const playerInfo = await this.getPlayerInfo(ctx, gameAccount);
    const expirationInfo = status.toLowerCase() === "active" ? await this.calculateExpirationTime(gameAccount) : "";

    // Only show winner info if game is completed
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
      `👥 Players: ${currentPlayers}/${maxPlayers}${playerInfo}\n` +
      `Status: ${this.formatGameStatus(status)}${expirationInfo}${winnerInfo}`;

    if (txHash) {
      messageText += `\n\nTransaction: <code>${txHash}</code>`;
    }

    const keyboard = [];
    if (status.toLowerCase() !== "completed") {
      keyboard.push([
        { text: "🎮 Join Game", callback_data: `join_${gamePda.toBase58()}` },
        { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` }
      ]);

      if (gameAccount.players.length > 0) {
        keyboard[0].push({ text: "❌ Unjoin", callback_data: `unjoin_${gamePda.toBase58()}` });
      }
    }

    return { messageText, keyboard };
  }

  // Helper function to create game message with inline keyboard
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

    // Store both message ID and chat ID
    await this.gameDb.saveGameMessage(gameAddress, message.message_id, message.chat.id);
    this.activeGameMessages.set(gameAddress, {
      messageId: message.message_id,
      chatId: message.chat.id
    });

    return message.message_id;
  }

  // Helper function to update game message
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
      const { messageText, keyboard } = await this.formatGameMessage(
        ctx,
        gamePda,
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
        // Check if the error is due to message not being modified
        if (error.description?.includes("message is not modified")) {
          // This is not a real error, just ignore it
          return;
        }

        console.error("Error updating game message:", error);
        // If the message update fails for other reasons, try to create a new message
        try {
          const newMessage = await ctx.reply(messageText, {
            parse_mode: "HTML",
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
          });
          // Update the stored message info
          this.activeGameMessages.set(gameAddress, {
            messageId: newMessage.message_id,
            chatId: ctx.chat?.id || 0
          });
          // Save to database
          this.gameDb.saveGameMessage(gameAddress, newMessage.message_id, ctx.chat?.id || 0);
        } catch (retryError) {
          console.error("Error creating new game message:", retryError);
        }
      }
    } catch (error) {
      console.error("Error in updateGameMessage:", error);
    }
  }

  // Helper function to get game info for display
  public async getGameInfo(ctx: Context, gamePda: PublicKey): Promise<string> {
    try {
      const gameAccount = await this.getCachedGameAccount(gamePda);
      const metadata = await this.wallet.getTokenMetadata(this.tokenMint);
      const { amount, maxPlayers, currentPlayers, creatorPubkey, status, gameType } = await this.getGameBasicInfo(gameAccount);

      const creatorInfo = await this.getCreatorInfo(ctx, gamePda, creatorPubkey);
      const expirationInfo = status.toLowerCase() === "active" ? await this.calculateExpirationTime(gameAccount) : "";
      const winnerInfo = status.toLowerCase() === "completed" ? await this.getWinnerInfo(ctx, gameAccount) : "";

      return `Game: <code>${gamePda.toBase58().slice(0, 8)}...</code>\n` +
             `Type: ${gameType}\n` +
             `Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
             `Creator: ${creatorInfo}\n` +
             `Players: ${currentPlayers}/${maxPlayers}${expirationInfo}${winnerInfo}`;
    } catch (error: any) {
      return `Error fetching game: ${error.message}`;
    }
  }

  // Helper function to format game section
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
        section += `Completed: ${this.formatDate(game.completed_at)}\n\n`;
      }
    }
    return section;
  }

  // Helper function to get user's games
  public async getUserGames(ctx: Context, telegramId: bigint): Promise<{
    activeGames: string;
    recentGames: string;
    totalTokensInGames: number;
  }> {
    const playerKp = await this.wallet.getKeyPair(telegramId);
    const playerBalancePda = this.getPlayerBalancePda(playerKp.publicKey);
    let totalTokensInGames = 0;

    // Get all games in a single query
    const allGames = await this.gameDb.getAllGames();

    // Batch fetch all game accounts in parallel
    const gameAccounts = new Map();
    const gamePromises = allGames.map(async (gameData) => {
      try {
        const gamePda = new PublicKey(gameData.game_address);
        const gameAccount = await this.getCachedGameAccount(gamePda);
        gameAccounts.set(gameData.game_address, gameAccount);
      } catch (error) {
        console.error(`Error fetching game ${gameData.game_address}:`, error);
      }
    });
    await Promise.all(gamePromises);

    // Get all unique Telegram IDs for username fetching
    const uniqueTelegramIds = new Set<string>();
    allGames.forEach(game => {
      uniqueTelegramIds.add(game.creator_telegram_id);
    });
    uniqueTelegramIds.add(telegramId.toString());

    // Get winner Telegram IDs from database in batch
    const winnerTelegramIds = new Map<string, string>();
    const winnerPromises = allGames
      .filter(game => game.winner_address && game.winner_address !== "cancelled" && game.winner_address !== "unknown")
      .map(async (game) => {
        const winnerTelegramId = await this.gameDb.getPlayerTelegramId(game.winner_address!);
        if (winnerTelegramId) {
          winnerTelegramIds.set(game.winner_address!, winnerTelegramId);
          uniqueTelegramIds.add(winnerTelegramId);
        }
      });
    await Promise.all(winnerPromises);

    // Batch fetch all usernames in parallel
    const usernameMap = new Map<string, string>();
    const usernamePromises = Array.from(uniqueTelegramIds).map(async (id) => {
      try {
        const username = await this.getUsernameFromTelegramId(ctx, id);
        usernameMap.set(id, username);
      } catch (error) {
        console.error(`Error getting username for ${id}:`, error);
        usernameMap.set(id, "Unknown");
      }
    });
    await Promise.all(usernamePromises);

    // Process active games
    const activeGames = await Promise.all(allGames
      .filter(gameData => {
        const gameAccount = gameAccounts.get(gameData.game_address);
        if (!gameAccount) return false;

        const gameStatus = Object.keys(gameAccount.status)[0].toLowerCase();
        if (gameStatus !== "active") return false;

        const isCreator = gameData.creator_telegram_id === telegramId.toString();
        const isPlayer = gameAccount.players.some((p: PublicKey) => p.equals(playerBalancePda));

        if (isCreator || isPlayer) {
          totalTokensInGames += Number(gameAccount.amount);
          return true;
        }
        return false;
      })
      .map(gameData => {
        const gamePda = new PublicKey(gameData.game_address);
        return this.getGameInfo(ctx, gamePda);
      }));

    // Process completed games
    const completedGames = allGames
      .filter(gameData => {
        const gameAccount = gameAccounts.get(gameData.game_address);
        if (!gameAccount) return false;

        const status = Object.keys(gameAccount.status)[0].toLowerCase();
        if (status === 'active') return false;

        return gameAccount.players.some((p: PublicKey) => p.equals(playerBalancePda));
      })
      .map(gameData => {
        const gameAccount = gameAccounts.get(gameData.game_address)!;
        const winnerTelegramId = winnerTelegramIds.get(gameData.winner_address || "");
        const winnerUsername = winnerTelegramId ? usernameMap.get(winnerTelegramId) || "Unknown" : "Unknown";
        const currentUsername = usernameMap.get(telegramId.toString()) || "Unknown";
        const isWinner = winnerUsername === currentUsername;

        return {
          ...gameData,
          gameAccount,
          category: gameData.winner_address === "cancelled" ? "cancelled" : isWinner ? "won" : "lost"
        };
      })
      .sort((a, b) => {
        const timeA = a.completed_at || a.created_at;
        const timeB = b.completed_at || b.created_at;
        return timeB - timeA;
      })
      .slice(0, 5); // Limit to 5 most recent games

    // Group completed games by category
    const categories = {
      won: completedGames.filter(game => game.category === 'won'),
      lost: completedGames.filter(game => game.category === 'lost'),
      cancelled: completedGames.filter(game => game.category === 'cancelled')
    };

    // Format sections
    const activeGamesSection = activeGames.length > 0
      ? "🎮 <b>Active Games</b>\n\n" + activeGames.join("\n\n")
      : "";

    const recentGamesSections = await Promise.all([
      this.formatGameSection(ctx, categories.won, "🏆 <b>Won Games</b>", new Map()),
      this.formatGameSection(ctx, categories.lost, "😢 <b>Lost Games</b>", new Map()),
      this.formatGameSection(ctx, categories.cancelled, "❌ <b>Cancelled Games</b>", new Map())
    ]);

    const recentGamesSection = recentGamesSections.filter(section => section !== "").join("\n");

    return {
      activeGames: activeGamesSection,
      recentGames: recentGamesSection,
      totalTokensInGames
    };
  }

  // Helper function to reload game messages from database
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

  // Helper function to create a game
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
      // Get player keypair and create PDAs
      const playerKp = await this.wallet.getKeyPair(telegramId);

      // Check wallet balance
      const tokenBalance = await this.wallet.getTokenBalance(telegramId, this.tokenMint);

      // Get player's game balance
      const playerBalancePda = this.getPlayerBalancePda(playerKp.publicKey);

      let gameBalance = 0;
      try {
        const playerBalance = await this.program.account.playerBalance.fetch(playerBalancePda);
        gameBalance = Number(playerBalance.amount);
      } catch (error) {
        console.log("Player balance account not found or error fetching it");
      }

      const totalBalance = tokenBalance + gameBalance;
      if (totalBalance < amount) {
        await ctx.reply(
          `Insufficient balance. You have ${this.wallet.formatTokenBalance(tokenBalance, metadata.decimals)} ${this.ticker} in wallet and ${this.wallet.formatTokenBalance(gameBalance, metadata.decimals)} ${this.ticker} in game balance (total: ${this.wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${this.ticker}) but the game requires ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}`,
          {
            reply_to_message_id: ctx.message?.message_id
          }
        );
        return;
      }

      // Save player mapping for creator - using both the wallet address and balance PDA
      const creatorPubkey = playerKp.publicKey.toBase58();
      console.log(`Saving creator mapping - Wallet Address: ${creatorPubkey}, Telegram ID: ${telegramId.toString()}`);
      this.gameDb.savePlayerMapping(creatorPubkey, telegramId.toString());

      // Generate game secrets using oracle manager
      const { randomHash } = this.oracleManager.generateGameSecrets();

      // Get all required PDAs and accounts
      const gamePda = this.getGamePda(randomHash);

      // Ensure player balance PDA exists
      await this.ensurePlayerBalance(playerKp);
      console.log(`Player balance PDA: ${playerBalancePda.toBase58()}`);
      // Save creator's balance PDA mapping
      console.log(`Saving creator balance PDA mapping - PDA: ${playerBalancePda.toBase58()}, Telegram ID: ${telegramId.toString()}`);
      this.gameDb.savePlayerMapping(playerBalancePda.toBase58(), telegramId.toString());

      // Get all required PDAs and accounts
      const accounts = await this.getGameAccounts(playerKp);

      // Create game on-chain
      const tx = await this.program.methods
        .initializeGame(
          { [gameType]: {} },
          new anchor.BN(amount),
          maxPlayers,
          minPlayers,
          timeout,
          false,
          [...randomHash]
        )
        .accounts({
          player: playerKp.publicKey,
          playerBalance: playerBalancePda,
          oracle: accounts.oraclePda,
          gameToken: accounts.gameTokenPda,
          playerTokenAccount: accounts.playerTokenAccount,
          gameTokenAccount: accounts.gameTokenAccount,
        })
        .signers([playerKp])
        .rpc();

      // Verify game creation
      try {
        await this.getCachedGameAccount(gamePda);
      } catch (error) {
        throw new Error("Game creation failed");
      }

      // Save to database
      this.gameDb.saveGame(
        gamePda.toBase58(),
        telegramId.toString(),
        amount
      );

      // Create game message
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
      await ctx.reply(`Error creating game: ${error.message || "Unknown error"}`, {
        reply_to_message_id: ctx.message?.message_id
      });
    }
  }

  // Helper function to get a user's username from their Telegram ID
  private async getUsernameFromTelegramId(ctx: Context, telegramId: string): Promise<string> {
    try {
      const chatMember = await ctx.api.getChatMember(ctx.chat!.id, parseInt(telegramId));
      return chatMember.user.username || chatMember.user.first_name;
    } catch (error) {
      console.error(`Error getting username for Telegram ID ${telegramId}:`, error);
      return "Unknown";
    }
  }

  // Helper function to get a game's creator username
  public async getGameCreatorUsername(ctx: Context, gameAddress: string): Promise<string> {
    const creatorTelegramId = await this.gameDb.getCreatorTelegramId(gameAddress);
    if (!creatorTelegramId) {
      console.error(`No creator telegram ID found for game ${gameAddress}`);
      return "Unknown";
    }
    return this.getUsernameFromTelegramId(ctx, creatorTelegramId);
  }

  // Helper function to get a player's username from their public key
  public async getPlayerUsername(ctx: Context, publicKey: string): Promise<string> {
    const playerTelegramId = await this.gameDb.getPlayerTelegramId(publicKey);
    if (!playerTelegramId) {
      return publicKey.slice(0, 8) + "...";
    }
    return this.getUsernameFromTelegramId(ctx, playerTelegramId);
  }
}
