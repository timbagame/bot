import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TokenDatabase } from "../src/utils/token-database";
import { getTestDatabasePath, resetTestDatabase } from "./helpers/database";

const dbPath = () => getTestDatabasePath("tokens.sqlite");

const withRawDatabase = (fn: (raw: Database) => void) => {
  const raw = new Database(dbPath(), { create: true });
  try {
    fn(raw);
  } finally {
    raw.close();
  }
};

const dropKnownTokens = (raw: Database) => {
  const existing = raw
    .query("SELECT type FROM sqlite_master WHERE name = 'known_tokens'")
    .get() as { type: string } | null;
  if (existing?.type === "view") raw.run("DROP VIEW known_tokens");
  else if (existing) raw.run("DROP TABLE known_tokens");
};

beforeEach(() => {
  TokenDatabase.resetForTesting();
  withRawDatabase(dropKnownTokens);
});

afterEach(() => {
  TokenDatabase.resetForTesting();
  // Leave the file with the current schema for other test files sharing it.
  withRawDatabase(dropKnownTokens);
  TokenDatabase.getInstance();
  TokenDatabase.resetForTesting();
  resetTestDatabase("tokens.sqlite");
});

describe("TokenDatabase known_tokens schema upgrade", () => {
  test("adds token_program_id to a legacy table and keeps existing rows", () => {
    withRawDatabase((raw) => {
      raw.run(
        `CREATE TABLE known_tokens (
          token_mint TEXT PRIMARY KEY,
          token_ticker TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          added_at INTEGER NOT NULL
        )`,
      );
      raw.run("INSERT INTO known_tokens VALUES ('legacy-mint', 'OLD', 6, 1)");
    });

    const db = TokenDatabase.getInstance();

    expect(db.getKnownTokenByTicker("OLD")).toMatchObject({
      token_mint: "legacy-mint",
      decimals: 6,
      token_program_id: null,
    });
    db.setTokenProgramId("legacy-mint", "fake-program-id");
    expect(db.getKnownTokenByTicker("OLD")?.token_program_id).toBe("fake-program-id");
  });

  test("logs instead of throwing when the schema cannot be upgraded", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      // A view named known_tokens makes CREATE TABLE IF NOT EXISTS a no-op, and SQLite
      // refuses to add a column to a view, so the upgrade fails.
      withRawDatabase((raw) => {
        raw.run(
          "CREATE VIEW known_tokens AS SELECT 'm' AS token_mint, 'T' AS token_ticker, 1 AS decimals, 1 AS added_at",
        );
      });

      expect(() => TokenDatabase.getInstance()).not.toThrow();

      const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(messages).toContain("Failed to ensure known_tokens schema:");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
