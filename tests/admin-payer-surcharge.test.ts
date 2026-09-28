import { describe, test, expect } from "bun:test";
import {
  calculateAdminPayerFeeBps,
  calculateReferralFeeBps,
  computeRequiredAdminLamports,
} from "../src/utils/admin-payer-surcharge";

describe("calculateAdminPayerFeeBps", () => {
  test("adds surcharge when deficit positive", () => {
    const result = calculateAdminPayerFeeBps({
      baseFeeBps: 85,
      tradeAmountRaw: 1_000_000_000,
      tradeDecimals: 9,
      tradePriceUsd: 20,
      deficitLamports: 500_000_000,
      solPriceUsd: 20,
    });
    expect(result).toBeGreaterThan(85);
    expect(result).toBeLessThanOrEqual(255);
  });

  test("uses token decimals and price for non-SOL trades", () => {
    const result = calculateAdminPayerFeeBps({
      baseFeeBps: 85,
      tradeAmountRaw: 1_000_000, // 1 unit at 6 decimals (e.g., USDC)
      tradeDecimals: 6,
      tradePriceUsd: 1,
      deficitLamports: 100_000, // 0.0001 SOL
      solPriceUsd: 100,
    });
    expect(result).toBe(185);
  });

  test("clamps to max when extra exceeds limit", () => {
    const result = calculateAdminPayerFeeBps({
      baseFeeBps: 200,
      tradeAmountRaw: 1,
      tradeDecimals: 9,
      tradePriceUsd: 100,
      deficitLamports: 1_000_000_000,
      solPriceUsd: 100,
    });
    expect(result).toBe(255);
  });

  test("returns base when deficit or price zero", () => {
    const result = calculateAdminPayerFeeBps({
      baseFeeBps: 90,
      tradeAmountRaw: 1_000_000_000,
      tradeDecimals: 9,
      tradePriceUsd: 10,
      deficitLamports: 0,
      solPriceUsd: 10,
    });
    expect(result).toBe(90);
  });

  test("adds proportional extra for tx+ATA rent sized deficit", () => {
    // deficit: ~0.003 SOL at $25 => $0.075; trade: 0.01 SOL at $25 => $0.25 -> extra bps ~ ceil(0.075/0.25*10k)=3000bps, clamped to 200
    const result = calculateAdminPayerFeeBps({
      baseFeeBps: 85,
      tradeAmountRaw: 10_000_000, // 0.01 SOL
      tradeDecimals: 9,
      tradePriceUsd: 25,
      deficitLamports: 3_000_000, // 0.003 SOL (tx+ATA)
      solPriceUsd: 25,
    });
    expect(result).toBe(255); // clamped
  });

  test("computeRequiredAdminLamports sums min balance, rent, extra ATA and prio", () => {
    expect(computeRequiredAdminLamports(10, 5, 2, 3)).toBe(20);
    expect(computeRequiredAdminLamports(0, 7, 0, 4)).toBe(11);
  });
});

describe("calculateAdminPayerFeeBps degenerate values", () => {
  test("returns the clamped base fee when the trade value underflows to zero", () => {
    expect(
      calculateAdminPayerFeeBps({
        baseFeeBps: 100,
        tradeAmountRaw: 1,
        tradeDecimals: 400,
        tradePriceUsd: 1,
        deficitLamports: 5_000,
        solPriceUsd: 150,
      }),
    ).toBe(100);
  });

  test("returns the clamped base fee when the deficit value underflows to zero", () => {
    expect(
      calculateAdminPayerFeeBps({
        baseFeeBps: 400,
        tradeAmountRaw: 1_000_000,
        tradeDecimals: 6,
        tradePriceUsd: 1,
        deficitLamports: 1,
        solPriceUsd: Number.MIN_VALUE,
      }),
    ).toBe(255);
  });
});

describe("calculateReferralFeeBps", () => {
  test("adds the deficit share of the trade to the base fee", () => {
    // $1 deficit on a $100 trade = 100 bps extra.
    expect(calculateReferralFeeBps({ baseFeeBps: 100, tradeUsd: 100, deficitUsd: 1 })).toBe(200);
  });

  test("rounds a fractional surcharge up", () => {
    expect(calculateReferralFeeBps({ baseFeeBps: 100, tradeUsd: 100, deficitUsd: 0.0001 })).toBe(
      101,
    );
  });

  test("accepts an extra exactly at the cap and clamps to the max fee", () => {
    expect(calculateReferralFeeBps({ baseFeeBps: 150, tradeUsd: 100, deficitUsd: 1.55 })).toBe(255);
  });

  test("rejects a surcharge one basis point above the cap", () => {
    expect(() =>
      calculateReferralFeeBps({ baseFeeBps: 100, tradeUsd: 100, deficitUsd: 1.56 }),
    ).toThrow("Trade is too small");
  });

  test("honours a custom extra cap", () => {
    expect(() =>
      calculateReferralFeeBps({ baseFeeBps: 100, tradeUsd: 100, deficitUsd: 0.2, maxExtraBps: 10 }),
    ).toThrow("Trade is too small");
  });

  test.each([
    ["zero trade value", 0, 1],
    ["negative trade value", -5, 1],
    ["zero deficit", 100, 0],
    ["negative deficit", 100, -1],
  ])("refuses to estimate with a %s", (_label, tradeUsd, deficitUsd) => {
    expect(() => calculateReferralFeeBps({ baseFeeBps: 100, tradeUsd, deficitUsd })).toThrow(
      "Cannot estimate referral surcharge",
    );
  });

  test("raises a low result to the minimum fee", () => {
    expect(
      calculateReferralFeeBps({ baseFeeBps: 10, tradeUsd: 1000, deficitUsd: 0.01, minFeeBps: 50 }),
    ).toBe(50);
  });

  test("rejects a misconfigured minimum above the maximum", () => {
    expect(() =>
      calculateReferralFeeBps({
        baseFeeBps: 100,
        tradeUsd: 100,
        deficitUsd: 0.01,
        minFeeBps: 300,
        maxFeeBps: 255,
      }),
    ).toThrow("Referral fee exceeds allowable limit");
  });
});
