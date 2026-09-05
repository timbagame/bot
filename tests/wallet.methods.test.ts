import { expect, test, vi } from "bun:test";
import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "#solana";
import { WalletManager } from "../src/utils/wallet";
import { TOKEN_PROGRAM_ID } from "#token";

class ConnFailTime implements Partial<Connection> {
  async getSlot(_cfg?: any): Promise<bigint> {
    throw new Error("rpc down");
  }
  async getBlockTime(_slot: number) {
    return null as any;
  }
}

class ConnATACheck implements Partial<Connection> {
  async getAccountInfo(_pk: PublicKey) {
    return null as any;
  }
}

test("getBlockchainTime falls back to system time on RPC failure", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    {
      connection: new ConnFailTime() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    },
  );
  const t = await wm.getBlockchainTime();
  const now = Math.floor(Date.now() / 1000);
  expect(Math.abs(t - now) < 3).toBe(true);
});

test("findOrCreateAssociatedTokenAccount returns create instruction when missing", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    {
      connection: new ConnATACheck() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    },
  );
  const owner = await Keypair.generate();
  const payer = await Keypair.generate();
  const mint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const res = await wm.findOrCreateAssociatedTokenAccount(owner.publicKey, mint, payer);
  expect(res.instructions.length).toBe(1);
});

test("wrapSol builds instructions and forwards to sendTransaction", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );
  const ata = (await Keypair.generate()).publicKey;
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
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );
  const ata = (await Keypair.generate()).publicKey;
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
        "failed to send transaction: Instruction 0: custom program error: 0x0 (already in use)",
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
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );
  await expect(wm.wrapSol(1n, 0)).rejects.toThrow(/greater than zero/);
});

test("unwrapSolWithKeypair skips admin signer when no loan is required", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const payer = await Keypair.generate();
  const operatorKeypair = await Keypair.generate();
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
    operatorKeypair,
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
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const payer = await Keypair.generate();
  const operatorKeypair = await Keypair.generate();
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
    operatorKeypair,
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

test("unwrapSolWithKeypair rejects a non-owner user signer", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const user = await Keypair.generate();
  const operatorKeypair = await Keypair.generate();

  await expect(
    wm.unwrapSolWithKeypair({
      owner: user.publicKey,
      payer: operatorKeypair,
      operatorKeypair,
      adminTopUpLamports: 500,
      amountLamports: 1_000,
    }),
  ).rejects.toThrow(/owner signer must match the wsol owner/i);
});

test("unwrapSolWithKeypair makes the operator fee payer for sponsored unwraps", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const payer = await Keypair.generate();
  const operatorKeypair = await Keypair.generate();
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
    payerRentLamports: 0,
  };

  const buildPlanSpy = vi.spyOn(wm as any, "buildUnwrapWsolPlan").mockResolvedValue(unwrapPlan);
  vi.spyOn(wm as any, "estimateFee").mockResolvedValue(500);
  const sendSpy = vi
    .spyOn(wm as any, "sendAndConfirmWithResubmits")
    .mockResolvedValue("UNWRAP_SIG");

  const result = await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    operatorKeypair,
    adminTopUpLamports: 750,
    amountLamports: 2_000,
  });

  expect(sendSpy).toHaveBeenCalledTimes(1);
  expect(buildPlanSpy).toHaveBeenCalledWith({
    owner: payer.publicKey,
    payer: operatorKeypair,
    amountLamports: 2_000,
  });
  const [ixs, signers, options] = sendSpy.mock.calls[0] as [
    TransactionInstruction[],
    Keypair[],
    Parameters<WalletManager["sendAndConfirmWithResubmits"]>[2],
  ];

  expect(signers).toEqual([operatorKeypair, payer]);
  expect(ixs[0]).toBe(unwrapPlan.instructions[0]);
  expect(ixs[ixs.length - 1]!.keys[0]!.pubkey).toEqual(payer.publicKey);
  expect(ixs[ixs.length - 1]!.keys[1]!.pubkey).toEqual(operatorKeypair.publicKey);
  expect(options).toEqual({ operationLabel: "Unwrap WSOL", maxResubmits: 0 });

  expect(result).toEqual({
    signature: "UNWRAP_SIG",
    amountLamports: 2_000,
    remainingLamports: 500,
  });
});

