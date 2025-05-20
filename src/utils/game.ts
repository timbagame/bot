import { PublicKey } from "@solana/web3.js";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { WalletManager } from "./wallet";
import { GameDatabase } from "./database";
import type { GameStatus, GameMessage, GameCancellationResult, GameInfo, GameAccounts, GameMessageFormat } from "../types/game";
import type { Coinflip } from "../../idl/idlType";
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';

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
      GameManager.instance = new GameManager(program, wallet, gameDb, tokenMint, ticker);
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
        await this.wallet.connection.confirmTransaction(tx);
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
      await this.wallet.connection.confirmTransaction(tx);
      console.log("Player balance created");
    }

    return playerBalancePda;
  }

  // Helper function to get cached game account
  private async getCachedGameAccount(gamePda: PublicKey): Promise<any> {
    const cached = this.gameAccountCache.get(gamePda.toBase58());
    const blockTime = await this.wallet.getBlockchainTime();
    const now = blockTime * 1000;

    if (cached && now - cached.timestamp < this.CACHE_DURATION) {
      return cached.account;
    }

    const account = await this.program.account.game.fetch(gamePda);
    this.gameAccountCache.set(gamePda.toBase58(), { account, timestamp: now });
    return account;
  }

  // Helper function to check game status
  public async checkGameStatus(gamePda: PublicKey): Promise<GameInfo> {
    const gameAccount = await this.program.account.game.fetch(gamePda);
    const status = Object.keys(gameAccount.status)[0].toLowerCase();

    const createdAt = Number(gameAccount.createdAt);
    const timeout = Number(gameAccount.timeout);
    const expiresAt = createdAt + timeout;
    const blockTime = await this.wallet.getBlockchainTime();
    const isExpired = blockTime > expiresAt;
    const hasEnoughPlayers = gameAccount.players.length >= gameAccount.minPlayers;

    return { status, isExpired, hasEnoughPlayers };
  }

  // Helper function to handle game completion
  public async handleGameCompletion(
    ctx: Context,
    gamePda: PublicKey,
    gameAccount: any,
    secretKey: Buffer,
    adminKp: anchor.web3.Keypair
  ): Promise<boolean> {
    try {
      const { oraclePda, gameTokenPda } = await this.getGameAccounts(adminKp);

      // Log detailed game state
      console.log(`\n=== Game State for ${gamePda.toBase58()} ===`);
      console.log(`Status: ${Object.keys(gameAccount.status)[0]}`);
      console.log(`Players: ${gameAccount.players.length}/${gameAccount.maxPlayers}`);
      console.log(`Min Players: ${gameAccount.minPlayers}`);
      console.log(`Created At: ${new Date(Number(gameAccount.createdAt) * 1000).toISOString()}`);
      console.log(`Timeout: ${gameAccount.timeout} seconds`);
      console.log(`Creator: ${gameAccount.creator.toBase58()}`);
      console.log(`Winner: ${gameAccount.winner?.toBase58() || 'Not set'}`);
      console.log(`Game Type: ${Object.keys(gameAccount.gameType)[0]}`);
      console.log(`Amount: ${gameAccount.amount}`);
      console.log('================================\n');

      // Calculate the winner using the same algorithm as the contract
      let winnerIndex = 0;
      const nPlayers = gameAccount.players.length;

      if (nPlayers > 1) {
        const randomBytes = secretKey.subarray(0, 8);
        const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
        const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
        const finalNumber = randomNumber % maxValid;
        winnerIndex = Number(finalNumber % BigInt(nPlayers));
      }

      const winnerBalancePda = gameAccount.players[winnerIndex];
      console.log(`Calculated winner: ${winnerBalancePda.toBase58()} (index ${winnerIndex})`);

      const gameMessage = this.activeGameMessages.get(gamePda.toBase58());
      if (!gameMessage) {
        console.error(`No game message found for game ${gamePda.toBase58()}`);
        return false;
      }

      // Add retry logic for transaction
      let retries = 3;
      let tx: string | null = null;

      while (retries > 0 && !tx) {
        try {
          tx = await this.program.methods
            .completeGame([...secretKey])
            .accounts({
              game: gamePda,
              oracle: oraclePda,
              authority: adminKp.publicKey,
              playerBalance: winnerBalancePda,
              gameToken: gameTokenPda,
            })
            .signers([adminKp])
            .rpc();
        } catch (error: any) {
          retries--;
          if (retries === 0) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      if (!tx) {
        throw new Error("Failed to complete game after retries");
      }

      // Wait for transaction confirmation with timeout
      const confirmationPromise = this.wallet.connection.confirmTransaction(tx);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Transaction confirmation timeout")), 30000)
      );

      await Promise.race([confirmationPromise, timeoutPromise]);

      const completedGameAccount = await this.getCachedGameAccount(gamePda);
      const winnerPubkeyStr = completedGameAccount.winner.toString();

      // Get the block time for the completion transaction
      const blockTime = await this.wallet.getBlockchainTime();
      const completedAt = blockTime * 1000;

      // Store the completion time in the database
      await this.gameDb.completeGame(gamePda.toBase58(), winnerPubkeyStr, completedAt);

      // Update game message with winner info
      await this.updateGameMessageWithWinner(ctx, gamePda, winnerPubkeyStr);

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
      const { isExpired, hasEnoughPlayers } = await this.checkGameStatus(gamePda);
      if (!isExpired) return false;

      // Log detailed game state
      console.log(`\n=== Expired Game State for ${gamePda.toBase58()} ===`);
      console.log(`Status: ${Object.keys(gameAccount.status)[0]}`);
      console.log(`Players: ${gameAccount.players.length}/${gameAccount.maxPlayers}`);
      console.log(`Min Players: ${gameAccount.minPlayers}`);
      console.log(`Created At: ${new Date(Number(gameAccount.createdAt) * 1000).toISOString()}`);
      console.log(`Timeout: ${gameAccount.timeout} seconds`);
      console.log(`Creator: ${gameAccount.creator.toBase58()}`);
      console.log(`Winner: ${gameAccount.winner?.toBase58() || 'Not set'}`);
      console.log(`Game Type: ${Object.keys(gameAccount.gameType)[0]}`);
      console.log(`Amount: ${gameAccount.amount}`);
      console.log(`Is Expired: ${isExpired}`);
      console.log(`Has Enough Players: ${hasEnoughPlayers}`);
      console.log('================================\n');

      const adminKp = await this.wallet.getAdminKeypair();
      const creatorTelegramId = await this.gameDb.getCreatorTelegramId(gamePda.toBase58());
      if (!creatorTelegramId) return false;

      // If game has enough players, complete it
      if (hasEnoughPlayers) {
        const gameData = await this.gameDb.getGame(gamePda.toBase58());
        if (!gameData) return false;

        const secretKey = Buffer.from(gameData.secret_key, "hex");
        const completed = await this.handleGameCompletion(ctx, gamePda, gameAccount, secretKey, adminKp);
        return completed ? false : false; // Return false since we don't want to track completed games in the cancellation list
      }

      // Otherwise, cancel the game and return funds
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

        // Get the block time for the cancellation transaction
        const blockTime = await this.wallet.getBlockchainTime();
        const completedAt = blockTime * 1000;

        await this.gameDb.completeGame(gamePda.toBase58(), "cancelled", completedAt);

        // Return the cancellation info
        return {
          cancelled: true,
          amount: Number(gameAccount.amount),
          creator: gameAccount.creator.toString(),
          tx
        };
      } catch (error: any) {
        if (error.message.includes("GameReadyForOracle")) {
          const gameData = await this.gameDb.getGame(gamePda.toBase58());
          if (!gameData) return false;

          const secretKey = Buffer.from(gameData.secret_key, "hex");
          const completed = await this.handleGameCompletion(ctx, gamePda, gameAccount, secretKey, adminKp);
          return completed ? false : false; // Return false since we don't want to track completed games in the cancellation list
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

      const adminKp = await this.wallet.getAdminKeypair();
      const gameData = await this.gameDb.getGame(gamePda.toBase58());
      if (!gameData) {
        console.error(`Error completing game: Game data not found for ${gamePda.toBase58()}`);
        return false;
      }
      const secretKey = Buffer.from(gameData.secret_key, "hex");
      const gameAccount = await this.program.account.game.fetch(gamePda);

      return await this.handleGameCompletion(ctx, gamePda, gameAccount, secretKey, adminKp);
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

    let creatorUsername = "Unknown";
    try {
      const chatMember = await ctx.api.getChatMember(ctx.chat!.id, parseInt(creatorTelegramId));
      creatorUsername = chatMember.user.username || chatMember.user.first_name;
    } catch (error) {
      console.error("Error getting creator's username:", error);
    }

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
      await this.wallet.connection.confirmTransaction(tx);

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
    const currentPlayers = gameAccount.players.length;
    const maxPlayers = gameAccount.maxPlayers;

    // Get player usernames
    let playerInfo = "";
    if (gameAccount.players.length > 0) {
      playerInfo = "\n👥 Players:\n";
      for (const playerBalancePda of gameAccount.players) {
        const username = await this.getPlayerUsername(ctx, playerBalancePda.toBase58());
        playerInfo += `• @${username}\n`;
      }
    }

    // Calculate expiration time using blockchain time
    let expirationInfo = "";
    if (status.toLowerCase() === "active") {
      expirationInfo = await this.calculateExpirationTime(gameAccount);
    }

    let messageText = `<b>🪙 ${gameType} Game</b>\n\n` +
      `💰 Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
      `👤 Creator: @${creatorUsername}\n` +
      `👥 Players: ${currentPlayers}/${maxPlayers}${playerInfo}\n` +
      `Status: ${status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}${expirationInfo}\n`;

    if (winnerAddress && winnerAddress !== "11111111111111111111111111111111") {
      const winnerUsername = await this.getPlayerUsername(ctx, winnerAddress);
      messageText += `\n🏆 Winner: @${winnerUsername}`;
    }

    if (txHash) {
      messageText += `\n\nTransaction: <code>${txHash}</code>`;
    }

    // Create keyboard based on game status
    const keyboard = [];
    if (status.toLowerCase() !== "completed") {
      keyboard.push([
        { text: "🎮 Join Game", callback_data: `join_${gamePda.toBase58()}` },
        { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` }
      ]);

      // Add unjoin button if there are players in the game
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
  public async getGameInfo(gamePda: PublicKey): Promise<string> {
    try {
      const gameAccount = await this.getCachedGameAccount(gamePda);
      const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

      // Format game details
      const amount = Number(gameAccount.amount);
      const maxPlayers = gameAccount.maxPlayers;
      const currentPlayers = gameAccount.players.length;
      const creatorPubkey = gameAccount.creator.toString();
      const status = Object.keys(gameAccount.status)[0] as GameStatus;
      const gameType = Object.keys(gameAccount.gameType)[0].charAt(0).toUpperCase() + Object.keys(gameAccount.gameType)[0].slice(1);

      // Calculate expiration time using blockchain time
      let expirationInfo = "";
      if (status.toLowerCase() === "active") {
        expirationInfo = await this.calculateExpirationTime(gameAccount);
      }

      return `Game: <code>${gamePda.toBase58().slice(0, 8)}...</code>\n` +
             `Type: ${gameType}\n` +
             `Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
             `Players: ${currentPlayers}/${maxPlayers}\n` +
             `Status: ${status.charAt(0).toUpperCase() + status.slice(1).toLowerCase()}${expirationInfo}\n` +
             `Creator: <code>${creatorPubkey.slice(0, 8)}...</code>`;
    } catch (error: any) {
      return `Error fetching game: ${error.message}`;
    }
  }

  // Helper function to get user's games
  public async getUserGames(ctx: Context, telegramId: bigint): Promise<{
    activeGames: string;
    recentGames: string;
    totalTokensInGames: number;
  }> {
    const playerKp = await this.wallet.getKeyPair(telegramId);
    const allGames = await this.gameDb.getAllGames();
    const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

    let activeGamesSection = "";
    let hasActiveGames = false;
    let totalTokensInGames = 0;

    // Get player's balance PDA once
    const playerBalancePda = this.getPlayerBalancePda(playerKp.publicKey);

    // Batch fetch all game accounts
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

    // Get all usernames in one batch
    const uniqueTelegramIds = new Set<string>();
    allGames.forEach(game => {
      uniqueTelegramIds.add(game.creator_telegram_id);
    });
    uniqueTelegramIds.add(telegramId.toString());

    // Get winner Telegram IDs from database
    const winnerTelegramIds = new Map<string, string>();
    for (const game of allGames) {
      if (game.winner_address && game.winner_address !== "cancelled" && game.winner_address !== "unknown") {
        const winnerTelegramId = await this.gameDb.getPlayerTelegramId(game.winner_address);
        if (winnerTelegramId) {
          winnerTelegramIds.set(game.winner_address, winnerTelegramId);
          uniqueTelegramIds.add(winnerTelegramId);
        }
      }
    }

    const usernameMap = new Map<string, string>();
    for (const id of uniqueTelegramIds) {
      try {
        const chatMember = await ctx.api.getChatMember(ctx.chat!.id, parseInt(id));
        usernameMap.set(id, chatMember.user.username || chatMember.user.first_name);
      } catch (error) {
        console.error(`Error getting username for ${id}:`, error);
        usernameMap.set(id, "Unknown");
      }
    }

    // Process active games
    for (const gameData of allGames) {
      try {
        const gameAccount = gameAccounts.get(gameData.game_address);
        if (!gameAccount) continue;

        const gameStatus = Object.keys(gameAccount.status)[0].toLowerCase();
        if (gameStatus !== "active") continue;

        const isCreator = gameData.creator_telegram_id === telegramId.toString();
        const isPlayer = gameAccount.players.some((p: PublicKey) => p.equals(playerBalancePda));

        if (isCreator || isPlayer) {
          if (!hasActiveGames) {
            activeGamesSection = "🎮 <b>Active Games</b>\n\n";
            hasActiveGames = true;
          }
          const gamePda = new PublicKey(gameData.game_address);
          const gameInfo = await this.getGameInfo(gamePda);
          activeGamesSection += `${gameInfo}\n\n`;
          totalTokensInGames += Number(gameAccount.amount);
        }
      } catch (error) {
        console.error(`Error processing game ${gameData.game_address}:`, error);
      }
    }

    // Process completed games
    const categories = {
      won: [] as any[],
      lost: [] as any[],
      cancelled: [] as any[]
    };

    for (const game of allGames) {
      const gameAccount = gameAccounts.get(game.game_address);
      if (!gameAccount) continue;

      const status = Object.keys(gameAccount.status)[0].toLowerCase();
      if (status === 'active') continue;

      if (game.winner_address === "cancelled") {
        categories.cancelled.push({ ...game, gameAccount });
      } else if (game.winner_address) {
        const winnerTelegramId = winnerTelegramIds.get(game.winner_address);
        const winnerUsername = winnerTelegramId ? usernameMap.get(winnerTelegramId) || "Unknown" : "Unknown";
        const currentUsername = usernameMap.get(telegramId.toString()) || "Unknown";
        const isWinner = winnerUsername === currentUsername;

        if (isWinner) {
          categories.won.push({ ...game, gameAccount });
        } else {
          categories.lost.push({ ...game, gameAccount });
        }
      }
    }

    // Sort games by completion time
    const sortGames = (games: any[]) => games.sort((a, b) => {
      const timeA = a.completed_at || a.created_at;
      const timeB = b.completed_at || b.created_at;
      return timeB - timeA;
    });

    categories.won = sortGames(categories.won);
    categories.lost = sortGames(categories.lost);
    categories.cancelled = sortGames(categories.cancelled);

    // Format recent games section
    let recentGamesSection = "";
    let hasRecentGames = false;

    // Helper function to format game info
    const formatGameInfo = (game: any) => {
      const gameAccount = game.gameAccount;
      const gameType = Object.keys(gameAccount.gameType)[0];
      const amount = Number(gameAccount.amount);
      const creatorUsername = usernameMap.get(game.creator_telegram_id) || "Unknown";

      let winnerInfo = "";
      if (game.winner_address && game.winner_address !== "cancelled" && game.winner_address !== "unknown") {
        const winnerTelegramId = winnerTelegramIds.get(game.winner_address);
        const winnerUsername = winnerTelegramId ? usernameMap.get(winnerTelegramId) || "Unknown" : "Unknown";
        winnerInfo = `\nWinner: @${winnerUsername}`;
      }

      return `Game: <code>${game.game_address.slice(0, 8)}...</code>\n` +
        `Type: ${gameType.charAt(0).toUpperCase() + gameType.slice(1)}\n` +
        `Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
        `Creator: @${creatorUsername}${winnerInfo}\n` +
        `Completed: ${game.completed_at ? new Date(game.completed_at * 1000).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : 'N/A'}\n\n`;
    };

    // Combine all completed games and sort by completion time
    const allCompletedGames = [
      ...categories.won.map(game => ({ ...game, category: 'won' })),
      ...categories.lost.map(game => ({ ...game, category: 'lost' })),
      ...categories.cancelled.map(game => ({ ...game, category: 'cancelled' }))
    ].sort((a, b) => {
      const timeA = a.completed_at || a.created_at;
      const timeB = b.completed_at || b.created_at;
      return timeB - timeA;
    }).slice(0, 5);

    // Group games by category
    const groupedGames = {
      won: allCompletedGames.filter(game => game.category === 'won'),
      lost: allCompletedGames.filter(game => game.category === 'lost'),
      cancelled: allCompletedGames.filter(game => game.category === 'cancelled')
    };

    // Add won games
    if (groupedGames.won.length > 0) {
      hasRecentGames = true;
      recentGamesSection += "🏆 <b>Won Games</b>\n\n";
      for (const game of groupedGames.won) {
        recentGamesSection += formatGameInfo(game);
      }
    }

    // Add lost games
    if (groupedGames.lost.length > 0) {
      hasRecentGames = true;
      recentGamesSection += "😢 <b>Lost Games</b>\n\n";
      for (const game of groupedGames.lost) {
        recentGamesSection += formatGameInfo(game);
      }
    }

    // Add cancelled games
    if (groupedGames.cancelled.length > 0) {
      hasRecentGames = true;
      recentGamesSection += "❌ <b>Cancelled Games</b>\n\n";
      for (const game of groupedGames.cancelled) {
        recentGamesSection += formatGameInfo(game);
      }
    }

    // Remove extra newlines at the end of recentGamesSection
    if (recentGamesSection.endsWith('\n\n')) {
      recentGamesSection = recentGamesSection.slice(0, -2);
    }

    return {
      activeGames: hasActiveGames ? activeGamesSection : "",
      recentGames: hasRecentGames ? recentGamesSection : "",
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

      const secretKey = randomBytes(64);
      const randomHash = createHash('sha256').update(secretKey).digest();

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
        secretKey.toString('hex'),
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
