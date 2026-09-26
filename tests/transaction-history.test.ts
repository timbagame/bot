import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
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

  test("initializes schema with updated_at column", () => {
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

  test("inserts and updates transactions", () => {
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

  test("aggregates traded and referral fee mints", () => {
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

    expect(txDb.getSwapsByWallet("wallet")).toEqual([
      expect.objectContaining({
        signature: "swap-1",
        wallet: "wallet",
        output_mint: "TOKEN-mint",
        amount_out: "2000000",
        referral_applied: true,
      }),
    ]);
    expect(txDb.getSwapsByWallet("other")).toEqual([]);

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

  test("stores finance events once in the append-only ledger", () => {
    const txDb = TransactionHistory.getInstance();
    const financeEvent = {
      eventId: "program:sig-finance:game:game-1",
      source: "program" as const,
      category: "game_fee" as const,
      kind: "earned" as const,
      signature: "sig-finance",
      account: "game-1",
      mint: "TIMBA-mint",
      amountRaw: "12345",
      networkFeeLamports: "5000",
      timestamp: 1500,
      slot: 42,
    };

    txDb.recordFinanceEvent(financeEvent);
    txDb.recordFinanceEvent(financeEvent);

    expect(txDb.getFinanceEvents(1000, 2000)).toContainEqual(financeEvent);
    expect(
      txDb.getFinanceEvents(1000, 2000).filter(({ eventId }) => eventId === financeEvent.eventId),
    ).toHaveLength(1);
  });

  test("persists resumable finance backfill cursors and progress", () => {
    const txDb = TransactionHistory.getInstance();
    txDb.ensureFinanceBackfillSource({
      sourceKey: "program:test",
      sourceType: "program",
      address: "11111111111111111111111111111111",
      startTimeMs: 1_000,
    });

    expect(txDb.getNextFinanceBackfillSource()).toMatchObject({
      sourceKey: "program:test",
      beforeSignature: null,
      completed: false,
      processedTransactions: 0,
    });

    txDb.advanceFinanceBackfillSource("program:test", "signature-1", false, 1);
    txDb.recordFinanceBackfillError("program:test", "429 Too Many Requests");
    expect(txDb.getFinanceBackfillProgress()).toEqual({
      totalSources: 1,
      completedSources: 0,
      processedTransactions: 1,
      lastError: "429 Too Many Requests",
    });

    txDb.advanceFinanceBackfillSource("program:test", "signature-2", true, 1);
    expect(txDb.getNextFinanceBackfillSource()).toBeNull();
    expect(txDb.getFinanceBackfillProgress()).toEqual({
      totalSources: 1,
      completedSources: 1,
      processedTransactions: 2,
      lastError: null,
    });
  });
});

describe("TransactionHistory query helpers", () => {
  beforeEach(() => {
    resetTestDatabase("transaction-history.sqlite");
    TransactionHistory.resetForTesting();
  });

  test("TransactionHistory: query helpers and cleanup", () => {
    const db = TransactionHistory.getInstance();
    const now = Date.now();

    // Insert mixed transactions
    const base = {
      user: "userA",
      signature: (s: string) => `${s}-${Math.random().toString(36).slice(2, 8)}`,
    };

    const tx1 = createTransactionRecord(
      base.user,
      "BUY",
      base.signature("sig1"),
      "SOL",
      "PUMP",
      "1",
      "100",
      "SUCCESS",
    );
    tx1.timestamp = now - 1000;
    const tx2 = createTransactionRecord(
      base.user,
      "SELL",
      base.signature("sig2"),
      "PUMP",
      "SOL",
      "50",
      "0.5",
      "FAILED",
    );
    tx2.timestamp = now - 500;
    const tx3 = createTransactionRecord(
      base.user,
      "SWAP",
      base.signature("sig3"),
      "SOL",
      "USDC",
      "0.1",
      "15",
      "SUCCESS",
    );
    tx3.timestamp = now;

    db.addTransaction(tx1);
    db.addTransaction(tx2);
    db.addTransaction(tx3);

    // Filters
    const byType = db.getUserHistoryByType(base.user, "BUY", 5);
    expect(byType.length).toBe(1);
    expect(byType[0]!.transaction_type).toBe("BUY");

    const recent = db.getRecentTransactions(5);
    expect(recent.length).toBe(2); // two SUCCESS

    const count = db.getUserTransactionCount(base.user);
    expect(count).toBe(3);

    // Cleanup: set a far-future keep window to avoid deletions
    const removedNone = db.cleanOldTransactions(3650);
    expect(removedNone).toBe(0);
  });
});
