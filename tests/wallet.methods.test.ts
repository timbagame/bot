import { expect, test } from "bun:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

class ConnFailTime implements Partial<Connection> {
  async getSlot(_cfg?: any): Promise<number> { throw new Error("rpc down"); }
  async getBlockTime(_slot: number) { return null as any; }
}

class ConnATACheck implements Partial<Connection> {
  async getAccountInfo(_pk: PublicKey) { return null as any; }
}

test("getBlockchainTime falls back to system time on RPC failure", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: new ConnFailTime() as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );
  const t = await wm.getBlockchainTime();
  const now = Math.floor(Date.now() / 1000);
  expect(Math.abs(t - now) < 3).toBe(true);
});

test("findOrCreateAssociatedTokenAccount returns create instruction when missing", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: new ConnATACheck() as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );
  const owner = Keypair.generate();
  const payer = Keypair.generate();
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const res = await wm.findOrCreateAssociatedTokenAccount(owner.publicKey, mint, payer);
  expect(res.instructions.length).toBe(1);
});
