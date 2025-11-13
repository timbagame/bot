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
import type { FeeBudgetProvider } from "../src/utils/fee-budget";

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
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 1_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(false);
    expect(result.error).toMatch(/Need/);
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

    const unwrapRequests: number[] = [];
    const unwrapLamports = TEST_GAME_BUFFER_LAMPORTS + TEST_JIT_BUFFER_LAMPORTS;
    (wallet as any).buildUnwrapWsolPlan = async ({
      amountLamports,
    }: {
      amountLamports?: number;
    }) => {
      unwrapRequests.push(amountLamports ?? 0);
      return {
        instructions: [],
        unwrapLamports: amountLamports ?? unwrapLamports,
        remainingLamports: 0,
      };
    };
    const sendCalls: Array<{
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }> = [];
    (wallet as any).sendAndConfirmWithResubmits = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions, signers });
      return "SIG_UNWRAP";
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
    expect(sendCalls.length).toBe(1);
    const sendCall = sendCalls[0]!;
    expect(sendCall.signers.length).toBe(2);
    expect(sendCall.signers[0]?.publicKey.equals(admin.publicKey)).toBe(true);
    expect(sendCall.signers[1]?.publicKey.equals(user.publicKey)).toBe(true);
    expect(sendCall.instructions.length).toBe(2);

    const loanIx = sendCall.instructions[0]!;
    const refundIx = sendCall.instructions[1]!;

    const loanDecoded = SystemInstruction.decodeTransfer(loanIx);
    expect(loanDecoded.fromPubkey.equals(admin.publicKey)).toBe(true);
    expect(loanDecoded.toPubkey.equals(user.publicKey)).toBe(true);
    expect(Number(loanDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);

    const refundDecoded = SystemInstruction.decodeTransfer(refundIx);
    expect(refundDecoded.fromPubkey.equals(user.publicKey)).toBe(true);
    expect(refundDecoded.toPubkey.equals(admin.publicKey)).toBe(true);
    expect(Number(refundDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);
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
    (wallet as any).buildUnwrapWsolPlan = async ({
      amountLamports,
    }: {
      amountLamports?: number;
    }) => {
      unwrapRequests.push(amountLamports ?? 0);
      return {
        instructions: [],
        unwrapLamports: amountLamports ?? 0,
        remainingLamports: 0,
      };
    };
    const sendCalls: Array<{
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }> = [];
    (wallet as any).sendAndConfirmWithResubmits = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions, signers });
      return "SIG_UNWRAP_OVER_BUFFER";
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
      TEST_GAME_BUFFER_LAMPORTS - currentLamports + TEST_JIT_BUFFER_LAMPORTS
    );
    expect(unwrapRequests).toEqual([
      TEST_GAME_BUFFER_LAMPORTS - currentLamports + TEST_JIT_BUFFER_LAMPORTS,
    ]);
    expect(sendCalls.length).toBe(1);
    const sendCall = sendCalls[0]!;
    expect(sendCall.signers.length).toBe(1);
    expect(sendCall.signers[0]?.publicKey.equals(user.publicKey)).toBe(true);
    expect(sendCall.instructions).toEqual([]);
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

    let unwrapAttempts = 0;
    (wallet as any).buildUnwrapWsolPlan = async () => {
      unwrapAttempts += 1;
      throw new Error("Unable to unwrap due to rent exempt requirement.");
    };

    const sendCalls: Array<{
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }> = [];
    (wallet as any).sendAndConfirmWithResubmits = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions, signers });
      return "SIG_FAIL";
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
    expect(sendCalls).toHaveLength(0);
  });

  test("executes pump.fun swap with admin as fee payer", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;
    const sendCalls: Array<{
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }> = [];
    (wallet as any).sendTransaction = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions, signers });
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
    expect(sendCalls.length).toBe(1);
    const sendCall = sendCalls[0]!;
    expect(sendCall.signers[0]?.publicKey.equals(admin.publicKey)).toBe(true);
    expect(sendCall.signers[1]?.publicKey.equals(user.publicKey)).toBe(true);

    const loanIx = sendCall.instructions[0]!;
    const refundIx = sendCall.instructions[sendCall.instructions.length - 1]!;

    const loanDecoded = SystemInstruction.decodeTransfer(loanIx);
    expect(loanDecoded.fromPubkey.equals(admin.publicKey)).toBe(true);
    expect(loanDecoded.toPubkey.equals(user.publicKey)).toBe(true);
    expect(Number(loanDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);

    const refundDecoded = SystemInstruction.decodeTransfer(refundIx);
    expect(refundDecoded.fromPubkey.equals(user.publicKey)).toBe(true);
    expect(refundDecoded.toPubkey.equals(admin.publicKey)).toBe(true);
    expect(Number(refundDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);
  });

  test("pump.fun swap skips lending when balance equals jit buffer", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const sendCalls: Array<{
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }> = [];
    (wallet as any).sendTransaction = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions, signers });
      return "SIG_PUMP_NO_LEND";
    };
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => TEST_JIT_BUFFER_LAMPORTS,
    };
    (swapManager as any).getBestProvider = async () => "pump-fun";
    (swapManager.pumpFunClient as any).getQuote = async () => ({
      inputMint: "TokenMint",
      outputMint: WSOL_MINT,
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "4000000",
      estimatedRate: 1,
      slippage: 2.5,
      isGraduated: false,
    });
    const stubInstructions: TransactionInstruction[] = [{} as TransactionInstruction];
    (swapManager.pumpFunClient as any).createSwapTransaction = async () =>
      stubInstructions;

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
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.instructions).toEqual(stubInstructions);
  });

  test("pump.fun swap surfaces sendAndConfirm failure", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;
    (wallet as any).sendAndConfirmWithResubmits = async () => {
      throw new Error("pump failure");
    };
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "pump-fun";
    (swapManager.pumpFunClient as any).getQuote = async () => ({
      inputMint: "TokenMint",
      outputMint: WSOL_MINT,
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "4000000",
      estimatedRate: 1,
      slippage: 2.5,
      isGraduated: false,
    });
    (swapManager.pumpFunClient as any).createSwapTransaction = async () => [
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

    expect(result.swapped).toBe(false);
    expect(result.error).toContain("pump failure");
  });

  test("pump.fun lending caps loan at jit buffer even when target large", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const sendCalls: Array<{
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }> = [];
    (wallet as any).sendTransaction = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions, signers });
      return "SIG_PUMP_BIG";
    };
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "pump-fun";
    (swapManager.pumpFunClient as any).getQuote = async () => ({
      inputMint: "TokenMint",
      outputMint: WSOL_MINT,
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "4000000",
      estimatedRate: 1,
      slippage: 2.5,
      isGraduated: false,
    });
    (swapManager.pumpFunClient as any).createSwapTransaction = async () => [
      {} as TransactionInstruction,
    ];

    const user = Keypair.generate();
    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "TokenMint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 10_000_000_000,
      tokenTicker: "TEST",
    });

    expect(result.swapped).toBe(true);
    expect(sendCalls.length).toBe(1);
    const sendCall = sendCalls[0]!;
    const loanIx = sendCall.instructions[0]!;
    const refundIx = sendCall.instructions[sendCall.instructions.length - 1]!;
    const loanDecoded = SystemInstruction.decodeTransfer(loanIx);
    expect(Number(loanDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);
    const refundDecoded = SystemInstruction.decodeTransfer(refundIx);
    expect(Number(refundDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);
  });

  test("pump.fun lending handles concurrent swaps for the same user", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;
    const sendCalls: Array<{
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }> = [];
    (wallet as any).sendAndConfirmWithResubmits = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      sendCalls.push({ instructions, signers });
      return `SIG_CONC_${sendCalls.length}`;
    };
    (wallet as any).confirmTransaction = async () => {};

    const swapManager = new SwapManager(connection, wallet, createFeeBudgetStub());
    (swapManager as any).connection = {
      getBalance: async () => 0,
    };
    (swapManager as any).getBestProvider = async () => "pump-fun";
    (swapManager.pumpFunClient as any).getQuote = async () => ({
      inputMint: "TokenMint",
      outputMint: WSOL_MINT,
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "4000000",
      estimatedRate: 1,
      slippage: 2.5,
      isGraduated: false,
    });
    (swapManager.pumpFunClient as any).createSwapTransaction = async () => [
      {} as TransactionInstruction,
    ];

    const user = Keypair.generate();
    const requests = await Promise.all([
      swapManager.performJustInTimeSolSwap({
        userKeypair: user,
        tokenMint: "TokenMint",
        tokenDecimals: 6,
        availableTokenAmountRaw: 10_000_000,
        tokenTicker: "TEST",
      }),
      swapManager.performJustInTimeSolSwap({
        userKeypair: user,
        tokenMint: "TokenMint",
        tokenDecimals: 6,
        availableTokenAmountRaw: 10_000_000,
        tokenTicker: "TEST",
      }),
    ]);

    expect(requests.every((r) => r.swapped)).toBe(true);
    expect(sendCalls.length).toBe(2);
    for (const sendCall of sendCalls) {
      expect(sendCall.signers[0]?.publicKey.equals(admin.publicKey)).toBe(true);
      expect(sendCall.signers[1]?.publicKey.equals(user.publicKey)).toBe(true);

      const loanIx = sendCall.instructions[0]!;
      const refundIx =
        sendCall.instructions[sendCall.instructions.length - 1]!;
      const loanDecoded = SystemInstruction.decodeTransfer(loanIx);
      const refundDecoded = SystemInstruction.decodeTransfer(refundIx);
      expect(Number(loanDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);
      expect(Number(refundDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);
    }
  });

  test("skips lending lamports for successful Jupiter swap", async () => {
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
    (swapManager as any).executeJupiterTransaction = async () => "SIG_JUP";

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
    const sendCalls: Array<{
      instructions: TransactionInstruction[];
      signers: Keypair[];
    }> = [];
    (wallet as any).sendTransaction = async (
      instructions: TransactionInstruction[],
      signers: Keypair[]
    ) => {
      sendCalls.push({ instructions, signers });
      return "SIG_PUMP_LOW_DEC";
    };
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

    expect(sendCalls.length).toBe(1);
    const sendCall = sendCalls[0]!;
    expect(sendCall.signers[0]?.publicKey.equals(admin.publicKey)).toBe(true);
    expect(sendCall.signers[1]?.publicKey.equals(user.publicKey)).toBe(true);
    const loanIx = sendCall.instructions[0]!;
    const refundIx = sendCall.instructions[sendCall.instructions.length - 1]!;
    const loanDecoded = SystemInstruction.decodeTransfer(loanIx);
    expect(loanDecoded.fromPubkey.equals(admin.publicKey)).toBe(true);
    expect(loanDecoded.toPubkey.equals(user.publicKey)).toBe(true);
    expect(Number(loanDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);
    const refundDecoded = SystemInstruction.decodeTransfer(refundIx);
    expect(refundDecoded.fromPubkey.equals(user.publicKey)).toBe(true);
    expect(refundDecoded.toPubkey.equals(admin.publicKey)).toBe(true);
    expect(Number(refundDecoded.lamports)).toBe(TEST_JIT_BUFFER_LAMPORTS);
  });

  test("skips lending lamports when Jupiter swap fails", async () => {
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
  });
});
