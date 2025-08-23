import { expect, test } from "bun:test";
import { WalletManager } from "./wallet";

const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";

const resetInstance = () => {
  // @ts-ignore - allow resetting singleton for testing
  WalletManager["instance"] = undefined;
};

test("getKeyPair returns same instance for same index", () => {
  resetInstance();
  const manager = WalletManager.getInstance(mnemonic);
  const kp1 = manager.getKeyPair(0n);
  const kp2 = manager.getKeyPair(0n);
  expect(kp1).toBe(kp2);
});

test("getKeyPair derives different keys for different index", () => {
  resetInstance();
  const manager = WalletManager.getInstance(mnemonic);
  const kp1 = manager.getKeyPair(0n);
  const kp2 = manager.getKeyPair(1n);
  expect(kp1.publicKey.toBase58()).not.toBe(kp2.publicKey.toBase58());
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
