import { expect, test } from "bun:test";
import { WSOL_MINT } from "../src/utils/constants";
import {
  USDC_MINT,
  USDT_MINT,
  buildTokenPositions,
  clearPositionSnapshot,
  createDecimalResolver,
  fillsFromSwaps,
  formatPositionMessage,
  formatPositionSpent,
  formatPositionsPage,
  loadTokenPositionsForWallet,
  resolveTokenDecimals,
  formatSolSpent,
  formatSignedPercent,
  quoteAmountToSol,
  rawAmountToNumber,
  sortTokenPositions,
  type TokenPosition,
} from "../src/services/positions";
import type { SwapStatRecord } from "../src/utils/transaction-history";

const TIMBA = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const UNKNOWN_MINT = "Unk1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const knownDecimals = (extra: Array<{ mint: string; decimals: number }> = []) =>
  createDecimalResolver([{ mint: TIMBA, decimals: 6 }, ...extra]);

const fromSwaps = (swaps: SwapStatRecord[], extra?: Array<{ mint: string; decimals: number }>) =>
  fillsFromSwaps(swaps, knownDecimals(extra));

const card = (overrides: Partial<TokenPosition> = {}): TokenPosition => ({
  mint: TIMBA,
  ticker: "TIMBA",
  balance: 123,
  trackedBalance: 123,
  decimals: 6,
  avgEntrySol: 0.01,
  avgEntryUsd: 0.00000441,
  priceUsd: 0.00000524,
  pnlPercent: 0.184,
  unrealizedUsd: 0.95,
  buyCount: 1,
  sellCount: 0,
  solSpent: 0.42,
  usdcSpent: 0,
  usdtSpent: 0,
  ...overrides,
});

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
  const fills = fromSwaps([
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
  const fills = fromSwaps([
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

test("resolveTokenDecimals does not invent 6 decimals for an unknown mint", () => {
  expect(resolveTokenDecimals(UNKNOWN_MINT, "NOPE")).toBeNull();
  expect(fromSwaps([swap({ output_mint: UNKNOWN_MINT, output_ticker: "NOPE" })])).toEqual([]);
  expect(fillsFromSwaps([swap({ output_mint: UNKNOWN_MINT, output_ticker: "NOPE" })])).toEqual([]);
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

test("buildTokenPositions aggregates multiple accounts for the same mint", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
  ]);

  const positions = buildTokenPositions({
    fills,
    holdings: [
      { mint: TIMBA, ticker: "TIMBA", balance: 60, decimals: 6, rawBalance: "60000000" },
      { mint: TIMBA, ticker: "TIMBA", balance: 40, decimals: 6, rawBalance: "40000000" },
    ],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
  });

  expect(positions).toHaveLength(1);
  expect(positions[0]).toMatchObject({
    balance: 100,
    rawBalance: "100000000",
    trackedBalance: 100,
    solSpent: 1,
  });
  expect(positions[0]?.unrealizedUsd).toBeCloseTo(20, 8);
});

test("buildTokenPositions does not confuse an SPL token symbol with native SOL", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", output_ticker: "SOL", amount_out: "100000000", timestamp: 1 }),
  ]);

  const positions = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "SOL", balance: 100, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
  });

  expect(positions).toHaveLength(1);
  expect(positions[0]?.mint).toBe(TIMBA);
});

test("a full sell closes the position", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
    swap({
      signature: "sell",
      input_mint: TIMBA,
      output_mint: WSOL_MINT,
      input_ticker: "TIMBA",
      output_ticker: "SOL",
      amount_in: "100000000",
      amount_out: "900000000",
      timestamp: 2,
    }),
  ]);

  expect(
    buildTokenPositions({
      fills,
      holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 0.000001, decimals: 6 }],
      pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
    }),
  ).toEqual([]);
});

