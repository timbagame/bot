import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WalletManager } from "../src/utils/wallet";

const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";

const resetInstance = () => {
  // @ts-ignore - allow resetting singleton for testing
  WalletManager["instance"] = undefined;
};

test("getKeyPair returns same instance for same index", () => {
  resetInstance();
  const manager = WalletManager.getInstance(mnemonic);
  const kp1 = manager.getKeyPair(1n);
  const kp2 = manager.getKeyPair(1n);
  expect(kp1).toBe(kp2);
});

test("getKeyPair derives different keys for different index", () => {
  resetInstance();
  const manager = WalletManager.getInstance(mnemonic);
  const kp1 = manager.getKeyPair(1n);
  const kp2 = manager.getKeyPair(2n);
  expect(kp1.publicKey.toBase58()).not.toBe(kp2.publicKey.toBase58());
});

test("getKeyPair throws when given fallback index", () => {
  resetInstance();
  const manager = WalletManager.getInstance(mnemonic);
  expect(() => manager.getKeyPair(0n)).toThrow(/Missing Telegram id/);
});

test("formatSolBalance formats lamports with precision", () => {
  resetInstance();
  const manager = WalletManager.getInstance(mnemonic);
  expect(manager.formatSolBalance(1234567000)).toBe("1.234567");
});

test("formatTokenBalance handles amounts under one token", () => {
  resetInstance();
  const manager = WalletManager.getInstance(mnemonic);
  expect(manager.formatTokenBalance(123, 3)).toBe("0.123");
});

test("formatTokenBalance caps precision for large amounts", () => {
  resetInstance();
  const manager = WalletManager.getInstance(mnemonic);
  expect(manager.formatTokenBalance(1234567890, 9)).toBe("1.234568");
});

test("getAdminKeypair throws when file missing", () => {
  resetInstance();
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
  resetInstance();
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
  resetInstance();
  const conn = { id: "connection" } as any;
  const manager = WalletManager.createForTest(mnemonic, {
    connection: conn,
    fetch: globalThis.fetch as any,
    timeNow: () => Date.now(),
  });
  expect(manager.getConnection()).toBe(conn);
});
