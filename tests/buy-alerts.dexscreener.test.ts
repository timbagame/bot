import { expect, setSystemTime, test } from "bun:test";
import {
  fetchDexScreenerPairStats,
  fetchDexScreenerPoolStats,
  selectSolanaPair,
  selectSolanaPairs,
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
            quoteToken: { address: "sol", symbol: "SOL" },
            baseToken: { address: "mint", name: "TIMBA", symbol: "TIMBA" },
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

test("pair discovery keeps the watched mint's orientation and returns every Solana pool", async () => {
  const pairs = [
    {
      chainId: "solana",
      dexId: "pumpswap",
      pairAddress: "quote-side",
      priceUsd: "4.25",
      marketCap: 20_000_000,
      liquidity: { usd: 20_000_000 },
      baseToken: { address: "pump", name: "Pump", symbol: "PUMP" },
      quoteToken: { address: "usdc", name: "USD Coin", symbol: "USDC" },
    },
    {
      chainId: "solana",
      dexId: "raydium",
      pairAddress: "base-side",
      priceUsd: "1",
      marketCap: 1_000_000,
      liquidity: { usd: 3_000_000 },
      baseToken: { address: "usdc", name: "USD Coin", symbol: "USDC" },
      quoteToken: { address: "usdt", name: "Tether", symbol: "USDT" },
    },
  ];

  const stats = selectSolanaPairs(pairs, "usdc");
  expect(stats.map((pair) => pair.pairAddress)).toEqual(["base-side", "quote-side"]);
  expect(stats[0]?.tokenName).toBe("USD Coin");
  expect(stats[0]?.quoteSymbol).toBe("USDT");
  expect(stats[0]?.priceUsd).toBe(1);
  expect(stats[1]?.tokenName).toBe("USD Coin");
  expect(stats[1]?.quoteSymbol).toBe("PUMP");
  expect(stats[1]?.priceUsd).toBeNull();

  __test_clearDexScreenerCache();
  const fetchImpl = async () =>
    new Response(JSON.stringify({ pairs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetched = await fetchDexScreenerPoolStats("usdc", fetchImpl as any);
  expect(fetched.map((pair) => pair.pairAddress)).toEqual(["base-side", "quote-side"]);
  expect((await fetchDexScreenerPairStats("usdc", fetchImpl as any))?.pairAddress).toBe(
    "base-side",
  );
});

test("pair selection handles empty inputs and ranks watched-mint base pairs first", () => {
  expect(selectSolanaPairs(null)).toEqual([]);
  expect(selectSolanaPairs([])).toEqual([]);
  expect(selectSolanaPair(undefined)).toBeNull();

  const pairs = [
    {
      chainId: "solana",
      pairAddress: "quote-a",
      liquidity: { usd: 900 },
      baseToken: { address: "other-a" },
      quoteToken: { address: "mint" },
    },
    {
      chainId: "solana",
      pairAddress: "base-low",
      liquidity: { usd: 10 },
      baseToken: { address: "mint" },
      quoteToken: { address: "sol" },
    },
    {
      chainId: "solana",
      pairAddress: "quote-b",
      liquidity: { usd: 500 },
      baseToken: { address: "other-b" },
      quoteToken: { address: "mint" },
    },
    {
      chainId: "solana",
      pairAddress: "unrelated",
      liquidity: { usd: 99_999 },
      baseToken: { address: "x" },
      quoteToken: { address: "y" },
    },
  ];
  expect(selectSolanaPairs(pairs, " mint ").map((pair) => pair.pairAddress)).toEqual([
    "base-low",
    "quote-a",
    "quote-b",
  ]);
  expect(selectSolanaPairs([...pairs].reverse(), "mint").map((pair) => pair.pairAddress)).toEqual([
    "base-low",
    "quote-a",
    "quote-b",
  ]);
});

test("fetchDexScreenerPoolStats skips blank mints and caches failed HTTP lookups as empty", async () => {
  __test_clearDexScreenerCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("upstream error", { status: 502 });
  };

  expect(await fetchDexScreenerPoolStats("   ", fetchImpl as any)).toEqual([]);
  expect(calls).toBe(0);

  expect(await fetchDexScreenerPoolStats("bad-mint", fetchImpl as any)).toEqual([]);
  expect(await fetchDexScreenerPoolStats("bad-mint", fetchImpl as any)).toEqual([]);
  expect(calls).toBe(1);
  expect(await fetchDexScreenerPairStats("bad-mint", fetchImpl as any)).toBeNull();
});

test("fetchDexScreenerPoolStats falls back to the stale lookup, or none, when the request fails", async () => {
  __test_clearDexScreenerCache();
  const start = new Date("2026-01-01T00:00:00Z");
  setSystemTime(start);
  try {
    let fail = false;
    const fetchImpl = async () => {
      if (fail) throw new Error("network down");
      return Response.json({
        pairs: [
          {
            chainId: "solana",
            dexId: "pumpswap",
            url: "https://dexscreener.com/solana/stale",
            pairAddress: "pair-stale",
            priceUsd: "0.5",
            liquidity: { usd: 10 },
            quoteToken: { address: "sol", symbol: "SOL" },
            baseToken: { address: "stale-mint", name: "STALE", symbol: "STALE" },
          },
        ],
      });
    };

    const fresh = await fetchDexScreenerPoolStats("stale-mint", fetchImpl as any);
    expect(fresh.map((stats) => stats.pairAddress)).toEqual(["pair-stale"]);

    // Past the 30s TTL the lookup is retried; a failed retry serves the expired result.
    setSystemTime(new Date(start.getTime() + 31_000));
    fail = true;
    expect(await fetchDexScreenerPoolStats("stale-mint", fetchImpl as any)).toEqual(fresh);

    // With nothing cached, a failed request yields no pools.
    expect(await fetchDexScreenerPoolStats("never-seen", fetchImpl as any)).toEqual([]);
  } finally {
    setSystemTime();
  }
});
