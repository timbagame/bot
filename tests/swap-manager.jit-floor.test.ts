import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";

describe("SwapManager JIT floor", () => {
  test("ExactOut requests are floored to 0.01 SOL for tiny shortfalls", async () => {
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
      return {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        inAmount: "5000000",
        outAmount: params.amount,
        otherAmountThreshold: "0",
        swapMode: "ExactOut",
        slippageBps: 50,
        priceImpactPct: "0",
        routePlan: [],
        requestId: "req-floor",
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
      availableTokenAmountRaw: 1_000_000_000_000, // plenty
      desiredLamports: 2_000_000, // 0.002 SOL shortfall
      tokenTicker: "TIMBA",
      logContext: "test",
    });

    expect(result.swapped).toBeTrue();
    expect(result.lamportsReceived).toBe(10_000_000); // floored to 0.01 SOL
    expect(requestedLamports).toBe("10000000");
  });
});
