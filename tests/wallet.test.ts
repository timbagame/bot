import { expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WalletManager } from "../src/utils/wallet";

const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";

test("getKeyPair returns same instance for same index", async () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  const kp1 = await manager.getKeyPair(1n);
  const kp2 = await manager.getKeyPair(1n);
  expect(kp1).toBe(kp2);
});

test("getKeyPair derives different keys for different index", async () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  const kp1 = await manager.getKeyPair(1n);
  const kp2 = await manager.getKeyPair(2n);
  expect(kp1.publicKey.toBase58()).not.toBe(kp2.publicKey.toBase58());
});

test("getKeyPair throws when given fallback index", async () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  await expect(manager.getKeyPair(0n)).rejects.toThrow(/Missing Telegram id/);
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

  await manager.getKeyPair(7n);
  clock.now += 10;

  const concurrent = await Promise.all([
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.now += 1;
      return await manager.getKeyPair(7n);
    })(),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.now += 1;
      return await manager.getKeyPair(8n);
    })(),
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      clock.now += 1;
      return await manager.getKeyPair(7n);
    })(),
  ]);

  const expected = await manager.getKeyPair(7n);
  expect(concurrent[0].publicKey.toBase58()).toBe(expected.publicKey.toBase58());
  expect(concurrent[2].publicKey.toBase58()).toBe(expected.publicKey.toBase58());
  expect(concurrent[1].publicKey.toBase58()).not.toBe(expected.publicKey.toBase58());
});

test("getOperatorKeypair throws when file missing", async () => {
  WalletManager.resetForTest();
  const tmpDir = mkdtempSync(join(tmpdir(), "wallet-test-"));
  try {
    const manager = WalletManager.createForTest(mnemonic, {
      connection: {} as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    vi.spyOn(manager as any, "resolveOperatorKeypairPath").mockReturnValue(
      join(tmpDir, "missing.json"),
    );
    await expect(manager.getOperatorKeypair()).rejects.toThrow(/Operator keypair file not found/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("getOperatorKeypair surfaces parse failures", async () => {
  WalletManager.resetForTest();
  const tmpDir = mkdtempSync(join(tmpdir(), "wallet-test-"));
  try {
    writeFileSync(join(tmpDir, "operator-keypair.json"), "not-json", {
      encoding: "utf-8",
      mode: 0o600,
    });
    const manager = WalletManager.createForTest(mnemonic, {
      connection: {} as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    vi.spyOn(manager as any, "resolveOperatorKeypairPath").mockReturnValue(
      join(tmpDir, "operator-keypair.json"),
    );
    await expect(manager.getOperatorKeypair()).rejects.toMatchObject({
      cause: expect.any(SyntaxError),
    });
  } finally {
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

test("concurrent key derivation shares the cached signer", async () => {
  WalletManager.resetForTest();
  const manager = WalletManager.getInstance(mnemonic);
  const [first, second] = await Promise.all([manager.getKeyPair(42n), manager.getKeyPair(42n)]);
  expect(first).toBe(second);
  const message = new TextEncoder().encode("Timba signer migration");
  const signature = await first.signBytes(message);
  expect(
    await crypto.subtle.verify(
      "Ed25519",
      first.keyPair.publicKey,
      new Uint8Array(signature),
      message,
    ),
  ).toBe(true);
});
