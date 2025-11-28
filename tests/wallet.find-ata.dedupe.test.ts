import { expect, test, vi } from "bun:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

class ConnNoAccounts implements Partial<Connection> {
  getAccountInfo = vi.fn(async () => null as any);
}

test("findOrCreateAssociatedTokenAccount scopes dedupe by payer", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: new ConnNoAccounts() as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  // Speed up test by skipping rate limiting
  (wm as any).throttle = async () => {};

  const owner = Keypair.generate().publicKey;
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const payerA = Keypair.generate();
  const payerB = Keypair.generate();

  const [resA, resB] = await Promise.all([
    wm.findOrCreateAssociatedTokenAccount(owner, mint, payerA),
    wm.findOrCreateAssociatedTokenAccount(owner, mint, payerB),
  ]);

  expect(resA.instructions[0]?.keys[0]?.pubkey.equals(payerA.publicKey)).toBe(true);
  expect(resB.instructions[0]?.keys[0]?.pubkey.equals(payerB.publicKey)).toBe(true);

  // Each payer hit RPC separately (cache key includes payer)
  const calls = (wm as any).connection.getAccountInfo.mock.calls.length;
  expect(calls).toBe(2);

  // Pending map should be cleared after both await
  expect((wm as any).pendingAtaCreations.size).toBe(0);
});