test("unwrapSolWithKeypair unwraps and reimburses estimated sponsor costs atomically", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const payer = await Keypair.generate();
  const operatorKeypair = await Keypair.generate();
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
    payerRentLamports: 300,
  });
  vi.spyOn(wm as any, "estimateFee").mockResolvedValue(500);

  const sendSpy = vi.spyOn(wm as any, "sendAndConfirmWithResubmits").mockResolvedValue("UNWRAP_TX");

  const result = await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    operatorKeypair,
    adminTopUpLamports: 750,
    amountLamports: 5_000,
  });

  expect(sendSpy).toHaveBeenCalledTimes(1);
  const [ixs, signers, options] = sendSpy.mock.calls[0] as [
    TransactionInstruction[],
    Keypair[],
    Parameters<WalletManager["sendAndConfirmWithResubmits"]>[2],
  ];

  expect(signers).toEqual([operatorKeypair, payer]);
  expect(ixs).toHaveLength(2);
  expect(ixs[0]).toBe(unwrapInstruction);
  expect(ixs[1]!.keys[0]!.pubkey).toEqual(payer.publicKey);
  expect(ixs[1]!.keys[1]!.pubkey).toEqual(operatorKeypair.publicKey);
  expect(Buffer.from(ixs[1]!.data).readBigUInt64LE(4)).toBe(800n);
  expect(options).toEqual({ operationLabel: "Unwrap WSOL", maxResubmits: 0 });

  expect(result).toEqual({
    signature: "UNWRAP_TX",
    amountLamports: 5_000,
    remainingLamports: 2_000,
  });
});

test("unwrapSolWithKeypair aborts when the sponsored fee cannot be estimated", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );
  const payer = await Keypair.generate();
  const operatorKeypair = await Keypair.generate();
  vi.spyOn(wm as any, "buildUnwrapWsolPlan").mockResolvedValue({
    instructions: [],
    unwrapLamports: 1_000,
    remainingLamports: 0,
    payerRentLamports: 0,
  });
  vi.spyOn(wm as any, "estimateFee").mockRejectedValue(
    new Error("Unable to estimate the sponsored transaction fee"),
  );
  const sendSpy = vi.spyOn(wm as any, "sendAndConfirmWithResubmits");

  await expect(
    wm.unwrapSolWithKeypair({
      owner: payer.publicKey,
      payer,
      operatorKeypair,
      adminTopUpLamports: 1,
      amountLamports: 1_000,
    }),
  ).rejects.toThrow(/Unable to estimate the sponsored transaction fee/);
  expect(sendSpy).not.toHaveBeenCalled();
});

test("buildUnwrapWsolPlan throws when no WSOL account found", async () => {
  const connection = {
    getAccountInfo: vi.fn().mockResolvedValue(null),
  };
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const owner = (await Keypair.generate()).publicKey;
  const payer = await Keypair.generate();

  await expect(wm.buildUnwrapWsolPlan({ owner, payer })).rejects.toThrow(
    "No WSOL account found to unwrap.",
  );
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
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const owner = (await Keypair.generate()).publicKey;
  const payer = await Keypair.generate();

  await expect(wm.buildUnwrapWsolPlan({ owner, payer })).rejects.toThrow(
    "Your WSOL account is already empty.",
  );
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
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const owner = (await Keypair.generate()).publicKey;
  const payer = await Keypair.generate();

  await expect(wm.buildUnwrapWsolPlan({ owner, payer, amountLamports: 2000 })).rejects.toThrow(
    /exceeds current balance/,
  );
});

