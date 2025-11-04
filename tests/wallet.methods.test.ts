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

test("wrapSol builds instructions and forwards to sendTransaction", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );
  const ata = Keypair.generate().publicKey;
  const sendCalls: any[] = [];
  (wm as any).findOrCreateAssociatedTokenAccount = async () => ({
    address: ata,
    instructions: ["ix1"],
  });
  (wm as any).sendTransaction = async (ixs: any[], signers: any[]) => {
    sendCalls.push({ ixs, signers });
    return "WRAP123";
  };
  const confirmed: string[] = [];
  (wm as any).confirmTransaction = async (sig: string) => {
    confirmed.push(sig);
  };

  const sig = await wm.wrapSol(1n, 500_000_000);
  expect(sig).toBe("WRAP123");
  expect(sendCalls[0]!.ixs.length).toBe(3);
  expect(sendCalls[0]!.signers[0]).toBeDefined();
  expect(confirmed).toEqual(["WRAP123"]);
});

test("wrapSol retries without ATA creation when account already exists", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );
  const ata = Keypair.generate().publicKey;
  let planCalls = 0;
  (wm as any).findOrCreateAssociatedTokenAccount = async () => {
    planCalls += 1;
    return {
      address: ata,
      instructions: planCalls === 1 ? ["create"] : [],
    };
  };

  const sendCalls: any[] = [];
  let attempt = 0;
  (wm as any).sendTransaction = async (ixs: any[]) => {
    sendCalls.push(ixs);
    attempt += 1;
    if (attempt === 1) {
      const err = new Error(
        "failed to send transaction: Instruction 0: custom program error: 0x0 (already in use)"
      ) as any;
      err.logs = ["Program log: account already in use"];
      throw err;
    }
    return "RETRY_SIG";
  };
  const confirmed: string[] = [];
  (wm as any).confirmTransaction = async (sig: string) => {
    confirmed.push(sig);
  };

  const sig = await wm.wrapSol(1n, 200_000_000);
  expect(sig).toBe("RETRY_SIG");
  expect(sendCalls.length).toBe(2);
  expect(sendCalls[0]!.length).toBeGreaterThan(sendCalls[1]!.length);
  expect(confirmed).toEqual(["RETRY_SIG"]);
});

test("wrapSol rejects non-positive amounts", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );
  await expect(wm.wrapSol(1n, 0)).rejects.toThrow(/greater than zero/);
});
