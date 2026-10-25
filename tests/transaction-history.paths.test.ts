import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  TransactionHistory,
  createTransactionRecord,
  formatTransactionForDisplay,
  type TransactionRecord,
} from "../src/utils/transaction-history";
import { getTestDatabasePath, resetTestDatabase } from "./helpers/database";

const dbFile = "transaction-history.sqlite";

const withRawDatabase = <T>(fn: (raw: Database) => T): T => {
  const raw = new Database(getTestDatabasePath(dbFile), { create: true });
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
};

const record = (signature: string, overrides: Partial<TransactionRecord> = {}) => ({
  ...createTransactionRecord("user-f", "BUY", signature, "SOL", "TOK", "1", "10", "SUCCESS"),
  ...overrides,
});

let errorSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetTestDatabase(dbFile);
  TransactionHistory.resetForTesting();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
  TransactionHistory.resetForTesting();
  resetTestDatabase(dbFile);
});

const loggedErrors = () => errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));

describe("swap_stats finance schema migration", () => {
  const dropSwapStats = () => withRawDatabase((raw) => raw.run("DROP TABLE IF EXISTS swap_stats"));

  afterEach(() => {
    // Rebuild swap_stats with the current schema for other files sharing the database.
    TransactionHistory.resetForTesting();
    dropSwapStats();
    TransactionHistory.getInstance();
    TransactionHistory.resetForTesting();
  });

  test("adds the fee and sponsor columns to a legacy swap_stats table", () => {
    TransactionHistory.getInstance();
    TransactionHistory.resetForTesting();
    dropSwapStats();
    withRawDatabase((raw) => {
      raw.run(
        `CREATE TABLE swap_stats (
          signature TEXT PRIMARY KEY,
          wallet TEXT NOT NULL,
          input_mint TEXT NOT NULL,
          output_mint TEXT NOT NULL,
          fee_mint TEXT,
          input_ticker TEXT NOT NULL,
          output_ticker TEXT NOT NULL,
          amount_in TEXT NOT NULL,
          amount_out TEXT,
          referral_applied INTEGER NOT NULL DEFAULT 0,
          timestamp INTEGER NOT NULL,
          network TEXT NOT NULL DEFAULT 'mainnet',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
      );
      raw.run(
        `INSERT INTO swap_stats (signature, wallet, input_mint, output_mint, input_ticker,
          output_ticker, amount_in, timestamp)
         VALUES ('legacy-sig', 'wallet-f', 'in', 'out', 'IN', 'OUT', '5', 1500)`,
      );
    });

    const db = TransactionHistory.getInstance();

    const columns = withRawDatabase((raw) =>
      (raw.query("PRAGMA table_info(swap_stats)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    expect(columns).toEqual(
      expect.arrayContaining([
        "fee_amount",
        "fee_bps",
        "sponsor_cost_lamports",
        "sponsor_reimbursement_lamports",
        "sponsor_cost_estimated",
      ]),
    );
    expect(db.getSwapsByWallet("wallet-f")).toEqual([
      expect.objectContaining({ signature: "legacy-sig", amount_in: "5" }),
    ]);
    // The upgraded table accepts rows that use the new columns.
    db.recordSwap({
      signature: "new-sig",
      wallet: "wallet-f",
      input_mint: "in",
      output_mint: "out",
      fee_mint: "in",
      input_ticker: "IN",
      output_ticker: "OUT",
      amount_in: "7",
      amount_out: "8",
      referral_applied: true,
      fee_amount: "70",
      fee_bps: 100,
      timestamp: 1600,
    });
    expect(db.getReferralFees(1550, 1700)).toEqual([
      expect.objectContaining({ feeAmount: "70", feeBps: 100 }),
    ]);
  });
});

describe("TransactionHistory error handling", () => {
  test("addTransaction logs and rethrows on a duplicate signature", () => {
    const db = TransactionHistory.getInstance();
    db.addTransaction(record("dup-sig"));
    errorSpy.mockClear();

    expect(() => db.addTransaction(record("dup-sig"))).toThrow(/UNIQUE/i);
    expect(loggedErrors()).toContain("Error adding transaction record:");
    expect(db.getUserTransactionCount("user-f")).toBe(1);
  });

  describe("when the transaction table is gone", () => {
    let db: TransactionHistory;
    beforeEach(() => {
      db = TransactionHistory.getInstance();
      db.addTransaction(record("pending-sig", { status: "PENDING" }));
      (db as unknown as { db: Database }).db.run("DROP TABLE transaction_history");
      errorSpy.mockClear();
    });

    test("updateTransactionStatus swallows the failure and logs it", () => {
      expect(() => db.updateTransactionStatus("pending-sig", "SUCCESS", 10)).not.toThrow();
      expect(loggedErrors()).toContain("Error updating transaction status:");
    });

    test("history readers fall back to empty results and zero counts", () => {
      expect(db.getUserHistoryByType("user-f", "BUY")).toEqual([]);
      expect(loggedErrors()).toContain("Error getting user history by type:");

      expect(db.getUserTransactionCount("user-f")).toBe(0);
      expect(loggedErrors()).toContain("Error getting transaction count:");

      expect(db.getRecentTransactions(5)).toEqual([]);
      expect(loggedErrors()).toContain("Error getting recent transactions:");

      expect(db.cleanOldTransactions(1)).toBe(0);
      expect(loggedErrors()).toContain("Error cleaning old transactions:");
    });
  });
});

describe("formatTransactionForDisplay icons and links", () => {
  test("uses a distinct icon for each transaction type", () => {
    const iconFor = (type: string) =>
      formatTransactionForDisplay(record(`sig-${type}`, { transaction_type: type as any }));

    expect(iconFor("DEPOSIT")).toContain("💰");
    expect(iconFor("WITHDRAW")).toContain("💸");
    expect(iconFor("WRAP")).toContain("🔄");
    expect(iconFor("SWAP")).toContain("🔀");
    expect(iconFor("SELL")).toContain("🔴");
    // Unknown types fall back to the generic chart icon.
    expect(iconFor("MYSTERY")).toContain("📊");
  });

  test("shows a plain View label when the network has no explorer and there is no signature", () => {
    const text = formatTransactionForDisplay(record("", { network: "localnet" }));

    expect(text).toContain("• View");
    expect(text).not.toContain("solscan.io");
  });
});