test("a full sell then rebuy starts a new average entry", () => {
  const fills = fromSwaps([
    swap({ signature: "buy-1", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
    swap({
      signature: "sell-all",
      input_mint: TIMBA,
      output_mint: WSOL_MINT,
      input_ticker: "TIMBA",
      output_ticker: "SOL",
      amount_in: "100000000",
      amount_out: "500000000",
      timestamp: 2,
    }),
    swap({ signature: "buy-2", amount_in: "2000000000", amount_out: "50000000", timestamp: 3 }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 50, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 5 },
  });

  expect(position?.avgEntrySol).toBeCloseTo(0.04, 8);
  expect(position?.avgEntryUsd).toBeCloseTo(4, 8);
  expect(position?.buyCount).toBe(2);
  expect(position?.sellCount).toBe(1);
  expect(position?.solSpent).toBeCloseTo(2, 8);
});

test("two buys then a sell keep a weighted average entry", () => {
  const fills = fromSwaps([
    swap({ signature: "buy-1", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
    swap({ signature: "buy-2", amount_in: "3000000000", amount_out: "100000000", timestamp: 2 }),
    swap({
      signature: "sell-1",
      input_mint: TIMBA,
      output_mint: WSOL_MINT,
      input_ticker: "TIMBA",
      output_ticker: "SOL",
      amount_in: "50000000",
      amount_out: "800000000",
      timestamp: 3,
    }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 150, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 2.5 },
  });

  expect(position?.avgEntrySol).toBeCloseTo(0.02, 8);
  expect(position?.avgEntryUsd).toBeCloseTo(2, 8);
  expect(position?.trackedBalance).toBeCloseTo(150, 8);
  expect(position?.buyCount).toBe(2);
  expect(position?.sellCount).toBe(1);
});

test("a USDC buy keeps a USD average entry", () => {
  const fills = fromSwaps([
    swap({
      signature: "usdc-buy",
      input_mint: USDC_MINT,
      output_mint: TIMBA,
      input_ticker: "USDC",
      output_ticker: "TIMBA",
      amount_in: "50000000",
      amount_out: "100000000",
      timestamp: 1,
    }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 200, [TIMBA]: 0.6 },
  });

  expect(position?.avgEntryUsd).toBeCloseTo(0.5, 8);
  expect(position?.avgEntrySol).toBeNull();
  expect(position?.solSpent).toBe(0);
  expect(position?.usdcSpent).toBeCloseTo(50, 8);
  expect(position?.pnlPercent).toBeCloseTo(0.2, 8);
  expect(formatPositionMessage(position!)).toContain("Spent: 50 USDC, 1 buy");
  expect(formatPositionMessage(position!)).not.toContain("SOL");
});

test("fillsFromSwaps turns token-to-token rotations into a linked sell and buy", () => {
  const fills = fromSwaps(
    [
      swap({ signature: "buy", timestamp: 1 }),
      swap({
        signature: "rotate",
        input_mint: TIMBA,
        output_mint: BONK,
        input_ticker: "TIMBA",
        output_ticker: "BONK",
        amount_in: "50000000",
        amount_out: "800000000",
        timestamp: 2,
      }),
    ],
    [{ mint: BONK, decimals: 6 }],
  );

  expect(fills).toHaveLength(3);
  expect(fills[0]).toMatchObject({ side: "buy", mint: TIMBA, source: "cash" });
  expect(fills[1]).toMatchObject({
    side: "sell",
    mint: TIMBA,
    source: "rotate",
    groupId: "rotate",
    tokenAmount: 50,
  });
  expect(fills[2]).toMatchObject({
    side: "buy",
    mint: BONK,
    source: "rotate",
    groupId: "rotate",
    tokenAmount: 800,
  });
});

test("a token-to-token rotate moves remaining cost basis into the new mint", () => {
  const fills = fromSwaps(
    [
      swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
      swap({
        signature: "rotate",
        input_mint: TIMBA,
        output_mint: BONK,
        input_ticker: "TIMBA",
        output_ticker: "BONK",
        amount_in: "40000000",
        amount_out: "800000000",
        timestamp: 2,
      }),
    ],
    [{ mint: BONK, decimals: 6 }],
  );

  const positions = buildTokenPositions({
    fills,
    holdings: [
      { mint: TIMBA, ticker: "TIMBA", balance: 60, decimals: 6 },
      { mint: BONK, ticker: "BONK", balance: 800, decimals: 6 },
    ],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2, [BONK]: 0.06 },
  });

  const timba = positions.find((position) => position.ticker === "TIMBA");
  const bonkPos = positions.find((position) => position.ticker === "BONK");

  expect(timba?.trackedBalance).toBeCloseTo(60, 8);
  expect(timba?.avgEntrySol).toBeCloseTo(0.01, 8);
  expect(timba?.solSpent).toBeCloseTo(0.6, 8);
  expect(timba?.buyCount).toBe(1);
  expect(timba?.sellCount).toBe(1);

  expect(bonkPos?.trackedBalance).toBeCloseTo(800, 8);
  expect(bonkPos?.avgEntrySol).toBeCloseTo(0.0005, 8);
  expect(bonkPos?.solSpent).toBeCloseTo(0.4, 8);
  expect(bonkPos?.buyCount).toBe(0);
  expect(bonkPos?.unrealizedUsd).toBeCloseTo(8, 8);
  expect(formatPositionMessage(bonkPos!)).toContain("Spent: 0.4 SOL");
  expect(formatPositionMessage(bonkPos!)).not.toContain("buy");
});

test("rotating a token with no bot lot does not invent a BONK entry", () => {
  const fills = fromSwaps(
    [
      swap({
        signature: "rotate",
        input_mint: TIMBA,
        output_mint: BONK,
        input_ticker: "TIMBA",
        output_ticker: "BONK",
        amount_in: "40000000",
        amount_out: "800000000",
        timestamp: 1,
      }),
    ],
    [{ mint: BONK, decimals: 6 }],
  );

  expect(
    buildTokenPositions({
      fills,
      holdings: [
        { mint: TIMBA, ticker: "TIMBA", balance: 10, decimals: 6 },
        { mint: BONK, ticker: "BONK", balance: 800, decimals: 6 },
      ],
      pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2, [BONK]: 0.06 },
    }),
  ).toEqual([]);
});

test("rotating the whole lot closes TIMBA and opens BONK with the same basis", () => {
  const fills = fromSwaps(
    [
      swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
      swap({
        signature: "rotate-all",
        input_mint: TIMBA,
        output_mint: BONK,
        input_ticker: "TIMBA",
        output_ticker: "BONK",
        amount_in: "100000000",
        amount_out: "2000000000",
        timestamp: 2,
      }),
    ],
    [{ mint: BONK, decimals: 6 }],
  );

  const positions = buildTokenPositions({
    fills,
    holdings: [
      { mint: TIMBA, ticker: "TIMBA", balance: 0.0001, decimals: 6 },
      { mint: BONK, ticker: "BONK", balance: 2000, decimals: 6 },
    ],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2, [BONK]: 0.05 },
  });

  expect(positions.map((position) => position.ticker)).toEqual(["BONK"]);
  expect(positions[0]?.solSpent).toBeCloseTo(1, 8);
  expect(positions[0]?.avgEntrySol).toBeCloseTo(0.0005, 8);
});

test("an external sell leaves books above the on-chain bag", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 40, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
  });

  expect(position?.trackedBalance).toBeCloseTo(100, 8);
  expect(position?.balance).toBeCloseTo(40, 8);
  expect(position?.avgEntryUsd).toBeCloseTo(1, 8);
  expect(position?.unrealizedUsd).toBeCloseTo(8, 8);
  expect(position?.solSpent).toBeCloseTo(1, 8);
  expect(formatPositionMessage(position!)).not.toContain("on ");
  expect(formatPositionMessage(position!)).not.toContain("left");
  expect(formatPositionMessage(position!)).toContain("Balance: <code>40</code>");
});

