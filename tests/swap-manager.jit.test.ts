import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import {
  Connection,
  Keypair,
  TransactionInstruction,
  SystemProgram,
  SystemInstruction,
  PublicKey,
} from "@solana/web3.js";
import * as splToken from "@solana/spl-token";

import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";
import { WSOL_MINT } from "../src/utils/constants";
import { formatAmount } from "../src/utils/format-amount";
import type { FeeBudgetProvider } from "../src/utils/fee-budget";
import type { SwapQuote } from "../src/utils/swap/types";
import type { JupiterQuoteResponse } from "../src/utils/jupiter";
import type { PumpFunQuote } from "../src/utils/pump-fun";

describe("SwapManager.performJustInTimeSolSwap", () => {
  const mnemonic = "test walk nut penalty hip pave soap entry language right filter choice";
  const connection = new Connection("http://localhost:8899", "confirmed");
  const TEST_SINGLE_TX_LAMPORTS = 1_000_000;
  const TEST_WRAP_BUFFER_LAMPORTS = 15_000;
  const TEST_JIT_BUFFER_LAMPORTS = 500_000;
  const TEST_GAME_BUFFER_LAMPORTS = 2_500_000;

  const createFeeBudgetStub = (): FeeBudgetProvider => ({
    getSingleTransactionLamports: async () => TEST_SINGLE_TX_LAMPORTS,
    getWrapFeeBufferLamports: async () => TEST_WRAP_BUFFER_LAMPORTS,
    getJitSwapFeeBufferLamports: async () => TEST_JIT_BUFFER_LAMPORTS,
    getGameSafetyBufferLamports: async () => TEST_GAME_BUFFER_LAMPORTS,
    getCachedSingleTransactionLamports: () => TEST_SINGLE_TX_LAMPORTS,
    getCachedWrapFeeBufferLamports: () => TEST_WRAP_BUFFER_LAMPORTS,
    getCachedGameSafetyBufferLamports: () => TEST_GAME_BUFFER_LAMPORTS,
    getDefaultSingleTransactionLamports: () => TEST_SINGLE_TX_LAMPORTS,
    getDefaultWrapFeeBufferLamports: () => TEST_WRAP_BUFFER_LAMPORTS,
    getDefaultGameSafetyBufferLamports: () => TEST_GAME_BUFFER_LAMPORTS,
  });

  beforeEach(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  });

  test("returns without swapping when SOL balance already sufficient", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const adminCompositePumpFailure = Keypair.generate();
    (wallet as any).getAdminKeypair = () => adminCompositePumpFailure;
    const adminCompositeRefund = Keypair.generate();
    (wallet as any).getAdminKeypair = () => adminCompositeRefund;
    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => TEST_GAME_BUFFER_LAMPORTS,
    };

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 1_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(false);
  });

  test("returns helpful error when Jupiter requires more tokens than available", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;
    (wallet as any).sendTransaction = async () => "sponsored";
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "jupiter";
    (swapManager as any).jupiterClient.getQuote = async () => ({
      inAmount: "2000000",
      inputMint: "",
      outputMint: "",
      outAmount: "0",
      otherAmountThreshold: "0",
      swapMode: "ExactOut",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      totalTime: 0,
    });

    const user = Keypair.generate();
    const tokenDecimals = 6;
    const availableRaw = 1_000_000;
    const requiredRaw = 2_000_000;
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: availableRaw,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(false);
    expect(result.error).toBe(
      `Need ${formatAmount(requiredRaw, tokenDecimals)} TEST available for swap but only ${formatAmount(
        availableRaw,
        tokenDecimals
      )}. Top up your balance or add SOL manually.`
    );
  });

  test("unwraps WSOL instead of swapping when token mint is SOL", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => {
      throw new Error("Jupiter/Pump fun routing should be skipped for WSOL unwrap");
    };

    const sponsorCalls: number[] = [];
    const refundCalls: number[] = [];
    (swapManager as any).sponsorSwapFees = async (_kp: Keypair, lamports: number) => {
      sponsorCalls.push(lamports);
    };
    (swapManager as any).refundSponsoredFees = async (_kp: Keypair, lamports: number) => {
      refundCalls.push(lamports);
    };

    let unwrapRequests: number[] = [];
    (swapManager as any).unwrapWsolPortion = async ({
      unwrapLamports,
    }: {
      unwrapLamports: number;
    }) => {
      unwrapRequests.push(unwrapLamports);
      return {
        signature: "SIG_UNWRAP",
        lamportsReceived: unwrapLamports,
      };
    };

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: WSOL_MINT,
      tokenDecimals: 9,
      availableTokenAmountRaw: TEST_GAME_BUFFER_LAMPORTS * 2,
      tokenTicker: "SOL",
    });

    expect(result.swapped).toBe(true);
    expect(result.provider).toBe("unwrap");
    expect(result.signature).toBe("SIG_UNWRAP");
    expect(result.lamportsReceived).toBe(
      TEST_GAME_BUFFER_LAMPORTS + TEST_JIT_BUFFER_LAMPORTS
    );
    expect(unwrapRequests).toEqual([
      TEST_GAME_BUFFER_LAMPORTS + TEST_JIT_BUFFER_LAMPORTS,
    ]);
    expect(sponsorCalls).toEqual([TEST_JIT_BUFFER_LAMPORTS]);
    expect(refundCalls).toEqual([TEST_JIT_BUFFER_LAMPORTS]);
  });

  test("performs Jupiter swap when available tokens exactly meet the requirement", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "jupiter";

    const availableRaw = 1_000_000;
    (swapManager as any).getJupiterQuote = async () => ({
      inputMint: "TokenMint",
      outputMint: WSOL_MINT,
      inAmount: availableRaw.toString(),
      outAmount: "500000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
    });
    (swapManager as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
    });
    (swapManager as any).executeJupiterTransaction = async () => ({
      signature: "SIG_BOUNDARY",
      estimatedFee: 0,
    });

    const sponsorCalls: number[] = [];
    const refundCalls: number[] = [];
    (swapManager as any).sponsorSwapFees = async (_kp: Keypair, lamports: number) => {
      sponsorCalls.push(lamports);
    };
    (swapManager as any).refundSponsoredFees = async (
      _kp: Keypair,
      lamports: number
    ) => {
      refundCalls.push(lamports);
    };

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: availableRaw,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(true);
    expect(sponsorCalls).toEqual([expect.any(Number)]);
    expect(refundCalls).toEqual([expect.any(Number)]);
  });

  test("unwrap still executes when current SOL already exceeds swap target", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const currentLamports = 1_730_000; // ~0.00173 SOL
    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => currentLamports,
    };
    (swapManager as any).getBestProvider = async () => {
      throw new Error("Routing should be skipped when unwrapping WSOL");
    };

    const unwrapRequests: number[] = [];
    (swapManager as any).unwrapWsolPortion = async ({
      unwrapLamports,
    }: {
      unwrapLamports: number;
    }) => {
      unwrapRequests.push(unwrapLamports);
      return {
        signature: "SIG_UNWRAP_OVER_BUFFER",
        lamportsReceived: unwrapLamports,
      };
    };

    const sponsorCalls: number[] = [];
    (swapManager as any).sponsorSwapFees = async (
      _kp: Keypair,
      lamports: number
    ) => {
      sponsorCalls.push(lamports);
    };
    const refundCalls: number[] = [];
    (swapManager as any).refundSponsoredFees = async (
      _kp: Keypair,
      lamports: number
    ) => {
      refundCalls.push(lamports);
    };

    const user = Keypair.generate();
    const availableRaw = 2_774_000; // ~0.002774 SOL wrapped
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: WSOL_MINT,
      tokenDecimals: 9,
      availableTokenAmountRaw: availableRaw,
      tokenTicker: "SOL",
    });

    expect(result.swapped).toBe(true);
    expect(result.provider).toBe("unwrap");
    expect(result.signature).toBe("SIG_UNWRAP_OVER_BUFFER");
    expect(result.lamportsReceived).toBe(
      TEST_GAME_BUFFER_LAMPORTS - currentLamports +
        TEST_JIT_BUFFER_LAMPORTS
    );
    expect(unwrapRequests).toEqual([
      TEST_GAME_BUFFER_LAMPORTS - currentLamports +
        TEST_JIT_BUFFER_LAMPORTS,
    ]);
    expect(sponsorCalls).toEqual([]);
    expect(refundCalls).toEqual([]);
  });

  test("returns helpful error when WSOL unwrap attempts fail", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };

    const sponsorCalls: number[] = [];
    const refundCalls: number[] = [];
    (swapManager as any).sponsorSwapFees = async (_kp: Keypair, lamports: number) => {
      sponsorCalls.push(lamports);
    };
    (swapManager as any).refundSponsoredFees = async (_kp: Keypair, lamports: number) => {
      refundCalls.push(lamports);
    };

    let unwrapAttempts = 0;
    (swapManager as any).unwrapWsolPortion = async () => {
      unwrapAttempts += 1;
      throw new Error("Unable to unwrap due to rent exempt requirement.");
    };

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: WSOL_MINT,
      tokenDecimals: 9,
      availableTokenAmountRaw: TEST_GAME_BUFFER_LAMPORTS * 2,
      tokenTicker: "SOL",
    });

    expect(result.swapped).toBe(false);
    expect(result.error).toContain("Unable to unwrap due to rent exempt requirement.");
    expect(unwrapAttempts).toBeGreaterThanOrEqual(1);
    expect(sponsorCalls.length).toBe(unwrapAttempts);
    expect(refundCalls.length).toBe(unwrapAttempts);
  });

  test("executes pump.fun swap with admin as fee payer", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;
    const sendCalls: Keypair[][] = [];
    (wallet as any).sendTransaction = async (
      _ixs: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push(signers);
      return "SIG_PUMP";
    };
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "pump-fun";
    (swapManager as any).pumpFunClient.getQuote = async () => ({
      outputAmount: "4000000",
    });
    (swapManager as any).pumpFunClient.createSwapTransaction = async () => [
      {} as TransactionInstruction,
    ];

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 10_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(true);
    expect(result.provider).toBe("pump-fun");
    expect(result.signature).toBe("SIG_PUMP");
    expect(sendCalls[0]?.[0]?.publicKey.equals(admin.publicKey)).toBe(true);
    expect(sendCalls[0]?.[1]?.publicKey.equals(user.publicKey)).toBe(true);
  });

  test("refunds sponsored lamports to admin after successful Jupiter swap", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const sendCalls: {
      signers: Keypair[];
      instructions: TransactionInstruction[];
    }[] = [];
    (wallet as any).sendTransaction = async (
      ixs: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions: ixs, signers });
      return `SIG_${sendCalls.length}`;
    };
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "jupiter";
    (swapManager as any).jupiterClient.getQuote = async () => ({
      inputMint: "TokenMint",
      outputMint: "So11111111111111111111111111111111111111112",
      inAmount: "1000000",
      outAmount: "500000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      totalTime: 0,
    });
    (swapManager as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: "BASE64",
    });
    (swapManager as any).executeJupiterTransaction = async () => ({
      signature: "SIG_JUP",
      estimatedFee: 0,
    });

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 10_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(true);
    expect(result.provider).toBe("jupiter");
    expect(result.signature).toBe("SIG_JUP");
    expect(result.lamportsReceived).toBe(
      TEST_GAME_BUFFER_LAMPORTS + TEST_JIT_BUFFER_LAMPORTS
    );

    expect(sendCalls.length).toBe(2);

    const sponsorCall = sendCalls[0]!;
    expect(
      sponsorCall.signers[0]?.publicKey.equals(admin.publicKey)
    ).toBe(true);
    expect(
      sponsorCall.instructions[0]?.keys[0]?.pubkey.equals(admin.publicKey)
    ).toBe(true);
    expect(
      sponsorCall.instructions[0]?.keys[1]?.pubkey.equals(user.publicKey)
    ).toBe(true);

    const refundCall = sendCalls[1]!;
    expect(refundCall.signers[0]?.publicKey.equals(user.publicKey)).toBe(true);
    expect(
      refundCall.instructions[0]?.keys[0]?.pubkey.equals(user.publicKey)
    ).toBe(true);
    expect(
      refundCall.instructions[0]?.keys[1]?.pubkey.equals(admin.publicKey)
    ).toBe(true);
  });

  test("unwrapWsolPortion closes WSOL ATA and rewraps remaining balance", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());

    const user = Keypair.generate();
    const totalRaw = TEST_GAME_BUFFER_LAMPORTS + TEST_JIT_BUFFER_LAMPORTS;
    const unwrapLamports = TEST_GAME_BUFFER_LAMPORTS;

    const sendCalls: TransactionInstruction[][] = [];
    (wallet as any).sendTransaction = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push(instructions);
      expect(signers[0]?.publicKey.equals(user.publicKey)).toBe(true);
      return "SIG_UNWRAP_REAL";
    };

    let confirmCount = 0;
    (wallet as any).confirmTransaction = async () => {
      confirmCount += 1;
    };

    const wsolMintKey = new PublicKey(WSOL_MINT);
    const wsolAta = await splToken.getAssociatedTokenAddress(
      wsolMintKey,
      user.publicKey,
      false,
      splToken.TOKEN_PROGRAM_ID
    );

    const getAccountSpy = spyOn(splToken, "getAccount") as any;
    getAccountSpy.mockImplementation(async () => ({
      address: wsolAta,
      mint: wsolMintKey,
      owner: user.publicKey,
      amount: BigInt(totalRaw),
      delegate: null,
      delegatedAmount: 0n,
      state: 1,
      isNative: null,
      rentExemptReserve: null,
      closeAuthority: null,
      isFrozen: false,
      tlvData: Buffer.alloc(0),
    }));

    try {
      const result = await (swapManager as any).unwrapWsolPortion({
        userKeypair: user,
        unwrapLamports,
        logContext: "unit test",
      });

      expect(result.signature).toBe("SIG_UNWRAP_REAL");
      expect(result.lamportsReceived).toBe(unwrapLamports);
      expect(sendCalls.length).toBe(1);

      const instructions = sendCalls[0]!;
      expect(instructions.length).toBe(5);

      const transferIx = instructions.find((ix) =>
        ix.programId.equals(SystemProgram.programId)
      );
      expect(transferIx).toBeDefined();
      const decoded = SystemInstruction.decodeTransfer(transferIx!);
      expect(Number(decoded.lamports)).toBe(totalRaw - unwrapLamports);
      expect(decoded.fromPubkey.equals(user.publicKey)).toBe(true);

      expect(confirmCount).toBe(1);
      expect(getAccountSpy.mock.calls.length).toBe(1);
    } finally {
      getAccountSpy.mockRestore();
    }
  });

  test("performs pump.fun JIT swap without zeroing low-decimal amounts", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;
    (wallet as any).sendTransaction = async () => "SIG_PUMP_LOW_DEC";
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "pump-fun";

    const requestedAmounts: string[] = [];
    (swapManager as any).getPumpFunQuote = async (opts: any) => {
      requestedAmounts.push(opts.amount);
      const normalizedRaw = opts.amount.includes(".")
        ? opts.amount.replace(".", "")
        : opts.amount;
      return {
        inputMint: opts.inputMint,
        outputMint: opts.outputMint,
        inputAmount: opts.amount,
        inputAmountRaw: normalizedRaw,
        outputAmount: "4000000",
        estimatedRate: 1,
        slippage: opts.slippageBps / 100,
        isGraduated: false,
      };
    };
    (swapManager.pumpFunClient as any).createSwapTransaction = async () => [
      {} as TransactionInstruction,
    ];

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "LowDecToken",
      tokenDecimals: 2,
      availableTokenAmountRaw: 375, // 3.75 tokens available
      tokenTicker: "LDEC",
    });

    expect(result.swapped).toBe(true);
    expect(result.provider).toBe("pump-fun");
    expect(requestedAmounts.length).toBeGreaterThan(0);
    const firstAmount = requestedAmounts[0]!;
    expect(firstAmount).not.toBe("0");
    expect(firstAmount).not.toBe("0.00");
    const rawUnits = BigInt(firstAmount.replace(".", ""));
    expect(rawUnits > 0n).toBe(true);
  });

  test("refunds sponsored lamports when Jupiter swap fails", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "jupiter";
    (swapManager as any).jupiterClient.getQuote = async () => ({
      inputMint: "TokenMint",
      outputMint: WSOL_MINT,
      inAmount: "1000000",
      outAmount: "4000000",
      otherAmountThreshold: "0",
      swapMode: "ExactOut",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      totalTime: 0,
    });
    (swapManager as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: "BASE64",
    });
    (swapManager as any).executeJupiterTransaction = async () => {
      throw new Error("Jupiter execution failed");
    };

    const sponsorCalls: number[] = [];
    const refundCalls: number[] = [];
    (swapManager as any).sponsorSwapFees = async (
      _kp: Keypair,
      lamports: number
    ) => {
      sponsorCalls.push(lamports);
    };
    (swapManager as any).refundSponsoredFees = async (
      _kp: Keypair,
      lamports: number
    ) => {
      refundCalls.push(lamports);
    };

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 5_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(false);
    expect(result.error).toMatch(/Jupiter execution failed/);
    expect(sponsorCalls).toEqual([TEST_JIT_BUFFER_LAMPORTS, TEST_JIT_BUFFER_LAMPORTS]);
    expect(refundCalls).toEqual([TEST_JIT_BUFFER_LAMPORTS, TEST_JIT_BUFFER_LAMPORTS]);
  });

  test("ensureJupiterSwapFeeBudget deduplicates concurrent requests", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };

    let sponsorCount = 0;
    (swapManager as any).sponsorSwapFees = async () => {
      sponsorCount++;
      await new Promise((resolve) => setTimeout(resolve, 30));
    };

    const user = Keypair.generate();
    await Promise.all([
      (swapManager as any).ensureJupiterSwapFeeBudget(user),
      (swapManager as any).ensureJupiterSwapFeeBudget(user),
    ]);

    expect(sponsorCount).toBe(1);
  });

  test("composite pump.fun+jupiter surfaces Jupiter failure after pump leg", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const adminCompositeFailure = Keypair.generate();
    (wallet as any).adminKeypair = adminCompositeFailure;
    (wallet as any).getAdminKeypair = () => adminCompositeFailure;

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    let balanceCall = 0;
    const intermediateLamports = 3_200_000;
    (swapManager as any).createTokenAccountsIfNeeded = async () => [];
    (swapManager as any).connection = {
      getBalance: async () => {
        const value = balanceCall === 0 ? 0 : intermediateLamports;
        balanceCall = Math.min(balanceCall + 1, 1);
        return value;
      },
    };
    (swapManager as any).getBestProvider = async () => "jupiter";
    (swapManager as any).pumpFunClient.createSwapTransaction = async () => [
      {} as TransactionInstruction,
    ];
    const pumpOps: string[] = [];
    (wallet as any).sendAndConfirmWithResubmits = async (
      _ixs: TransactionInstruction[],
      _signers: Keypair[],
      opts: { operationLabel?: string }
    ) => {
      pumpOps.push(opts.operationLabel ?? "unknown");
      return opts.operationLabel ?? "pump";
    };

    (swapManager as any).getJupiterQuote = async () => ({
      inputMint: WSOL_MINT,
      outputMint: "TARGET",
      inAmount: (intermediateLamports - 10_000).toString(),
      outAmount: "5000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      totalTime: 0,
    });

    (swapManager as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: "BASE64",
    });

    (swapManager as any).executeJupiterTransaction = async () => {
      throw new Error("Jupiter leg failure");
    };

    const user = Keypair.generate();
    const request = {
      inputMint: "PUMP",
      outputMint: "TARGET",
      amount: "0",
      userKeypair: user,
      slippageBps: 100,
      inputDecimals: 6,
      outputDecimals: 6,
      inputTicker: "PUMP",
      outputTicker: "TOK",
    } as const;

    const pumpQuote: PumpFunQuote = {
      inputMint: "PUMP",
      outputMint: WSOL_MINT,
      inputAmount: "100000",
      inputAmountRaw: "100000",
      outputAmount: "3200000",
      estimatedRate: 1,
      slippage: 1,
      isGraduated: true,
    };

    const jupiterQuote: JupiterQuoteResponse = {
      inputMint: WSOL_MINT,
      outputMint: "TARGET",
      inAmount: (intermediateLamports - 10_000).toString(),
      outAmount: "5000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      totalTime: 0,
    };

    const composite: NonNullable<SwapQuote["composite"]> = {
      flow: "pump-then-jupiter",
      intermediateMint: WSOL_MINT,
      intermediateAmount: intermediateLamports.toString(),
      pumpQuote,
      jupiterQuote,
    };

    const quote: SwapQuote = {
      provider: "pump-fun+jupiter" as const,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputAmount: "0",
      inputAmountRaw: "0",
      outputAmount: "0",
      estimatedRate: 0,
      slippage: 1,
      composite,
    } satisfies SwapQuote;

    await expect(
      swapManager.executeCompositePumpFunJupiterSwap(request, quote)
    ).rejects.toThrow("Jupiter leg failure");
    expect(pumpOps).toContain("Pump.fun leg");
  });

  test("composite swap logs but resolves when refund fails", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const adminCompositeRefund = Keypair.generate();
    (wallet as any).adminKeypair = adminCompositeRefund;
    (wallet as any).getAdminKeypair = () => adminCompositeRefund;

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };

    const sendCalls: {
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }[] = [];
    (wallet as any).sendAndConfirmWithResubmits = async (
      ixs: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions: ixs, signers });
      return `SIG_${sendCalls.length}`;
    };
    (wallet as any).confirmTransaction = async () => {};

    (swapManager as any).createTokenAccountsIfNeeded = async () => [];
    (swapManager as any).pumpFunClient.createSwapTransaction = async () => [
      {} as TransactionInstruction,
    ];
    (swapManager as any).jupiterClient.getQuote = async () => ({
      inputMint: WSOL_MINT,
      outputMint: "TARGET",
      inAmount: "1000000",
      outAmount: "5000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      totalTime: 0,
    });
    (swapManager as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: "BASE64",
    });
    (swapManager as any).executeJupiterTransaction = async () => ({
      signature: "SIG_JUP",
      estimatedFee: 0,
    });

    let sponsorCalls = 0;
    (swapManager as any).sponsorSwapFees = async () => {
      sponsorCalls += 1;
    };

    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    (swapManager as any).refundSponsoredFees = async () => {
      throw new Error("refund failure");
    };

    const request = {
      inputMint: "PUMP",
      outputMint: "TARGET",
      amount: "0",
      userKeypair: Keypair.generate(),
      slippageBps: 100,
      inputDecimals: 6,
      outputDecimals: 6,
      inputTicker: "PUMP",
      outputTicker: "TOK",
    } as const;

    const intermediateLamports = 3_200_000;
    const pumpQuote: PumpFunQuote = {
      inputMint: "PUMP",
      outputMint: WSOL_MINT,
      inputAmount: "100000",
      inputAmountRaw: "100000",
      outputAmount: intermediateLamports.toString(),
      estimatedRate: 1,
      slippage: 1,
      isGraduated: true,
    };

    const jupiterQuote = {
      inputMint: WSOL_MINT,
      outputMint: "TARGET",
      inAmount: (intermediateLamports - 10_000).toString(),
      outAmount: "5000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      totalTime: 0,
    };

    const composite: NonNullable<SwapQuote["composite"]> = {
      flow: "pump-then-jupiter",
      intermediateMint: WSOL_MINT,
      intermediateAmount: intermediateLamports.toString(),
      pumpQuote,
      jupiterQuote,
    };

    const quote: SwapQuote = {
      provider: "pump-fun+jupiter",
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputAmount: "0",
      inputAmountRaw: "0",
      outputAmount: "0",
      estimatedRate: 0,
      slippage: 1,
      composite,
    } satisfies SwapQuote;

    const result = await swapManager.executeCompositePumpFunJupiterSwap(
      request,
      quote
    );

    expect(result.pumpSignature).toBe("SIG_1");
    expect(result.jupiterSignature).toBe("SIG_JUP");
    expect(errorSpy.mock.calls[0]?.[0]).toContain(
      "Failed to refund sponsored swap fees after composite"
    );
    expect((swapManager as any).jupiterFeeSponsorships.size).toBe(0);
    errorSpy.mockRestore();
  });

  test("concurrent JIT swaps across tokens sponsor separately", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "jupiter";
    (swapManager as any).jupiterClient.getQuote = async ({
      amount,
    }: {
      amount: string;
    }) => ({
      inputMint: "TOKEN",
      outputMint: WSOL_MINT,
      inAmount: amount,
      outAmount: "1000",
      otherAmountThreshold: "0",
      swapMode: "ExactOut",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
    });
    (swapManager as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
    });
    (swapManager as any).executeJupiterTransaction = async () => ({
      signature: "SIG_JUP",
      estimatedFee: 0,
    });

    const sponsorCalls: number[] = [];
    (swapManager as any).sponsorSwapFees = async (_kp: Keypair, lamports: number) => {
      sponsorCalls.push(lamports);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    const refundCalls: number[] = [];
    (swapManager as any).refundSponsoredFees = async (
      _kp: Keypair,
      lamports: number
    ) => {
      refundCalls.push(lamports);
    };

    const user = Keypair.generate();
    const tokens = ["TOKEN_A", "TOKEN_B"];
    const swapPromises = tokens.map((token) =>
      swapManager.performJustInTimeSolSwap({
        userKeypair: user,
        tokenMint: token,
        tokenDecimals: 6,
        availableTokenAmountRaw: 12_000_000,
        tokenTicker: "TEST",
      })
    );

    const results = await Promise.all(swapPromises);
    expect(results.every((result) => result.swapped)).toBe(true);
    expect(sponsorCalls.length).toBe(tokens.length);
    expect(refundCalls.length).toBe(tokens.length);
  });

});
