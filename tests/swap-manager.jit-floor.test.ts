import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";

describe("SwapManager JIT floor", () => {
  test("Tiny SOL top-ups are floored to 0.01 SOL", async () => {
    const user = Keypair.generate();

    // Keep buffers small so the natural target stays below the 0.01 SOL floor
    const feeBudget = {
      getGameSafetyBufferLamports: async () => 2_000_000, // 0.002 SOL
      getJitSwapFeeBufferLamports: async () => 100_000, // 0.0001 SOL
    } as any;

    const connection = {
      getBalance: async () => 0,
    } as any;

    const swapManager = new SwapManager(connection, {} as any, feeBudget);

    // Record the request amount Jupiter sees
    let requestedLamports = "0";
    (swapManager as any).getJupiterQuote = async (params: any) => {
      requestedLamports = params.amount;
      // First call: probe (1,000,000 in -> 2,000,000 out)
      if (params.amount === "1000000") {
        return {
          inputMint: params.inputMint,
          outputMint: params.outputMint,
          inAmount: "1000000",
          outAmount: "2000000",
          otherAmountThreshold: "0",
          swapMode: "ExactIn",
          slippageBps: 50,
          priceImpactPct: "0",
          routePlan: [],
          requestId: "req-probe",
        };
      }

      // Second call: final quote must exceed target (10,000,000)
      return {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: params.amount,
        outAmount: "12000000",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 50,
        priceImpactPct: "0",
        routePlan: [],
        requestId: "req-final",
      };
    };

    (swapManager as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("tx").toString("base64"),
      requestId: "req-floor",
    });

    (swapManager as any).executeJupiterTransaction = async () => "SIG";

    const result = await swapManager.performJustInTimeSolSwap({
      userKeypair: user,
      tokenMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      tokenDecimals: 6,
      availableTokenAmountRaw: 2_000_000, // small balance to exercise probe path
      desiredLamports: 2_000_000, // 0.002 SOL shortfall
      tokenTicker: "TIMBA",
      logContext: "test",
    });

    expect(result.swapped).toBeTrue();
    expect(result.lamportsReceived).toBe(3_600_000); // target + buffers
    expect(requestedLamports).toBe("1890000"); // sized by probe-based ExactIn calc
  });
});
