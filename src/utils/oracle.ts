import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { randomBytes } from 'crypto';
import { createHash } from 'crypto';
import { WalletManager } from "./wallet";
import { GameDatabase } from "./database";
import type { Coinflip } from "../../idl/idlType";

export class OracleManager {
  private static instance: OracleManager;
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

  // Helper function to get oracle PDA
  private getOraclePda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [this.PDA_SEEDS.ORACLE],
      this.program.programId
    );
    return pda;
  }

  // Helper function to get game PDA
  private getGamePda(randomHash: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [this.PDA_SEEDS.GAME, randomHash],
      this.program.programId
    );
    return pda;
  }

  // Generate secret key and random hash for a new game
  public generateGameSecrets(): { randomHash: Buffer } {
    const secretKey = randomBytes(64);
    const randomHash = createHash('sha256').update(secretKey).digest();

    // Store the secret key in the database
    this.gameDb.saveOracleSecretKey(
      this.getGamePda(randomHash).toBase58(),
      secretKey.toString('hex')
    );

    return { randomHash };
  }

  // Complete a game using the oracle
  public async completeGame(
    gamePda: PublicKey
  ): Promise<{ success: boolean; winnerAddress?: string; error?: any }> {
    try {
      const adminKp = await this.wallet.getAdminKeypair();
      const oraclePda = this.getOraclePda();

      // Verify if the admin is indeed the oracle authority
      const oracleAccount = await this.program.account.oracle.fetch(oraclePda);
      if (!oracleAccount.authority.equals(adminKp.publicKey)) {
        throw new Error("Unauthorized: Admin is not the oracle authority");
      }

      // Fetch the game account
      const gameAccount = await this.program.account.game.fetch(gamePda);

      // Get the secret key from the database
      const secretKey = await this.gameDb.getOracleSecretKey(gamePda.toBase58());
      if (!secretKey) {
        throw new Error("Secret key not found");
      }

      const secretKeyBuffer = Buffer.from(secretKey, "hex");

      // Calculate the winner using the same algorithm as the contract
      let winnerIndex = 0;
      const nPlayers = gameAccount.players.length;

      if (nPlayers > 1) {
        const randomBytes = secretKeyBuffer.subarray(0, 8);
        const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
        const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
        const finalNumber = randomNumber % maxValid;
        winnerIndex = Number(finalNumber % BigInt(nPlayers));
      }

      const winnerBalancePda = gameAccount.players[winnerIndex];

      // Get game token PDA
      const [gameTokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_token"), new PublicKey(process.env.TOKEN_MINT!).toBuffer()],
        this.program.programId
      );

      // Add retry logic for transaction
      let retries = 3;
      let tx: string | null = null;

      while (retries > 0 && !tx) {
        try {
          tx = await this.program.methods
            .completeGame([...secretKeyBuffer])
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

      // Get the completed game account to verify winner
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
      const gameAccount = await this.program.account.game.fetch(gamePda);
      const status = Object.keys(gameAccount.status)[0].toLowerCase();
      const blockTime = await this.wallet.getBlockchainTime();
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