test("selling the whole bag outside the bot closes the card", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
  ]);

  expect(
    buildTokenPositions({
      fills,
      holdings: [],
      pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
    }),
  ).toEqual([]);
  expect(
    buildTokenPositions({
      fills,
      holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 0, decimals: 6 }],
      pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
    }),
  ).toEqual([]);
});

test("a sell to USDC reduces the lot the same way as a sell to SOL", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
    swap({
      signature: "sell-usdc",
      input_mint: TIMBA,
      output_mint: USDC_MINT,
      input_ticker: "TIMBA",
      output_ticker: "USDC",
      amount_in: "40000000",
      amount_out: "50000000",
      timestamp: 2,
    }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 60, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
  });

  expect(position?.trackedBalance).toBeCloseTo(60, 8);
  expect(position?.avgEntrySol).toBeCloseTo(0.01, 8);
  expect(position?.solSpent).toBeCloseTo(0.6, 8);
});

test("a USDT buy is treated like a USDC buy", () => {
  const fills = fromSwaps([
    swap({
      signature: "usdt-buy",
      input_mint: USDT_MINT,
      output_mint: TIMBA,
      input_ticker: "USDT",
      output_ticker: "TIMBA",
      amount_in: "50000000",
      amount_out: "100000000",
      timestamp: 1,
    }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 200, [TIMBA]: 0.6 },
  });

  expect(position?.avgEntryUsd).toBeCloseTo(0.5, 8);
  expect(position?.avgEntrySol).toBeNull();
  expect(position?.solSpent).toBe(0);
  expect(position?.usdtSpent).toBeCloseTo(50, 8);
  expect(formatPositionMessage(position!)).toContain("Spent: 50 USDT, 1 buy");
});

