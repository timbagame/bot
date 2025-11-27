import { expect, test, vi } from "bun:test";
import { Buffer } from "buffer";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";


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

test("unwrapSolWithKeypair skips admin signer when no loan is required", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const payer = Keypair.generate();
  const adminKeypair = Keypair.generate();
  const unwrapPlan = {
    instructions: ["UNWRAP"] as any,
    unwrapLamports: 1_000,
    remainingLamports: 0,
  };

  (wm as any).buildUnwrapWsolPlan = vi.fn().mockResolvedValue(unwrapPlan);
  const sendSpy = vi
    .spyOn(wm as any, "sendAndConfirmWithResubmits")
    .mockResolvedValue("UNWRAP_SIG");

  const result = await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    adminKeypair,
    adminTopUpLamports: 0,
    amountLamports: 1_000,
  });

  expect(sendSpy).toHaveBeenCalledWith(unwrapPlan.instructions, [payer], {
    operationLabel: "Unwrap WSOL",
  });
  expect(result).toEqual({
    signature: "UNWRAP_SIG",
    amountLamports: 1_000,
    remainingLamports: 0,
  });
});

test("unwrapSolWithKeypair defaults missing admin top-up to zero", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const payer = Keypair.generate();
  const adminKeypair = Keypair.generate();
  const unwrapPlan = {
    instructions: ["UNWRAP"] as any,
    unwrapLamports: 1_000,
    remainingLamports: 0,
  };

  (wm as any).buildUnwrapWsolPlan = vi.fn().mockResolvedValue(unwrapPlan);
  const sendSpy = vi
    .spyOn(wm as any, "sendAndConfirmWithResubmits")
    .mockResolvedValue("UNWRAP_SIG");

  const result = await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    adminKeypair,
    amountLamports: 1_000,
  });

  expect(sendSpy).toHaveBeenCalledWith(unwrapPlan.instructions, [payer], {
    operationLabel: "Unwrap WSOL",
  });
  expect(result).toEqual({
    signature: "UNWRAP_SIG",
    amountLamports: 1_000,
    remainingLamports: 0,
  });
});

test("unwrapSolWithKeypair rejects admin payer and keeps user as fee payer", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const user = Keypair.generate();
  const adminKeypair = Keypair.generate();

  await expect(
    wm.unwrapSolWithKeypair({
      owner: user.publicKey,
      payer: adminKeypair,
      adminKeypair,
      adminTopUpLamports: 500,
      amountLamports: 1_000,
    })
  ).rejects.toThrow(/payer must match the wsol owner/i);
});

test("unwrapSolWithKeypair keeps user as payer when admin lends fees", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const payer = Keypair.generate();
  const adminKeypair = Keypair.generate();
  const unwrapPlan = {
    instructions: [
      new TransactionInstruction({
        keys: [],
        programId: SystemProgram.programId,
        data: Buffer.alloc(0),
      }),
    ],
    unwrapLamports: 2_000,
    remainingLamports: 500,
  };

  (wm as any).buildUnwrapWsolPlan = vi.fn().mockResolvedValue(unwrapPlan);
  const sendSpy = vi
    .spyOn(wm as any, "sendAndConfirmWithResubmits")
    .mockResolvedValue("UNWRAP_SIG");

  const result = await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    adminKeypair,
    adminTopUpLamports: 750,
    amountLamports: 2_000,
  });

  expect(sendSpy).toHaveBeenCalledTimes(1);
  const [ixs, signers, options] = sendSpy.mock.calls[0] as [
    TransactionInstruction[],
    Keypair[],
    Parameters<WalletManager["sendAndConfirmWithResubmits"]>[2],
  ];

  expect(signers).toEqual([payer, adminKeypair]);
  expect(ixs[0]!.keys[0]!.pubkey).toEqual(adminKeypair.publicKey);
  expect(ixs[ixs.length - 1]!.keys[0]!.pubkey).toEqual(payer.publicKey);
  expect(options).toEqual({ operationLabel: "Unwrap WSOL" });

  expect(result).toEqual({
    signature: "UNWRAP_SIG",
    amountLamports: 2_000,
    remainingLamports: 500,
  });
});

