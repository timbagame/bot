import { expect, test } from "bun:test";
import { mergeWsolIntoSol, type TokenBalance } from "./balance";

const WSOL = "So11111111111111111111111111111111111111112";

test("mergeWsolIntoSol merges WSOL into SOL and removes WSOL token", () => {
  const solLamports = 200; // lamports as number for util
  const tokens: TokenBalance[] = [
    {
      mint: WSOL,
      ticker: "WSOL",
      balance: 100,
      decimals: 9,
      rawBalance: "100",
    },
    {
      mint: "USDC_MINT",
      ticker: "USDC",
      balance: 1_000_000, // 1 USDC with 6 decimals
      decimals: 6,
      rawBalance: "1000000",
    },
  ];

  const { solLamports: merged, tokenBalances } = mergeWsolIntoSol(
    solLamports,
    tokens,
    WSOL
  );

  expect(merged).toBe(Number(solLamports) + 100);
  expect(tokenBalances.length).toBe(1);
  expect(tokenBalances[0]!.ticker).toBe("USDC");
});

test("mergeWsolIntoSol is a no-op when WSOL not present", () => {
  const solLamports = 500;
  const tokens: TokenBalance[] = [
    {
      mint: "USDC_MINT",
      ticker: "USDC",
      balance: 2_000_000,
      decimals: 6,
      rawBalance: "2000000",
    },
  ];

  const { solLamports: merged, tokenBalances } = mergeWsolIntoSol(
    solLamports,
    tokens,
    WSOL
  );

  expect(merged).toBe(solLamports);
  expect(tokenBalances).toEqual(tokens);
});