test("mixed SOL and USDC buys share one weighted USD average", () => {
  const fills = fromSwaps([
    swap({ signature: "sol-buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
    swap({
      signature: "usdc-buy",
      input_mint: USDC_MINT,
      output_mint: TIMBA,
      input_ticker: "USDC",
      output_ticker: "TIMBA",
      amount_in: "50000000",
      amount_out: "50000000",
      timestamp: 2,
    }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 150, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1 },
  });

  expect(position?.trackedBalance).toBeCloseTo(150, 8);
  expect(position?.avgEntryUsd).toBeCloseTo(1, 8);
  expect(position?.avgEntrySol).toBeCloseTo(1 / 150, 8);
  expect(position?.solSpent).toBeCloseTo(1, 8);
  expect(position?.usdcSpent).toBeCloseTo(50, 8);
  expect(position?.buyCount).toBe(2);
  expect(formatPositionMessage(position!)).toContain("Spent: 1 SOL + 50 USDC, 2 buys");
});

test("selling more than the tracked lot just closes the books", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
    swap({
      signature: "oversell",
      input_mint: TIMBA,
      output_mint: WSOL_MINT,
      input_ticker: "TIMBA",
      output_ticker: "SOL",
      amount_in: "150000000",
      amount_out: "2000000000",
      timestamp: 2,
    }),
  ]);

  expect(
    buildTokenPositions({
      fills,
      holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 10, decimals: 6 }],
      pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
    }),
  ).toEqual([]);
});

test("fillsFromSwaps applies later buys even if the row arrives first", () => {
  const fills = fromSwaps([
    swap({
      signature: "sell",
      input_mint: TIMBA,
      output_mint: WSOL_MINT,
      input_ticker: "TIMBA",
      output_ticker: "SOL",
      amount_in: "40000000",
      amount_out: "500000000",
      timestamp: 2,
    }),
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
  ]);

  expect(fills[0]?.side).toBe("buy");
  expect(fills[1]?.side).toBe("sell");

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 60, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1.2 },
  });
  expect(position?.avgEntrySol).toBeCloseTo(0.01, 8);
  expect(position?.trackedBalance).toBeCloseTo(60, 8);
});

test("quote holdings and SOL are never positions", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", timestamp: 1 }),
    swap({
      signature: "usdc-in",
      input_mint: WSOL_MINT,
      output_mint: USDC_MINT,
      input_ticker: "SOL",
      output_ticker: "USDC",
      amount_in: "1000000000",
      amount_out: "100000000",
      timestamp: 2,
    }),
  ]);

  expect(
    buildTokenPositions({
      fills,
      holdings: [
        { mint: TIMBA, ticker: "TIMBA", balance: 123, decimals: 6 },
        { mint: USDC_MINT, ticker: "USDC", balance: 100, decimals: 6 },
        { mint: WSOL_MINT, ticker: "WSOL", balance: 2, decimals: 9 },
        {
          mint: "So11111111111111111111111111111111111111112",
          ticker: "SOL",
          balance: 1,
          decimals: 9,
        },
      ],
      pricesUsd: { [WSOL_MINT]: 100, [TIMBA]: 1, [USDC_MINT]: 1 },
    }).map((position) => position.ticker),
  ).toEqual(["TIMBA"]);
});

