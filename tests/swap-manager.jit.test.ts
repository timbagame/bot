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
import {
  MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
  JIT_SWAP_FEE_BUFFER_LAMPORTS,
  WSOL_MINT,
} from "../src/utils/constants";

describe("SwapManager.performJustInTimeSolSwap", () => {
  const mnemonic = "test walk nut penalty hip pave soap entry language right filter choice";
  const connection = new Connection("http://localhost:8899", "confirmed");

  beforeEach(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  });

  test("returns without swapping when SOL balance already sufficient", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const swapManager = new SwapManager(connection, wallet);
    (swapManager as any).connection = {
      getBalance: async () => MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS,
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

    const swapManager = new SwapManager(connection, wallet);
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

    const swapManager = new SwapManager(connection, wallet);
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
      availableTokenAmountRaw: MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS * 2,
      tokenTicker: "SOL",
    });

    expect(result.swapped).toBe(true);
    expect(result.provider).toBe("unwrap");
    expect(result.signature).toBe("SIG_UNWRAP");
    expect(result.lamportsReceived).toBe(
      MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS + JIT_SWAP_FEE_BUFFER_LAMPORTS
    );
    expect(unwrapRequests).toEqual([
      MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS + JIT_SWAP_FEE_BUFFER_LAMPORTS,
    ]);
    expect(sponsorCalls).toEqual([JIT_SWAP_FEE_BUFFER_LAMPORTS]);
    expect(refundCalls).toEqual([JIT_SWAP_FEE_BUFFER_LAMPORTS]);
  });

  test("returns helpful error when WSOL unwrap attempts fail", async () => {
    const wallet = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const admin = Keypair.generate();
    (wallet as any).getAdminKeypair = () => admin;

    const swapManager = new SwapManager(connection, wallet);
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
      availableTokenAmountRaw: MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS * 2,
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

    const swapManager = new SwapManager(connection, wallet);
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

    const swapManager = new SwapManager(connection, wallet);
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
      MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS + JIT_SWAP_FEE_BUFFER_LAMPORTS
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
    const swapManager = new SwapManager(connection, wallet);

    const user = Keypair.generate();
    const totalRaw = MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS + 500_000;
    const unwrapLamports = MIN_SOL_BALANCE_FOR_GAMES_LAMPORTS;

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
});
