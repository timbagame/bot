import type { KnownToken } from "../types";
import { BaseDatabase, createDatabaseClassSingleton } from "./base-database";

/**
 * Database service for storing token-related data
 */
export class TokenDatabase extends BaseDatabase {
  public static getInstance: () => TokenDatabase;
  public static resetForTesting: () => void;

  static {
    const { getInstance, resetForTesting } = createDatabaseClassSingleton(
      () => new TokenDatabase()
    );
    TokenDatabase.getInstance = getInstance;
    TokenDatabase.resetForTesting = resetForTesting;
  }

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
      ],
      "Token"
    );
  }

  // ================================
  // KNOWN TOKENS METHODS
  // ================================

  public addKnownToken(
    tokenMint: string,
    tokenTicker: string,
    decimals: number
  ): void {
    this.run(
      "INSERT OR REPLACE INTO known_tokens (token_mint, token_ticker, decimals, added_at) VALUES (?, ?, ?, ?)",
      [tokenMint, tokenTicker, decimals, Date.now()],
      "adding known token"
    );
  }

  public getKnownTokenByTicker(ticker: string): KnownToken | null {
    return this.get<KnownToken>(
      "SELECT * FROM known_tokens WHERE UPPER(token_ticker) = UPPER(?)",
      [ticker],
      "getting known token by ticker"
    );
  }

  public getKnownTokenByMint(tokenMint: string): KnownToken | null {
    return this.get<KnownToken>(
      "SELECT * FROM known_tokens WHERE token_mint = ?",
      [tokenMint],
      "getting known token by mint"
    );
  }

  public getAllKnownTokens(): KnownToken[] {
    return this.all<KnownToken>(
      "SELECT * FROM known_tokens ORDER BY token_ticker",
      [],
      "getting all known tokens"
    );
  }

  public removeKnownToken(tokenMint: string): void {
    this.run(
      "DELETE FROM known_tokens WHERE token_mint = ?",
      [tokenMint],
      "removing known token"
    );
  }

  // ================================
  // MAINTENANCE METHODS
  // ================================

  public getTokenCount(): number {
    return this.getCount(
      "SELECT COUNT(*) as count FROM known_tokens",
      [],
      "getting token count"
    );
  }

}
