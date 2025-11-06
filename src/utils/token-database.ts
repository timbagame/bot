import type { KnownToken } from "../types";
import { BaseDatabase, initializeDatabaseSingleton } from "./base-database";

/**
 * Database service for storing token-related data
 */
export class TokenDatabase extends BaseDatabase {
  public static getInstance: () => TokenDatabase;
  public static resetForTesting: () => void;

  static {
    initializeDatabaseSingleton(TokenDatabase, () => new TokenDatabase());
  }

  private constructor() {
    super(
      "tokens.sqlite",
      [
        `CREATE TABLE IF NOT EXISTS known_tokens (
          token_mint TEXT PRIMARY KEY,
          token_ticker TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          added_at INTEGER NOT NULL,
          token_program_id TEXT
        )`,
      ],
      "Token"
    );

    this.ensureKnownTokenSchema();
  }

  // ================================
  // KNOWN TOKENS METHODS
  // ================================

  public addKnownToken(
    tokenMint: string,
    tokenTicker: string,
    decimals: number,
    tokenProgramId?: string | null
  ): void {
    this.run(
      `INSERT OR REPLACE INTO known_tokens (
        token_mint,
        token_ticker,
        decimals,
        added_at,
        token_program_id
      ) VALUES (?, ?, ?, ?, ?)`,
      [tokenMint, tokenTicker, decimals, Date.now(), tokenProgramId ?? null],
      "adding known token"
    );
  }

  public setTokenProgramId(tokenMint: string, programId: string | null): void {
    this.run(
      "UPDATE known_tokens SET token_program_id = ? WHERE token_mint = ?",
      [programId, tokenMint],
      "setting known token program id"
    );
  }

  private ensureKnownTokenSchema(): void {
    try {
      const columns = this.all<{ name: string }>(
        "PRAGMA table_info(known_tokens)",
        [],
        "reading known_tokens schema"
      );
      const columnNames = new Set(columns.map((col) => col.name));

      if (!columnNames.has("token_program_id")) {
        this.run(
          "ALTER TABLE known_tokens ADD COLUMN token_program_id TEXT",
          [],
          "adding token_program_id column to known_tokens"
        );
      }
    } catch (error) {
      console.error("Failed to ensure known_tokens schema:", error);
    }
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
