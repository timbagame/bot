import { expect, test } from "bun:test";
import { WSOL_MINT } from "../src/utils/constants";
import {
  USDC_MINT,
  buildTokenPositions,
  createDecimalResolver,
  fillsFromSwaps,
  formatPositionMessage,
  resolveTokenDecimals,
  formatSolSpent,
  formatSignedPercent,
  quoteAmountToSol,
  rawAmountToNumber,
} from "../src/services/positions";
import type { SwapStatRecord } from "../src/utils/transaction-history";

const TIMBA = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

const swap = (overrides: Partial<SwapStatRecord>): SwapStatRecord => ({
  signature: overrides.signature ?? "sig",
  wallet: "wallet-1",
  input_mint: WSOL_MINT,
  output_mint: TIMBA,
  input_ticker: "SOL",
  output_ticker: "TIMBA",
  amount_in: "420000000",
  amount_out: "123000000",
  referral_applied: false,
  timestamp: 1,
  ...overrides,
});

test("rawAmountToNumber converts raw units with decimals", () => {
  expect(rawAmountToNumber("123000000", 6)).toBe(123);
  expect(rawAmountToNumber("420000000", 9)).toBe(0.42);
});

test("fillsFromSwaps maps SOL buys and sells and skips wraps", () => {
  const fills = fillsFromSwaps([
    swap({ signature: "buy", timestamp: 1 }),
    swap({
      signature: "sell",
      input_mint: TIMBA,
      output_mint: WSOL_MINT,
      input_ticker: "TIMBA",
      output_ticker: "SOL",
      amount_in: "23000000",
      amount_out: "80000000",
      timestamp: 2,
    }),
    swap({
      signature: "wrap",
      input_mint: WSOL_MINT,
      output_mint: USDC_MINT,
      input_ticker: "SOL",
      output_ticker: "USDC",
      amount_in: "1000000000",
      amount_out: "100000000",
      timestamp: 3,
    }),
  ]);

  expect(fills).toHaveLength(2);
  expect(fills[0]).toMatchObject({ side: "buy", mint: TIMBA, tokenAmount: 123, quoteAmount: 0.42 });
  expect(fills[1]).toMatchObject({ side: "sell", mint: TIMBA, tokenAmount: 23, quoteAmount: 0.08 });
});

test("buildTokenPositions uses weighted average entry after a partial sell", () => {
  const fills = fillsFromSwaps([
    swap({ signature: "buy-1", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
    swap({
      signature: "sell-1",
      input_mint: TIMBA,
      output_mint: WSOL_MINT,
      input_ticker: "TIMBA",
      output_ticker: "SOL",
      amount_in: "40000000",
      amount_out: "500000000",
      timestamp: 2,
    }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 60, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
  });

  expect(position?.avgEntrySol).toBeCloseTo(0.01, 8);
  expect(position?.avgEntryUsd).toBeCloseTo(1, 8);
  expect(position?.pnlPercent).toBeCloseTo(0.2, 8);
  expect(position?.unrealizedUsd).toBeCloseTo(12, 8);
  expect(position?.buyCount).toBe(1);
  expect(position?.sellCount).toBe(1);
});

test("resolveTokenDecimals uses MAGAIBA's on-chain 8 decimals, not the 6-decimal default", () => {
  const magaiba = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";
  expect(resolveTokenDecimals(magaiba, "MAGAIBA")).toBe(8);
  expect(createDecimalResolver([{ mint: magaiba, decimals: 8 }])(magaiba, "MAGAIBA")).toBe(8);
});

test("buildTokenPositions does not treat a small bot buy as the cost of a larger bag", () => {
  const magaiba = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";
  const fills = fillsFromSwaps(
    [
      {
        signature: "tiny-buy",
        wallet: "wallet-1",
        input_mint: WSOL_MINT,
        output_mint: magaiba,
        input_ticker: "SOL",
        output_ticker: "MAGAIBA",
        amount_in: "5000000",
        amount_out: "325953344985",
        referral_applied: false,
        timestamp: 1,
      },
    ],
    createDecimalResolver([{ mint: magaiba, decimals: 8 }]),
  );

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: magaiba, ticker: "MAGAIBA", balance: 4259.53344985, decimals: 8 }],
    pricesUsd: { [WSOL_MINT]: 103, [magaiba]: 0.000155 },
  });

  expect(fills[0]?.tokenAmount).toBeCloseTo(3259.53344985, 6);
  expect(position?.avgEntryUsd).toBeCloseTo(0.000158, 6);
  expect(position?.pnlPercent).toBeGreaterThan(-0.05);
  expect(position?.pnlPercent).toBeLessThan(0.05);
  expect(position?.trackedBalance).toBeCloseTo(3259.53344985, 4);
  expect(position?.unrealizedUsd).toBeLessThan(0.05);
});