test("fillsFromSwaps skips zero amounts and same-mint rows", () => {
  expect(
    fromSwaps([
      swap({ signature: "zero", amount_out: "0" }),
      swap({ signature: "same", input_mint: TIMBA, output_mint: TIMBA, output_ticker: "TIMBA" }),
    ]),
  ).toEqual([]);
});

test("buildTokenPositions leaves PNL blank when the token has no price", () => {
  const fills = fromSwaps([
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
  ]);

  const [position] = buildTokenPositions({
    fills,
    holdings: [{ mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6 }],
    pricesUsd: { [WSOL_MINT]: 100 },
  });

  expect(position?.avgEntryUsd).toBeCloseTo(1, 8);
  expect(position?.priceUsd).toBeNull();
  expect(position?.pnlPercent).toBeNull();
  expect(position?.unrealizedUsd).toBeNull();
  expect(formatPositionMessage(position!)).toContain("Unrealized: -");
});

test("sortTokenPositions puts the largest USD bag first", () => {
  const small = card({
    mint: "small",
    ticker: "SMALL",
    balance: 10,
    trackedBalance: 10,
    avgEntryUsd: 1,
    priceUsd: 1,
    pnlPercent: 0.5,
    unrealizedUsd: 5,
    solSpent: 0.1,
  });
  const large = { ...small, mint: "large", ticker: "LARGE", balance: 100, unrealizedUsd: 50 };

  expect(sortTokenPositions([small, large]).map((position) => position.ticker)).toEqual([
    "LARGE",
    "SMALL",
  ]);

  const red = { ...small, mint: "red", ticker: "RED", pnlPercent: -0.8 };
  const green = { ...small, mint: "green", ticker: "GRN", pnlPercent: 0.2 };
  expect(sortTokenPositions([green, red]).map((position) => position.ticker)).toEqual([
    "RED",
    "GRN",
  ]);
});

test("quoteAmountToSol only counts native SOL", () => {
  expect(quoteAmountToSol(USDC_MINT, 50)).toBe(0);
  expect(quoteAmountToSol(USDT_MINT, 50)).toBe(0);
  expect(quoteAmountToSol(WSOL_MINT, 0.42)).toBeCloseTo(0.42, 8);
});

test("format helpers match the wallet PNL style", () => {
  expect(formatSignedPercent(0.184)).toBe("+18.4%");
  expect(formatSignedPercent(-0.0646)).toBe("-6.46%");
  expect(formatSignedPercent(0)).toBe("0%");
  expect(formatSolSpent(0.42)).toBe("0.42 SOL");
  expect(formatPositionSpent({ solSpent: 0.2, usdcSpent: 10 })).toBe("0.2 SOL + 10 USDC");
  expect(formatPositionSpent({ usdcSpent: 12 })).toBe("12 USDC");
  expect(formatPositionSpent({})).toBe("-");
});

test("formatPositionMessage includes avg entry and unrealized PNL", () => {
  const text = formatPositionMessage(card());

  expect(text).toContain("📊 TIMBA");
  expect(text).not.toContain("1/2");
  expect(text).toContain(`<a href="https://dexscreener.com/solana/${TIMBA}">📈</a>`);
  expect(text).toContain(TIMBA);
  expect(text).toContain("Mark: $0.00000524");
  expect(text).not.toContain("Price:");
  expect(text).toContain("Avg entry: $0.00000441");
  expect(text).toContain("Unrealized: +18.4% (+$0.95) 🟢");
  expect(text).toContain("Spent: 0.42 SOL, 1 buy");
});

