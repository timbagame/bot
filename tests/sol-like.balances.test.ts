import { describe, expect, test } from "bun:test";
import {
  __test_presentSpendAmount as presentSpendAmount,
} from "../src/bot";
import { JUPITER_MIN_SOL_BALANCE_LAMPORTS } from "../src/utils/constants";

const formatSol = (lamports: number) => `${lamports} lamports`;
const formatToken = () => "";

describe("SOL-like balance handling", () => {
  test("requires native SOL for fees even when WSOL adds to spendable balance", () => {
    expect(() =>
      presentSpendAmount({
        amount: "0.5",
        assetTicker: "SOL",
        decimals: 9,
        // Combined SOL-like balance includes WSOL, but native SOL is zero
        solBalance: 1_500_000_000,
        solFeePayerBalance: 0,
        tokenBalance: undefined,
        applySolFeeBuffer: true,
        solFeeBufferLamports: JUPITER_MIN_SOL_BALANCE_LAMPORTS,
        formatSol,
        formatToken,
        insufficientSolForFeesMessage:
          "Not enough native SOL available for fees",
      })
    ).toThrow(/native SOL available for fees/);
  });

  test("max SOL spends only the native balance when a buffer is required", () => {
    const nativeSolLamports = 200_000_000;

    const result = presentSpendAmount({
      amount: "max",
      assetTicker: "SOL",
      decimals: 9,
      solBalance: nativeSolLamports,
      tokenBalance: undefined,
      applySolFeeBuffer: true,
      solFeeBufferLamports: JUPITER_MIN_SOL_BALANCE_LAMPORTS,
      formatSol,
      formatToken,
      userSolBufferLamports: 0,
    });

    expect(result.rawAmount).toBe(
      nativeSolLamports - JUPITER_MIN_SOL_BALANCE_LAMPORTS
    );
  });
});
