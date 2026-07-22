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
    const cols = verifier.query("PRAGMA table_info(transaction_history)").all() as Array<{
      name: string;
    }>;
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
      "PENDING",
    );

    const id = txDb.addTransaction(rec);
    expect(id).toBeGreaterThan(0);

    // Update to SUCCESS with block height
    txDb.updateTransactionStatus("sig-123", "SUCCESS", 999);

    // Verify update applied
    const verifier = new Database(dbPath, { create: true });
    const row = verifier
      .query("SELECT status, block_height FROM transaction_history WHERE signature = ?")
      .get("sig-123") as { status: string; block_height: number };

    expect(row.status).toBe("SUCCESS");
    expect(row.block_height).toBe(999);
  });

  it("aggregates traded and referral fee mints", () => {
    const txDb = TransactionHistory.getInstance();
    txDb.recordSwap({
      signature: "swap-1",
      wallet: "wallet",
      input_mint: "USDC-mint",
      output_mint: "TOKEN-mint",
      fee_mint: "USDC-mint",
      input_ticker: "USDC",
      output_ticker: "TOKEN",
      amount_in: "1000000",
      amount_out: "2000000",
      referral_applied: true,
      fee_amount: "10000",
      fee_bps: 100,
      timestamp: 1234,
    });

    const stats = txDb.getSwapTokenStats();
    expect(stats.find((stat) => stat.mint === "USDC-mint")).toMatchObject({
      inputSwaps: 1,
      outputSwaps: 0,
      feeMintSelections: 1,
    });
    expect(stats.find((stat) => stat.mint === "TOKEN-mint")).toMatchObject({
      inputSwaps: 0,
      outputSwaps: 1,
      feeMintSelections: 0,
    });

    expect(txDb.getReferralFees(1000, 2000)).toEqual([
      {
        feeMint: "USDC-mint",
        inputMint: "USDC-mint",
        outputMint: "TOKEN-mint",
        amountIn: "1000000",
        amountOut: "2000000",
        feeAmount: "10000",
        feeBps: 100,
        sponsorCostLamports: null,
        sponsorReimbursementLamports: null,
        sponsorCostEstimated: null,
      },
    ]);
  });
});
