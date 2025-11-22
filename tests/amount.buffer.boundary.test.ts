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

  test("absolute SOL spend enforces fee buffer against fee payer even with WSOL", () => {
    const solBalance = 1_050_000_000; // 0.05 native + 1 WSOL combined
    const nativeSolBalance = 50_000_000; // 0.05 SOL
    const solFeeBufferLamports = 5_000_000; // 0.005 SOL

    expect(() =>
      evaluateTradeAmount({
        amount: "1",
        assetTicker: "SOL",
        decimals: 9,
        solBalance,
        solFeePayerBalance: nativeSolBalance,
        tokenBalance: undefined,
        applySolFeeBuffer: true,
        solFeeBufferLamports,
      })
    ).toThrow("Insufficient SOL balance for this purchase");
  });
});
