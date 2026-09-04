import { afterEach, describe, expect, test } from "bun:test";
import { PublicKey, SystemProgram } from "#solana";
import { FeeBudgetManager } from "../src/utils/fee-budget";

const envBackup: Record<string, string | undefined> = {
  FEE_SINGLE_TX_MULTIPLIER: process.env["FEE_SINGLE_TX_MULTIPLIER"],
  FEE_WRAP_BUFFER_MULTIPLIER: process.env["FEE_WRAP_BUFFER_MULTIPLIER"],
  FEE_CACHE_TTL_MS: process.env["FEE_CACHE_TTL_MS"],
};

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("fee budget environment parsing", () => {
  test("invalid environment values fall back to defaults", async () => {
    process.env["FEE_SINGLE_TX_MULTIPLIER"] = "abc";
    process.env["FEE_WRAP_BUFFER_MULTIPLIER"] = "-2";
    process.env["FEE_CACHE_TTL_MS"] = "0";

    const module = await import(`../src/utils/fee-budget.ts?env=${Date.now()}`);
    const manager: any = module.FeeBudgetManager.createForTest({
      rpcEndpoint: "http://localhost:8899",
      getLatestBlockhash: async () => ({ blockhash: "x", lastValidBlockHeight: 1 }),
      getFeeForMessage: async () => 1,
      getRecentPrioritizationFees: async () => [],
    } as any);

    expect(manager.config.singleTxMultiplier).toBe(2);
    expect(manager.config.wrapBufferMultiplier).toBe(1);
    expect(manager.config.cacheTtlMs).toBeGreaterThanOrEqual(1);
  });

  test("estimateFee returns zero for empty instruction list", async () => {
    const previousNodeEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    const connection = {
      rpcEndpoint: "http://localhost:8899",
      getLatestBlockhash: async () => ({ blockhash: "abc", lastValidBlockHeight: 1 }),
      getFeeForMessage: async () => 1,
      getRecentPrioritizationFees: async () => [],
    } as any;
    const manager = FeeBudgetManager.createForTest(connection) as any;
    const value = await (manager as any).estimateFee(new PublicKey(SystemProgram.programId), []);
    expect(value).toBe((manager as any).config.fallbackSingleTxLamports);
    if (previousNodeEnv === undefined) {
      delete process.env["NODE_ENV"];
    } else {
      process.env["NODE_ENV"] = previousNodeEnv;
    }
  });

  test("estimateFee logs fallback when RPC throws", async () => {
    const connection = {
      rpcEndpoint: "http://localhost:8899",
      getLatestBlockhash: async () => {
        throw new Error("rpc down");
      },
      getFeeForMessage: async () => {
        throw new Error("rpc down");
      },
      getRecentPrioritizationFees: async () => [],
    } as any;
    const manager = FeeBudgetManager.createForTest(connection, {
      fallbackSingleTxLamports: 123_000,
    });
    const value = await (manager as any).estimateFee(new PublicKey(SystemProgram.programId), [
      SystemProgram.transfer({
        fromPubkey: new PublicKey(SystemProgram.programId),
        toPubkey: new PublicKey(SystemProgram.programId),
        lamports: 1,
      }),
    ]);
    expect(value).toBe(123_000);
  });
});
