import { expect, test, beforeEach } from "bun:test";
import { TransactionHistory, createTransactionRecord, formatTransactionForDisplay } from "../src/utils/transaction-history";
import { resetTestDatabase } from "./helpers/database";

beforeEach(() => {
  resetTestDatabase("transaction-history.sqlite");
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

test("formatTransactionForDisplay adds cluster for non-mainnet networks", () => {
  const devnetTx = createTransactionRecord(
    "userDev",
    "SWAP",
    "sig-dev",
    "SOL",
    "USDC",
    "1",
    "25",
    "SUCCESS"
  );
  devnetTx.network = "devnet";

  const testnetTx = createTransactionRecord(
    "userTest",
    "BUY",
    "sig-test",
    "SOL",
    "BONK",
    "3",
    "9000",
    "SUCCESS"
  );
  testnetTx.network = "testnet";

  const mainnetTx = createTransactionRecord(
    "userMain",
    "SELL",
    "sig-main",
    "USDC",
    "SOL",
    "100",
    "4",
    "SUCCESS"
  );
  mainnetTx.network = "mainnet";

  const devnetDisplay = formatTransactionForDisplay(devnetTx);
  const testnetDisplay = formatTransactionForDisplay(testnetTx);
  const mainnetDisplay = formatTransactionForDisplay(mainnetTx);

  expect(devnetDisplay).toContain("https://solscan.io/tx/sig-dev?cluster=devnet");
  expect(testnetDisplay).toContain("https://solscan.io/tx/sig-test?cluster=testnet");
  expect(mainnetDisplay).toContain("https://solscan.io/tx/sig-main");
  expect(mainnetDisplay).not.toContain("?cluster=");
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
