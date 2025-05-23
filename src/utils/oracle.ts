import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';
import { WalletManager } from "./wallet";
import { GameDatabase } from "./database";
import type { Coinflip } from "../../idl/idlType";

// ================================
// HELPER FUNCTIONS
// ================================

// Helper function to calculate winner index using the same algorithm as the contract
const calculateWinnerIndex = (secretKeyBuffer: Buffer, nPlayers: number): number => {
  if (nPlayers <= 1) return 0;

  const randomBytes = secretKeyBuffer.subarray(0, 8);
  const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
  const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
  const finalNumber = randomNumber % maxValid;
  return Number(finalNumber % BigInt(nPlayers));
};

// Helper function to generate random hash from secret key
const generateRandomHash = (secretKey: Buffer): Buffer => {
  return createHash('sha256').update(secretKey).digest();
};

// ================================
// ORACLE MANAGER CLASS
// ================================

export class OracleManager {
  private static instance: OracleManager;
  private pdaCache: Map<string, PublicKey> = new Map();

  private readonly PDA_SEEDS = {
    ORACLE: Buffer.from("oracle"),
    GAME: Buffer.from("game")
  };

  private constructor(
    private program: anchor.Program<Coinflip>,
    private wallet: WalletManager,
    private gameDb: GameDatabase
  ) {}

  public static getInstance(
    program: anchor.Program<Coinflip>,
    wallet: WalletManager
  ): OracleManager {
    if (!OracleManager.instance) {
      const gameDb = GameDatabase.getInstance();
      OracleManager.instance = new OracleManager(program, wallet, gameDb);
    }
    return OracleManager.instance;
  }

  // Cached PDA generation
  private getPda(seeds: Buffer[], programId: PublicKey): PublicKey {
    const key = seeds.map(s => s.toString('hex')).join('_') + programId.toBase58();
    if (!this.pdaCache.has(key)) {
      const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
      this.pdaCache.set(key, pda);
    }
    return this.pdaCache.get(key)!;
  }

  // Helper function to get oracle PDA
  private getOraclePda(): PublicKey {
    return this.getPda([this.PDA_SEEDS.ORACLE], this.program.programId);
  }

  // Helper function to get game PDA
  private getGamePda(randomHash: Buffer): PublicKey {
    return this.getPda([this.PDA_SEEDS.GAME, randomHash], this.program.programId);
  }

  // Generate secret key and random hash for a new game
  public generateGameSecrets(): { randomHash: Buffer } {
    const secretKey = randomBytes(64);
    const randomHash = generateRandomHash(secretKey);

    // Store the secret key in the database (synchronous)
    this.gameDb.saveOracleSecretKey(
      this.getGamePda(randomHash).toBase58(),
      secretKey.toString('hex')
    );

    return { randomHash };
  }

  // Helper function to retry an operation with improved error handling
  private async retryOperation<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    delay: number = 1000
  ): Promise<T> {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (i < maxRetries - 1) {
          const backoffDelay = delay * Math.pow(1.5, i); // More conservative backoff
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
      }
    }
    throw lastError;
  }

  // Complete a game using the oracle
  public async completeGame(
    gamePda: PublicKey
  ): Promise<{ success: boolean; winnerAddress?: string; error?: any }> {
    try {
      const adminKp = this.wallet.getAdminKeypair(); // Now synchronous
      const oraclePda = this.getOraclePda();

      // Batch fetch oracle and game account info
      const [oracleAccount, gameAccount] = await Promise.all([
        this.program.account.oracle.fetch(oraclePda),
        this.program.account.game.fetch(gamePda)
      ]);

      // Verify authority
      if (!oracleAccount.authority.equals(adminKp.publicKey)) {
        throw new Error("Unauthorized: Admin is not the oracle authority");
      }

      // Get the secret key from the database (synchronous)
      const secretKey = this.gameDb.getOracleSecretKey(gamePda.toBase58());
      if (!secretKey) {
        throw new Error("Secret key not found");
      }

      const secretKeyBuffer = Buffer.from(secretKey, "hex");
      const winnerIndex = calculateWinnerIndex(secretKeyBuffer, gameAccount.players.length);
      const winnerAddress = gameAccount.players[winnerIndex];

      // Send transaction with retry logic
      const tx = await this.retryOperation(async () => {
        return await this.program.methods
          .completeGame([...secretKeyBuffer])
          .accounts({
            game: gamePda,
            player: winnerAddress,
            authority: adminKp.publicKey,
          })
          .signers([adminKp])
          .rpc();
      });

      // Wait for transaction confirmation
      await this.wallet.confirmTransaction(tx);

      // Verify completion and get winner
      const completedGameAccount = await this.program.account.game.fetch(gamePda);
      const winnerPubkeyStr = completedGameAccount.winner.toString();

      return { success: true, winnerAddress: winnerPubkeyStr };
    } catch (error) {
      console.error(`Error completing game ${gamePda.toBase58()}:`, error);
      return { success: false, error };
    }
  }

  // Check if a game is ready to be completed by the oracle
  public async isGameReadyForOracle(gamePda: PublicKey): Promise<boolean> {
    try {
      // Fetch game account and blockchain time concurrently
      const [gameAccount, blockTime] = await Promise.all([
        this.program.account.game.fetch(gamePda),
        this.wallet.getBlockchainTime()
      ]);

      const status = Object.keys(gameAccount.status)[0].toLowerCase();
      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const isExpired = blockTime > expiresAt;

      // Game is ready if:
      // 1. It's active AND has max players, OR
      // 2. It's expired AND has minimum players
      return status === 'active' && (
        gameAccount.players.length >= gameAccount.maxPlayers ||
        (isExpired && gameAccount.players.length >= gameAccount.minPlayers)
      );
    } catch (error) {
      console.error(`Error checking game status:`, error);
      return false;
    }
  }
}
