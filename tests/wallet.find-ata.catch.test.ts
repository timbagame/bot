import { test, expect } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

class ConnThrow {
  async getAccountInfo(_pk: PublicKey, _cfg?: any) { throw new Error("rpc error"); }
}

test("findOrCreateAssociatedTokenAccount adds create instruction on RPC error", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: new ConnThrow() as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );
  const owner = Keypair.generate();
  const payer = Keypair.generate();
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const res = await wm.findOrCreateAssociatedTokenAccount(owner.publicKey, mint, payer);
  expect(res.instructions.length).toBe(1);
});