test("formatPositionMessage escapes an on-chain token symbol", () => {
  const text = formatPositionMessage(card({ ticker: "<b>T&I" }));

  expect(text).toContain("📊 &lt;b&gt;T&amp;I");
  expect(text).not.toContain("📊 <b>T&I");
});

test("formatPositionMessage scopes Unrealized when the bag is larger than the swap fill", () => {
  const text = formatPositionMessage(
    card({
      balance: 200,
      trackedBalance: 80,
      avgEntryUsd: 1,
      priceUsd: 1.2,
      pnlPercent: 0.2,
      unrealizedUsd: 16,
      solSpent: 0.8,
    }),
  );

  expect(text).toContain("on 80 ($96)");
  expect(text).toContain("Balance: <code>200</code> ($240)");
  expect(text).not.toContain("Bought here:");
  expect(text).not.toContain("Bot lot:");
  expect(text).not.toContain("Tracked:");
});

test("formatPositionMessage omits the scope line when the on-chain bag is smaller than the books", () => {
  const text = formatPositionMessage(
    card({
      balance: 40,
      trackedBalance: 100,
      avgEntryUsd: 1,
      priceUsd: 1.2,
      pnlPercent: -0.1,
      unrealizedUsd: -8,
      solSpent: 1,
    }),
  );

  expect(text).not.toContain("on ");
  expect(text).not.toContain("left");
  expect(text).toContain("Balance: <code>40</code>");
  expect(text).toContain("Unrealized: -10% (-$8) 🟥");
});

test("formatPositionMessage scopes Unrealized to the swap piece of a transferred bag", () => {
  const text = formatPositionMessage(
    card({
      balance: 16350307.619063,
      trackedBalance: 194012.995423,
      decimals: 6,
      rawBalance: "16350307619063",
      avgEntryUsd: 0.00000544,
      priceUsd: 0.00000551,
      pnlPercent: 0.0134,
      unrealizedUsd: 0.01,
      solSpent: 0,
      usdcSpent: 1.055,
    }),
  );

  expect(text).toContain("Balance: <code>16350307.619063</code> ($90.09)");
  expect(text).toContain("on 194012.995423 ($1.07)");
  expect(text).toContain("Unrealized: +1.34% (+$0.01) 🟢");
  expect(text).toContain("Spent: 1.055 USDC, 1 buy");
  expect(text).not.toContain("Bought here:");
  expect(text).not.toContain("Received");
});

test("formatPositionMessage copies the exact on-chain bag", () => {
  const magaiba = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";
  const text = formatPositionMessage(
    card({
      mint: magaiba,
      ticker: "MAGAIBA",
      balance: 3703.33795378,
      trackedBalance: 3259.53344985,
      decimals: 8,
      rawBalance: "370333795378",
      avgEntryUsd: 0.000158,
      priceUsd: 0.000155,
      pnlPercent: -0.019,
      unrealizedUsd: -0.01,
      solSpent: 0.005,
    }),
  );

  expect(text).toContain("Balance: <code>3703.33795378</code>");
  expect(text).not.toContain("3,703");
  expect(text).toContain("on 3259.53344985 ($0.51)");
});

test("formatPositionsPage lists cards and only paginates after three positions", () => {
  const onePage = formatPositionsPage(
    [card({ ticker: "AAA" }), card({ ticker: "BBB" }), card({ ticker: "CCC" })],
    { page: 0, pageCount: 1 },
  );
  expect(onePage).toContain("AAA");
  expect(onePage).toContain("BBB");
  expect(onePage).toContain("CCC");
  expect(onePage).not.toContain("Positions (");

  const paged = formatPositionsPage([card({ ticker: "DDD" })], { page: 1, pageCount: 2 });
  expect(paged).toContain("📊 Positions (2/2)");
  expect(paged).toContain("DDD");
});

