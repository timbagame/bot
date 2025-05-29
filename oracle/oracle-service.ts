import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { randomBytes, createHash } from 'crypto';
import { OracleDatabase } from "./database.ts";
import type { Coinflip } from "./idl/idlType.ts";
import idl from "./idl/idl.json" with { type: "json" };
import * as fs from "fs";
import * as path from "path";

/**
 * Oracle Service for generating secrets and completing games
 */
export class OracleService {
  private static instance: OracleService;
  private program: anchor.Program<Coinflip>;
  private connection: Connection;
  private adminKeypair: Keypair;
  private db: OracleDatabase;

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

    // Save secret key to database
    this.db.saveSecretKey(
      gamePda.toBase58(),
      secretKey.toString('hex'),
      randomHash.toString('hex')
    );

    console.log(`Generated secrets for game: ${gamePda.toBase58()}`);
    return {
      randomHash: randomHash.toString('hex'),
      gameAddress: gamePda.toBase58()
    };
  }

  /**
   * Start tracking a game for completion
   */
  public trackGame(gameAddress: string): void {
    this.db.trackGame(gameAddress);
    console.log(`Started tracking game: ${gameAddress}`);
  }

  /**
   * Check if a game is ready for completion
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
      if (error.message?.includes('Account does not exist')) {
        console.log(`Game ${gamePda.toBase58()} no longer exists (already completed)`);
        return false;
      }
      console.error(`Error checking game readiness:`, error);
      return false;
    }
  }

  /**
   * Complete a game using the oracle
   */
  public async completeGame(gameAddress: string): Promise<{ success: boolean; error?: string; txHash?: string }> {
    try {
      const gamePda = new PublicKey(gameAddress);

      // Get secret key from database
      const secretData = this.db.getSecretKey(gameAddress);
      if (!secretData) {
        return { success: false, error: "No secret key found for game" };
      }

      // Check if game is ready
      const isReady = await this.isGameReadyForCompletion(gamePda);
      if (!isReady) {
        return { success: false, error: "Game is not ready for completion" };
      }

      // Get game account
      const gameAccount = await this.program.account.game.fetch(gamePda);

      // Calculate winner
      const secretKeyBuffer = Buffer.from(secretData.secretKey, "hex");
      const winnerIndex = this.calculateWinnerIndex(secretKeyBuffer, gameAccount.players.length);
      const winnerAddress = gameAccount.players[winnerIndex];

      if (!winnerAddress) {
        return { success: false, error: "Unable to determine winner - no players found" };
      }

      // Verify oracle authority
      const oraclePda = this.getOraclePDA();
      const oracleAccount = await this.program.account.oracle.fetch(oraclePda);

      if (!oracleAccount.authority.equals(this.adminKeypair.publicKey)) {
        return { success: false, error: "Unauthorized: Admin is not the oracle authority" };
      }

      console.log(`Completing game ${gameAddress}, winner: ${winnerAddress.toBase58()}`);

      // Execute completion transaction
      const tx = await this.program.methods
        .completeGame([...secretKeyBuffer])
        .accounts({
          game: gamePda,
          player: winnerAddress,
          creator: gameAccount.creator,
          authority: this.adminKeypair.publicKey,
        })
        .signers([this.adminKeypair])
        .rpc();

      await this.confirmTransaction(tx);

      // Mark secret key as used and game as completed
      this.db.markSecretKeyUsed(gameAddress);
      this.db.markGameCompleted(gameAddress);

      console.log(`✅ Successfully completed game ${gameAddress}, tx: ${tx}`);
      return { success: true, txHash: tx };

    } catch (error: any) {
      console.error(`❌ Error completing game ${gameAddress}:`, error);
      this.db.updateGameStatus(gameAddress, 'error', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process all pending games
   */
  public async processPendingGames(): Promise<void> {
    const pendingGames = this.db.getPendingGames();
    console.log(`Processing ${pendingGames.length} pending games...`);

    for (const game of pendingGames) {
      try {
        // Skip games that have failed too many times
        if (game.completion_attempts >= 5) {
          console.log(`Skipping game ${game.game_address} - too many attempts (${game.completion_attempts})`);
          continue;
        }

        // Skip games checked recently (within last 30 seconds)
        const now = Date.now();
        if (now - game.last_checked < 30000) {
          continue;
        }

        // Validate game address before processing
        try {
          new PublicKey(game.game_address);
        } catch (error: any) {
          console.log(`❌ Invalid game address ${game.game_address}, marking as failed: ${error.message}`);
          this.db.updateGameStatus(game.game_address, 'error', `Invalid game address: ${error.message}`);
          continue;
        }

        console.log(`Checking game ${game.game_address}...`);
        this.db.incrementCompletionAttempts(game.game_address);

        const result = await this.completeGame(game.game_address);

        if (result.success) {
          console.log(`✅ Completed game ${game.game_address}`);
        } else {
          console.log(`⚠️ Could not complete game ${game.game_address}: ${result.error}`);
        }

        // Small delay between game completions
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`Error processing game ${game.game_address}:`, error);
      }
    }
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
}
