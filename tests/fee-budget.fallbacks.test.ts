import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Connection } from "#solana";
import { FeeBudgetManager, loadFeeBudgetConfigFromEnv } from "../src/utils/fee-budget";

const connectionWith = (overrides: Record<string, unknown> = {}): Connection =>
  ({
    rpcEndpoint: "http://test-stub",
    getLatestBlockhash: async () => ({ blockhash: "hash", lastValidBlockHeight: 1 }),
    getFeeForMessage: async () => ({ context: { slot: 0 }, value: 5_000 }),
    getRecentPrioritizationFees: async () => [],
    ...overrides,
  }) as unknown as Connection;

describe("fee budget", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    warnSpy.mockRestore();
  });

  describe("loadFeeBudgetConfigFromEnv", () => {
    test("accepts a valid labelled value without warning", () => {
      const config = loadFeeBudgetConfigFromEnv({ FEE_CACHE_TTL_MS: "45000" });
      expect(config.cacheTtlMs).toBe(45_000);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    test("warns and uses the default when a labelled value is not numeric", () => {
      const config = loadFeeBudgetConfigFromEnv({ FEE_CACHE_TTL_MS: "abc" });
      expect(config.cacheTtlMs).toBe(30_000);
      expect(warnSpy).toHaveBeenCalledWith(
        "[FeeBudget] FEE_CACHE_TTL_MS must be numeric. Received 'abc', using 30000.",
      );
    });

    test("warns and uses the default when a labelled value is negative", () => {
      const config = loadFeeBudgetConfigFromEnv({ FEE_CACHE_TTL_MS: "-5" });
      expect(config.cacheTtlMs).toBe(30_000);
      expect(warnSpy).toHaveBeenCalledWith(
        "[FeeBudget] FEE_CACHE_TTL_MS cannot be negative. Received -5, using 30000.",
      );
    });
  });

  describe("fallback values", () => {
    test("an unusable computation falls back to the configured single transaction lamports", async () => {
      const manager: any = FeeBudgetManager.createForTest(connectionWith(), {
        fallbackSingleTxLamports: 12_345,
      });

      const value = await manager.getOrCompute("single", async () => 0);

      expect(value).toBe(12_345);
      expect(manager.getFallbackForKey("single")).toBe(12_345);
    });

    test("an unrecognised cache key uses the single transaction fallback", () => {
      const manager: any = FeeBudgetManager.createForTest(connectionWith(), {
        fallbackSingleTxLamports: 13_579,
      });

      expect(manager.getFallbackForKey("not-a-real-key")).toBe(13_579);
    });

    test("falls back when computing the single transaction budget throws", async () => {
      process.env.NODE_ENV = "production";
      const manager: any = FeeBudgetManager.createForTest(connectionWith(), {
        fallbackSingleTxLamports: 11_111,
      });
      const failure = new Error("fee estimator exploded");
      manager.estimateFee = async () => {
        throw failure;
      };

      expect(await manager.getSingleTransactionLamports()).toBe(11_111);
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to compute single transaction budget, using fallback:",
        failure,
      );
    });
  });

  describe("estimatePriorityFee", () => {
    test("returns zero in the test environment without touching the connection", async () => {
      process.env.NODE_ENV = "test";
      let calls = 0;
      const manager: any = FeeBudgetManager.createForTest(
        connectionWith({
          getRecentPrioritizationFees: async () => {
            calls += 1;
            return [{ prioritizationFee: 9_999_999 }];
          },
        }),
      );

      expect(await manager.estimatePriorityFee()).toBe(0);
      expect(calls).toBe(0);
    });

    test("returns zero when the computed lamports are not positive", async () => {
      process.env.NODE_ENV = "production";
      const manager: any = FeeBudgetManager.createForTest(
        connectionWith({
          getRecentPrioritizationFees: async () => [{ prioritizationFee: 5_000 }],
        }),
        { computeUnitLimit: 0 },
      );

      expect(await manager.estimatePriorityFee()).toBe(0);
    });

    test("returns zero and warns when the connection fails", async () => {
      process.env.NODE_ENV = "production";
      const failure = new Error("rpc down");
      const manager: any = FeeBudgetManager.createForTest(
        connectionWith({
          getRecentPrioritizationFees: async () => {
            throw failure;
          },
        }),
      );

      expect(await manager.estimatePriorityFee()).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith("Failed to estimate priority fee:", failure);
    });
  });
});
