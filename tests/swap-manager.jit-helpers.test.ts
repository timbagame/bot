import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";

import { SwapManager } from "../src/utils/swap-manager";
import type { WalletManager } from "../src/utils/wallet";

type FeeBudgetStub = {
  getGameSafetyBufferLamports: () => Promise<number>;
  getJitSwapFeeBufferLamports: () => Promise<number>;
};

const createConnection = (initialBalance = 0) => {
  let balance = initialBalance;
  return {
    getBalance: async () => balance,
    setBalance: (value: number) => {
      balance = value;
    },
  } as any;
};

const createWallet = (
  connection: any,
  adminKeypair: Keypair | null
): WalletManager => {
  return {
    getConnection: () => connection,
    getAdminKeypair: () => adminKeypair,
    formatSolBalance: (lamports: number) => `${lamports} lamports`,
    ensureAssociatedTokenAccount: async () => ({
      created: false,
      instructions: [],
      isToken2022: false,
    }),
  } as unknown as WalletManager;
};

const defaultFeeBudget: FeeBudgetStub = {
  getGameSafetyBufferLamports: async () => 1_000_000,
  getJitSwapFeeBufferLamports: async () => 500_000,
};

const createSwapManager = (
  connection: any,
  wallet: WalletManager,
  feeBudget: FeeBudgetStub = defaultFeeBudget
) => new SwapManager(connection as any, wallet, feeBudget as any);

describe("SwapManager JIT helpers", () => {
  test("computeTargets fails when no tokens are available", async () => {
    const user = Keypair.generate();
    const connection = createConnection(0);
    const wallet = createWallet(connection, null);
    const manager = createSwapManager(connection, wallet);

    const result = await (manager as any).computeTargets({
      userKeypair: user,
      availableTokenAmountRaw: 0,
      desiredLamports: 2_000_000,
      tokenTicker: "ABC",
    });

    expect(result.ok).toBeFalse();
    expect(result.error.type).toBe("INSUFFICIENT_TOKENS");
  });

  test("probePriceAndSizeInput surfaces zero-liquidity probes", async () => {
    const user = Keypair.generate();
    const connection = createConnection(0);
    const wallet = createWallet(connection, null);
    const manager = createSwapManager(connection, wallet);

    (manager as any).swapService = {
      prepareSwap: async () => {
        throw new Error("should not prepare swap when probe fails");
      },
    };

    (manager as any).getJupiterQuote = async () => ({
      inputMint: "TOKEN",
      outputMint: "SOL",
      inAmount: "1000000",
      outAmount: "0",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: "0",
      routePlan: [],
      requestId: "req-probe",
    });

    const result = await (manager as any).probePriceAndSizeInput({
      targetLamportsOut: 1_000_000,
      availableRawBig: 20_000_000n,
      tokenMint: "mint",
      tokenDecimals: 6,
      tokenTicker: "TKN",
      userKeypair: user,
      integrator: null,
    });

    expect(result.ok).toBeFalse();
    expect(result.error.type).toBe("ZERO_LIQUIDITY");
  });

  test("attemptWsolUnwrap unwraps without admin lending", async () => {
    const user = Keypair.generate();
    const connection = createConnection(0);
    const wallet = createWallet(connection, null);
    const manager = createSwapManager(connection, wallet);

    const calls: any[] = [];
    (manager as any).unwrapWsolPortion = async (args: any) => {
      calls.push(args);
      return { signature: "SIG", lamportsReceived: args.unwrapLamports };
    };

    const result = await (manager as any).attemptWsolUnwrap({
      target: 500_000,
      availableRaw: 1_000_000,
      currentLamports: 800_000,
      jitFeeBuffer: 100_000,
      userKeypair: user,
      logContext: "test",
    });

    expect(result.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0].adminKeypair).toBeUndefined();
    expect(calls[0].lendingLamports).toBe(0);
  });

  test("attemptWsolUnwrap requests admin lending when needed", async () => {
    const user = Keypair.generate();
    const admin = Keypair.generate();
    const connection = createConnection(0);
    const wallet = createWallet(connection, admin);
    const manager = createSwapManager(connection, wallet);

    const calls: any[] = [];
    (manager as any).unwrapWsolPortion = async (args: any) => {
      calls.push(args);
      return { signature: "SIG", lamportsReceived: args.unwrapLamports };
    };

    const result = await (manager as any).attemptWsolUnwrap({
      target: 1_200_000,
      availableRaw: 2_000_000,
      currentLamports: 100_000,
      jitFeeBuffer: 700_000,
      userKeypair: user,
      logContext: "test",
    });

    expect(result.status).toBe("success");
    expect(calls[0].adminKeypair?.publicKey).toEqual(admin.publicKey);
    expect(calls[0].lendingLamports).toBe(600_000);
  });

  test("attemptJupiterSwap executes when probe succeeds", async () => {
    const user = Keypair.generate();
    const connection = createConnection(0);
    const wallet = createWallet(connection, null);
    const manager = createSwapManager(connection, wallet);

    const targetLamports = 3_000_000;

    (manager as any).swapService = {
      prepareSwap: async (request: any) => ({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        inputAmountRaw: request.amount,
        providerQuote: { outAmount: `${targetLamports + 10}` },
        outputAmount: `${targetLamports + 10}`,
        integrator: null,
      }),
      execute: async () => "SIG_EXEC",
    };

    (manager as any).getJupiterQuote = async () => ({
      inputMint: "TOKEN",
      outputMint: "SOL",
      inAmount: "1000000",
      outAmount: "2000000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: "0",
      routePlan: [],
      requestId: "req-probe",
    });

    const result = await (manager as any).attemptJupiterSwap({
      targetLamportsOut: targetLamports,
      availableRawBig: 20_000_000n,
      userKeypair: user,
      tokenMint: "mint",
      tokenDecimals: 6,
      tokenTicker: "TKN",
      integrator: null,
    });

    expect(result.status).toBe("success");
    expect(result.result.signature).toBe("SIG_EXEC");
    expect(result.result.lamportsReceived).toBe(targetLamports);
  });
});
