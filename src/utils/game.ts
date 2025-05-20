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

  private constructor(
    private program: anchor.Program<Coinflip>,
    private wallet: WalletManager,
    private gameDb: GameDatabase,
    private tokenMint: string,
    private ticker: string
  ) {
    this.activeGameMessages = new Map();
    this.gameAccountCache = new Map();
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

  // Helper function to get all required PDAs and accounts for a game
  public async getGameAccounts(playerKp: anchor.web3.Keypair): Promise<GameAccounts> {
    const [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle")],
      this.program.programId
    );
    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), new PublicKey(this.tokenMint).toBuffer()],
      this.program.programId
    );
    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), new PublicKey(this.tokenMint).toBuffer()],
      this.program.programId
    );

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
    const [playerBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player_balance"), playerKeypair.publicKey.toBuffer(), new PublicKey(this.tokenMint).toBuffer()],
      this.program.programId
    );

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

      const [gameTokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_token"), new PublicKey(this.tokenMint).toBuffer()],
        this.program.programId
      );

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
    const blockTime = await this.wallet.connection.getBlockTime(
      await this.wallet.connection.getSlot()
    );
    if (!blockTime) {
      throw new Error("Could not get blockchain time");
    }
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
    const blockTime = await this.wallet.connection.getBlockTime(
      await this.wallet.connection.getSlot()
    );
    if (!blockTime) {
      throw new Error("Could not get blockchain time");
    }
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
      const blockTime = await this.wallet.connection.getBlockTime(
        await this.wallet.connection.getSignatureStatus(tx).then(status => status.value?.slot || 0)
      );

      // Convert block time to milliseconds for database storage
      const completedAt = blockTime ? blockTime * 1000 : await this.wallet.connection.getBlockTime(
        await this.wallet.connection.getSlot()
      ).then(time => time ? time * 1000 : 0);

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
        const blockTime = await this.wallet.connection.getBlockTime(
          await this.wallet.connection.getSignatureStatus(tx).then(status => status.value?.slot || 0)
        );

        // Convert block time to milliseconds for database storage
        const completedAt = blockTime ? blockTime * 1000 : await this.wallet.connection.getBlockTime(
          await this.wallet.connection.getSlot()
        ).then(time => time ? time * 1000 : 0);

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
    const gameAccount = await this.program.account.game.fetch(gamePda);
    const currentPlayers = gameAccount.players.length;
    const maxPlayers = gameAccount.maxPlayers;

    // Get player usernames
    let playerInfo = "";
    if (gameAccount.players.length > 0) {
      playerInfo = "\n👥 Players:\n";
      for (const playerBalancePda of gameAccount.players) {
        // Try to get the player's Telegram ID from their balance PDA
        const playerTelegramId = await this.gameDb.getPlayerTelegramId(playerBalancePda.toBase58());

        if (playerTelegramId) {
          try {
            const chatMember = await ctx.api.getChatMember(ctx.chat!.id, parseInt(playerTelegramId));
            const username = chatMember.user.username || chatMember.user.first_name;
            playerInfo += `• @${username}\n`;
          } catch (error) {
            console.error(`Error getting chat member for ${playerTelegramId}:`, error);
            playerInfo += `• ${playerBalancePda.toBase58().slice(0, 8)}...\n`;
          }
        } else {
          playerInfo += `• ${playerBalancePda.toBase58().slice(0, 8)}...\n`;
        }
      }
    }

    // Calculate expiration time using blockchain time
    let expirationInfo = "";
    if (status.toLowerCase() === "active") {
      try {
        const blockTime = await this.wallet.connection.getBlockTime(
          await this.wallet.connection.getSlot()
        );
        if (blockTime) {
          const createdAt = Number(gameAccount.createdAt);
          const timeout = Number(gameAccount.timeout);
          const expiresAt = createdAt + timeout;
          const timeLeft = expiresAt - blockTime;

          if (timeLeft > 0) {
            const hours = Math.floor(timeLeft / 3600);
            const minutes = Math.floor((timeLeft % 3600) / 60);
            expirationInfo = `\n⏰ Expires in: ${hours}h ${minutes}m`;
          } else {
            expirationInfo = "\n⚠️ Expired";
          }
        }
      } catch (error) {
        console.error("Error calculating expiration time:", error);
      }
    }

    let messageText = `<b>🪙 ${gameType} Game</b>\n\n` +
      `💰 Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
      `👤 Creator: @${creatorUsername}\n` +
      `👥 Players: ${currentPlayers}/${maxPlayers}${playerInfo}\n` +
      `Status: ${status}${expirationInfo}\n`;

    if (winnerAddress && winnerAddress !== "11111111111111111111111111111111") {
      // Get winner's Telegram username
      const winnerTelegramId = await this.gameDb.getPlayerTelegramId(winnerAddress);
      let winnerTag = winnerAddress.slice(0, 8) + "...";
      if (winnerTelegramId) {
        try {
          const chatMember = await ctx.api.getChatMember(ctx.chat!.id, parseInt(winnerTelegramId));
          const username = chatMember.user.username || chatMember.user.first_name;
          winnerTag = `@${username}`;
        } catch (error) {
          console.error("Error getting winner's username:", error);
        }
      }
      messageText += `\n🏆 Winner: ${winnerTag}`;
    }

    if (txHash) {
      messageText += `\n\nTransaction: <code>${txHash}</code>`;
    }

    const keyboard = status.toLowerCase() === "completed" ? [] : [
      [
        { text: "🎮 Join Game", callback_data: `join_${gamePda.toBase58()}` },
        { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` }
      ]
    ];

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
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

      // Format game details
      const amount = Number(gameAccount.amount);
      const maxPlayers = gameAccount.maxPlayers;
      const currentPlayers = gameAccount.players.length;
      const creatorPubkey = gameAccount.creator.toString();
      const status = Object.keys(gameAccount.status)[0] as GameStatus;
      const gameType = Object.keys(gameAccount.gameType)[0];

      // Calculate expiration time using blockchain time
      let expirationInfo = "";
      if (status.toLowerCase() === "active") {
        // Get current blockchain time
        const blockTime = await this.wallet.connection.getBlockTime(
          await this.wallet.connection.getSlot()
        );
        if (!blockTime) {
          throw new Error("Could not get blockchain time");
        }

        const createdAt = Number(gameAccount.createdAt);
        const timeout = Number(gameAccount.timeout);
        const expiresAt = createdAt + timeout;
        const timeLeft = expiresAt - blockTime;

        if (timeLeft > 0) {
          const hours = Math.floor(timeLeft / 3600);
          const minutes = Math.floor((timeLeft % 3600) / 60);
          expirationInfo = `\nExpires in: ${hours}h ${minutes}m`;
        } else {
          expirationInfo = "\n⚠️ Expired";
        }
      }

      return `Game: <code>${gamePda.toBase58().slice(0, 8)}...</code>\n` +
             `Type: ${gameType}\n` +
             `Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
             `Players: ${currentPlayers}/${maxPlayers}\n` +
             `Status: ${status}${expirationInfo}\n` +
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
    const playerPubkey = playerKp.publicKey;
    const allGames = await this.gameDb.getAllGames();
    const metadata = await this.wallet.getTokenMetadata(this.tokenMint);

    let activeGamesSection = "🔄 <b>Active Games</b>\n";
    let hasActiveGames = false;
    let totalTokensInGames = 0;

    // Check games where user is creator
    for (const gameData of allGames) {
      try {
        const gamePda = new PublicKey(gameData.game_address);
        const gameAccount = await this.program.account.game.fetch(gamePda);
        const gameStatus = Object.keys(gameAccount.status)[0] as GameStatus;

        // If game is not active on-chain, update database and skip
        if (gameStatus.toLowerCase() !== "active") {
          console.log(`Game ${gamePda.toBase58()} is ${gameStatus} on-chain, updating database...`);
          try {
            // Only update if the game doesn't have a completion time
            if (!gameData.completed_at) {
              const blockTime = await this.wallet.connection.getBlockTime(
                await this.wallet.connection.getSlot()
              );
              const completedAt = blockTime ? blockTime * 1000 : 0;
              await this.gameDb.completeGame(gameData.game_address, gameAccount.winner?.toString() || "unknown", completedAt);
            }
          } catch (dbError) {
            console.error(`Error updating game status in database: ${dbError}`);
          }
          continue;
        }

        // Check if game is expired
        const { isExpired } = await this.checkGameStatus(gamePda);

        // If game is expired, try to handle it
        if (isExpired) {
          await this.handleExpiredGame(ctx, gamePda, gameAccount);
          continue; // Skip expired games from active games list
        }

        // Check if user is creator or player
        const isCreator = gameData.creator_telegram_id === telegramId.toString();
        const [playerBalancePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("player_balance"), playerKp.publicKey.toBuffer(), new PublicKey(this.tokenMint).toBuffer()],
          this.program.programId
        );
        const isPlayer = gameAccount.players.some((p: PublicKey) => p.equals(playerBalancePda));

        if (isCreator || isPlayer) {
          hasActiveGames = true;
          const gameInfo = await this.getGameInfo(gamePda);
          activeGamesSection += `${gameInfo}\n\n`;
          // Add to total tokens for active games
          totalTokensInGames += Number(gameAccount.amount);
        }
      } catch (error) {
        console.error(`Error fetching game ${gameData.game_address}:`, error);
        // If we can't fetch the game on-chain, it might be completed or cancelled
        // Let's update the database to reflect this
        try {
          // Only update if the game doesn't have a completion time
          if (!gameData.completed_at) {
            const blockTime = await this.wallet.connection.getBlockTime(
              await this.wallet.connection.getSlot()
            );
            const completedAt = blockTime ? blockTime * 1000 : 0;
            await this.gameDb.completeGame(gameData.game_address, "unknown", completedAt);
          }
        } catch (dbError) {
          console.error(`Error updating game status in database: ${dbError}`);
        }
      }
    }

    // Then show last 5 games where player participated
    let recentGamesSection = "📜 <b>Recent Games</b>\n";
    let hasRecentGames = false;

    // Get all games where player participated (as creator or player)
    const playerGames = [];
    for (const game of allGames) {
      try {
        const gamePda = new PublicKey(game.game_address);
        const gameAccount = await this.program.account.game.fetch(gamePda);
        const isCreator = game.creator_telegram_id === telegramId.toString();

        // Get player's balance PDA
        const [playerBalancePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("player_balance"), playerPubkey.toBuffer(), new PublicKey(this.tokenMint).toBuffer()],
          this.program.programId
        );

        // Check if player is in the game by checking their balance PDA
        const isPlayer = gameAccount.players.some((p: PublicKey) => p.equals(playerBalancePda));

        if (isCreator || isPlayer) {
          playerGames.push({
            ...game,
            isCreator,
            isPlayer
          });
        }
      } catch (error) {
        console.error(`Error checking player participation for game ${game.game_address}:`, error);
      }
    }

    // Sort games by completion time (most recent first)
    const sortedGames = playerGames.sort((a, b) => {
      const timeA = a.completed_at || a.created_at;
      const timeB = b.completed_at || b.created_at;
      return timeB - timeA;
    });

    // Take only the last 5 games
    const recentGames = sortedGames.slice(0, 5);

    for (const game of recentGames) {
      hasRecentGames = true;

      // Get game details from blockchain
      try {
        const gamePda = new PublicKey(game.game_address);
        const gameAccount = await this.program.account.game.fetch(gamePda);
        const gameType = Object.keys(gameAccount.gameType)[0];
        const status = Object.keys(gameAccount.status)[0];
        const amount = Number(gameAccount.amount);

        // Get creator's username
        const creatorTelegramId = game.creator_telegram_id;
        let creatorUsername = "Unknown";
        try {
          const chatMember = await ctx.api.getChatMember(ctx.chat!.id, parseInt(creatorTelegramId));
          creatorUsername = chatMember.user.username || chatMember.user.first_name;
        } catch (error) {
          console.error("Error getting creator's username:", error);
        }

        // Get winner's username if game is completed
        let winnerInfo = "";
        if (game.winner_address && game.winner_address !== "cancelled" && game.winner_address !== "unknown") {
          const winnerTelegramId = await this.gameDb.getPlayerTelegramId(game.winner_address);
          let winnerTag = game.winner_address.slice(0, 8) + "...";
          if (winnerTelegramId) {
            try {
              const chatMember = await ctx.api.getChatMember(ctx.chat!.id, parseInt(winnerTelegramId));
              const username = chatMember.user.username || chatMember.user.first_name;
              winnerTag = `@${username}`;
            } catch (error) {
              console.error("Error getting winner's username:", error);
            }
          }
          winnerInfo = `\nWinner: ${winnerTag}`;
        } else if (gameAccount.winner && gameAccount.winner.toString() !== "11111111111111111111111111111111") {
          // If winner not in database, try to get from blockchain
          const winnerPubkey = gameAccount.winner.toString();
          const winnerTelegramId = await this.gameDb.getPlayerTelegramId(winnerPubkey);
          let winnerTag = winnerPubkey.slice(0, 8) + "...";
          if (winnerTelegramId) {
            try {
              const chatMember = await ctx.api.getChatMember(ctx.chat!.id, parseInt(winnerTelegramId));
              const username = chatMember.user.username || chatMember.user.first_name;
              winnerTag = `@${username}`;
            } catch (error) {
              console.error("Error getting winner's username:", error);
            }
          }
          winnerInfo = `\nWinner: ${winnerTag}`;
        }

        // Format game info
        recentGamesSection += `Game: <code>${game.game_address.slice(0, 8)}...</code>\n` +
          `Type: ${gameType.charAt(0).toUpperCase() + gameType.slice(1)}\n` +
          `Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${this.ticker}\n` +
          `Creator: @${creatorUsername}\n` +
          `Status: ${status.charAt(0).toUpperCase() + status.slice(1)}${winnerInfo}\n` +
          `Completed: ${game.completed_at ? new Date(game.completed_at * 1000).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : 'N/A'}\n\n`;
      } catch (error) {
        console.error(`Error fetching game details for ${game.game_address}:`, error);
      }
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
      const [playerBalancePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("player_balance"), playerKp.publicKey.toBuffer(), new PublicKey(this.tokenMint).toBuffer()],
        this.program.programId
      );

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
      const [gamePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("game"), randomHash],
        this.program.programId
      );

      // Ensure player balance PDA exists
      await this.ensurePlayerBalance(playerKp);
      console.log(`Player balance PDA: ${playerBalancePda.toBase58()}`);
      // Save creator's balance PDA mapping
      console.log(`Saving creator balance PDA mapping - PDA: ${playerBalancePda.toBase58()}, Telegram ID: ${telegramId.toString()}`);
      this.gameDb.savePlayerMapping(playerBalancePda.toBase58(), telegramId.toString());

      const [oraclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("oracle")],
        this.program.programId
      );
      const [gameTokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_token"), new PublicKey(this.tokenMint).toBuffer()],
        this.program.programId
      );
      const [gameVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_vault"), new PublicKey(this.tokenMint).toBuffer()],
        this.program.programId
      );

      // Get token accounts
      const playerTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(this.tokenMint),
        playerKp.publicKey
      );
      const gameTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(this.tokenMint),
        gameVaultPda,
        true
      );

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
          oracle: oraclePda,
          gameToken: gameTokenPda,
          playerTokenAccount: playerTokenAccount,
          gameTokenAccount: gameTokenAccount,
        })
        .signers([playerKp])
        .rpc();

      // Verify game creation
      try {
        await this.program.account.game.fetch(gamePda);
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
}
