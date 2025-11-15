import { describe, expect, test } from "bun:test";
import { __test_clampSolFeeBufferLamports as clampSolFeeBuffer } from "../src/bot";
import { JUPITER_MIN_SOL_BALANCE_LAMPORTS } from "../src/utils/constants";

describe("clampSolFeeBufferLamports", () => {
  test("caps buffer to available balance", () => {
    const solBalance = 20_000_000; // 0.02 SOL
    const desiredBuffer = 50_000_000; // 0.05 SOL
    const result = clampSolFeeBuffer(solBalance, desiredBuffer);
    expect(result).toBeLessThanOrEqual(solBalance);
  });

  test("never drops below minimum buffer", () => {
    const solBalance = JUPITER_MIN_SOL_BALANCE_LAMPORTS * 2;
    const desiredBuffer = 5_000; // low buffer
    const result = clampSolFeeBuffer(solBalance, desiredBuffer);
    expect(result).toBeGreaterThanOrEqual(JUPITER_MIN_SOL_BALANCE_LAMPORTS);
  });
});
