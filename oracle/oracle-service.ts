import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { randomBytes, createHash } from 'crypto';
import { OracleDatabase } from "./database.ts";
import type { Coinflip } from "./idl/idlType.ts";
import idl from "./idl/idl.json" with { type: "json" };
import * as fs from "fs";
import * as path from "path";

// Types for better error handling
interface GameCompletionResult {
  success: boolean;
  error?: string;
  txHash?: string;
  retryable?: boolean;
}

interface ScanResult {
  totalAccounts: number;
  validGameAccounts: number;
  readyGames: number;
  completedGames: number;
  errors: number;
  retryableErrors: number;
}

/**
 * Oracle Service for generating secrets and completing games
 */
export class OracleService {
  private static instance: OracleService;
  private program: anchor.Program<Coinflip>;
  private connection: Connection;
  private adminKeypair: Keypair;
  private db: OracleDatabase;
  private isScanning: boolean = false;
  private lastScanTime: number = 0;
  private scanCooldown: number = 30000; // 30 seconds
  private retryDelay: number = 5000; // 5 seconds

  private constructor() {
    this.db = OracleDatabase.getInstance();
    this.connection = new Connection(process.env["SOLANA_NETWORK"]!, "confirmed");
    this.adminKeypair = this.loadAdminKeypair();
    this.program = this.initializeProgram();
  }

  public static getInstance(): OracleService {
    if (!OracleService.instance) {
      OracleService.instance = new OracleService();
    }
    return OracleService.instance;
  }

  private loadAdminKeypair(): Keypair {
    try {
      const keypairPath = path.join(process.cwd(), "admin-keypair.json");
      if (!fs.existsSync(keypairPath)) {
        throw new Error("Admin keypair file not found at " + keypairPath);
      }

      const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
      const keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
      console.log(`Loaded admin keypair: ${keypair.publicKey.toBase58()}`);
      return keypair;
    } catch (error) {
      console.error("Failed to load admin keypair:", error);
      throw error;
    }
  }

  private initializeProgram(): anchor.Program<Coinflip> {
    const adminWallet = new anchor.Wallet(this.adminKeypair);
    const provider = new anchor.AnchorProvider(this.connection, adminWallet, { commitment: "confirmed" });
    anchor.setProvider(provider);
    return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
  }

  /**
   * Generate a random hash and secret key for a new game
   */
  public generateGameSecrets(): { randomHash: string; gameAddress: string } {
    const secretKey = randomBytes(64);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = this.getGamePDA(randomHash);

    // Save secret key to database and track game
    this.db.saveSecretKey(
      gamePda.toBase58(),
      secretKey.toString('hex'),
      randomHash.toString('hex')
    );
    this.db.trackGame(gamePda.toBase58());

    console.log(`Generated secrets for game: ${gamePda.toBase58()}`);
    return {
      randomHash: randomHash.toString('hex'),
      gameAddress: gamePda.toBase58()
    };
  }

  /**
   * Check if a game is ready for completion with better error handling
   */
  public async isGameReadyForCompletion(gamePda: PublicKey): Promise<boolean> {
    try {
      const [gameAccount, blockTime] = await Promise.all([
        this.program.account.game.fetch(gamePda),
        this.getBlockchainTime()
      ]);

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const isExpired = blockTime > expiresAt;

      // Game is ready if it's full or expired with enough players
      return gameAccount.players.length >= gameAccount.maxPlayers ||
        (isExpired && gameAccount.players.length >= gameAccount.minPlayers);
    } catch (error: any) {
      console.error(`Error checking game readiness for ${gamePda.toBase58()}:`, error.message);

      // Check if it's an account not found error
      if (error.message?.includes('Account does not exist')) {
        console.log(`✅ Game ${gamePda.toBase58()} account confirmed not to exist (completed or closed)`);
        this.db.markGameCompleted(gamePda.toBase58());
        return false;
      }

      // For other errors (invalid data, deserialization issues), check if account exists
      try {
        const accountInfo = await this.connection.getAccountInfo(gamePda);
        if (!accountInfo) {
          console.log(`✅ Game ${gamePda.toBase58()} account confirmed not to exist (completed or closed)`);
          this.db.markGameCompleted(gamePda.toBase58());
          return false;
        } else {
          // Account exists but we can't deserialize it as a game - likely invalid/corrupted
          console.log(`⚠️ Game ${gamePda.toBase58()} account exists but contains invalid game data - marking as completed`);
          console.log(`   Account owner: ${accountInfo.owner.toBase58()}, data length: ${accountInfo.data.length}`);
          this.db.markGameCompleted(gamePda.toBase58());
          return false;
        }
      } catch (checkError: any) {
        console.error(`❌ Unable to verify game ${gamePda.toBase58()} account existence:`, checkError.message);
        // For network/RPC errors, don't assume game is gone - throw error to retry later
        throw error;
      }
    }
  }

