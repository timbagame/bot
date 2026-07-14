import { expect, test } from "bun:test";
import { LAMPORTS_PER_SOL, WSOL_MINT } from "../src/utils/constants";
import { buildWalletTokenLines } from "../src/utils/wallet-ui";

const formatSol = (lamports: number): string => (lamports / LAMPORTS_PER_SOL).toFixed(2);

const formatToken = (balance: number, decimals: number): string =>
  (balance / Math.pow(10, decimals)).toFixed(2);

test("wallet token lines prioritize SOL, WSOL, TIMBA order", async () => {
  const solLamports = 3 * LAMPORTS_PER_SOL;
  const wsolLamports = 2 * LAMPORTS_PER_SOL;

  const lines = await buildWalletTokenLines({
    solBalanceLamports: solLamports,
    tokenBalances: [
      { mint: "MAGAIBA_MINT", ticker: "MAGAIBA", balance: 3_540_649_831_400, decimals: 9 },
      { mint: WSOL_MINT, ticker: "WSOL", balance: wsolLamports, decimals: 9 },
      { mint: "TIMBA_MINT", ticker: "TIMBA", balance: 883_975_356_158, decimals: 9 },
      { mint: "USDC_MINT", ticker: "USDC", balance: 1_500_000, decimals: 6 },
    ],
    formatSolBalance: formatSol,
    formatTokenBalance: formatToken,
    fetchPricesUSD: async () => ({}),
  });

  expect(lines[0]?.ticker).toBe("SOL");
  expect(lines[0]?.amount).toBe("3.00");
  expect(lines[0]?.unit).toBe("SOL");

  expect(lines[1]?.ticker).toBe("WSOL");
  expect(lines[1]?.amount).toBe("2.00");

  expect(lines[2]?.ticker).toBe("TIMBA");
  expect(lines[2]?.amount).toBe("883.98");

  const remainingTickers = lines.slice(3).map((line) => line.ticker);
  expect(remainingTickers).toEqual(["MAGAIBA", "USDC"]);
});

test("wallet token lines omit zero WSOL balances", async () => {
  const lines = await buildWalletTokenLines({
    solBalanceLamports: 1 * LAMPORTS_PER_SOL,
    tokenBalances: [
      { mint: WSOL_MINT, ticker: "WSOL", balance: 0, decimals: 9 },
      { mint: "USDC_MINT", ticker: "USDC", balance: 2_000_000, decimals: 6 },
    ],
    formatSolBalance: formatSol,
    formatTokenBalance: formatToken,
    fetchPricesUSD: async () => ({}),
  });

  expect(lines.some((line) => line.ticker === "WSOL")).toBe(false);
  expect(lines.some((line) => line.ticker === "USDC")).toBe(true);
});
