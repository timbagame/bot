import type { KnownToken } from "../types";
import { BaseDatabase, createDatabaseHandle } from "./base-database";

/**
 * Database service for storing token-related data
 */
export class TokenDatabase extends BaseDatabase {
  private static readonly handles = createDatabaseHandle(
    () => new TokenDatabase()
  );

  public static readonly getInstance = TokenDatabase.handles.getInstance;
  public static readonly resetForTesting = TokenDatabase.handles.reset;

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
  // TOKEN METADATA METHODS (for future use)
  // ================================

  public saveTokenMetadata(
    tokenMint: string,
    name?: string,
    symbol?: string,
    decimals?: number,
    logoUri?: string
  ): void {
    this.run(
      "INSERT OR REPLACE INTO token_metadata (token_mint, name, symbol, decimals, logo_uri, last_updated) VALUES (?, ?, ?, ?, ?, ?)",
      [
        tokenMint,
        name || null,
        symbol || null,
        decimals || null,
        logoUri || null,
        Date.now(),
      ],
      "saving token metadata"
    );
  }

  public getTokenMetadata(tokenMint: string): {
    token_mint: string;
    name?: string;
    symbol?: string;
    decimals?: number;
    logo_uri?: string;
    last_updated: number;
  } | null {
    return this.get(
      "SELECT * FROM token_metadata WHERE token_mint = ?",
      [tokenMint],
      "getting token metadata"
    );
  }

  // ================================
  // MAINTENANCE METHODS
  // ================================

  public getTokenCount(): number {
    try {
      const result = this.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM known_tokens",
        [],
        "getting token count"
      );
      return result?.count ?? 0;
    } catch {
      return 0;
    }
  }

  public cleanupOldMetadata(olderThanDays: number = 30): number {
    try {
      const cutoffTime = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
      const result = this.run(
        "DELETE FROM token_metadata WHERE last_updated < ?",
        [cutoffTime],
        "cleaning up old metadata"
      );
      return (result?.changes as number | undefined) ?? 0;
    } catch {
      return 0;
    }
  }
}