  /**
   * Complete a game with retry mechanism
   */
  public async completeGame(gameAddress: string, retryCount: number = 0): Promise<GameCompletionResult> {
    try {
      const gamePda = new PublicKey(gameAddress);

      // Get secret key from database
      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        return { success: false, error: "No secret key found for game", retryable: false };
      }

      // Check if game is ready
      const isReady = await this.isGameReadyForCompletion(gamePda);
      if (!isReady) {
        return { success: false, error: "Game is not ready for completion", retryable: true };
      }

      // Get game account
      const gameAccount = await this.program.account.game.fetch(gamePda);

      // Calculate winner
      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const winnerIndex = this.calculateWinnerIndex(secretKeyBuffer, gameAccount.players.length);
      const winnerAddress = gameAccount.players[winnerIndex];

      if (!winnerAddress) {
        return { success: false, error: "Unable to determine winner - no players found", retryable: false };
      }

      // Verify oracle authority
      const oraclePda = this.getOraclePDA();
      const oracleAccount = await this.program.account.oracle.fetch(oraclePda);

      if (!oracleAccount.authority.equals(this.adminKeypair.publicKey)) {
        return { success: false, error: "Unauthorized: Admin is not the oracle authority", retryable: false };
      }

      console.log(`Completing game ${gameAddress}, winner: ${winnerAddress.toBase58()}`);

      // Execute completion transaction with timeout
      const tx = await Promise.race([
        this.program.methods
          .completeGame([...secretKeyBuffer])
          .accounts({
            game: gamePda,
            player: winnerAddress,
            creator: gameAccount.creator,
            authority: this.adminKeypair.publicKey,
          })
          .signers([this.adminKeypair])
          .rpc(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Transaction timeout")), 60000)
        )
      ]);

      await this.confirmTransaction(tx);

      // Mark secret key as used and game as completed
      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);

