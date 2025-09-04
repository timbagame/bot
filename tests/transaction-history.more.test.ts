import { expect, test, beforeEach } from "bun:test";
import { rmSync } from "fs";
import { TransactionHistory, createTransactionRecord } from "../src/utils/transaction-history";

beforeEach(() => {
  rmSync("transaction-history.sqlite", { force: true });
  // @ts-ignore reset singleton not needed (class not singleton in tests)
});

test("TransactionHistory: query helpers and cleanup", () => {
  const db = new TransactionHistory();
  const now = Date.now();

  // Insert mixed transactions
  const base = {
    user: "userA",
    signature: (s: string) => `${s}-${Math.random().toString(36).slice(2, 8)}`,
  };

  const tx1 = createTransactionRecord(base.user, "BUY", base.signature("sig1"), "SOL", "PUMP", "1", "100", "SUCCESS");
  tx1.timestamp = now - 1000;
  const tx2 = createTransactionRecord(base.user, "SELL", base.signature("sig2"), "PUMP", "SOL", "50", "0.5", "FAILED");
  tx2.timestamp = now - 500;
  const tx3 = createTransactionRecord(base.user, "SWAP", base.signature("sig3"), "SOL", "USDC", "0.1", "15", "SUCCESS");
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
