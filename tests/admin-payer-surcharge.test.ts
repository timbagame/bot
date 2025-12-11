import { describe, test, expect } from "bun:test";
import {
  calculateAdminPayerFeeBps,
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