test("loadTokenPositionsForWallet reuses fills and prices across /start and Positions", async () => {
  clearPositionSnapshot();
  let priceCalls = 0;
  const swaps = [
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
  ];
  const holdings = [
    { mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6, rawBalance: "100000000" },
  ];
  const loader = {
    walletAddress: "wallet-cache-1",
    getHoldings: async () => holdings,
    getSwaps: () => swaps,
    fetchPricesUSD: async (mints: string[]) => {
      priceCalls += 1;
      expect(mints).toContain(WSOL_MINT);
      return { [WSOL_MINT]: 100, [TIMBA]: 1.2 };
    },
    knownTokens: [{ mint: TIMBA, decimals: 6 }],
  };

  const first = await loadTokenPositionsForWallet(loader);
  const second = await loadTokenPositionsForWallet(loader);
  expect(priceCalls).toBe(1);
  expect(second).toEqual(first);
  expect(first[0]?.solSpent).toBeCloseTo(1, 8);

  clearPositionSnapshot("wallet-cache-1");
  const third = await loadTokenPositionsForWallet(loader);
  expect(priceCalls).toBe(2);
  expect(third[0]?.ticker).toBe("TIMBA");
  clearPositionSnapshot();
});

test("loadTokenPositionsForWallet skips price requests when no swaps are tracked", async () => {
  clearPositionSnapshot();
  let priceCalls = 0;
  const positions = await loadTokenPositionsForWallet({
    walletAddress: "wallet-no-tracked-lots",
    getHoldings: async () =>
      Array.from({ length: 60 }, (_, index) => ({
        mint: `dust-${index}`,
        ticker: `D${index}`,
        balance: 1,
        decimals: 6,
      })),
    getSwaps: () => [],
    fetchPricesUSD: async () => {
      priceCalls += 1;
      return {};
    },
  });

  expect(positions).toEqual([]);
  expect(priceCalls).toBe(0);
  clearPositionSnapshot();
});

test("loadTokenPositionsForWallet prices only tracked lots in a dust-heavy wallet", async () => {
  clearPositionSnapshot();
  const requested: string[][] = [];
  const positions = await loadTokenPositionsForWallet({
    walletAddress: "wallet-tracked-lot-with-dust",
    getHoldings: async () => [
      { mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6 },
      ...Array.from({ length: 60 }, (_, index) => ({
        mint: `dust-${index}`,
        ticker: `D${index}`,
        balance: 1,
        decimals: 6,
      })),
    ],
    getSwaps: () => [swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000" })],
    fetchPricesUSD: async (mints) => {
      requested.push(mints);
      return { [WSOL_MINT]: 100, [TIMBA]: 1.2 };
    },
    knownTokens: [{ mint: TIMBA, decimals: 6 }],
  });

  expect(requested).toEqual([[WSOL_MINT, TIMBA]]);
  expect(positions.map((position) => position.mint)).toEqual([TIMBA]);
  clearPositionSnapshot();
});

test("loadTokenPositionsForWallet retries a mint after a failed price fetch", async () => {
  clearPositionSnapshot();
  const swaps = [
    swap({ signature: "buy", amount_in: "1000000000", amount_out: "100000000", timestamp: 1 }),
  ];
  const holdings = [
    { mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6, rawBalance: "100000000" },
  ];
  const fetches: string[][] = [];
  const loader = {
    walletAddress: "wallet-price-retry",
    getHoldings: async () => holdings,
    getSwaps: () => swaps,
    fetchPricesUSD: async (mints: string[]): Promise<Record<string, number>> => {
      fetches.push([...mints]);
      if (fetches.length === 1) {
        return { [WSOL_MINT]: 100 };
      }
      return { [WSOL_MINT]: 100, [TIMBA]: 1.2 };
    },
    knownTokens: [{ mint: TIMBA, decimals: 6 }],
  };

  const first = await loadTokenPositionsForWallet(loader);
  expect(first[0]?.priceUsd).toBeNull();
  expect(first[0]?.pnlPercent).toBeNull();

  const second = await loadTokenPositionsForWallet(loader);
  expect(fetches.length).toBe(2);
  expect(fetches[1]).toContain(TIMBA);
  expect(second[0]?.priceUsd).toBeCloseTo(1.2, 8);
  expect(second[0]?.pnlPercent).not.toBeNull();
  clearPositionSnapshot();
});
