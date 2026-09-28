import { describe, expect, test } from "bun:test";
import { evaluateTradeAmount, presentTradeAmount } from "../src/utils/amount";

const token = (balance: number, decimals = 6) => ({ balance, decimals });

describe("evaluateTradeAmount token edge cases", () => {
  test("rejects a token trade when no balance snapshot exists", () => {
    expect(() =>
      evaluateTradeAmount({ amount: "1", assetTicker: "BONK", decimals: 5, solBalance: 1e9 }),
    ).toThrow("No BONK balance found");
  });

  test("rejects a token trade with a zero balance", () => {
    expect(() =>
      evaluateTradeAmount({
        amount: "50%",
        assetTicker: "BONK",
        decimals: 5,
        solBalance: 0,
        tokenBalance: token(0, 5),
      }),
    ).toThrow("No BONK balance found");
  });

  test("rejects max when only a fraction of a raw unit is held", () => {
    expect(() =>
      evaluateTradeAmount({
        amount: "max",
        assetTicker: "BONK",
        decimals: 5,
        solBalance: 0,
        tokenBalance: token(0.5, 5),
      }),
    ).toThrow("No BONK balance found");
  });

  test("rejects a percentage that rounds down to zero raw units", () => {
    expect(() =>
      evaluateTradeAmount({
        amount: "10%",
        assetTicker: "BONK",
        decimals: 0,
        solBalance: 0,
        tokenBalance: token(9, 0),
      }),
    ).toThrow("Percentage results in zero amount");
  });

  test("a token percentage without a formatter displays the normalized amount", () => {
    expect(
      evaluateTradeAmount({
        amount: "50%",
        assetTicker: "BONK",
        decimals: 2,
        solBalance: 0,
        tokenBalance: token(1_001, 2),
      }),
    ).toEqual({ kind: "percentage", rawAmount: 500, displayAmount: "5", normalizedAmount: "5" });
  });
});

describe("presentTradeAmount display fallbacks", () => {
  test("shows 'max' for a token max trade without a formatter", () => {
    expect(
      presentTradeAmount({
        amount: "MAX",
        assetTicker: "BONK",
        decimals: 5,
        solBalance: 0,
        tokenBalance: token(123_456, 5),
      }),
    ).toEqual({ kind: "max", rawAmount: 123_456, normalizedAmount: "max", displayAmount: "max" });
  });

  test("formats SOL amounts from lamports without a formatter", () => {
    expect(
      presentTradeAmount({
        amount: "0.25",
        assetTicker: "SOL",
        decimals: 9,
        solBalance: 1_000_000_000,
      }),
    ).toEqual({
      kind: "absolute",
      rawAmount: 250_000_000,
      normalizedAmount: "0.25",
      displayAmount: "0.25",
    });
  });

  test("uses the token's own decimals for the fallback display", () => {
    expect(
      presentTradeAmount({
        amount: "1.5",
        assetTicker: "USDC",
        decimals: 6,
        solBalance: 0,
        tokenBalance: token(5_000_000, 6),
      }).displayAmount,
    ).toBe("1.5");
  });

  test("prefers the provided formatters", () => {
    expect(
      presentTradeAmount({
        amount: "0.5",
        assetTicker: "SOL",
        decimals: 9,
        solBalance: 1_000_000_000,
        formatSol: (lamports) => `${lamports} lamports`,
      }).displayAmount,
    ).toBe("500000000 lamports");
    expect(
      presentTradeAmount({
        amount: "2",
        assetTicker: "USDC",
        decimals: 6,
        solBalance: 0,
        tokenBalance: token(5_000_000, 6),
        formatToken: (raw, decimals) => `${raw}/${decimals}`,
      }).displayAmount,
    ).toBe("2000000/6");
  });
});
