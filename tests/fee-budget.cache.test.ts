import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { FeeBudgetManager } from "../src/utils/fee-budget";

const baseConnection = {
  rpcEndpoint: "http://localhost:8899",
  getLatestBlockhash: async () => ({ blockhash: "abc", lastValidBlockHeight: 99 }),
  getFeeForMessage: async () => 5_000,
  getRecentPrioritizationFees: async () => [],
} as any;

let previousEnv: string | undefined;

beforeEach(() => {
  previousEnv = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "test";
});

afterEach(() => {
  if (previousEnv === undefined) {
    delete process.env["NODE_ENV"];
  } else {
    process.env["NODE_ENV"] = previousEnv;
  }
});

describe("FeeBudgetManager caching and fallbacks", () => {
  test("getOrCompute returns fallback when compute yields non-positive and no stale", async () => {
    const manager = FeeBudgetManager.createForTest(baseConnection, {
      fallbackSingleTxLamports: 42,
    }) as any;

    const value = await manager.getOrCompute("single", async () => 0);
    expect(value).toBe(42);
  });

  test("getOrCompute reuses stale value when compute result invalid", async () => {
    const manager = FeeBudgetManager.createForTest(baseConnection, {
      fallbackSingleTxLamports: 50,
    }) as any;
    manager.cache.setWithTTL("jit", 123);

    const value = await manager.getOrCompute("jit", async () => -1);
    expect(value).toBe(123);
  });

  test("wrap/jit/game buffers respect min thresholds", async () => {
    const manager = FeeBudgetManager.createForTest(baseConnection, {
      wrapBufferMultiplier: 0.1,
      wrapBufferExtraLamports: 1,
      wrapBufferMinLamports: 75_000,
      jitBufferMultiplier: 0.1,
      jitBufferExtraLamports: 1,
      jitBufferMinLamports: 90_000,
      gameBufferMultiplier: 0.1,
      gameBufferExtraLamports: 1,
      gameBufferMinLamports: 120_000,
      fallbackSingleTxLamports: 60_000,
    });

    expect(await manager.getWrapFeeBufferLamports()).toBe(75_000);
    expect(await manager.getJitSwapFeeBufferLamports()).toBe(90_000);
    expect(await manager.getGameSafetyBufferLamports()).toBeGreaterThanOrEqual(120_000);
  });

  test("computeSingleTransaction uses production fees and caches result", async () => {
    process.env["NODE_ENV"] = "production";
    let feeCalls = 0;
    const connection = {
      ...baseConnection,
      async getFeeForMessage() {
        feeCalls += 1;
        return 10_000;
      },
      async getRecentPrioritizationFees() {
        return [{ prioritizationFee: 2_000_000 }];
      },
    } as any;

    const manager = FeeBudgetManager.createForTest(connection, {
      fallbackSingleTxLamports: 5_000,
      singleTxMultiplier: 1.5,
      singleTxExtraLamports: 1_000,
      computeUnitLimit: 200_000,
    });

    const value = await manager.getSingleTransactionLamports();
    expect(value).toBeGreaterThan(5_000);
    expect(feeCalls).toBe(1);
    expect(await manager.getSingleTransactionLamports()).toBe(value);
    expect(feeCalls).toBe(1);
  });

  test("estimatePriorityFee handles invalid RPC responses gracefully", async () => {
    process.env["NODE_ENV"] = "production";
    const connection = {
      ...baseConnection,
      async getRecentPrioritizationFees() {
        return [{ prioritizationFee: "not-a-number" }];
      },
    } as any;

    const manager = FeeBudgetManager.createForTest(connection);
    const priority = await (manager as any).estimatePriorityFee();
    expect(priority).toBe(0);
  });

  test("fallback calculators respect configured minimums (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          fallbackSingleTxLamports: fc.integer({ min: 1, max: 500_000 }),
          wrapBufferExtraLamports: fc.integer({ min: 0, max: 200_000 }),
          wrapBufferMinLamports: fc.integer({ min: 1, max: 300_000 }),
          jitBufferExtraLamports: fc.integer({ min: 0, max: 200_000 }),
          jitBufferMinLamports: fc.integer({ min: 1, max: 300_000 }),
          gameBufferMultiplier: fc.float({ min: 0.5, max: 5 }),
          gameBufferExtraLamports: fc.integer({ min: 0, max: 400_000 }),
          gameBufferMinLamports: fc.integer({ min: 1, max: 600_000 }),
        }),
        async (config: {
          fallbackSingleTxLamports: number;
          wrapBufferExtraLamports: number;
          wrapBufferMinLamports: number;
          jitBufferExtraLamports: number;
          jitBufferMinLamports: number;
          gameBufferMultiplier: number;
          gameBufferExtraLamports: number;
          gameBufferMinLamports: number;
        }) => {
          const manager = FeeBudgetManager.createForTest(baseConnection, config) as any;
          const wrapFallback = manager.getFallbackForKey("wrap");
          const jitFallback = manager.getFallbackForKey("jit");
          const gameFallback = manager.getFallbackForKey("game");

          expect(wrapFallback).toBeGreaterThanOrEqual(config.wrapBufferMinLamports);
          expect(jitFallback).toBeGreaterThanOrEqual(config.jitBufferMinLamports);
          expect(gameFallback).toBeGreaterThanOrEqual(config.gameBufferMinLamports);
        }
      ),
      { numRuns: 25, seed: 6789 }
    );
  });
});
