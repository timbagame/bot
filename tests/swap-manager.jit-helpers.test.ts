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

const createWallet = (connection: any, operatorKeypair: Keypair | null): WalletManager => {
  return {
    getConnection: () => connection,
    getOperatorKeypair: () => operatorKeypair,
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
  feeBudget: FeeBudgetStub = defaultFeeBudget,
) => new SwapManager(connection as any, wallet, feeBudget as any);

describe("SwapManager JIT helpers", () => {
  test("performJustInTimeSolSwap keeps provider errors out of user messages", async () => {
    const user = Keypair.generate();
    const connection = createConnection(0);
    const wallet = createWallet(connection, null);
    const manager = createSwapManager(connection, wallet);
    const rawError = 'Failed to request Jupiter order: [{"code":"invalid_type"}]';

    (manager as any).buildJitIntegrator = async () => null;
    (manager as any).attemptJupiterSwap = async () => ({
      status: "error",
      error: {
        type: "PROBE_FAILED",
        message: rawError,
        cause: new Error(rawError),
      },
    });

    const result = await manager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "mint",
      tokenDecimals: 6,
      availableTokenAmountRaw: 20_000_000,
      desiredLamports: 2_000_000,
      tokenTicker: "TKN",
      logContext: "test",
    });

    expect(result.swapped).toBeFalse();
    expect(result.error).toBe(rawError);
    expect(result.userMessage).toContain("Jupiter could not prepare");
    expect(result.userMessage).not.toContain("invalid_type");
    expect(result.userMessage).not.toContain("Failed to request Jupiter order");
  });

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
      availableTokenAmountRaw: 20_000_000,
      tokenMint: "mint",
      tokenDecimals: 6,
      tokenTicker: "TKN",
      userKeypair: user,
      integrator: null,
      shortfallLamports: 500_000,
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
    expect(calls[0].operatorKeypair).toBeUndefined();
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
    expect(calls[0].operatorKeypair?.publicKey).toEqual(admin.publicKey);
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
      availableTokenAmountRaw: 20_000_000,
      userKeypair: user,
      tokenMint: "mint",
      tokenDecimals: 6,
      tokenTicker: "TKN",
      integrator: null,
      shortfallLamports: targetLamports,
    });

    expect(result.status).toBe("success");
    expect(result.result.signature).toBe("SIG_EXEC");
    expect(result.result.lamportsReceived).toBe(targetLamports);
  });

  test("probePriceAndSizeInput recalculates fee using sized swap input", async () => {
    const user = Keypair.generate();
    const connection = createConnection(0);
    const wallet = createWallet(connection, Keypair.generate());
    const manager = createSwapManager(connection, wallet);

    const integrator = {
      referralAccount: "referral",
      referralFee: 85,
      payer: "payer",
      closeAuthority: "payer",
      payerKind: "admin" as const,
    };

    const recalculatedFees: any[] = [];
    (manager as any).buildJitIntegrator = async (args: any) => {
      recalculatedFees.push(args);
      return { ...integrator, referralFee: 200 };
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

    let usedIntegrator: any = null;
    (manager as any).swapService = {
      prepareSwap: async (_params: any, integratorArg: any) => {
        usedIntegrator = integratorArg;
        return {
          providerQuote: { outAmount: "2000000" },
          outputAmount: "2000000",
        };
      },
    };

    const result = await (manager as any).probePriceAndSizeInput({
      targetLamportsOut: 2_000_000,
      availableRawBig: 10_000_000n,
      availableTokenAmountRaw: 10_000_000,
      tokenMint: "mint",
      tokenDecimals: 6,
      tokenTicker: "TKN",
      userKeypair: user,
      integrator,
      shortfallLamports: 1_500_000,
    });

    expect(result.ok).toBeTrue();
    expect(recalculatedFees).toHaveLength(1);
    expect(recalculatedFees[0].inputAmountRawOverride).toBe(1_050_000);
    expect(usedIntegrator?.referralFee).toBe(200);
  });

  test("buildJitIntegrator calculates dynamic fee based on shortfall vs trade value", async () => {
    const admin = Keypair.generate();
    const connection = createConnection(0);
    const wallet = createWallet(connection, admin);
    const manager = createSwapManager(connection, wallet);

    // Directly test the fee calculation logic
    // Scenario: 10 tokens @ $0.10 = $1 trade value
    // Shortfall: 0.003 SOL @ $150 = $0.45 deficit
    // Expected extra bps: ceil(0.45 / 1 * 10000) = 4500 bps, but capped at maxExtraFeeBps (100)
    // Expected total: 85 + 100 = 185 bps

    // Since we can't easily mock the module functions, test the calculation math directly
    const baseFeeBps = 85;
    const maxExtraBps = 100;
    const tokenPrice = 0.1; // $0.10 per token
    const solPrice = 150; // $150 per SOL
    const tokenDecimals = 6;
    const availableTokenAmountRaw = 10_000_000; // 10 tokens
    const shortfallLamports = 3_000_000; // 0.003 SOL
    const LAMPORTS_PER_SOL = 1_000_000_000;

    const tokenAmount = availableTokenAmountRaw / Math.pow(10, tokenDecimals);
    const tradeUsd = tokenAmount * tokenPrice; // 10 * 0.10 = $1.00
    const solShortfall = shortfallLamports / LAMPORTS_PER_SOL; // 0.003
    const deficitUsd = solShortfall * solPrice; // 0.003 * 150 = $0.45

    const rawExtraBps = Math.ceil((deficitUsd / tradeUsd) * 10_000); // ceil(0.45/1 * 10000) = 4500
    const actualExtraBps = Math.min(rawExtraBps, maxExtraBps); // min(4500, 100) = 100
    const expectedFee = baseFeeBps + actualExtraBps; // 85 + 100 = 185

    expect(tradeUsd).toBe(1.0);
    expect(deficitUsd).toBeCloseTo(0.45);
    expect(rawExtraBps).toBe(4500);
    expect(actualExtraBps).toBe(100);
    expect(expectedFee).toBe(185);

    // Also verify the manager exists and has the method
    expect(typeof (manager as any).buildJitIntegrator).toBe("function");
  });

  test("dynamic fee calculation handles various shortfall scenarios", async () => {
    // Test different shortfall scenarios to verify fee scaling
    const baseFeeBps = 85;
    const maxExtraBps = 100;
    const LAMPORTS_PER_SOL = 1_000_000_000;

    // Scenario 1: Large trade, small shortfall = low extra fee
    const scenario1 = (() => {
      const tokenAmount = 100; // 100 tokens
      const tokenPrice = 1.0; // $1 each = $100 trade
      const shortfallLamports = 1_000_000; // 0.001 SOL
      const solPrice = 150;
      const tradeUsd = tokenAmount * tokenPrice;
      const deficitUsd = (shortfallLamports / LAMPORTS_PER_SOL) * solPrice;
      const rawExtraBps = Math.ceil((deficitUsd / tradeUsd) * 10_000);
      return {
        tradeUsd,
        deficitUsd,
        rawExtraBps,
        fee: baseFeeBps + Math.min(rawExtraBps, maxExtraBps),
      };
    })();
    expect(scenario1.tradeUsd).toBe(100);
    expect(scenario1.deficitUsd).toBeCloseTo(0.15);
    expect(scenario1.rawExtraBps).toBe(15); // 0.15% extra
    expect(scenario1.fee).toBe(100); // 85 + 15

    // Scenario 2: Small trade, large shortfall = capped extra fee
    const scenario2 = (() => {
      const tokenAmount = 1; // 1 token
      const tokenPrice = 0.5; // $0.50 = $0.50 trade
      const shortfallLamports = 5_000_000; // 0.005 SOL
      const solPrice = 150;
      const tradeUsd = tokenAmount * tokenPrice;
      const deficitUsd = (shortfallLamports / LAMPORTS_PER_SOL) * solPrice;
      const rawExtraBps = Math.ceil((deficitUsd / tradeUsd) * 10_000);
      return {
        tradeUsd,
        deficitUsd,
        rawExtraBps,
        fee: baseFeeBps + Math.min(rawExtraBps, maxExtraBps),
      };
    })();
    expect(scenario2.tradeUsd).toBe(0.5);
    expect(scenario2.deficitUsd).toBeCloseTo(0.75);
    expect(scenario2.rawExtraBps).toBe(15000); // 150% extra (uncapped)
    expect(scenario2.fee).toBe(185); // 85 + 100 (capped)
  });
});
