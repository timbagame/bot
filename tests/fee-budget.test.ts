import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Connection } from "@solana/web3.js";
import { FeeBudgetManager } from "../src/utils/fee-budget";

const createConnectionStub = (
  overrides: Partial<Connection> & { rpcEndpoint?: string } = {},
): Connection => {
  return {
    rpcEndpoint: "http://stub" as string,
    getLatestBlockhash: async () => ({
      blockhash: "hash",
      lastValidBlockHeight: 1,
      blockhashCommitment: "confirmed",
    }),
    getFeeForMessage: async () => ({
      context: { slot: 0 },
      value: 5_000,
    }),
    getRecentPrioritizationFees: async () => [{ prioritizationFee: "1200000" } as any],
    ...overrides,
  } as unknown as Connection;
};

describe("FeeBudgetManager", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let nowSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    process.env.NODE_ENV = "production";
    nowSpy?.mockRestore();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    nowSpy?.mockRestore();
  });

  test("clamps cache TTL when env override is non-positive", async () => {
    const originalTtl = process.env["FEE_CACHE_TTL_MS"];
    process.env["FEE_CACHE_TTL_MS"] = "0";

    try {
      const module = await import(`../src/utils/fee-budget?ttl=${Date.now()}`);
      const FreshManager = module.FeeBudgetManager;
      const manager = FreshManager.createForTest(createConnectionStub());
      expect((manager as any).config.cacheTtlMs).toBeGreaterThan(0);
    } finally {
      if (originalTtl === undefined) {
        Reflect.deleteProperty(process.env, "FEE_CACHE_TTL_MS");
      } else {
        process.env["FEE_CACHE_TTL_MS"] = originalTtl;
      }
    }
  });

  test("clamps cache TTL when config override is non-positive", () => {
    const connection = createConnectionStub();
    const manager = FeeBudgetManager.createForTest(connection, {
      cacheTtlMs: 0,
    });
    expect((manager as any).config.cacheTtlMs).toBeGreaterThan(0);
  });

  test("getOrCompute caches values until TTL expires", async () => {
    const connection = createConnectionStub();
    const manager = FeeBudgetManager.createForTest(connection, { cacheTtlMs: 100 });

    const computeSpy = spyOn(manager as any, "computeSingleTransaction");
    computeSpy.mockResolvedValueOnce(150_000).mockResolvedValueOnce(175_000);

    let currentTime = 0;
    nowSpy = spyOn(Date, "now").mockImplementation(() => currentTime);

    const first = await manager.getSingleTransactionLamports();
    expect(first).toBe(150_000);
    expect(computeSpy).toHaveBeenCalledTimes(1);

    currentTime = 50;
    const cached = await manager.getSingleTransactionLamports();
    expect(cached).toBe(150_000);
    expect(computeSpy).toHaveBeenCalledTimes(1);

    currentTime = 150;
    const recomputed = await manager.getSingleTransactionLamports();
    expect(recomputed).toBe(175_000);
    expect(computeSpy).toHaveBeenCalledTimes(2);
  });

  test("getOrCompute falls back to cached value when compute returns non-positive", async () => {
    const connection = createConnectionStub();
    const manager = FeeBudgetManager.createForTest(connection, { cacheTtlMs: 100 });

    const computeSpy = spyOn(manager as any, "computeSingleTransaction");
    computeSpy.mockResolvedValueOnce(200_000).mockResolvedValueOnce(0);

    let currentTime = 0;
    nowSpy = spyOn(Date, "now").mockImplementation(() => currentTime);

    const first = await manager.getSingleTransactionLamports();
    expect(first).toBe(200_000);

    currentTime = 200;
    const fallback = await manager.getSingleTransactionLamports();
    expect(fallback).toBe(200_000);
    expect(computeSpy).toHaveBeenCalledTimes(2);
  });

  test("getOrCompute falls back to configured defaults when no cache available", async () => {
    const connection = createConnectionStub();
    const manager = FeeBudgetManager.createForTest(connection, {
      cacheTtlMs: 10,
      fallbackSingleTxLamports: 123,
      wrapBufferMinLamports: 0,
      wrapBufferExtraLamports: 0,
      wrapBufferMultiplier: 0,
    });

    const singleSpy = spyOn(manager, "getSingleTransactionLamports");
    singleSpy.mockResolvedValue(0);

    const fallback = await manager.getWrapFeeBufferLamports();
    expect(fallback).toBe(123);
  });

  test("computeSingleTransaction returns default budget in test environment", async () => {
    const connection = createConnectionStub();
    const manager = FeeBudgetManager.createForTest(connection);

    process.env.NODE_ENV = "test";
    const result = await (manager as any).computeSingleTransaction();

    expect(result).toBe(FeeBudgetManager.getDefaultSingleTransactionLamports());
  });

  test("estimatePriorityFee handles empty and non-positive responses", async () => {
    const baseConnection = createConnectionStub({
      getRecentPrioritizationFees: async () => [],
    });
    const manager = FeeBudgetManager.createForTest(baseConnection);

    let result = await (manager as any).estimatePriorityFee();
    expect(result).toBe(0);

    const zeroConnection = createConnectionStub({
      getRecentPrioritizationFees: async () =>
        [{ prioritizationFee: "0" }, { prioritizationFee: "-5" }] as any,
    });
    const zeroManager = FeeBudgetManager.createForTest(zeroConnection);
    result = await (zeroManager as any).estimatePriorityFee();
    expect(result).toBe(0);

    const positiveConnection = createConnectionStub({
      getRecentPrioritizationFees: async () => [{ prioritizationFee: "2500000" }] as any,
    });
    const positiveManager = FeeBudgetManager.createForTest(positiveConnection, {
      computeUnitLimit: 1_000,
    });
    result = await (positiveManager as any).estimatePriorityFee();
    expect(result).toBe(2_500);
  });

  test("estimatePriorityFee uses percentile and clamps outliers", async () => {
    const connection = createConnectionStub({
      getRecentPrioritizationFees: async () =>
        [
          { prioritizationFee: "100000" },
          { prioritizationFee: "150000" },
          { prioritizationFee: "200000" },
          { prioritizationFee: "1000000000" },
        ] as any,
    });
    const manager = FeeBudgetManager.createForTest(connection, {
      computeUnitLimit: 1_000,
    });

    const result = await (manager as any).estimatePriorityFee();
    expect(result).toBe(200);
  });

  test("estimatePriorityFee selects upper sample when only two entries", async () => {
    const connection = createConnectionStub({
      getRecentPrioritizationFees: async () =>
        [{ prioritizationFee: "100000" }, { prioritizationFee: "600000" }] as any,
    });
    const manager = FeeBudgetManager.createForTest(connection, {
      computeUnitLimit: 1_000,
    });

    const result = await (manager as any).estimatePriorityFee();
    expect(result).toBe(600);
  });

  test("estimatePriorityFee caps extreme percentile values", async () => {
    const connection = createConnectionStub({
      getRecentPrioritizationFees: async () =>
        [
          { prioritizationFee: "800000000" },
          { prioritizationFee: "900000000" },
          { prioritizationFee: "1000000000" },
        ] as any,
    });
    const manager = FeeBudgetManager.createForTest(connection, {
      computeUnitLimit: 1_000,
    });

    const result = await (manager as any).estimatePriorityFee();
    expect(result).toBe(500_000);
  });

  test("computeSingleTransaction incorporates percentile-based priority fee", async () => {
    const connection = createConnectionStub({
      getFeeForMessage: async () => ({
        context: { slot: 0 },
        value: 1_000,
      }),
      getRecentPrioritizationFees: async () =>
        [
          { prioritizationFee: "100000" },
          { prioritizationFee: "200000" },
          { prioritizationFee: "4000000" },
        ] as any,
    });
    const manager = FeeBudgetManager.createForTest(connection, {
      singleTxMultiplier: 1,
      singleTxExtraLamports: 0,
      fallbackSingleTxLamports: 100,
      computeUnitLimit: 1_000,
    });

    const result = await (manager as any).computeSingleTransaction();
    expect(result).toBe(1_200);
  });

  test("deduplicates concurrent computations and clears inflight failures", async () => {
    const connection = createConnectionStub();
    const manager = FeeBudgetManager.createForTest(connection, { cacheTtlMs: 10_000 });

    const computeSpy = spyOn(manager as any, "computeSingleTransaction").mockImplementation(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return 123_456;
      },
    );

    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => manager.getSingleTransactionLamports()),
    );
    expect(new Set(concurrent)).toEqual(new Set([123_456]));
    expect(computeSpy).toHaveBeenCalledTimes(1);

    const failingManager = FeeBudgetManager.createForTest(connection, { cacheTtlMs: 5_000 });
    const failingSpy = spyOn(
      failingManager as any,
      "computeSingleTransaction",
    ).mockRejectedValueOnce(new Error("boom"));
    failingSpy.mockResolvedValueOnce(654_321);

    await expect(failingManager.getSingleTransactionLamports()).rejects.toThrow("boom");

    const recovered = await failingManager.getSingleTransactionLamports();
    expect(recovered).toBe(654_321);
    expect(failingSpy).toHaveBeenCalledTimes(2);
  });
});
