import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Connection } from "@solana/web3.js";
import { FeeBudgetManager } from "../src/utils/fee-budget";

const createConnectionStub = (
  overrides: Partial<Connection> & { rpcEndpoint?: string } = {}
): Connection => {
  return {
    rpcEndpoint: "http://stub" as string,
    getLatestBlockhash: async () => ({
      blockhash: "hash",
      lastValidBlockHeight: 1,
      blockhashCommitment: "confirmed",
    }),
    getFeeForMessage: async () => 5000,
    getRecentPrioritizationFees: async () => [
      { prioritizationFee: "1200000" } as any,
    ],
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
      getRecentPrioritizationFees: async () => [
        { prioritizationFee: "0" },
        { prioritizationFee: "-5" },
      ] as any,
    });
    const zeroManager = FeeBudgetManager.createForTest(zeroConnection);
    result = await (zeroManager as any).estimatePriorityFee();
    expect(result).toBe(0);

    const positiveConnection = createConnectionStub({
      getRecentPrioritizationFees: async () => [
        { prioritizationFee: "2500000" },
      ] as any,
    });
    const positiveManager = FeeBudgetManager.createForTest(positiveConnection, {
      computeUnitLimit: 1_000,
    });
    result = await (positiveManager as any).estimatePriorityFee();
    expect(result).toBeGreaterThan(0);
  });
});
