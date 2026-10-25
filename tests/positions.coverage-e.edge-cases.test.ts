import { afterEach, describe, expect, test } from "bun:test";
import { WSOL_MINT } from "../src/utils/constants";
import {
  USDC_MINT,
  applyFillsToLots,
  clearPositionSnapshot,
  formatPositionMessage,
  formatUnrealizedScopeLine,
  loadTokenPositionsForWallet,
  type PositionFill,
  type TokenPosition,
} from "../src/services/positions";

const TIMBA = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";
const DUST = "Dust1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

afterEach(() => {
  clearPositionSnapshot();
});

const position = (overrides: Partial<TokenPosition> = {}): TokenPosition => ({
  mint: TIMBA,
  ticker: "TIMBA",
  balance: 100,
  trackedBalance: 100,
  decimals: 6,
  avgEntrySol: 0.01,
  avgEntryUsd: 1,
  priceUsd: 1.5,
  pnlPercent: 0.5,
  unrealizedUsd: 50,
  buyCount: 1,
  sellCount: 0,
  solSpent: 0.5,
  usdcSpent: 0,
  usdtSpent: 0,
  ...overrides,
});

const rotateBuy = (overrides: Partial<PositionFill> = {}): PositionFill => ({
  mint: TIMBA,
  ticker: "TIMBA",
  side: "buy",
  tokenAmount: 40,
  quoteMint: "",
  quoteAmount: 0,
  timestamp: 10,
  source: "rotate",
  ...overrides,
});

describe("applyFillsToLots rotate buys without moved cost", () => {
  test("adds quantity but no cost when the rotate buy has no group id", () => {
    const lot = applyFillsToLots([rotateBuy()]).get(TIMBA)!;
    expect(lot.qty).toBe(40);
    expect(lot.costSol).toBe(0);
    expect(lot.costUsdc).toBe(0);
    expect(lot.costUsdt).toBe(0);
    expect(lot.buyCount).toBe(0);
  });

  test("adds quantity but no cost when the group has no matching rotate sell", () => {
    const lot = applyFillsToLots([rotateBuy({ groupId: "orphan-group" })]).get(TIMBA)!;
    expect(lot.qty).toBe(40);
    expect(lot.costSol).toBe(0);
    expect(lot.costUsdc).toBe(0);
    expect(lot.costUsdt).toBe(0);
  });

  test("carries the sold lot's cost into the matching rotate buy", () => {
    const lots = applyFillsToLots([
      {
        mint: DUST,
        ticker: "DUST",
        side: "buy",
        tokenAmount: 10,
        quoteMint: WSOL_MINT,
        quoteAmount: 2,
        timestamp: 1,
        source: "cash",
      },
      {
        mint: DUST,
        ticker: "DUST",
        side: "sell",
        tokenAmount: 10,
        quoteMint: "",
        quoteAmount: 0,
        timestamp: 5,
        source: "rotate",
        groupId: "g1",
      },
      rotateBuy({ groupId: "g1", timestamp: 5 }),
    ]);
    expect(lots.get(TIMBA)!.costSol).toBeCloseTo(2, 10);
    expect(lots.get(DUST)!.qty).toBe(0);
  });
});

describe("loadTokenPositionsForWallet price requests", () => {
  test("ignores zero balances and quote mints when collecting prices", async () => {
    const requested: string[][] = [];
    const positions = await loadTokenPositionsForWallet({
      walletAddress: "wallet-coverage-e-skip",
      getHoldings: async () => [
        { mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6, rawBalance: "100000000" },
        { mint: DUST, ticker: "DUST", balance: 0, decimals: 6, rawBalance: "0" },
        { mint: USDC_MINT, ticker: "USDC", balance: 25, decimals: 6, rawBalance: "25000000" },
      ],
      getSwaps: () => [
        {
          signature: "buy-1",
          wallet: "wallet-coverage-e-skip",
          input_mint: USDC_MINT,
          output_mint: TIMBA,
          input_ticker: "USDC",
          output_ticker: "TIMBA",
          amount_in: "10000000",
          amount_out: "100000000",
          timestamp: 1,
        } as never,
        {
          signature: "buy-2",
          wallet: "wallet-coverage-e-skip",
          input_mint: USDC_MINT,
          output_mint: DUST,
          input_ticker: "USDC",
          output_ticker: "DUST",
          amount_in: "1000000",
          amount_out: "5000000",
          timestamp: 2,
        } as never,
      ],
      fetchPricesUSD: async (mints) => {
        requested.push(mints);
        return { [TIMBA]: 0.2 };
      },
      knownTokens: [
        { mint: TIMBA, decimals: 6 },
        { mint: DUST, decimals: 6 },
      ],
    });

    expect(requested).toEqual([[TIMBA]]);
    expect(positions.map((p) => p.mint)).toEqual([TIMBA]);
    expect(positions[0]?.usdcSpent).toBeCloseTo(10, 8);
  });
});

describe("position message fallbacks", () => {
  test("omits the unrealized USD amount when only the percentage is known", () => {
    const message = formatPositionMessage(position({ unrealizedUsd: null, pnlPercent: 0.25 }));
    const unrealizedLine = message.split("\n").find((line) => line.startsWith("Unrealized:"));
    expect(unrealizedLine).toBe("Unrealized: +25% 🟢");
  });

  test("omits the swap USD value in the scope line when there is no price", () => {
    const line = formatUnrealizedScopeLine(position({ priceUsd: null, trackedBalance: 40 }));
    expect(line).toMatch(/^on [\d.,]+$/);
    expect(line).not.toContain("$");
  });

  test("includes the swap USD value in the scope line when priced", () => {
    const line = formatUnrealizedScopeLine(position({ priceUsd: 2, trackedBalance: 40 }));
    expect(line).toContain("($80");
  });
});