test("unwrapSolWithKeypair lends, unwraps, and repays within one transaction", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const payer = Keypair.generate();
  const adminKeypair = Keypair.generate();
  const unwrapInstruction = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: SystemProgram.programId,
    data: Buffer.alloc(0),
  });

  (wm as any).buildUnwrapWsolPlan = vi.fn().mockResolvedValue({
    instructions: [unwrapInstruction],
    unwrapLamports: 5_000,
    remainingLamports: 2_000,
  });

  const sendSpy = vi
    .spyOn(wm as any, "sendAndConfirmWithResubmits")
    .mockResolvedValue("UNWRAP_TX");

  const result = await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    adminKeypair,
    adminTopUpLamports: 750,
    amountLamports: 5_000,
  });

  expect(sendSpy).toHaveBeenCalledTimes(1);
  const [ixs, signers, options] = sendSpy.mock.calls[0] as [
    TransactionInstruction[],
    Keypair[],
    Parameters<WalletManager["sendAndConfirmWithResubmits"]>[2],
  ];

  expect(signers).toEqual([payer, adminKeypair]);
  expect(ixs).toHaveLength(3);
  expect(ixs[0]!.keys[0]!.pubkey).toEqual(adminKeypair.publicKey);
  expect(ixs[0]!.keys[1]!.pubkey).toEqual(payer.publicKey);
  expect(ixs[1]).toBe(unwrapInstruction);
  expect(ixs[2]!.keys[0]!.pubkey).toEqual(payer.publicKey);
  expect(ixs[2]!.keys[1]!.pubkey).toEqual(adminKeypair.publicKey);
  expect(options).toEqual({ operationLabel: "Unwrap WSOL" });

  expect(result).toEqual({
    signature: "UNWRAP_TX",
    amountLamports: 5_000,
    remainingLamports: 2_000,
  });
});

test("buildUnwrapWsolPlan throws when no WSOL account found", async () => {
  const connection = {
    getAccountInfo: vi.fn().mockResolvedValue(null),
  };
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const owner = Keypair.generate().publicKey;
  const payer = Keypair.generate();

  await expect(
    wm.buildUnwrapWsolPlan({ owner, payer })
  ).rejects.toThrow("No WSOL account found to unwrap.");
});

test("buildUnwrapWsolPlan throws when WSOL account is empty", async () => {
  const accountData = Buffer.alloc(165);
  accountData.writeBigUInt64LE(0n, 64); // Amount at offset 64
  const connection = {
    getAccountInfo: vi.fn().mockResolvedValue({
      data: accountData,
      owner: TOKEN_PROGRAM_ID,
      lamports: 0,
    }),
  };

  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const owner = Keypair.generate().publicKey;
  const payer = Keypair.generate();

  await expect(
    wm.buildUnwrapWsolPlan({ owner, payer })
  ).rejects.toThrow("Your WSOL account is already empty.");
});

test("buildUnwrapWsolPlan throws when unwrap amount exceeds balance", async () => {
  const accountData = Buffer.alloc(165);
  accountData.writeBigUInt64LE(1000n, 64); // Amount = 1000
  const connection = {
    getAccountInfo: vi.fn().mockResolvedValue({
      data: accountData,
      owner: TOKEN_PROGRAM_ID,
    }),
  };

  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const owner = Keypair.generate().publicKey;
  const payer = Keypair.generate();

  await expect(
    wm.buildUnwrapWsolPlan({ owner, payer, amountLamports: 2000 })
  ).rejects.toThrow(/exceeds current balance/);
});

test("buildUnwrapWsolPlan throws for invalid unwrap amounts", async () => {
  const accountData = Buffer.alloc(165);
  accountData.writeBigUInt64LE(1000n, 64); // Amount = 1000
  const connection = {
    getAccountInfo: vi.fn().mockResolvedValue({
      data: accountData,
      owner: TOKEN_PROGRAM_ID,
    }),
  };

  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const owner = Keypair.generate().publicKey;
  const payer = Keypair.generate();

  await expect(
    wm.buildUnwrapWsolPlan({ owner, payer, amountLamports: -100 })
  ).rejects.toThrow("Unwrap amount must be greater than zero.");

  await expect(
    wm.buildUnwrapWsolPlan({ owner, payer, amountLamports: 1.5 })
  ).rejects.toThrow("Unwrap amount must be a safe integer in lamports.");
});

