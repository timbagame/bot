import { describe, expect, test } from "bun:test";
import { parseTradeAmountInput } from "../src/utils/amount";
import { __test_presentSpendAmount as presentSpendAmount } from "../src/bot";
import { JUPITER_MIN_SOL_BALANCE_LAMPORTS } from "../src/utils/constants";

describe("parseTradeAmountInput", () => {
  test("parses max input", () => {
    expect(parseTradeAmountInput("max")).toEqual({ kind: "max" });
  });

  test("parses percentage input", () => {
    expect(parseTradeAmountInput("25%")).toEqual({
      kind: "percentage",
      percentage: 25,
    });
  });

  test("parses numeric input", () => {
    expect(parseTradeAmountInput("  1.5 ")).toEqual({
      kind: "absolute",
      normalized: "1.5",
    });
  });
});

describe("trade amount helpers share validation", () => {
  const solParams = {
    assetTicker: "SOL",
    decimals: 9,
    solBalance: 10,
    tokenBalance: undefined,
    formatSol: (lamports: number) => `${lamports} lamports`,
    formatToken: () => "",
    applySolFeeBuffer: true,
    solFeeBufferLamports: 0,
  } as const;

  test("rejects empty inputs", () => {
    expect(() =>
      presentSpendAmount({
        amount: " ",
        ...solParams,
      }),
    ).toThrow("Amount cannot be empty");

    expect(() =>
      presentSpendAmount({
        amount: " ",
        ...solParams,
        applySolFeeBuffer: false,
      }),
    ).toThrow("Amount cannot be empty");
  });

  test("rejects invalid percentages", () => {
    expect(() =>
      presentSpendAmount({
        amount: "150%",
        ...solParams,
      }),
    ).toThrow("Invalid percentage format");

    expect(() =>
      presentSpendAmount({
        amount: "150%",
        ...solParams,
        applySolFeeBuffer: false,
      }),
    ).toThrow("Invalid percentage format");
  });

  test("rejects percentages that round to zero", () => {
    expect(() =>
      presentSpendAmount({
        amount: "0.01%",
        ...solParams,
      }),
    ).toThrow("Percentage results in zero amount");

    expect(() =>
      presentSpendAmount({
        amount: "0.01%",
        ...solParams,
        applySolFeeBuffer: false,
      }),
    ).toThrow("Percentage results in zero amount");
  });

  test("max SOL trades leave configured fee buffer behind", () => {
    const solBalance = 1_000_000_000; // 1 SOL
    const solFeeBufferLamports = 250_000_000; // 0.25 SOL rent+fees

    const result = presentSpendAmount({
      amount: "max",
      assetTicker: "SOL",
      decimals: 9,
      solBalance,
      tokenBalance: undefined,
      formatSol: (lamports) => `${lamports} lamports`,
      formatToken: () => "",
      applySolFeeBuffer: true,
      solFeeBufferLamports,
    });

    expect(solBalance - result.rawAmount).toBe(solFeeBufferLamports);
  });

  test("rejects SOL inputs that exceed spendable lamports", () => {
    const solBalance = 1_000_000_000; // 1 SOL
    const solFeeBufferLamports = 200_000_000; // Reserve for rent + fees

    expect(() =>
      presentSpendAmount({
        amount: "1",
        assetTicker: "SOL",
        decimals: 9,
        solBalance,
        tokenBalance: undefined,
        formatSol: (lamports) => `${lamports} lamports`,
        formatToken: () => "",
        applySolFeeBuffer: true,
        solFeeBufferLamports,
      }),
    ).toThrow(/Insufficient SOL balance for this purchase/);
  });

  test("max SOL with balance equal to buffer throws helpful error", () => {
    const solBalance = 1_000_000_000; // 1 SOL
    const solFeeBufferLamports = 1_000_000_000;

    expect(() =>
      presentSpendAmount({
        amount: "max",
        assetTicker: "SOL",
        decimals: 9,
        solBalance,
        tokenBalance: undefined,
        formatSol: (lamports) => `${lamports} lamports`,
        formatToken: () => "",
        applySolFeeBuffer: true,
        solFeeBufferLamports,
      }),
    ).toThrow(/Not enough SOL to cover purchase and fees \(keep ~/);
  });

  test("uses custom insufficient fee message when provided", () => {
    const solBalance = JUPITER_MIN_SOL_BALANCE_LAMPORTS;

    expect(() =>
      presentSpendAmount({
        amount: "max",
        assetTicker: "SOL",
        decimals: 9,
        solBalance,
        tokenBalance: undefined,
        formatSol: (lamports) => `${lamports} lamports`,
        formatToken: () => "",
        applySolFeeBuffer: true,
        solFeeBufferLamports: solBalance,
        insufficientSolForFeesMessage: "Swaps under ~$10 need 0.01 SOL",
        omitSolFeeBufferHint: true,
      }),
    ).toThrow("Swaps under ~$10 need 0.01 SOL");
  });

  test("max SOL respects additional user buffer", () => {
    const solBalance = 1_000_000_000;
    const userBuffer = 250_000;

    const result = presentSpendAmount({
      amount: "max",
      assetTicker: "SOL",
      decimals: 9,
      solBalance,
      tokenBalance: undefined,
      formatSol: (lamports) => `${lamports} lamports`,
      formatToken: () => "",
      applySolFeeBuffer: true,
      solFeeBufferLamports: 0,
      userSolBufferLamports: userBuffer,
    });

    expect(solBalance - result.rawAmount).toBe(userBuffer);
  });

  test("max SOL with buffer equal to spendable throws helpful message", () => {
    const solBalance = 500_000;
    const userBuffer = 500_000;

    expect(() =>
      presentSpendAmount({
        amount: "max",
        assetTicker: "SOL",
        decimals: 9,
        solBalance,
        tokenBalance: undefined,
        formatSol: (lamports) => `${lamports} lamports`,
        formatToken: () => "",
        applySolFeeBuffer: true,
        solFeeBufferLamports: 0,
        userSolBufferLamports: userBuffer,
      }),
    ).toThrow(/Not enough SOL to keep/);
  });
});
