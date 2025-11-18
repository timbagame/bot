import { describe, expect, test } from "bun:test";
import { evaluateTradeAmount } from "../src/utils/amount";

describe("evaluateTradeAmount boundary buffers", () => {
  test("max SOL spend leaves required buffer even when balance equals buffer", () => {
    const solBalance = 500_000;
    const buffer = 500_000;
    expect(() =>
      evaluateTradeAmount({
        amount: "max",
        assetTicker: "SOL",
        decimals: 9,
        solBalance,
        tokenBalance: undefined,
        applySolFeeBuffer: true,
        solFeeBufferLamports: buffer,
        userSolBufferLamports: buffer,
      })
    ).toThrow(/keep ~?/);
  });
});
