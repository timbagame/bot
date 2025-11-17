import { describe, test, expect } from "bun:test";
import { calculateAdminPayerFeeBps } from "../src/utils/admin-payer-surcharge";

describe("calculateAdminPayerFeeBps", () => {
  test("adds surcharge when deficit positive", () => {
    const result = calculateAdminPayerFeeBps({
      baseFeeBps: 85,
      tradeLamports: 1_000_000_000,
      deficitLamports: 500_000_000,
      solPriceUsd: 20,
    });
    expect(result).toBeGreaterThan(85);
    expect(result).toBeLessThanOrEqual(255);
  });

  test("clamps to max when extra exceeds limit", () => {
    const result = calculateAdminPayerFeeBps({
      baseFeeBps: 200,
      tradeLamports: 1,
      deficitLamports: 1_000_000_000,
      solPriceUsd: 100,
    });
    expect(result).toBe(255);
  });

  test("returns base when deficit or price zero", () => {
    const result = calculateAdminPayerFeeBps({
      baseFeeBps: 90,
      tradeLamports: 1_000_000_000,
      deficitLamports: 0,
      solPriceUsd: 10,
    });
    expect(result).toBe(90);
  });
});
