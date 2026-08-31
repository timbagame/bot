import { expect, test } from "bun:test";
import {
  fetchDexScreenerPairStats,
  selectSolanaPair,
  __test_clearDexScreenerCache,
} from "../src/services/buy-alerts/dexscreener";

test("selectSolanaPair prefers the highest-liquidity Solana pair", () => {
  const stats = selectSolanaPair([
    {
      chainId: "solana",
      dexId: "raydium",
      url: "https://dexscreener.com/solana/low",
      priceUsd: "0.1",
      marketCap: 10,
      liquidity: { usd: 100 },
      priceChange: { h24: 1 },
      quoteToken: { symbol: "SOL" },
    },
    {
      chainId: "solana",
      dexId: "pumpswap",
      url: "https://dexscreener.com/solana/high",
      priceUsd: "0.000151",
      marketCap: 131550,
      liquidity: { usd: 50_000 },
      priceChange: { h24: 12.81 },
      quoteToken: { symbol: "SOL" },
    },
    {
      chainId: "ethereum",
      dexId: "uniswap",
      url: "https://dexscreener.com/ethereum/other",
      liquidity: { usd: 9_999_999 },
    },
  ]);

  expect(stats?.url).toBe("https://dexscreener.com/solana/high");
  expect(stats?.dexId).toBe("pumpswap");
  expect(stats?.priceUsd).toBe(0.000151);
  expect(stats?.marketCapUsd).toBe(131550);
  expect(stats?.pairAddress).toBeNull();
  expect(stats?.tokenName).toBeNull();
});

test("fetchDexScreenerPairStats uses the injected fetch and caches the result", async () => {
  __test_clearDexScreenerCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        pairs: [
          {
            chainId: "solana",
            dexId: "pumpswap",
            url: "https://dexscreener.com/solana/timba",
            pairAddress: "pair-timba",
            priceUsd: "0.0002",
            marketCap: 1000,
            liquidity: { usd: 10 },
            priceChange: { h24: -3.5 },
            quoteToken: { symbol: "SOL" },
            baseToken: { name: "TIMBA", symbol: "TIMBA" },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const first = await fetchDexScreenerPairStats("mint", fetchImpl as any);
  const second = await fetchDexScreenerPairStats("mint", fetchImpl as any);
  expect(calls).toBe(1);
  expect(first?.url).toBe("https://dexscreener.com/solana/timba");
  expect(first?.pairAddress).toBe("pair-timba");
  expect(first?.tokenName).toBe("TIMBA");
  expect(second?.priceChangeH24).toBe(-3.5);
});
