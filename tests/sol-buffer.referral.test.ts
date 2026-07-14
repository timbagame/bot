import { describe, test, expect } from "bun:test";
import { __test_shouldSkipSolFeeBuffer as shouldSkipSolFeeBuffer } from "../src/bot";

const solAsset = {
  ticker: "SOL",
  mint: "So11111111111111111111111111111111111111112",
  decimals: 9,
} as any;

describe("shouldSkipSolFeeBuffer", () => {
  test("does not skip buffer for SOL when no admin payer and not max", () => {
    const skip = shouldSkipSolFeeBuffer(solAsset, "SOL", "0.5", undefined);
    expect(skip).toBe(false);
  });

  test("skips buffer when referral has admin payer metadata", () => {
    const skip = shouldSkipSolFeeBuffer(solAsset, "SOL", "0.5", {
      adminPayer: "Admin",
      adminCloseAuthority: "AdminClose",
    });
    expect(skip).toBe(true);
  });

  test("skips buffer when user selects max even without admin payer", () => {
    const skip = shouldSkipSolFeeBuffer(solAsset, "SOL", "max", {});
    expect(skip).toBe(true);
  });

  test("non-SOL never skips buffer via this helper", () => {
    const otherAsset = { ticker: "USDC", mint: "EPjF", decimals: 6 } as any;
    const skip = shouldSkipSolFeeBuffer(otherAsset, "SOL", "max", {
      adminPayer: "Admin",
      adminCloseAuthority: "AdminClose",
    });
    expect(skip).toBe(false);
  });

  test("requires SOL output to drop buffer even with admin payer", () => {
    const skip = shouldSkipSolFeeBuffer(solAsset, "USDC", "max", {
      adminPayer: "Admin",
      adminCloseAuthority: "AdminClose",
    });

    expect(skip).toBe(false);
  });
});
