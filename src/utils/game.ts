import { PublicKey } from "@solana/web3.js";
import { Context } from "grammy";
import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { createHash } from "crypto";
import { WalletManager } from "./wallet";
import { GameDatabase } from "./game-database";
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
    _tokenMint: string,
    tokenTicker: string,
    winnerAddress?: string,
    txHash?: string,
    providedTotalPot?: number
  ): Promise<GameMessageFormat> {
    let currentPlayers: number = 0;
    let maxPlayers: number = 2;
    let minPlayers: number = 1;
    let totalPot = providedTotalPot ?? amount; // Use provided totalPot if available, otherwise default to amount per player
    let expirationInfo = "";

    if (status.toLowerCase() === "completed") {
      // For completed games, we might not have access to the game account
      if (!providedTotalPot) {
        totalPot = amount * currentPlayers; // Calculate total pot for completed games only if not provided
      }
      currentPlayers = 0; // Will be set from the game data
      maxPlayers = 0; // Will be set from the game data
      minPlayers = 0; // Will be set from the game data
    } else {
      // For active games, fetch current state from blockchain
      try {
        const gameAccount = await this.program.account.game.fetch(gamePda);
        currentPlayers = gameAccount.playersCount;
        maxPlayers = gameAccount.maxPlayers;
        minPlayers = gameAccount.minPlayers;

        // If totalPot is not provided, use totalAmount from the game account or calculate it
        if (!providedTotalPot) {
          totalPot = Number(gameAccount.totalAmount || 0) || (amount * currentPlayers); // Use totalAmount from contract if available and not provided
        }

        // Calculate expiration time
        const createdAt = Number(gameAccount.createdAt);
        const timeout = Number(gameAccount.timeout);
        const expiresAt = createdAt + timeout;
        expirationInfo = await formatExpirationTime(expiresAt, this.wallet, "\n⏰ ");
      } catch (error) {
        console.warn(`Warning: Could not fetch game account for ${gamePda.toBase58()}:`, error);
        currentPlayers = 0;
        maxPlayers = 0;
        minPlayers = 0;
      }
    }

    if (status.toLowerCase() === "completed") {
      // For completed games where we don't have game account access, get player count from participants
      const participants = this.getGamePlayers(gamePda.toBase58());
      currentPlayers = participants.length;
      maxPlayers = currentPlayers; // Set max to current for display purposes
      minPlayers = currentPlayers; // Set min to current for display purposes

      if (!providedTotalPot) {
        totalPot = amount * currentPlayers; // Calculate total pot for completed games only if not provided
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

    // Show amount per player and total pot
    let amountDisplay = `💰 Amount: ${this.wallet.formatTokenBalance(amount, 9)} ${tokenTicker}`;
    // For snowball games, always show total pot since it's a growing pot concept
    // For other games, only show total pot when there are multiple players or when totalPot != amount
    if (gameType.toLowerCase() === "snowball" || currentPlayers > 1 || totalPot !== amount) {
      amountDisplay += `\n🎯 Total Pot: ${this.wallet.formatTokenBalance(totalPot, 9)} ${tokenTicker}`;
    }

    let messageText = `<b>🪙 ${gameType} Game</b>\n\n` +
      `${amountDisplay}\n` +
      `👤 Creator: @${creatorUsername}\n` +
      `👥 Players: ${currentPlayers}/${maxPlayers}`;

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

    // Keyboard - only show buttons for active games
    const keyboard = [];
    if (status.toLowerCase() !== "completed") {
      // Change button text for snowball and dumbflip games
      const joinButtonText = (gameType.toLowerCase() === "snowball" || gameType.toLowerCase() === "dumbflip") ? "🎲 Roll" : "🎮 Join";

      keyboard.push([
        { text: joinButtonText, callback_data: `join_${gamePda.toBase58()}` },
        { text: "🔄 Refresh", callback_data: `refresh_${gamePda.toBase58()}` }
      ]);

      // For snowball games, hide unjoin button if 2+ players (since you can't unjoin)
      // For other games, show unjoin button if there are any players
      if (currentPlayers > 0) {
        if (gameType.toLowerCase() === "snowball" && currentPlayers >= 2) {
          // Don't add unjoin button for snowball games with 2+ players
        } else {
          keyboard[0]?.push({ text: "❌ Unjoin", callback_data: `unjoin_${gamePda.toBase58()}` });
        }
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

      const creatorTelegramId = this.gameDb.getCreatorTelegramId(gamePda.toBase58());
      const creatorInfo = creatorTelegramId
        ? `@${await this.getUsernameFromTelegramId(ctx, creatorTelegramId)}`
        : `<code>${creatorPubkey.slice(0, ADDRESS_DISPLAY_LENGTH)}...</code>`;

      // Add expiration info
      const expiresAt = Number(gameAccount.createdAt) + Number(gameAccount.timeout);
      const expirationInfo = "\n" + await formatExpirationTime(expiresAt, this.wallet);

      let winnerInfo = "";
      if (gameData && gameData.winner_address && gameData.winner_address !== "cancelled" && gameData.winner_address !== DEFAULT_NULL_ADDRESS) {
        const winnerUsername = await this.getPlayerUsername(ctx, gameData.winner_address);
        winnerInfo = `\nWinner: @${winnerUsername}`;
      }

      return `Type: ${gameType}\n` +
             `Amount: ${this.wallet.formatTokenBalance(amount, metadata.decimals)} ${tokenTicker}\n` +
             `Creator: ${creatorInfo}\n` +
             `Players: ${currentPlayers}/${maxPlayers}${expirationInfo}${winnerInfo}`;
    } catch (error: any) {
      return `Error fetching game: ${error.message}`;
    }
  }

  // Helper method to get game info for completed games from database
  public async getCompletedGameInfo(ctx: Context, gameData: any): Promise<string> {
    try {
      const winnerUsername = await this.getPlayerUsername(ctx, gameData.winner_address);
      const creatorUsername = await this.getUsernameFromTelegramId(ctx, gameData.creator_telegram_id);
      const amount = Number(gameData.amount);
      const playerCount = gameData.max_players || 2;

      const gameTypeText = gameData.game_type.charAt(0).toUpperCase() + gameData.game_type.slice(1);

      return [
        `<b>🏆 ${gameTypeText} Completed</b>`,
        "",
        `💰 Amount: ${this.wallet.formatTokenBalance(amount, 9)} ${gameData.token_ticker || "WSOL"}`,
        `👥 Players: ${playerCount}/${gameData.max_players || playerCount}`,
        `👤 Creator: @${creatorUsername}`,
        `🎉 Winner: @${winnerUsername}`,
        "",
        `<i>Game completed at ${formatDate(gameData.completed_at || Date.now())}</i>`
      ].join("\n");
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

                  const { randomHash, secretKey } = await this.oracleClient.generateGameSecrets(gameType);
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

      // Listen for GameInitialized event to get the correct nonce and game address
      const { gamePda, eventNonce } = await this.waitForGameInitializedEvent(tx, new PublicKey(tokenMint), randomHashBuffer);

      console.log(`📍 Game address from event: ${gamePda.toBase58()} (nonce: ${eventNonce})`);

      const gameCreationConfirmed = await this.confirmTransactionWithRecovery(tx, gamePda, "Game creation");

      if (!gameCreationConfirmed) {
        throw new Error("Game creation could not be confirmed");
      }

            // Save game and create message
      this.gameDb.saveGame(gamePda.toBase58(), telegramId.toString(), amount, gameType, tokenMint, tokenTicker, maxPlayers, minPlayers);

      // Store secret key for dumbflip and snowball games with derived game address
      if ((gameType === "dumbflip" || gameType === "snowball") && secretKey) {
        this.gameDb.saveOracleSecretKey(gamePda.toBase58(), secretKey);
        console.log(`🔐 Secret key stored for ${gameType} game`);
      }

      await this.createGameMessage(ctx, gamePda.toBase58(), gameType.charAt(0).toUpperCase() + gameType.slice(1), amount, ctx.from?.username || "Unknown", tokenMint, tokenTicker, "Active", tx);

      // Auto-join logic based on game type
      if (gameType === "coinflip" || gameType === "dumbflip" || gameType === "snowball") {
        await this.handleGameAutoJoin(ctx, gamePda, playerKp, telegramId, creatorPubkey, gameType, amount, tokenMint, tokenTicker);
      } else {
        console.log(`🎁 ${gameType.charAt(0).toUpperCase() + gameType.slice(1)} game ${gamePda.toBase58()} created - creator not auto-joined`);
      }

    } catch (error: any) {
      console.error(`Error creating ${gameType} game:`, error);
      const userFriendlyError = formatUserFriendlyError(error, this.wallet);
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
        await this.updateGameMessage(ctx, gamePda.toBase58(), gameType.charAt(0).toUpperCase() + gameType.slice(1), amount, ctx.from?.username || "Unknown", "Active", tokenMint, tokenTicker);
      }

    } catch (joinError: any) {
      console.error(`❌ Failed to auto-join creator to ${gameType} game: ${joinError.message}`);
      await ctx.reply(
        `⚠️ <b>Game created successfully, but failed to auto-join creator!</b>\n\n` +
        `Please manually join the game using the "🎮 Join" button.\n\n` +
        `Error: ${joinError.message}`,
        { parse_mode: "HTML", reply_to_message_id: ctx.message?.message_id }
      );
    }
  }

  // ================================
  // EVENT LISTENING
  // ================================

    /**
   * Wait for GameInitialized event to get the correct nonce and derive game address
   */
  private async waitForGameInitializedEvent(
    txSignature: string,
    tokenMint: PublicKey,
    randomHashBuffer: Buffer
  ): Promise<{ gamePda: PublicKey; eventNonce: number }> {
    console.log(`🔍 Waiting for GameInitialized event from tx: ${txSignature.slice(0, 8)}...`);

    const maxWaitTime = 30000; // 30 seconds

    return new Promise((resolve, reject) => {
      let listenerRemoved = false;

      // Set up one-time event listener for GameInitialized
      const listener = this.program.addEventListener('gameInitialized', (event, _slot, signature) => {
        try {
          // Check if this event is from our transaction
          if (signature === txSignature) {
            const eventNonce = Number(event.nonce);
            const gamePda = PDAManager.getGamePDA(tokenMint, randomHashBuffer, eventNonce, this.program.programId);

            console.log(`✅ Received GameInitialized event with nonce: ${eventNonce}`);

            // Remove the listener and resolve (only if not already removed)
            if (!listenerRemoved) {
              listenerRemoved = true;
              try {
                this.program.removeEventListener(listener);
              } catch (removeError) {
                console.warn('Event listener already removed:', removeError);
              }
            }
            resolve({ gamePda, eventNonce });
          }
        } catch (error) {
          console.error('Error processing GameInitialized event:', error);
          if (!listenerRemoved) {
            listenerRemoved = true;
            try {
              this.program.removeEventListener(listener);
            } catch (removeError) {
              console.warn('Event listener already removed:', removeError);
            }
          }
          reject(error);
        }
      });

      // Set timeout to cleanup if event never comes
      setTimeout(() => {
        if (!listenerRemoved) {
          listenerRemoved = true;
          try {
            this.program.removeEventListener(listener);
          } catch (removeError) {
            console.warn('Event listener already removed during timeout:', removeError);
          }
        }
        reject(new Error(`GameInitialized event not received within ${maxWaitTime}ms for tx: ${txSignature}`));
      }, maxWaitTime);
    });
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
   * Get expected winner for dumbflip and snowball games using secret key and lastSlot
   */
  private async getExpectedWinner(gameAddress: string, participants: string[]): Promise<string | null> {
    try {
      const secretKey = this.gameDb.getOracleSecretKey(gameAddress);
      const lastSlot = this.gameDb.getGameLastSlot(gameAddress);

      if (!secretKey || !lastSlot || participants.length === 0) {
        return null;
      }

      // Validate inputs before calculating
      if (participants.length <= 0) {
        console.warn(`Invalid participants length for game ${gameAddress}: ${participants.length}`);
        return null;
      }

      const lastSlotBigInt = BigInt(lastSlot);
      if (lastSlotBigInt < 0n) {
        console.warn(`Invalid lastSlot for game ${gameAddress}: ${lastSlot}`);
        return null;
      }

      return this.calculateWinnerFromSecretAndSlot(secretKey, lastSlot, participants);
    } catch (error) {
      console.error('Error calculating expected winner:', error);
      return null;
    }
  }

  /**
   * Calculate winner index using secret key and lastSlot (matching contract logic)
   */
  private calculateWinnerFromSecretAndSlot(secretKey: string, lastSlot: string, participants: string[]): string | null {
    try {
      const winnerIndex = this.calculateWinnerIndex(secretKey, BigInt(lastSlot), participants.length);
      return participants[winnerIndex] || null;
    } catch (error) {
      console.error('Error in winner calculation:', error);
      return null;
    }
  }

  /**
   * Calculate winner index using the exact same algorithm as the contract
   */
  private calculateWinnerIndex(secretKey: string, lastSlot: bigint, nPlayers: number): number {
    if (nPlayers <= 1) {
      return 0;
    }

    if (nPlayers <= 0) {
      throw new Error("Number of players must be greater than 0");
    }

    // Convert secret key from hex string to buffer
    const secretKeyBuffer = Buffer.from(secretKey, 'hex');
    if (secretKeyBuffer.length !== 32) {
      throw new Error("Invalid secret key length - must be 32 bytes");
    }

    // Validate lastSlot is within safe range
    if (lastSlot < 0n) {
      throw new Error("Last slot cannot be negative");
    }

    // Hash combination of secret key and last_slot for additional entropy (matching contract logic)
    const combinedData = Buffer.alloc(40); // 32 bytes secret + 8 bytes last_slot
    secretKeyBuffer.copy(combinedData, 0, 0, 32);

    // Convert bigint to little-endian bytes (matching contract's to_le_bytes())
    const lastSlotBytes = Buffer.alloc(8);

    // Handle large numbers by converting to bigint and then to buffer safely
    const lastSlotBigInt = BigInt(lastSlot);
    const low32 = Number(lastSlotBigInt & BigInt(0xffffffff));
    const high32 = Number((lastSlotBigInt >> BigInt(32)) & BigInt(0xffffffff));

    // Write as unsigned 32-bit integers
    lastSlotBytes.writeUInt32LE(low32, 0);
    lastSlotBytes.writeUInt32LE(high32, 4);
    lastSlotBytes.copy(combinedData, 32);

    // Hash the combined data (matching contract's hash() function)
    const entropyHash = createHash('sha256').update(combinedData).digest();

    const maxU64 = BigInt('0xFFFFFFFFFFFFFFFF');
    const nPlayersBig = BigInt(nPlayers);
    const maxValid = maxU64 - (maxU64 % nPlayersBig);

    // Try sliding 8-byte windows through the hashed entropy
    for (let startPos = 0; startPos <= (32 - 8); startPos++) {
      // Extract 8 bytes and convert to u64 using little-endian (matching contract)
      const window = entropyHash.subarray(startPos, startPos + 8);

      // Convert to BigInt using little-endian format
      let randomU64 = BigInt(0);
      for (let i = 0; i < 8; i++) {
        const byte = window[i];
        if (byte === undefined) {
          throw new Error("Invalid entropy hash buffer size");
        }
        randomU64 |= BigInt(byte) << (BigInt(i) * BigInt(8));
      }

      // Use this value if it's in the unbiased range
      if (randomU64 < maxValid) {
        return Number(randomU64 % nPlayersBig);
      }
    }

    throw new Error("Unable to generate unbiased random number - game must be cancelled");
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

      const expectedWinnerTelegramId = await this.getExpectedWinner(gameAddress, participants);
      if (!expectedWinnerTelegramId) {
        return "\n🎯 Expected winner: Calculating...";
      }

      const expectedWinnerUsername = await this.getUsernameFromTelegramId(ctx, expectedWinnerTelegramId);
      return `\n🎯 Expected winner: @${expectedWinnerUsername}`;
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

      const creatorTelegramId = await this.gameDb.getCreatorTelegramId(gamePda.toBase58());
      if (creatorTelegramId) {
        const creatorUsername = await this.getUsernameFromTelegramId(ctx, creatorTelegramId);

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

  public async cancelGameWithPlayerKeys(gamePda: PublicKey, gameType: string): Promise<{ success: boolean; tx?: string; error?: string }> {
    try {
      const gameAccount = await this.program.account.game.fetch(gamePda);
      console.log(`Attempting to cancel ${gameType} game ${gamePda.toBase58()} using player keys`);

            // For competitive game types, unjoin all players first before cancellation (after buffer time)
      // Giveaways can be cancelled without unjoining players since creator is giving away their tokens
      if (gameType === "coinflip" || gameType === "dumbflip" || gameType === "snowball") {
        // Get players from database since the contract no longer stores players array
        const participants = this.getGamePlayers(gamePda.toBase58());

        if (participants.length > 0) {
          console.log(`${gameType.charAt(0).toUpperCase() + gameType.slice(1)} has ${participants.length} players, unjoining all of them first`);
          let allPlayersUnjoined = true;

          // Unjoin all players including creator
          for (const telegramId of participants) {
            try {
              const playerPubkey = this.gameDb.getPlayerPublicKey(telegramId);
              if (playerPubkey) {
                const playerKp = this.wallet.getKeyPair(BigInt(telegramId));
                await this.unjoinPlayerFromGame(gamePda, playerKp, new PublicKey(playerPubkey));
                console.log(`➡️ Unjoined player ${playerPubkey.slice(0, 8)}... from ${gameType}`);
              } else {
                console.error(`No public key found for player ${telegramId}`);
                allPlayersUnjoined = false;
              }
            } catch (error) {
              console.error(`Failed to unjoin player ${telegramId}:`, error);
              allPlayersUnjoined = false;
              // Continue with other players but mark as failed
            }
          }

          // Only proceed if all players were successfully unjoined
          if (!allPlayersUnjoined) {
            console.log(`❌ Could not unjoin all players from ${gameType} ${gamePda.toBase58()}, skipping cancellation`);
            return { success: false, error: `Could not unjoin all players from ${gameType} game` };
          }
        }
      }

      // Now cancel the game using creator's key
      const creatorPubkey = gameAccount.creator.toBase58();
      const creatorTelegramId = this.gameDb.getPlayerTelegramId(creatorPubkey);

      if (!creatorTelegramId) {
        console.log(`No telegram ID found for creator ${creatorPubkey}, cannot cancel game`);
        return { success: false, error: "Creator not found in database" };
      }

      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const cancelInstruction = await this.program.methods
        .cancelGame()
        .accounts({
          game: gamePda,
          creator: gameAccount.creator,
        })
        .instruction();

      const tx = await this.wallet.sendTransaction([cancelInstruction], [creatorKp]);
      await this.wallet.confirmTransaction(tx);
      console.log(`Successfully cancelled ${gameType} game ${gamePda.toBase58()} with tx: ${tx}`);

      return { success: true, tx };
    } catch (error: any) {
      console.error(`Error cancelling ${gameType} game with player keys ${gamePda.toBase58()}:`, error);
      return { success: false, error: error.message };
    }
  }

  private async unjoinPlayerFromGame(gamePda: PublicKey, playerKp: any, playerPubkey: PublicKey): Promise<void> {
    const unjoinInstruction = await this.program.methods
      .unjoinGame()
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
      recentGames: recentGamesSections
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
    const bufferTime = 300; // 5 minutes buffer
    return currentTime > (expiresAt + bufferTime);
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
      console.log(`🎁 Cancelling expired ${gameType} ${address} with creator key`);
      const creatorKp = this.wallet.getKeyPair(BigInt(creatorTelegramId));

      const cancelInstruction = await this.program.methods
        .cancelGame()
        .accounts({
          game: gamePda,
          creator: gameAccount.creator,
        })
        .instruction();

      const tx = await this.wallet.sendTransaction([cancelInstruction], [creatorKp]);
      await this.wallet.confirmTransaction(tx);
      console.log(`✅ Successfully cancelled expired ${gameType} ${address}`);
      return true;
    } catch (error: any) {
      console.error(`❌ Failed to cancel expired ${gameType} ${address}:`, error.message);
      return false;
    }
  }
}