test("an 8-decimal fill parsed as 6 decimals would fake a 100x PNL", () => {
  const magaiba = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";
  const rawOut = "325953344985";
  const wrongFills = fillsFromSwaps(
    [
      {
        signature: "tiny-buy",
        wallet: "wallet-1",
        input_mint: WSOL_MINT,
        output_mint: magaiba,
        input_ticker: "SOL",
        output_ticker: "MAGAIBA",
        amount_in: "5000000",
        amount_out: rawOut,
        referral_applied: false,
        timestamp: 1,
      },
    ],
    (mint, ticker) =>
      mint === magaiba || ticker === "MAGAIBA" ? 6 : resolveTokenDecimals(mint, ticker),
  );
  const [wrong] = buildTokenPositions({
    fills: wrongFills,
    holdings: [{ mint: magaiba, ticker: "MAGAIBA", balance: 4259.53344985, decimals: 8 }],
    pricesUsd: { [WSOL_MINT]: 103, [magaiba]: 0.000155 },
  });

  expect(wrongFills[0]?.tokenAmount).toBeCloseTo(325953.344985, 4);
  expect(wrong?.avgEntryUsd).toBeCloseTo(0.00000158, 8);
  expect(wrong?.pnlPercent).toBeGreaterThan(90);
});

test("buildTokenPositions skips tokens without bot buys", () => {
  expect(
    buildTokenPositions({
      fills: [],
      holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 60, decimals: 6 }],
      pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
    }),
  ).toEqual([]);
});

test("quoteAmountToSol converts stables using the current SOL price", () => {
  expect(quoteAmountToSol(USDC_MINT, 50, 100)).toBeCloseTo(0.5, 8);
  expect(quoteAmountToSol(WSOL_MINT, 0.42, 100)).toBeCloseTo(0.42, 8);
});

test("format helpers match the wallet PNL style", () => {
  expect(formatSignedPercent(0.184)).toBe("+18.4%");
  expect(formatSignedPercent(-0.0646)).toBe("-6.46%");
  expect(formatSignedPercent(0)).toBe("0%");
  expect(formatSolSpent(0.42)).toBe("0.42 SOL");
});

test("formatPositionMessage includes avg entry and unrealized PNL", () => {
  const text = formatPositionMessage(
    {
      mint: TIMBA,
      ticker: "TIMBA",
      balance: 123,
      avgEntrySol: 0.01,
      avgEntryUsd: 0.00000441,
      priceUsd: 0.00000524,
      pnlPercent: 0.184,
      unrealizedUsd: 0.95,
      trackedBalance: 123,
      buyCount: 1,
      sellCount: 0,
      solSpent: 0.42,
    },
    { index: 0, count: 2 },
  );

  expect(text).toContain("📊 TIMBA · 1/2");
  expect(text).toContain(TIMBA);
  expect(text).toContain("Price: $0.00000524");
  expect(text).toContain("Avg entry: $0.00000441");
  expect(text).toContain("Unrealized: +18.4% (+$0.95) 🟢");
  expect(text).toContain("Spent: 0.42 SOL · 1 buy");
});