test("unwrapSolWithKeypair throws if admin lending is requested without admin keypair", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const owner = Keypair.generate().publicKey;
  const payer = Keypair.generate();

  await expect(
    wm.unwrapSolWithKeypair({
      owner,
      payer,
      adminTopUpLamports: 1000,
      // No adminKeypair provided
    })
  ).rejects.toThrow("Admin keypair required when lending lamports");
});

test("unwrapSolWithKeypair handles bigint for adminTopUpLamports", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const payer = Keypair.generate();
  const adminKeypair = Keypair.generate();
  const unwrapPlan = {
    instructions: [],
    unwrapLamports: 1000,
    remainingLamports: 0,
  };

  (wm as any).buildUnwrapWsolPlan = vi.fn().mockResolvedValue(unwrapPlan);
  const sendSpy = vi
    .spyOn(wm as any, "sendAndConfirmWithResubmits")
    .mockResolvedValue("SIG");

  await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    adminKeypair,
    adminTopUpLamports: 500n, // Pass as bigint
    amountLamports: 1000,
  });

  const [ixs] = sendSpy.mock.calls[0] as [TransactionInstruction[]];
  // Check that transfer instruction was created with correct amount
  const transferIx = ixs[0];
  const lamports = Number((transferIx!.data as Buffer).readBigUInt64LE(4));
  expect(lamports).toBe(500);
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
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
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
  (wm as any).sendAndConfirmWithResubmits = async () => {
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
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
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

test("B-001: withdrawAllSol leaves dust if balance increases between fetch and send", async () => {
  const connection: any = {
    getBalance: vi.fn()
      .mockResolvedValueOnce(1_000_000) // Initial fetch
      .mockResolvedValueOnce(2_000_000), // Updated balance (simulating incoming transfer)
    getLatestBlockhash: async () => ({ blockhash: "BH", lastValidBlockHeight: 1 }),
  };

  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  (wm as any).estimateFee = async () => 5_000;

  const lamportTransfers: number[] = [];
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
    const instruction = ixs[0]!;
    const lamports = Number((instruction.data as Buffer).readBigUInt64LE(4));
    lamportTransfers.push(lamports);
    return "WITHDRAW_SIG";
  };

  const destination = Keypair.generate().publicKey;
  await wm.withdrawAllSol(1n, destination);

  // We expect it to send 1_000_000 - 5_000 = 995_000
  // Even though the balance is now 2_000_000
  // This confirms the race condition/staleness
  expect(lamportTransfers[0]).toBe(995_000);
  expect(connection.getBalance).toHaveBeenCalledTimes(1); // Should have only called once
});

test("B-002: transferToken handles unsafe integer amounts by losing precision", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const intendedAmount = BigInt(Number.MAX_SAFE_INTEGER) + 2n; // Odd number > 2^53, definitely loses precision in double
  const unsafeAmount = Number(intendedAmount); // This will lose precision

  const fromKeypair = Keypair.generate();
  const toAddress = Keypair.generate().publicKey;
  const tokenMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  // Mock getAccountInfo for detectTokenProgram
  (wm as any).connection.getAccountInfo = async () => ({
    data: Buffer.alloc(0),
    owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    lamports: 0,
  });

  (wm as any).getKeyPair = () => fromKeypair;
  (wm as any).getTokenMetadata = async () => ({ decimals: 6 });
  (wm as any).findOrCreateAssociatedTokenAccount = async () => ({
    address: Keypair.generate().publicKey,
    instructions: [],
  });

  let capturedAmount: bigint = 0n;
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
    const transferIx = ixs[0];
    // TransferChecked instruction layout: [instruction (1), amount (8), decimals (1)]
    capturedAmount = (transferIx.data as Buffer).readBigUInt64LE(1);
    return "SIG";
  };

  await wm.transferToken(1n, toAddress, unsafeAmount, tokenMint.toBase58());

  // We expect the captured amount (derived from number) to NOT match the intended amount
  expect(capturedAmount).not.toBe(intendedAmount);
});

