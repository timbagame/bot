import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { randomBytes, createHash } from 'crypto';
import { WalletManager } from "./wallet";
import { GameDatabase } from "./database";
import { PDAManager } from "./pda";
import { MAX_RETRIES } from "./constants";
import type { Coinflip } from "../../idl/idlType";
import type { OracleResult, AuthorizationResult } from "../types";

// ================================
// UTILITY FUNCTIONS
// ================================

const calculateWinnerIndex = (secretKeyBuffer: Buffer, nPlayers: number): number => {
  if (nPlayers <= 1) return 0;

  const randomBytes = secretKeyBuffer.subarray(0, 8);
  const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
  const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
  const finalNumber = randomNumber % maxValid;
  return Number(finalNumber % BigInt(nPlayers));
};

const retryOperation = async <T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  delay: number = 1000
): Promise<T> => {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (i < maxRetries - 1) {
        const backoffDelay = delay * Math.pow(1.5, i);
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }
  }
  throw lastError;
};

// ================================
// ORACLE MANAGER CLASS
// ================================

export class OracleManager {
  private static instance: OracleManager;

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

  // ================================
  // GAME SECRETS GENERATION
  // ================================

  public generateGameSecrets(): { randomHash: Buffer } {
    const secretKey = randomBytes(64);
    const randomHash = createHash('sha256').update(secretKey).digest();
    const gamePda = PDAManager.getGamePDA(randomHash, this.program.programId);

    this.gameDb.saveOracleSecretKey(
      gamePda.toBase58(),
      secretKey.toString('hex')
    );

    return { randomHash };
  }

  // ================================
  // GAME COMPLETION
  // ================================

  public async completeGame(gamePda: PublicKey): Promise<OracleResult> {
    try {
      const adminKp = this.wallet.getAdminKeypair();
      const oraclePda = PDAManager.getOraclePDA(this.program.programId);

      // Fetch oracle and game accounts
      const [oracleAccount, gameAccount] = await Promise.all([
        this.program.account.oracle.fetch(oraclePda),
        this.program.account.game.fetch(gamePda)
      ]);

      // Verify oracle authority
      if (!oracleAccount.authority.equals(adminKp.publicKey)) {
        throw new Error("Unauthorized: Admin is not the oracle authority");
      }

      // Get secret key and calculate winner
      const secretKey = this.gameDb.getOracleSecretKey(gamePda.toBase58());
      if (!secretKey) {
        console.log(`No secret key found for game ${gamePda.toBase58()}, attempting oracle cancellation instead`);
        return await this.cancelGameWithAuthority(gamePda);
      }

      const secretKeyBuffer = Buffer.from(secretKey, "hex");
      const winnerIndex = calculateWinnerIndex(secretKeyBuffer, gameAccount.players.length);
      const winnerAddress = gameAccount.players[winnerIndex];

      // Execute completion transaction with retry
      const tx = await retryOperation(async () => {
        return await this.program.methods
          .completeGame([...secretKeyBuffer])
          .accounts({
            game: gamePda,
            player: winnerAddress,
            creator: gameAccount.creator,
            authority: adminKp.publicKey,
          })
          .signers([adminKp])
          .rpc();
      });

      await this.wallet.confirmTransaction(tx);

      // Return success with basic event info
      return {
        success: true,
        event: {
          gameKey: gamePda,
          creator: gameAccount.creator,
          winner: winnerAddress,
          gameType: gameAccount.gameType,
          amount: gameAccount.amount,
          players: gameAccount.players,
          tokenMint: gameAccount.tokenMint,
          winnerAmount: new anchor.BN(0), // Event data not available here
          feeAmount: new anchor.BN(0) // Event data not available here
        }
      };
    } catch (error) {
      console.error(`Error completing game ${gamePda.toBase58()}:`, error);
      return { success: false, error };
    }
  }

  public async cancelGameWithAuthority(gamePda: PublicKey): Promise<OracleResult> {
    try {
      const adminKp = this.wallet.getAdminKeypair();
      const oraclePda = PDAManager.getOraclePDA(this.program.programId);

      // Fetch oracle and game accounts
      const [oracleAccount, gameAccount] = await Promise.all([
        this.program.account.oracle.fetch(oraclePda),
        this.program.account.game.fetch(gamePda)
      ]);

      // Verify oracle authority
      if (!oracleAccount.authority.equals(adminKp.publicKey)) {
        throw new Error("Unauthorized: Admin is not the oracle authority");
      }

      console.log(`Cancelling orphaned game ${gamePda.toBase58()} using oracle authority`);

      // Execute cancellation transaction with retry
      const tx = await retryOperation(async () => {
        return await this.program.methods
          .cancelGame()
          .accounts({
            game: gamePda,
            creator: gameAccount.creator,
            authority: adminKp.publicKey,
          })
          .signers([adminKp])
          .rpc();
      });

      await this.wallet.confirmTransaction(tx);

      console.log(`Successfully cancelled orphaned game ${gamePda.toBase58()} with tx: ${tx}`);

      // Return success with cancellation event info
      return {
        success: true,
        event: {
          gameKey: gamePda,
          creator: gameAccount.creator,
          winner: new PublicKey("11111111111111111111111111111111"), // Use null address for cancelled games
          gameType: gameAccount.gameType,
          amount: gameAccount.amount,
          players: gameAccount.players,
          tokenMint: gameAccount.tokenMint,
          winnerAmount: new anchor.BN(0),
          feeAmount: new anchor.BN(0)
        }
      };
    } catch (error) {
      console.error(`Error cancelling game with authority ${gamePda.toBase58()}:`, error);
      return { success: false, error };
    }
  }

  // ================================
  // GAME STATUS CHECKS
  // ================================

  public async isGameReadyForOracle(gamePda: PublicKey): Promise<boolean> {
    try {
      const [gameAccount, blockTime] = await Promise.all([
        this.program.account.game.fetch(gamePda),
        this.wallet.getBlockchainTime()
      ]);

      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const isExpired = blockTime > expiresAt;

      return gameAccount.players.length >= gameAccount.maxPlayers ||
        (isExpired && gameAccount.players.length >= gameAccount.minPlayers);
    } catch (error) {
      console.error(`Error checking game status:`, error);
      return false;
    }
  }

  // ================================
  // PRIVATE GAME AUTHORIZATION
  // ================================

  public async authorizePlayer(gamePda: PublicKey, chatId: number): Promise<AuthorizationResult> {
    try {
      const game = this.gameDb.getGame(gamePda.toBase58());
      if (!game) {
        return { authorized: false, error: "Game not found in database" };
      }

      if (!game.chat_id || game.chat_id !== chatId) {
        return { authorized: false, error: "Player not in same chat as game creator" };
      }

      const adminKp = this.wallet.getAdminKeypair();
      return { authorized: true, adminKeypair: adminKp };
    } catch (error) {
      console.error(`Error authorizing player:`, error);
      return { authorized: false, error: (error as Error).message };
    }
  }
}
