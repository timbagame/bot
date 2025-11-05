import { expect, test } from "bun:test";
import {
  LAMPORTS_PER_SOL,
  WSOL_MINT,
} from "../src/utils/constants";
import { buildWalletTokenLines } from "../src/utils/wallet-ui";

const formatSol = (lamports: number): string =>
  (lamports / LAMPORTS_PER_SOL).toFixed(2);

const formatToken = (balance: number, decimals: number): string =>
  (balance / Math.pow(10, decimals)).toFixed(2);

test("wallet token lines list native SOL and WSOL separately", async () => {
  const solLamports = 3 * LAMPORTS_PER_SOL;
  const wsolLamports = 2 * LAMPORTS_PER_SOL;

  const lines = await buildWalletTokenLines({
    solBalanceLamports: solLamports,
    tokenBalances: [
      { mint: WSOL_MINT, ticker: "WSOL", balance: wsolLamports, decimals: 9 },
      { mint: "USDC_MINT", ticker: "USDC", balance: 1_500_000, decimals: 6 },
    ],
    formatSolBalance: formatSol,
    formatTokenBalance: formatToken,
    fetchPricesUSD: async () => ({}),
  });

  const solLine = lines.find((line) => line.ticker === "SOL");
  const wsolLine = lines.find((line) => line.ticker === "WSOL");

  expect(solLine).toBeDefined();
  expect(solLine?.amount).toBe("3.00");
  expect(solLine?.unit).toBe("SOL");

  expect(wsolLine).toBeDefined();
  expect(wsolLine?.amount).toBe("2.00");
  expect(wsolLine?.unit).toBeUndefined();
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
