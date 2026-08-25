import { Transaction, type PublicKey } from "@solana/web3.js";
import type { AuthorizationResult, OracleStats } from "../types";
import { GameDatabase } from "./game-database";
import type { WalletManager } from "./wallet";
import { loadOracleApiToken } from "./secrets";
import { createRestClient, expectStatus } from "@timbagame/protocol/common";
import { oracleContract } from "@timbagame/protocol/oracle";

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

// ================================
// ORACLE API CLIENT
// ================================

export class OracleClient {
  private static instance: OracleClient;
  private gameDb: GameDatabase;
  private oracleApiUrl: string;
  private wallet?: WalletManager;

  private constructor() {
    this.gameDb = GameDatabase.getInstance();
    this.oracleApiUrl = process.env["ORACLE_API_URL"] || "http://localhost:3001";
  }

  public static getInstance(wallet?: WalletManager): OracleClient {
    if (!OracleClient.instance) {
      OracleClient.instance = new OracleClient();
    }
    if (wallet) {
      OracleClient.instance.wallet = wallet;
    }
    return OracleClient.instance;
  }

  // ================================
  // ORACLE API METHODS
  // ================================

  private apiClient() {
    return createRestClient(oracleContract, {
      baseUrl: this.oracleApiUrl,
      getHeaders: (endpoint) => {
        const apiToken = loadOracleApiToken();
        const headers: Record<string, string> = {};
        if (endpoint.authenticated && apiToken) {
          headers["Authorization"] = `Bearer ${apiToken}`;
        }
        return headers;
      },
    });
  }

  /**
   * Request a random hash from the oracle API for game creation
   */
  public async generateGameSecrets(): Promise<{ randomHash: string; oracleOperator: string }> {
    try {
      const data = expectStatus(await this.apiClient().generateHash({ body: {} }), 200).data;

      console.log(`✅ Generated random hash from oracle: ${data.randomHash}`);

      return {
        randomHash: data.randomHash,
        oracleOperator: data.oracleOperator,
      };
    } catch (error) {
      console.error("❌ Error requesting random hash from oracle:", error);
      throw new Error(`Oracle API unavailable: ${(error as Error).message}`, { cause: error });
    }
  }

  public async signGameTransaction(transaction: Transaction): Promise<Transaction> {
    const txBase64 = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    const data = expectStatus(
      await this.apiClient().signGameTransaction({ body: { txBase64 } }),
      200,
    ).data;
    return Transaction.from(Buffer.from(data.txBase64, "base64"));
  }

  /**
   * Get oracle statistics
   */
  public async getStats(): Promise<OracleStats | null> {
    try {
      const data = expectStatus(await this.apiClient().stats(), 200).data;

      return data.stats;
    } catch (error) {
      console.warn("Error fetching oracle stats:", error);
      return null;
    }
  }

  /**
   * Check if oracle API is healthy
   */
  public async isHealthy(): Promise<boolean> {
    try {
      console.log(`🔍 Checking Oracle health at: ${this.oracleApiUrl}/health`);
      const result = await this.apiClient().health({
        request: { signal: AbortSignal.timeout(5000) },
      });

      console.log(
        `🔍 Oracle health response: ${result.response.status} ${result.response.statusText}`,
      );
      expectStatus(result, 200);
      return true;
    } catch (error) {
      console.error("❌ Oracle health check failed:", {
        url: `${this.oracleApiUrl}/health`,
        error: error instanceof Error ? error.message : String(error),
        type: error?.constructor?.name || typeof error,
        code: errorCode(error),
      });
      return false;
    }
  }

  public async requestGameCompletion(gameAddress: string): Promise<boolean> {
    try {
      expectStatus(
        await this.apiClient().completeGameNow({
          body: { gameAddress },
          request: { signal: AbortSignal.timeout(3000) },
        }),
        200,
      );
      return true;
    } catch (error) {
      console.warn(`Oracle completion wake-up failed for ${gameAddress}:`, error);
      return false;
    }
  }

  // ================================
  // PRIVATE GAME AUTHORIZATION (kept for private games)
  // ================================

  public async authorizePlayer(gamePda: PublicKey, chatId: number): Promise<AuthorizationResult> {
    try {
      const game = this.gameDb.getGame(gamePda.toBase58());
      if (!game) {
        return { authorized: false, error: "Game not found in database" };
      }

      if (!game.chat_id || game.chat_id !== chatId) {
        return {
          authorized: false,
          error: "Player not in same chat as game creator",
        };
      }

      // Private games require the shared operator keypair for authorization.
      if (!this.wallet) {
        return { authorized: false, error: "Wallet manager not available" };
      }

      const operatorKeypair = this.wallet.getOperatorKeypair();
      return { authorized: true, operatorKeypair };
    } catch (error) {
      console.error(`Error authorizing player:`, error);
      return { authorized: false, error: (error as Error).message };
    }
  }

  // ================================
  // UTILITY METHODS
  // ================================

  /**
   * Convert hex string to Buffer (for random hash)
   */
  public hexToBuffer(hex: string): Buffer {
    return Buffer.from(hex, "hex");
  }

  /**
   * Get oracle API URL
   */
  public getOracleUrl(): string {
    return this.oracleApiUrl;
  }

  /**
   * Set oracle API URL (for testing or different environments)
   */
  public setOracleUrl(url: string): void {
    this.oracleApiUrl = url;
  }
}
