import { describe, expect, test } from "bun:test";
import { parseTradeAmountInput } from "../src/utils/amount";
import {
  __test_resolveSpendAmount as resolveSpendAmount,
  __test_normalizeCustomTradeAmount as normalizeCustomTradeAmount,
} from "../src/bot";

describe("parseTradeAmountInput", () => {
  test("parses max input", () => {
    expect(parseTradeAmountInput("max")).toEqual({ kind: "max" });
  });

  test("parses percentage input", () => {
    expect(parseTradeAmountInput("25%"))
      .toEqual({ kind: "percentage", percentage: 25 });
  });

  test("parses numeric input", () => {
    expect(parseTradeAmountInput("  1.5 "))
      .toEqual({ kind: "absolute", normalized: "1.5" });
  });
});

describe("trade amount helpers share validation", () => {
  const solParams = {
    assetTicker: "SOL",
    inputDecimals: 9,
    solBalance: 10,
    tokenBalance: undefined,
    formatSol: (lamports: number) => `${lamports} lamports`,
    formatToken: () => "",
    applySolFeeBuffer: false,
  } as const;

  const normalizeParams = {
    assetTicker: "SOL",
    solBalance: 10,
    decimals: 9,
  } as const;

  test("rejects empty inputs", () => {
    expect(() =>
      resolveSpendAmount({
        amount: " ",
        ...solParams,
      })
    ).toThrow("Amount cannot be empty");

    expect(() =>
      normalizeCustomTradeAmount({
        amount: " ",
        tokenBalance: undefined,
        ...normalizeParams,
      })
    ).toThrow("Amount cannot be empty");
  });

  test("rejects invalid percentages", () => {
    expect(() =>
      resolveSpendAmount({
        amount: "150%",
        ...solParams,
      })
    ).toThrow("Invalid percentage format");

    expect(() =>
      normalizeCustomTradeAmount({
        amount: "150%",
        tokenBalance: undefined,
        ...normalizeParams,
      })
    ).toThrow("Invalid percentage format");
  });

  test("rejects percentages that round to zero", () => {
    expect(() =>
      resolveSpendAmount({
        amount: "0.01%",
        ...solParams,
      })
    ).toThrow("Percentage results in zero amount");

    expect(() =>
      normalizeCustomTradeAmount({
        amount: "0.01%",
        tokenBalance: undefined,
        ...normalizeParams,
      })
    ).toThrow("Percentage results in zero amount");
  });
});
