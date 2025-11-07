import { expect, test } from "bun:test";
import { Buffer } from "buffer";
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

test("transferSol preserves lamports for dust transfers", async () => {
  const connection: any = {
    getLatestBlockhash: async () => ({ blockhash: "BH", lastValidBlockHeight: 1 }),
    sendTransaction: async () => "SIG1",
  };
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const instructions: any[][] = [];
  (wm as any).sendTransaction = async (ixs: any[]) => {
    instructions.push(ixs);
    return "SIG_DUST";
  };

  const destination = Keypair.generate().publicKey;
  const sig = await wm.transferSol(1n, destination, 1);

  expect(sig).toBe("SIG_DUST");
  const dataBuffer: Buffer = instructions[0]![0]!.data as Buffer;
  const lamports = Number(dataBuffer.readBigUInt64LE(4));
  expect(lamports).toBe(1);
});

test("withdrawAllSol aborts when fees exceed balance", async () => {
  let balanceCalls = 0;
  const connection: any = {
    getBalance: async () => {
      balanceCalls += 1;
      return 1000;
    },
  };
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  (wm as any).estimateFee = async () => 2000;

  let sendCalled = false;
  (wm as any).sendTransaction = async () => {
    sendCalled = true;
    return "UNREACHABLE";
  };

  await expect(
    wm.withdrawAllSol(1n, Keypair.generate().publicKey)
  ).rejects.toThrow(/Not enough SOL to cover the transaction fee/);

  expect(balanceCalls).toBe(1);
  expect(sendCalled).toBe(false);
});

test("withdrawAllSol refreshes balance instead of using stale cache", async () => {
  let balanceCalls = 0;
  const connection: any = {
    getBalance: async () => {
      balanceCalls += 1;
      return 1_000_000;
    },
  };

  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const telegramId = 1n;
  wm.setCachedNativeBalance(telegramId, 5_000_000);

  (wm as any).estimateFee = async () => 5_000;

  const lamportTransfers: number[] = [];
  (wm as any).sendTransaction = async (ixs: any[]) => {
    const instruction = ixs[0]!;
    const lamports = Number((instruction.data as Buffer).readBigUInt64LE(4));
    lamportTransfers.push(lamports);
    return "WITHDRAW_SIG";
  };

  const destination = Keypair.generate().publicKey;
  const result = await wm.withdrawAllSol(telegramId, destination);

  expect(balanceCalls).toBe(1);
  expect(result.nativeLamportsSent).toBe(995_000);
  expect(result.totalLamportsSent).toBe(995_000);
  expect(lamportTransfers[0]).toBe(995_000);
});
