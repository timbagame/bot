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

const calculateWinnerIndex = (secretKeyBuffer: Buffer, nPlayers: number): number => {
  if (nPlayers <= 1) return 0;

  const randomBytes = secretKeyBuffer.subarray(0, 8);
  const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
  const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
  const finalNumber = randomNumber % maxValid;
  return Number(finalNumber % BigInt(nPlayers));
};

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

  private getPda(seeds: Buffer[], programId: PublicKey): PublicKey {
    const key = seeds.map(s => s.toString('hex')).join('_') + programId.toBase58();
    if (!this.pdaCache.has(key)) {
      const [pda] = PublicKey.findProgramAddressSync(seeds, programId);
      this.pdaCache.set(key, pda);
    }
    return this.pdaCache.get(key)!;
  }

  private getOraclePda(): PublicKey {
    return this.getPda([this.PDA_SEEDS.ORACLE], this.program.programId);
  }

  private getGamePda(randomHash: Buffer): PublicKey {
    return this.getPda([this.PDA_SEEDS.GAME, randomHash], this.program.programId);
  }

  public generateGameSecrets(): { randomHash: Buffer } {
    const secretKey = randomBytes(64);
    const randomHash = generateRandomHash(secretKey);

    this.gameDb.saveOracleSecretKey(
      this.getGamePda(randomHash).toBase58(),
      secretKey.toString('hex')
    );

    return { randomHash };
  }

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
          const backoffDelay = delay * Math.pow(1.5, i);
          await new Promise(resolve => setTimeout(resolve, backoffDelay));
        }
      }
    }
    throw lastError;
  }

  public async completeGame(
    gamePda: PublicKey
  ): Promise<{ success: boolean; winnerAddress?: string; error?: any }> {
    try {
      const adminKp = this.wallet.getAdminKeypair();
      const oraclePda = this.getOraclePda();

      const [oracleAccount, gameAccount] = await Promise.all([
        this.program.account.oracle.fetch(oraclePda),
        this.program.account.game.fetch(gamePda)
      ]);

      if (!oracleAccount.authority.equals(adminKp.publicKey)) {
        throw new Error("Unauthorized: Admin is not the oracle authority");
      }

      const secretKey = this.gameDb.getOracleSecretKey(gamePda.toBase58());
      if (!secretKey) {
        throw new Error("Secret key not found");
      }

      const secretKeyBuffer = Buffer.from(secretKey, "hex");
      const winnerIndex = calculateWinnerIndex(secretKeyBuffer, gameAccount.players.length);
      const winnerAddress = gameAccount.players[winnerIndex];

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

      await this.wallet.confirmTransaction(tx);

      const completedGameAccount = await this.program.account.game.fetch(gamePda);
      const winnerPubkeyStr = completedGameAccount.winner.toString();

      return { success: true, winnerAddress: winnerPubkeyStr };
    } catch (error) {
      console.error(`Error completing game ${gamePda.toBase58()}:`, error);
      return { success: false, error };
    }
  }

  public async isGameReadyForOracle(gamePda: PublicKey): Promise<boolean> {
    try {
      const [gameAccount, blockTime] = await Promise.all([
        this.program.account.game.fetch(gamePda),
        this.wallet.getBlockchainTime()
      ]);

      const status = Object.keys(gameAccount.status)[0].toLowerCase();
      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      const isExpired = blockTime > expiresAt;

      return status === 'active' && (
        gameAccount.players.length >= gameAccount.maxPlayers ||
        (isExpired && gameAccount.players.length >= gameAccount.minPlayers)
      );
    } catch (error) {
      console.error(`Error checking game status:`, error);
      return false;
    }
  }

  /**
   * Authorizes a player to join a private game
   * Verifies that the player is in the same Telegram group as the creator
   */
  public async authorizePlayer(
    gamePda: PublicKey,
    chatId: number
  ): Promise<{ authorized: boolean; adminKeypair?: anchor.web3.Keypair; error?: string }> {
    try {
      // Get game information
      const game = this.gameDb.getGame(gamePda.toBase58());
      if (!game) {
        return { authorized: false, error: "Game not found in database" };
      }

      // Verify that the game has a chat_id and matches the current chat
      if (!game.chat_id) {
        return { authorized: false, error: "Game does not have a registered chat" };
      }

      if (game.chat_id !== chatId) {
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
