import { expect, test, beforeEach } from "bun:test";
import { rmSync } from "fs";
import { TransactionHistory, createTransactionRecord, formatTransactionForDisplay } from "../src/utils/transaction-history";

beforeEach(() => {
  rmSync("transaction-history.sqlite", { force: true });
});

test("formatTransactionForDisplay shows icons, link, and amounts", () => {
  const now = Date.now();
  const tx = createTransactionRecord(
    "userZ",
    "SWAP",
    "sig-abc",
    "SOL",
    "USDC",
    "0.25",
    "25.1",
    "SUCCESS"
  );
  tx.timestamp = now;

  const s = formatTransactionForDisplay(tx);
  expect(s).toContain("✅"); // success icon
  expect(s).toContain("🔀"); // swap icon
  expect(s).toContain("0.25 SOL");
  expect(s).toContain("→ 25.1 USDC");
  expect(s).toContain("https://solscan.io/tx/sig-abc");
  expect(s).toContain("<code>"); // date wrapper
});

test("TransactionHistory add + display roundtrip smoke", () => {
  const db = new TransactionHistory();
  const rec = createTransactionRecord("u1", "DEPOSIT", "sig-x", "SOL", "SOL", "1.0", undefined, "PENDING");
  db.addTransaction(rec);
  const list = db.getUserHistory("u1", 1, 0);
  expect(list.length).toBe(1);
  const display = formatTransactionForDisplay(list[0]!);
  expect(display).toContain("⏳"); // pending icon
});
