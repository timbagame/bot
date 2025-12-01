import { describe, expect, test } from "bun:test";
import { __test_shouldWithdrawToken } from "../src/services/fee-sweeper";

describe("fee sweeper helpers", () => {
  const wallet = {
    formatTokenBalance: (raw: number, decimals: number) =>
      (raw / 10 ** decimals).toFixed(decimals),
  } as any;
  const tokenConfig = { mint: "mint", ticker: "TEST" };

  test("skips withdrawals when below $5 threshold", async () => {
    const priceResolver = async () => ({ price: 1 });
    const result = await __test_shouldWithdrawToken(
      wallet,
      tokenConfig,
      2_000_000_000n,
      9,
      priceResolver as any
    );

    expect(result.shouldWithdraw).toBe(false);
    expect(result.formattedPending).toBe("2.000000000");
    expect(result.tokenUsdValue).toBeCloseTo(2);
  });

  test("allows withdrawals at or above the $5 threshold", async () => {
    const priceResolver = async () => ({ price: 5 });
    const result = await __test_shouldWithdrawToken(
      wallet,
      tokenConfig,
      1_000_000_000n,
      9,
      priceResolver as any
    );

    expect(result.shouldWithdraw).toBe(true);
    expect(result.tokenUsdValue).toBeCloseTo(5);
  });
});

describe("ENABLE_FEE_SWEEPER config", () => {
  const importConstants = async () =>
    await import(`../src/utils/constants.ts?test=${Date.now()}`);

  test("defaults to enabled when unset", async () => {
    delete process.env.ENABLE_FEE_SWEEPER;
    const module = await importConstants();
    expect(module.ENABLE_FEE_SWEEPER).toBe(true);
  });

  test("honours explicit false-like values", async () => {
    process.env.ENABLE_FEE_SWEEPER = "false";
    const moduleFalse = await importConstants();
    expect(moduleFalse.ENABLE_FEE_SWEEPER).toBe(false);

    process.env.ENABLE_FEE_SWEEPER = "0";
    const moduleZero = await importConstants();
    expect(moduleZero.ENABLE_FEE_SWEEPER).toBe(false);

    delete process.env.ENABLE_FEE_SWEEPER;
  });
});