test("buildUnwrapWsolPlan rejects a partial unwrap without a known rent reserve", async () => {
  const accountData = Buffer.alloc(165);
  accountData.writeBigUInt64LE(1_000n, 64);
  const connection = {
    getAccountInfo: vi.fn().mockResolvedValue({
      data: accountData,
      owner: TOKEN_PROGRAM_ID,
    }),
  };
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  await expect(
    wm.buildUnwrapWsolPlan({
      owner: (await Keypair.generate()).publicKey,
      payer: await Keypair.generate(),
      amountLamports: 500,
    }),
  ).rejects.toThrow(/rent reserve is unavailable/);
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
    { connection: connection as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const owner = (await Keypair.generate()).publicKey;
  const payer = await Keypair.generate();

  await expect(wm.buildUnwrapWsolPlan({ owner, payer, amountLamports: -100 })).rejects.toThrow(
    "Unwrap amount must be greater than zero.",
  );

  await expect(wm.buildUnwrapWsolPlan({ owner, payer, amountLamports: 1.5 })).rejects.toThrow(
    "Unwrap amount must be a safe integer in lamports.",
  );
});

test("unwrapSolWithKeypair throws if sponsorship is requested without operator keypair", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const owner = (await Keypair.generate()).publicKey;
  const payer = await Keypair.generate();

  await expect(
    wm.unwrapSolWithKeypair({
      owner,
      payer,
      adminTopUpLamports: 1000,
      // No operatorKeypair provided
    }),
  ).rejects.toThrow("Operator keypair required when sponsoring WSOL unwrap fees");
});

test("unwrapSolWithKeypair handles bigint for adminTopUpLamports", async () => {
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection: {} as any, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const payer = await Keypair.generate();
  const operatorKeypair = await Keypair.generate();
  const unwrapPlan = {
    instructions: [],
    unwrapLamports: 1000,
    remainingLamports: 0,
    payerRentLamports: 0,
  };

  (wm as any).buildUnwrapWsolPlan = vi.fn().mockResolvedValue(unwrapPlan);
  vi.spyOn(wm as any, "estimateFee").mockResolvedValue(500);
  const sendSpy = vi.spyOn(wm as any, "sendAndConfirmWithResubmits").mockResolvedValue("SIG");

  await wm.unwrapSolWithKeypair({
    owner: payer.publicKey,
    payer,
    operatorKeypair,
    adminTopUpLamports: 500n, // Pass as bigint
    amountLamports: 1000,
  });

  const [ixs] = sendSpy.mock.calls[0] as [TransactionInstruction[]];
  // Check that transfer instruction was created with correct amount
  const transferIx = ixs[0];
  const lamports = Number(Buffer.from(transferIx!.data).readBigUInt64LE(4));
  expect(lamports).toBe(500);
});

test("transferSol preserves lamports for dust transfers", async () => {
  const connection: any = {
    getLatestBlockhash: async () => ({ blockhash: "BH", lastValidBlockHeight: 1 }),
    sendTransaction: async () => "SIG1",
  };
  const wm = WalletManager.createForTest(
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const instructions: any[][] = [];
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
    instructions.push(ixs);
    return "SIG_DUST";
  };

  const destination = (await Keypair.generate()).publicKey;
  const sig = await wm.transferSol(1n, destination, 1);

  expect(sig).toBe("SIG_DUST");
  const dataBuffer = Buffer.from(instructions[0]![0]!.data);
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
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  (wm as any).estimateFee = async () => 2000;

  let sendCalled = false;
  (wm as any).sendAndConfirmWithResubmits = async () => {
    sendCalled = true;
    return "UNREACHABLE";
  };

  await expect(wm.withdrawAllSol(1n, (await Keypair.generate()).publicKey)).rejects.toThrow(
    /Not enough SOL to cover the transaction fee/,
  );

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
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
  );

  const telegramId = 1n;
  wm.setCachedNativeBalance(telegramId, 5_000_000);

  (wm as any).estimateFee = async () => 5_000;

  const lamportTransfers: number[] = [];
  (wm as any).sendAndConfirmWithResubmits = async (ixs: any[]) => {
    const instruction = ixs[0]!;
    const lamports = Number(Buffer.from(instruction.data).readBigUInt64LE(4));
    lamportTransfers.push(lamports);
    return "WITHDRAW_SIG";
  };

  const destination = (await Keypair.generate()).publicKey;
  const result = await wm.withdrawAllSol(telegramId, destination);

  expect(balanceCalls).toBe(1);
  expect(result.nativeLamportsSent).toBe(995_000);
  expect(result.totalLamportsSent).toBe(995_000);
  expect(lamportTransfers[0]).toBe(995_000);
});
