import { PublicKey } from "@solana/web3.js";
import type {
  AuthorizationResult,
  OracleApiResponse,
  OracleStats,
  OracleStatsResponse,
  GameType
} from "../types";
import { GameDatabase } from "./game-database";
import { WalletManager } from "./wallet";

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
    this.oracleApiUrl = process.env["ORACLE_API_URL"] || 'http://localhost:3001';
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

  /**
   * Request a random hash from the oracle API for game creation
   */
  public async generateGameSecrets(gameType: GameType): Promise<{ randomHash: string; gameAddress: string; secretKey?: string }> {
    try {
      const response = await fetch(`${this.oracleApiUrl}/generate-hash`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ gameType })
      });

      if (!response.ok) {
        throw new Error(`Oracle API request failed: ${response.status} ${response.statusText}`);
      }

      const data: OracleApiResponse = await response.json();

      if (!data.success || !data.randomHash || !data.gameAddress) {
        throw new Error(data.error || 'Failed to generate random hash');
      }

      console.log(`✅ Generated random hash from oracle for ${gameType}: ${data.randomHash}`);
      console.log(`📍 Game address: ${data.gameAddress}`);

      const result: { randomHash: string; gameAddress: string; secretKey?: string } = {
        randomHash: data.randomHash,
        gameAddress: data.gameAddress
      };

      // Store secret key for dumbflip and snowball games
      if ((gameType === "dumbflip" || gameType === "snowball") && data.secretKey) {
        result.secretKey = data.secretKey;
        // Store in database for later use
        this.gameDb.saveOracleSecretKey(data.gameAddress, data.secretKey);
        console.log(`🔐 Secret key stored for ${gameType} game`);
      }

      return result;
    } catch (error) {
      console.error('❌ Error requesting random hash from oracle:', error);
      throw new Error(`Oracle API unavailable: ${(error as Error).message}`);
    }
  }

  /**
   * Get oracle statistics
   */
  public async getStats(): Promise<OracleStats | null> {
    try {
      const response = await fetch(`${this.oracleApiUrl}/stats`);

      if (!response.ok) {
        console.warn(`Oracle stats request failed: ${response.status}`);
        return null;
      }

      const data: OracleStatsResponse = await response.json();

      if (!data.success || !data.stats) {
        console.warn('Oracle stats not available:', data.error);
        return null;
      }

      return data.stats;
    } catch (error) {
      console.warn('Error fetching oracle stats:', error);
      return null;
    }
  }

  /**
   * Check if oracle API is healthy
   */
  public async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.oracleApiUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000) // 5 second timeout
      });

      return response.ok;
    } catch (error) {
      console.warn('Oracle health check failed:', error);
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
        return { authorized: false, error: "Player not in same chat as game creator" };
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
    return Buffer.from(hex, 'hex');
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
