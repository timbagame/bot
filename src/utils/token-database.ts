import type { KnownToken } from "../types";
import { BaseDatabase } from "./base-database";

/**
 * Database service for storing token-related data
 */
export class TokenDatabase extends BaseDatabase {
  private static instance: TokenDatabase;

  private constructor() {
    super(
      "tokens.sqlite",
      [
        `CREATE TABLE IF NOT EXISTS known_tokens (
          token_mint TEXT PRIMARY KEY,
          token_ticker TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          added_at INTEGER NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS token_metadata (
          token_mint TEXT PRIMARY KEY,
          name TEXT,
          symbol TEXT,
          decimals INTEGER NOT NULL,
          logo_uri TEXT,
          last_updated INTEGER NOT NULL
        )`,
      ],
      "Token"
    );
  }

  public static getInstance(): TokenDatabase {
    if (!TokenDatabase.instance) {
      TokenDatabase.instance = new TokenDatabase();
    }
    return TokenDatabase.instance;
  }

  // ================================
  // KNOWN TOKENS METHODS
  // ================================

  public addKnownToken(
    tokenMint: string,
    tokenTicker: string,
    decimals: number
  ): void {
    try {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO known_tokens (token_mint, token_ticker, decimals, added_at) VALUES (?, ?, ?, ?)"
      );
      stmt.run(tokenMint, tokenTicker, decimals, Date.now());
    } catch (error) {
      console.error("Error adding known token:", error);
      throw error;
    }
  }

  public getKnownTokenByTicker(ticker: string): KnownToken | null {
    try {
      const stmt = this.db.prepare(
        "SELECT * FROM known_tokens WHERE UPPER(token_ticker) = UPPER(?)"
      );
      return (stmt.get(ticker) as KnownToken) || null;
    } catch (error) {
      console.error("Error getting known token by ticker:", error);
      throw error;
    }
  }

  public getKnownTokenByMint(tokenMint: string): KnownToken | null {
    try {
      const stmt = this.db.prepare(
        "SELECT * FROM known_tokens WHERE token_mint = ?"
      );
      return (stmt.get(tokenMint) as KnownToken) || null;
    } catch (error) {
      console.error("Error getting known token by mint:", error);
      throw error;
    }
  }

  public getAllKnownTokens(): KnownToken[] {
    try {
      return this.db
        .query("SELECT * FROM known_tokens ORDER BY token_ticker")
        .all() as KnownToken[];
    } catch (error) {
      console.error("Error getting all known tokens:", error);
      throw error;
    }
  }

  public removeKnownToken(tokenMint: string): void {
    try {
      const stmt = this.db.prepare(
        "DELETE FROM known_tokens WHERE token_mint = ?"
      );
      stmt.run(tokenMint);
    } catch (error) {
      console.error("Error removing known token:", error);
      throw error;
    }
  }

  // ================================
  // TOKEN METADATA METHODS (for future use)
  // ================================

  public saveTokenMetadata(
    tokenMint: string,
    name?: string,
    symbol?: string,
    decimals?: number,
    logoUri?: string
  ): void {
    try {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO token_metadata (token_mint, name, symbol, decimals, logo_uri, last_updated) VALUES (?, ?, ?, ?, ?, ?)"
      );
      stmt.run(
        tokenMint,
        name || null,
        symbol || null,
        decimals || null,
        logoUri || null,
        Date.now()
      );
    } catch (error) {
      console.error("Error saving token metadata:", error);
      throw error;
    }
  }

  public getTokenMetadata(tokenMint: string): {
    token_mint: string;
    name?: string;
    symbol?: string;
    decimals?: number;
    logo_uri?: string;
    last_updated: number;
  } | null {
    try {
      const stmt = this.db.prepare(
        "SELECT * FROM token_metadata WHERE token_mint = ?"
      );
      return (stmt.get(tokenMint) as any) || null;
    } catch (error) {
      console.error("Error getting token metadata:", error);
      throw error;
    }
  }

  // ================================
  // MAINTENANCE METHODS
  // ================================

  public getTokenCount(): number {
    try {
      const stmt = this.db.prepare(
        "SELECT COUNT(*) as count FROM known_tokens"
      );
      const result = stmt.get() as { count: number };
      return result.count;
    } catch (error) {
      console.error("Error getting token count:", error);
      return 0;
    }
  }

  public cleanupOldMetadata(olderThanDays: number = 30): number {
    try {
      const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      const stmt = this.db.prepare(
        "DELETE FROM token_metadata WHERE last_updated < ?"
      );
      const result = stmt.run(cutoffTime);
      return result.changes || 0;
    } catch (error) {
      console.error("Error cleaning up old metadata:", error);
      return 0;
    }
  }
}