      console.log(`✅ Successfully completed game ${gameAddress}, tx: ${tx}`);
      return { success: true, txHash: tx };

    } catch (error: any) {
      console.error(`❌ Error completing game ${gameAddress} (attempt ${retryCount + 1}):`, error);

      // Determine if error is retryable
      const retryable = this.isRetryableError(error);

      // Update database with error
      this.db.updateGameStatus(gameAddress, retryable ? 'error_retryable' : 'error', error.message);
      this.db.incrementCompletionAttempts(gameAddress);

      // Immediate retry logic (within this call) - only for quick retryable errors
      // The broader retry logic is handled by the cooldown system
      const immediateRetryLimit = 2; // Only 2 immediate retries per call
      if (retryable && retryCount < immediateRetryLimit && this.isImmediateRetryableError(error)) {
        console.log(`🔄 Immediate retry for game ${gameAddress} in ${this.retryDelay}ms (quick retry ${retryCount + 1}/${immediateRetryLimit})`);
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
        return this.completeGame(gameAddress, retryCount + 1);
      }

      return { success: false, error: error.message, retryable };
    }
  }

  /**
   * Improved blockchain scanning with better performance and error handling
   */
  public async scanAndCompleteActiveGames(): Promise<ScanResult> {
    if (this.isScanning) {
      console.log('⏳ Scan already in progress, skipping...');
      return { totalAccounts: 0, validGameAccounts: 0, readyGames: 0, completedGames: 0, errors: 0, retryableErrors: 0 };
    }

    const now = Date.now();
    if (now - this.lastScanTime < this.scanCooldown) {
      const remaining = this.scanCooldown - (now - this.lastScanTime);
      console.log(`⏰ Scan cooldown active, ${Math.ceil(remaining / 1000)}s remaining`);
      return { totalAccounts: 0, validGameAccounts: 0, readyGames: 0, completedGames: 0, errors: 0, retryableErrors: 0 };
    }

    this.isScanning = true;
    this.lastScanTime = now;

    try {
      console.log('🔍 Scanning blockchain for active games...');

      const result: ScanResult = {
        totalAccounts: 0,
        validGameAccounts: 0,
        readyGames: 0,
        completedGames: 0,
        errors: 0,
        retryableErrors: 0
      };

      // First, check pending games from database for quick retry
      const pendingGames = this.db.getPendingGames();
      console.log(`📋 Found ${pendingGames.length} pending games in database`);

      for (const pendingGame of pendingGames) {
        try {
          // Smart retry logic: use cooldown periods instead of permanent skipping
          const shouldSkip = this.shouldSkipGameForCooldown(pendingGame);
          if (shouldSkip.skip) {
            console.log(`⏭️ Skipping game ${pendingGame.game_address} (${shouldSkip.reason})`);
            continue;
          }

          // Reset retry count if it's been a long time since the last attempt
          if (shouldSkip.resetRetries) {
            console.log(`🔄 Resetting retry count for game ${pendingGame.game_address} (long cooldown period)`);
            this.db.resetCompletionAttempts(pendingGame.game_address);
          }

          const gamePda = new PublicKey(pendingGame.game_address);
          let isReady: boolean;
          let gameWasCompleted = false;

          try {
            isReady = await this.isGameReadyForCompletion(gamePda);
          } catch (checkError: any) {
            // If we can't check the game due to RPC/network issues, skip for this round
            console.warn(`⚠️ Unable to check game ${pendingGame.game_address} readiness: ${checkError.message}`);
            console.log(`🔄 Will retry checking this game in the next scan cycle`);
            continue;
          }

          // Check if the game was marked as completed during the readiness check
          // (this happens when the game account no longer exists)
          const currentDbStatus = await this.getGameDbStatus(pendingGame.game_address);
          if (currentDbStatus?.status === 'completed') {
            console.log(`✅ Game ${pendingGame.game_address} was marked as completed (no longer exists on-chain)`);
            result.completedGames++;
            gameWasCompleted = true;
          }

          if (isReady && !gameWasCompleted) {
            result.readyGames++;
            const completionResult = await this.completeGame(pendingGame.game_address);

            if (completionResult.success) {
              result.completedGames++;
            } else {
              result.errors++;
              if (completionResult.retryable) {
                result.retryableErrors++;
              }
            }
          }

          // Rate limiting between operations
          await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (error: any) {
          result.errors++;
          console.error(`Error processing pending game ${pendingGame.game_address}:`, error);
        }
      }

      // Then scan blockchain for new games (less frequently)
      if (pendingGames.length === 0 || now % (5 * 60 * 1000) < this.scanCooldown) {
        await this.scanBlockchainForNewGames(result);
      }

      console.log(`📊 Scan complete:`, result);
      return result;

    } catch (error: any) {
      console.error('❌ Error in scan process:', error);
      return { totalAccounts: 0, validGameAccounts: 0, readyGames: 0, completedGames: 0, errors: 1, retryableErrors: 0 };
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * Smart cooldown logic for failed games
   */
  private shouldSkipGameForCooldown(pendingGame: {
    game_address: string;
    last_checked: number;
    completion_attempts: number;
    first_seen: number;
  }): { skip: boolean; reason?: string; resetRetries?: boolean } {
    const now = Date.now();
    const timeSinceLastAttempt = now - pendingGame.last_checked;
    const timeSinceFirstSeen = now - pendingGame.first_seen;

    // If it's been more than 24 hours since first seen, reset retry count
    // The game conditions might have changed significantly
    if (timeSinceFirstSeen > 24 * 60 * 60 * 1000) {
      return { skip: false, resetRetries: true };
    }

    // If no previous attempts, always try
    if (pendingGame.completion_attempts === 0) {
      return { skip: false };
    }

    // Progressive cooldown based on attempt count
    let cooldownMinutes: number;
    if (pendingGame.completion_attempts <= 3) {
      cooldownMinutes = 5; // 5 minutes for first few attempts
    } else if (pendingGame.completion_attempts <= 6) {
      cooldownMinutes = 30; // 30 minutes for medium attempts
    } else if (pendingGame.completion_attempts <= 10) {
      cooldownMinutes = 120; // 2 hours for many attempts
    } else {
      cooldownMinutes = 360; // 6 hours for excessive attempts
    }

    const cooldownMs = cooldownMinutes * 60 * 1000;

    if (timeSinceLastAttempt < cooldownMs) {
      const remainingMinutes = Math.ceil((cooldownMs - timeSinceLastAttempt) / (60 * 1000));
      return {
        skip: true,
        reason: `cooldown active, ${remainingMinutes}m remaining (attempt ${pendingGame.completion_attempts})`
      };
    }

    return { skip: false };
  }

  /**
   * Scan blockchain for new games with improved filtering
   */
  private async scanBlockchainForNewGames(result: ScanResult): Promise<void> {
    try {
      // Get program accounts with better filtering
      const programAccounts = await this.connection.getProgramAccounts(this.program.programId, {
        filters: [
          {
            // Filter by account size (approximate game account size)
            dataSize: 8 + 32 + 8 + 4 + 4 + 8 + 8 + 32 + (32 * 10) + 1 // Approximate game account structure
          }
        ]
      });

      result.totalAccounts = programAccounts.length;
      console.log(`Found ${programAccounts.length} potential game accounts`);

      // Game account discriminator
      const gameDiscriminator = [27, 90, 166, 125, 74, 100, 121, 18];

      for (const accountInfo of programAccounts) {
        try {
          // Validate discriminator
          if (accountInfo.account.data.length < 8) continue;

          const accountDiscriminator = Array.from(accountInfo.account.data.slice(0, 8));
          const isGameAccount = accountDiscriminator.every((byte, index) => byte === gameDiscriminator[index]);

          if (!isGameAccount) continue;

          // Safely try to deserialize
          const gameAccount = await this.safelyFetchGameAccount(accountInfo.pubkey);
          if (!gameAccount) continue;

          result.validGameAccounts++;

          const gameAddress = accountInfo.pubkey.toBase58();

          // Check if we have the secret key for this game
          const secretData = this.db.getSecretKey(gameAddress);
          if (!secretData) {
            // Track unknown games for debugging
            console.log(`🔍 Found game not created by our oracle: ${gameAddress}`);
            continue;
          }

          // Check if game is ready for completion
          const isReady = await this.isGameReadyForCompletion(accountInfo.pubkey);
          if (!isReady) continue;

          result.readyGames++;
          console.log(`🎯 Game ${gameAddress} is ready for completion`);

          // Complete the game
          const completionResult = await this.completeGame(gameAddress);
          if (completionResult.success) {
            result.completedGames++;
          } else {
            result.errors++;
            if (completionResult.retryable) {
              result.retryableErrors++;
            }
          }

          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error: any) {
          result.errors++;
          console.warn(`⚠️ Error processing account ${accountInfo.pubkey.toBase58()}:`, error.message);
        }
      }
    } catch (error: any) {
      console.error('❌ Error scanning blockchain:', error);
      throw error;
    }
  }

  /**
   * Safely fetch game account with better error handling
   */
  private async safelyFetchGameAccount(pubkey: PublicKey): Promise<any | null> {
    try {
      return await this.program.account.game.fetch(pubkey);
    } catch (error: any) {
      if (error.message?.includes('Account does not exist')) {
        return null;
      }
      if (error.message?.includes('offset') && error.message?.includes('out of range')) {
        console.warn(`⚠️ Invalid game account data structure: ${pubkey.toBase58()}`);
        return null;
      }
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Determine if an error is retryable
   */
  private isRetryableError(error: any): boolean {
    const retryableErrors = [
      'Transaction timeout',
      'Network error',
      'RPC error',
      'Connection timeout',
      'blockhash not found',
      'block height exceeded'
    ];

    const errorMessage = error.message?.toLowerCase() || '';
    return retryableErrors.some(retryableError =>
      errorMessage.includes(retryableError.toLowerCase())
    );
  }

  /**
   * Determine if an error should be retried immediately (vs waiting for cooldown)
   */
  private isImmediateRetryableError(error: any): boolean {
    const immediateRetryErrors = [
      'Transaction timeout',
      'Network error',
      'Connection timeout',
      'blockhash not found'
    ];

    const errorMessage = error.message?.toLowerCase() || '';
    return immediateRetryErrors.some(retryableError =>
      errorMessage.includes(retryableError.toLowerCase())
    );
  }

  /**
   * Get Oracle PDA
   */
  private getOraclePDA(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle", 'utf8')],
      this.program.programId
    );
    return pda;
  }

  /**
   * Get Game PDA from random hash
   */
  private getGamePDA(randomHash: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game", 'utf8'), randomHash],
      this.program.programId
    );
    return pda;
  }

  /**
   * Calculate winner index from secret key
   */
  private calculateWinnerIndex(secretKeyBuffer: Buffer, nPlayers: number): number {
    if (nPlayers <= 1) return 0;

    const randomBytes = secretKeyBuffer.subarray(0, 8);
    const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
    const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
    const finalNumber = randomNumber % maxValid;
    return Number(finalNumber % BigInt(nPlayers));
  }

  /**
   * Get blockchain time
   */
  private async getBlockchainTime(): Promise<number> {
    try {
      const slot = await this.connection.getSlot();
      const blockTime = await this.connection.getBlockTime(slot);
      if (!blockTime) {
        throw new Error("Could not get blockchain time");
      }
      return blockTime;
    } catch (error) {
      console.warn("Falling back to system time:", error);
      return Math.floor(Date.now() / 1000);
    }
  }

  /**
   * Confirm transaction
   */
  private async confirmTransaction(signature: string): Promise<void> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash();

    await Promise.race([
      this.connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Transaction confirmation timeout")), 30000)
      )
    ]);
  }

  /**
   * Get service statistics
   */
  public getStats() {
    return this.db.getStats();
  }

  /**
   * Get detailed information about a specific game (for debugging)
   */
  public async debugGameStatus(gameAddress: string): Promise<{
    exists: boolean;
    accountInfo?: any;
    gameData?: any;
    secretExists: boolean;
    dbStatus?: any;
    error?: string;
  }> {
    try {
      const gamePda = new PublicKey(gameAddress);

      // Check if account exists at all
      const accountInfo = await this.connection.getAccountInfo(gamePda);

      if (!accountInfo) {
        return {
          exists: false,
          secretExists: !!this.db.getSecretKey(gameAddress),
          dbStatus: await this.getGameDbStatus(gameAddress)
        };
      }

      // Try to fetch game data
      let gameData = null;
      try {
        gameData = await this.program.account.game.fetch(gamePda);
      } catch (fetchError: any) {
        return {
          exists: true,
          accountInfo: {
            lamports: accountInfo.lamports,
            owner: accountInfo.owner.toBase58(),
            dataLength: accountInfo.data.length
          },
          secretExists: !!this.db.getSecretKey(gameAddress),
          dbStatus: await this.getGameDbStatus(gameAddress),
          error: `Failed to deserialize game data: ${fetchError.message}`
        };
      }

      return {
        exists: true,
        accountInfo: {
          lamports: accountInfo.lamports,
          owner: accountInfo.owner.toBase58(),
          dataLength: accountInfo.data.length
        },
        gameData: {
          players: gameData.players.length,
          maxPlayers: gameData.maxPlayers,
          minPlayers: gameData.minPlayers,
          createdAt: Number(gameData.createdAt),
          timeout: Number(gameData.timeout),
          creator: gameData.creator.toBase58()
        },
        secretExists: !!this.db.getSecretKey(gameAddress),
        dbStatus: await this.getGameDbStatus(gameAddress)
      };

    } catch (error: any) {
      return {
        exists: false,
        secretExists: !!this.db.getSecretKey(gameAddress),
        dbStatus: await this.getGameDbStatus(gameAddress),
        error: error.message
      };
    }
  }

  private async getGameDbStatus(gameAddress: string): Promise<any> {
    try {
      const stmt = this.db['db'].prepare(
        'SELECT * FROM game_tracking WHERE game_address = ?'
      );
      return stmt.get(gameAddress);
    } catch (error) {
      return null;
    }
  }
}
