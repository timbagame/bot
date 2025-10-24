import { describe, it, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import {
  TransactionHistory,
  createTransactionRecord,
  type TransactionRecord,
} from "../src/utils/transaction-history";
import { getTestDatabasePath, resetTestDatabase } from "./helpers/database";

const dbPath = getTestDatabasePath("transaction-history.sqlite");

describe("TransactionHistory", () => {
  beforeAll(() => {
    resetTestDatabase("transaction-history.sqlite");
    TransactionHistory.resetForTesting();
  });

  it("initializes schema with updated_at column", () => {
    const txDb = TransactionHistory.getInstance();
    // Force DB creation and schema init
    expect(txDb).toBeDefined();

    const verifier = new Database(dbPath, { create: true });
    const cols = verifier
      .query("PRAGMA table_info(transaction_history)")
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));

    expect(colNames.has("created_at")).toBeTrue();
    expect(colNames.has("updated_at")).toBeTrue();
  });

  it("inserts and updates transactions", () => {
    const txDb = TransactionHistory.getInstance();

    const rec: TransactionRecord = createTransactionRecord(
      "user-1",
      "BUY",
      "sig-123",
      "SOL",
      "PUMP",
      "1.0",
      "100.0",
      "PENDING"
    );

    const id = txDb.addTransaction(rec);
    expect(id).toBeGreaterThan(0);

    // Update to SUCCESS with block height
    txDb.updateTransactionStatus("sig-123", "SUCCESS", 999);

    // Verify update applied
    const verifier = new Database(dbPath, { create: true });
    const row = verifier
      .query(
        "SELECT status, block_height FROM transaction_history WHERE signature = ?"
      )
      .get("sig-123") as { status: string; block_height: number };

    expect(row.status).toBe("SUCCESS");
    expect(row.block_height).toBe(999);
  });
});
