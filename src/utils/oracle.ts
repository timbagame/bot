import { PublicKey, Transaction } from "@solana/web3.js";
import type {
  AuthorizationResult,
  OracleApiResponse,
  OracleStats,
  OracleStatsResponse,
} from "../types";
import { GameDatabase } from "./game-database";
import { WalletManager } from "./wallet";
import { loadOracleApiToken } from "./secrets";

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
    this.oracleApiUrl =
      process.env["ORACLE_API_URL"] || "http://localhost:3001";
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

  private serviceHeaders(includeJson = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (includeJson) headers["Content-Type"] = "application/json";
    const apiToken = loadOracleApiToken();
    if (apiToken) {
      headers["Authorization"] = `Bearer ${apiToken}`;
    }
    return headers;
  }

  /**
   * Request a random hash from the oracle API for game creation
   */
  public async generateGameSecrets(): Promise<{ randomHash: string }> {
    try {
      const response = await fetch(`${this.oracleApiUrl}/generate-hash`, {
        method: "POST",
        headers: this.serviceHeaders(true),
      });

      if (!response.ok) {
        throw new Error(
          `Oracle API request failed: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as OracleApiResponse;

      if (!data.success || !data.randomHash) {
        throw new Error(data.error || "Failed to generate random hash");
      }

      console.log(`✅ Generated random hash from oracle: ${data.randomHash}`);

      return {
        randomHash: data.randomHash,
      };
    } catch (error) {
      console.error("❌ Error requesting random hash from oracle:", error);
      throw new Error(`Oracle API unavailable: ${(error as Error).message}`);
    }
  }

  public async signGameTransaction(
    transaction: Transaction,
  ): Promise<Transaction> {
    const txBase64 = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    const response = await fetch(`${this.oracleApiUrl}/sign-game-transaction`, {
      method: "POST",
      headers: this.serviceHeaders(true),
      body: JSON.stringify({ txBase64 }),
    });
    const data = (await response.json()) as OracleApiResponse & {
      txBase64?: string;
    };
    if (!response.ok || !data.success || !data.txBase64) {
      throw new Error(data.error || "Oracle rejected the game transaction");
    }
    return Transaction.from(Buffer.from(data.txBase64, "base64"));
  }

  /**
   * Get oracle statistics
   */
  public async getStats(): Promise<OracleStats | null> {
    try {
      const response = await fetch(`${this.oracleApiUrl}/stats`, {
        headers: this.serviceHeaders(),
      });

      if (!response.ok) {
        console.warn(`Oracle stats request failed: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as OracleStatsResponse;

      if (!data.success || !data.stats) {
        console.warn("Oracle stats not available:", data.error);
        return null;
      }

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
      const response = await fetch(`${this.oracleApiUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      console.log(
        `🔍 Oracle health response: ${response.status} ${response.statusText}`,
      );
      return response.ok;
    } catch (error) {
      console.error("❌ Oracle health check failed:", {
        url: `${this.oracleApiUrl}/health`,
        error: error instanceof Error ? error.message : String(error),
        type: error?.constructor?.name || typeof error,
        code: (error as any)?.code,
      });
      return false;
    }
  }

  public async requestGameCompletion(gameAddress: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.oracleApiUrl}/games/complete-now`, {
        method: "POST",
        headers: this.serviceHeaders(true),
        body: JSON.stringify({ gameAddress }),
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        console.warn(
          `Oracle completion wake-up failed for ${gameAddress}: ${response.status} ${response.statusText}`,
        );
        return false;
      }

      return true;
    } catch (error) {
      console.warn(
        `Oracle completion wake-up failed for ${gameAddress}:`,
        error,
      );
      return false;
    }
  }

  // ================================
  // PRIVATE GAME AUTHORIZATION (kept for private games)
  // ================================

  public async authorizePlayer(
    gamePda: PublicKey,
    chatId: number,
  ): Promise<AuthorizationResult> {
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

      // For private games, we still need admin keypair for authorization
      if (!this.wallet) {
        return { authorized: false, error: "Wallet manager not available" };
      }

      const adminKeypair = this.wallet.getAdminKeypair();
      return { authorized: true, adminKeypair };
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