test("B-003: unwrapSolWithKeypair fails when payer has 0 SOL even with admin loan covering exact amount", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const payer = Keypair.generate();
  const adminKeypair = Keypair.generate();

  // Admin lends 5000.
  // We need to pay transaction fees.
  // If payer has 0, and we transfer 5000, and we try to send back 5000.
  // The transaction fee will eat into the 5000.
  // So the transfer back of 5000 will fail (insufficient funds).

  (wm as any).buildUnwrapWsolPlan = async () => ({
    instructions: [],
    unwrapLamports: 1000,
    remainingLamports: 0,
  });

  const instructions: TransactionInstruction[] = [];
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
    instructions.push(...ixs);
    return "SIG";
  };

  await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    adminKeypair,
    adminTopUpLamports: 5000,
    amountLamports: 1000,
  });

  // Verify the instructions sequence
  // 1. Transfer Admin -> Payer (5000)
  // 2. Unwrap ...
  // 3. Transfer Payer -> Admin (5000)

  const transferBack = instructions[instructions.length - 1];
  const amountBack = Number((transferBack!.data as Buffer).readBigUInt64LE(4));

  expect(amountBack).toBe(5000);
  // This confirms the logic tries to send back exactly what was lent, ignoring fees paid by payer.
});

test("B-004: findOrCreateAssociatedTokenAccount tries to create account on arbitrary RPC error", async () => {
  const connection = {
    getAccountInfo: vi.fn().mockRejectedValue(new Error("Network Error - 503 Service Unavailable")),
  };

  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const payer = Keypair.generate();

  const res = await wm.findOrCreateAssociatedTokenAccount(owner, mint, payer);

  // It should NOT have instructions if it's a network error (we don't know if it exists)
  // But the bug is that it DOES return create instruction
  expect(res.instructions.length).toBe(1);
});

test("B-005: unwrapSolWithKeypair loses precision for large adminTopUpLamports", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const payer = Keypair.generate();
  const adminKeypair = Keypair.generate();

  // Use a value that is safe in BigInt but unsafe in Number
  // 2^53 + 1 is the first odd number greater than 2^53, which is not representable in double
  const largeVal = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

  (wm as any).buildUnwrapWsolPlan = async () => ({
    instructions: [],
    unwrapLamports: 1000,
    remainingLamports: 0,
  });

  let capturedAmount: bigint = 0n;
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
    const transferIx = ixs[0]; // Admin -> Payer
    capturedAmount = (transferIx!.data as Buffer).readBigUInt64LE(4);
    return "SIG";
  };

  await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    adminKeypair,
    adminTopUpLamports: largeVal,
    amountLamports: 1000,
  });

  // The code converts to Number, so it should lose precision
  expect(capturedAmount).not.toBe(largeVal);
});

test("B-006: withdrawAllSol fails if actual fee is higher than estimated", async () => {
  const connection: any = {
    getBalance: async () => 1_000_000,
  };
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  // Estimate fee says 5000
  (wm as any).estimateFee = async () => 5_000;

  let sentLamports = 0;
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
    const instruction = ixs[0]!;
    sentLamports = Number((instruction.data as Buffer).readBigUInt64LE(4));
    return "SIG";
  };

  await wm.withdrawAllSol(1n, Keypair.generate().publicKey);

  // We send 995,000.
  // If actual fee is 5001, Total needed = 995,000 + 5,001 = 1,000,001.
  // Available = 1,000,000.
  // Transaction fails.
  // The test confirms we send exactly Balance - EstimatedFee.
  expect(sentLamports).toBe(995_000);
});

test("B-007: sendAndConfirmWithResubmits retries without checking history first", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const sendCalls: string[] = [];
  (wm as any).sendTransaction = async () => {
    sendCalls.push("call");
    return "SIG123";
  };

  let confirmAttempts = 0;
  (wm as any).confirmTransaction = async () => {
    confirmAttempts++;
    if (confirmAttempts === 1) {
      throw new Error("Timeout");
    }
    return; // Success on second try
  };

  // We want to see if it calls sendTransaction again on timeout
  await wm.sendAndConfirmWithResubmits(
    [new TransactionInstruction({ keys: [], programId: SystemProgram.programId, data: Buffer.alloc(0) })],
    [Keypair.generate()]
  );

  // It should have called sendTransaction twice (initial + retry)
  expect(sendCalls.length).toBe(2);
});
