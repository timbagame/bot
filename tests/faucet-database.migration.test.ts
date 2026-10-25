import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FaucetDatabase } from "../src/utils/faucet-database";
import { getTestDatabasePath, resetTestDatabase } from "./helpers/database";

const withRawDatabase = <T>(fn: (raw: Database) => T): T => {
  const raw = new Database(getTestDatabasePath("faucets.sqlite"), { create: true });
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
};

const dropTables = (raw: Database) => {
  raw.run("DROP TABLE IF EXISTS faucet_claims");
  raw.run("DROP TABLE IF EXISTS faucets");
};

const columnNames = (table: string) =>
  withRawDatabase((raw) =>
    (raw.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name),
  );

beforeEach(() => {
  FaucetDatabase.resetForTesting();
  withRawDatabase(dropTables);
});

afterEach(() => {
  FaucetDatabase.resetForTesting();
  // Rebuild with the current schema so other test files sharing the file are unaffected.
  withRawDatabase(dropTables);
  FaucetDatabase.getInstance();
  FaucetDatabase.resetForTesting();
  resetTestDatabase("faucets.sqlite");
});

describe("FaucetDatabase legacy schema migration", () => {
  test("adds the display-name and notification columns and keeps existing rows", () => {
    withRawDatabase((raw) => {
      raw.run(
        `CREATE TABLE faucets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          creator_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          message_id INTEGER,
          token_mint TEXT NOT NULL,
          token_ticker TEXT NOT NULL,
          decimals INTEGER NOT NULL,
          is_sol INTEGER NOT NULL DEFAULT 0,
          amount_per_claim TEXT NOT NULL,
          max_claims INTEGER NOT NULL,
          display_amount TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        )`,
      );
      raw.run(
        `CREATE TABLE faucet_claims (
          faucet_id INTEGER NOT NULL,
          telegram_id TEXT NOT NULL,
          status TEXT NOT NULL,
          transaction_signature TEXT,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (faucet_id, telegram_id)
        )`,
      );
      raw.run(
        `INSERT INTO faucets (creator_id, chat_id, token_mint, token_ticker, decimals,
          amount_per_claim, max_claims, display_amount, created_at, expires_at)
         VALUES ('10', '-100', 'mint', 'TOK', 2, '100', 2, '1 TOK', 1000, 10000)`,
      );
    });

    const db = FaucetDatabase.getInstance();

    expect(columnNames("faucets")).toContain("creator_display_name");
    expect(columnNames("faucet_claims")).toEqual(
      expect.arrayContaining([
        "claimant_display_name",
        "notification_status",
        "notification_error",
        "notification_attempts",
        "notification_next_attempt_at",
      ]),
    );
    // The migrated table is usable: the pre-existing faucet survives and accepts claims.
    const reserved = db.reserveClaim(1, 20n, 2_000);
    expect(reserved).toEqual(expect.objectContaining({ ok: true }));
  });
});
