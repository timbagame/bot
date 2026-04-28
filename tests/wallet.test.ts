import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WalletManager } from "../src/utils/wallet";

const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";

test("getKeyPair returns same instance for same index", () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  const kp1 = manager.getKeyPair(1n);
  const kp2 = manager.getKeyPair(1n);
  expect(kp1).toBe(kp2);
});

test("getKeyPair derives different keys for different index", () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  const kp1 = manager.getKeyPair(1n);
  const kp2 = manager.getKeyPair(2n);
  expect(kp1.publicKey.toBase58()).not.toBe(kp2.publicKey.toBase58());
});

test("getKeyPair throws when given fallback index", () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  expect(() => manager.getKeyPair(0n)).toThrow(/Missing Telegram id/);
});

test("formatSolBalance formats lamports with precision", () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  expect(manager.formatSolBalance(1234567000)).toBe("1.234567");
});

test("formatTokenBalance handles amounts under one token", () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  expect(manager.formatTokenBalance(123, 3)).toBe("0.123");
});

test("formatTokenBalance shows full precision by default", () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  expect(manager.formatTokenBalance(1234567890, 9)).toBe("1.23456789");
});

test("getKeyPair remains consistent under concurrent cache evictions", async () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  const clock = { now: Date.now() };
  manager.__test_setKeypairCacheConfig({
    capacity: 2,
    ttlMs: 5,
    timeNow: () => clock.now,
  });

  manager.getKeyPair(7n);
  clock.now += 10;

  const concurrent = await Promise.all([
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.now += 1;
      return manager.getKeyPair(7n);
    })(),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.now += 1;
      return manager.getKeyPair(8n);
    })(),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.now += 1;
      return manager.getKeyPair(7n);
    })(),
  ]);

  const expected = manager.getKeyPair(7n);
  expect(concurrent[0].publicKey.toBase58()).toBe(expected.publicKey.toBase58());
  expect(concurrent[2].publicKey.toBase58()).toBe(expected.publicKey.toBase58());
  expect(concurrent[1].publicKey.toBase58()).not.toBe(expected.publicKey.toBase58());
});

test("getAdminKeypair throws when file missing", () => {
  WalletManager.resetForTest();
  const originalCwd = process.cwd();
  const tmpDir = mkdtempSync(join(tmpdir(), "wallet-test-"));
  try {
    process.chdir(tmpDir);
    const manager = WalletManager.createForTest(mnemonic, {
      connection: { } as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    expect(() => manager.getAdminKeypair()).toThrow(/Admin keypair file not found/);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getAdminKeypair surfaces parse failures", () => {
  WalletManager.resetForTest();
  const originalCwd = process.cwd();
  const tmpDir = mkdtempSync(join(tmpdir(), "wallet-test-"));
  try {
    process.chdir(tmpDir);
    writeFileSync(join(tmpDir, "admin-keypair.json"), "not-json", "utf-8");
    const manager = WalletManager.createForTest(mnemonic, {
      connection: { } as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    expect(() => manager.getAdminKeypair()).toThrow(/Failed to load admin keypair/);
  } finally {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getConnection returns injected connection", () => {
  WalletManager.resetForTest();
  const conn = { id: "connection" } as any;
  const manager = WalletManager.createForTest(mnemonic, {
    connection: conn,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
  });
  expect(manager.getConnection()).toBe(conn);
});
