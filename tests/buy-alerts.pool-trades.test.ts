import { expect, test } from "bun:test";
import {
  createPoolTradePoller,
  GeckoRateLimitError,
  parseGeckoPoolTrade,
  parseRetryAfterMs,
  rememberSignature,
} from "../src/services/buy-alerts/pool-trades";
import { WSOL_MINT } from "../src/utils/constants";
import type { BuyEvent } from "../src/services/buy-alerts/types";

const mint = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

const geckoBuy = {
  attributes: {
    tx_hash: "buy-sig-1",
    tx_from_address: "Trader11111111111111111111111111111111111",
    from_token_amount: "1.8998",
    to_token_amount: "1270000",
    kind: "buy",
    from_token_address: WSOL_MINT,
    to_token_address: mint,
  },
};

test("parseGeckoPoolTrade maps a SOL buy on the watched mint", () => {
  expect(parseGeckoPoolTrade(mint, geckoBuy, "raydium")).toEqual({
    signature: "buy-sig-1",
    mint,
    trader: "Trader11111111111111111111111111111111111",
    solAmount: 1.8998,
    inputAmount: 1.8998,
    inputSymbol: "SOL",
    tokenAmount: 1_270_000,
    dex: "raydium",
    dexId: "raydium",
    quoteSymbol: "SOL",
  });
});

test("parseGeckoPoolTrade skips trades whose output is another mint", () => {
  expect(
    parseGeckoPoolTrade(mint, {
      attributes: { ...geckoBuy.attributes, kind: "sell", to_token_address: WSOL_MINT },
    }),
  ).toBeNull();
});

test("parseRetryAfterMs accepts seconds and HTTP dates", () => {
  const now = Date.parse("2026-09-03T20:00:00.000Z");
  expect(parseRetryAfterMs("30", now)).toBe(30_000);
  expect(parseRetryAfterMs("Thu, 03 Sep 2026 20:00:45 GMT", now)).toBe(45_000);
  expect(parseRetryAfterMs("invalid", now)).toBeNull();
});

test("pool trade poller honors rate-limit cooldowns and suppresses repeated logs", async () => {
  const errors: unknown[] = [];
  const delays: number[] = [];
  let now = 0;
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 1_000,
    fetchPairStats: async () => ({
      priceUsd: 1,
      marketCapUsd: 1,
      priceChangeH24: 1,
      url: null,
      dexId: "raydium",
      quoteSymbol: "SOL",
      pairAddress: "pair-rate-limited",
      tokenName: "TOKEN",
    }),
    fetchTrades: async () => {
      throw new GeckoRateLimitError(30_000);
    },
    onError: (error) => errors.push(error),
    now: () => now,
    wait: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    },
  });

  poller.setMints([mint]);
  await poller.pollNow();

  expect(delays).toEqual([30_000]);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(GeckoRateLimitError);
  poller.stop();
});

test("parseGeckoPoolTrade accepts the watched mint on the quote side", () => {
  expect(
    parseGeckoPoolTrade(
      mint,
      {
        attributes: {
          ...geckoBuy.attributes,
          kind: "sell",
          from_token_address: "PumpMint",
          to_token_address: mint,
          from_token_amount: "250",
        },
      },
      "pumpswap",
      "PUMP",
    ),
  ).toMatchObject({
    mint,
    solAmount: null,
    inputAmount: 250,
    inputSymbol: "PUMP",
    dex: "pump",
  });
});

test("pool trade poller seeds existing trades then emits only new buys", async () => {
  const received: BuyEvent[] = [];
  let payload = { data: [geckoBuy] };
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    fetchPairStats: async () => ({
      priceUsd: 0.000152,
      marketCapUsd: 132_750,
      priceChangeH24: 14.44,
      url: "https://dexscreener.com/solana/pair",
      dexId: "raydium",
      quoteSymbol: "SOL",
      pairAddress: "pair-1",
      tokenName: "MAGAIBA",
    }),
    fetchTrades: async () => payload,
  });

  poller.onTrade((event) => received.push(event));
  poller.setMints([mint]);
  await poller.pollNow();
  expect(received).toEqual([]);

  payload = {
    data: [
      geckoBuy,
      {
        attributes: {
          ...geckoBuy.attributes,
          tx_hash: "buy-sig-2",
        },
      },
    ],
  };
  await poller.pollNow();
  expect(received.map((event) => event.signature)).toEqual(["buy-sig-2"]);

  poller.stop();
});

test("rememberSignature evicts the oldest hashes once the per-mint cap is hit", () => {
  const known = new Set<string>();
  expect(rememberSignature(known, "a", 2)).toBe(true);
  expect(rememberSignature(known, "b", 2)).toBe(true);
  expect(rememberSignature(known, "c", 2)).toBe(true);
  expect(known.has("a")).toBe(false);
  expect([...known]).toEqual(["b", "c"]);
  expect(rememberSignature(known, "b", 2)).toBe(false);
});

test("pool trade poller watches every discovered pool", async () => {
  const received: string[] = [];
  const payloads = new Map<string, { data: Array<typeof geckoBuy> }>([
    ["pair-a", { data: [geckoBuy] }],
    ["pair-b", { data: [{ attributes: { ...geckoBuy.attributes, tx_hash: "seed-b" } }] }],
  ]);
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    fetchPoolStats: async () => [
      {
        priceUsd: 1,
        marketCapUsd: 1,
        priceChangeH24: 1,
        url: null,
        dexId: "raydium",
        quoteSymbol: "SOL",
        pairAddress: "pair-a",
        tokenName: "TOKEN",
      },
      {
        priceUsd: 1,
        marketCapUsd: 1,
        priceChangeH24: 1,
        url: null,
        dexId: "meteora",
        quoteSymbol: "SOL",
        pairAddress: "pair-b",
        tokenName: "TOKEN",
      },
    ],
    fetchTrades: async (pairAddress) => payloads.get(pairAddress) ?? { data: [] },
  });

  poller.onTrade((buy) => received.push(buy.signature));
  poller.setMints([mint]);
  await poller.pollNow();
  expect(received).toEqual([]);

  payloads.set("pair-a", {
    data: [{ attributes: { ...geckoBuy.attributes, tx_hash: "new-a" } }],
  });
  payloads.set("pair-b", {
    data: [{ attributes: { ...geckoBuy.attributes, tx_hash: "new-b" } }],
  });
  await poller.pollNow();
  expect(received.sort()).toEqual(["new-a", "new-b"]);
  poller.stop();
});

test("pool trade poller retains newest signatures when snapshots arrive newest-first", async () => {
  const received: string[] = [];
  const trade = (signature: string) => ({
    attributes: { ...geckoBuy.attributes, tx_hash: signature },
  });
  let payload = {
    data: Array.from({ length: 300 }, (_, index) => trade(`a${index + 1}`)),
  };
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    fetchPairStats: async () => ({
      priceUsd: 1,
      marketCapUsd: 1,
      priceChangeH24: 1,
      url: null,
      dexId: "raydium",
      quoteSymbol: "SOL",
      pairAddress: "pair-bounded",
      tokenName: "TOKEN",
    }),
    fetchTrades: async () => payload,
  });

  poller.onTrade((buy) => received.push(buy.signature));
  poller.setMints([mint]);
  await poller.pollNow();

  payload = {
    data: [
      ...Array.from({ length: 100 }, (_, index) => trade(`b${index + 1}`)),
      ...Array.from({ length: 200 }, (_, index) => trade(`a${index + 1}`)),
    ],
  };
  await poller.pollNow();
  expect(received).toHaveLength(100);
  received.length = 0;

  payload = {
    data: [
      trade("c1"),
      ...Array.from({ length: 100 }, (_, index) => trade(`b${index + 1}`)),
      ...Array.from({ length: 199 }, (_, index) => trade(`a${index + 1}`)),
    ],
  };
  await poller.pollNow();
  expect(received).toEqual(["c1"]);
  poller.stop();
});

test("pool trade poller rotates fairly across Pump and non-Pump pools", async () => {
  const requestedPools: string[] = [];
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    poolsPerCycle: 1,
    fetchPoolStats: async () => [
      {
        priceUsd: 1,
        marketCapUsd: 1,
        priceChangeH24: 1,
        url: null,
        dexId: "raydium",
        quoteSymbol: "SOL",
        pairAddress: "pair-a",
        tokenName: "TOKEN",
      },
      {
        priceUsd: 1,
        marketCapUsd: 1,
        priceChangeH24: 1,
        url: null,
        dexId: "meteora",
        quoteSymbol: "SOL",
        pairAddress: "pair-b",
        tokenName: "TOKEN",
      },
      {
        priceUsd: 1,
        marketCapUsd: 1,
        priceChangeH24: 1,
        url: null,
        dexId: "pump-fun",
        quoteSymbol: "SOL",
        pairAddress: "pair-pump",
        tokenName: "TOKEN",
      },
    ],
    fetchTrades: async (pairAddress) => {
      requestedPools.push(pairAddress);
      return { data: [] };
    },
  });

  poller.setMints([mint]);
  await poller.pollNow();
  await poller.pollNow();
  expect(requestedPools).toEqual(["pair-a", "pair-b", "pair-pump"]);

  await poller.pollNow();
  expect(requestedPools.at(-1)).toBe("pair-a");
  poller.stop();
});

test("pool trade poller does not prime a pool after failed or malformed responses", async () => {
  const received: string[] = [];
  const errors: unknown[] = [];
  let calls = 0;
  let payload = { data: [geckoBuy] };
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    fetchPairStats: async () => ({
      priceUsd: 1,
      marketCapUsd: 1,
      priceChangeH24: 1,
      url: null,
      dexId: "raydium",
      quoteSymbol: "SOL",
      pairAddress: "pair-failure",
      tokenName: "TOKEN",
    }),
    fetchTrades: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("429");
      }
      if (calls === 2) {
        return { malformed: true };
      }
      return payload;
    },
    onError: (error) => errors.push(error),
  });

  poller.onTrade((buy) => received.push(buy.signature));
  poller.setMints([mint]);
  await poller.pollNow();
  await poller.pollNow();
  expect(received).toEqual([]);
  expect(errors).toHaveLength(2);

  payload = {
    data: [{ attributes: { ...geckoBuy.attributes, tx_hash: "after-recovery" } }],
  };
  await poller.pollNow();
  expect(received).toEqual(["after-recovery"]);
  poller.stop();
});

test("pool trade poller reports pool discovery failures", async () => {
  const errors: unknown[] = [];
  const discoveryError = new Error("discovery unavailable");
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    fetchPoolStats: async () => {
      throw discoveryError;
    },
    fetchTrades: async () => ({ data: [] }),
    onError: (error) => errors.push(error),
  });

  poller.setMints([mint]);
  await poller.pollNow();

  expect(errors).toContain(discoveryError);
  poller.stop();
});

test("pool trade poller emits the first snapshot from a newly discovered pool", async () => {
  const received: string[] = [];
  let includeNewPool = false;
  const watchedAt = Date.parse("2026-08-31T20:00:00.000Z");
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    fetchPoolStats: async () => [
      {
        priceUsd: 1,
        marketCapUsd: 1,
        priceChangeH24: 1,
        url: null,
        dexId: "raydium",
        quoteSymbol: "SOL",
        pairAddress: "pair-initial",
        tokenName: "TOKEN",
      },
      ...(includeNewPool
        ? [
            {
              priceUsd: 1,
              marketCapUsd: 1,
              priceChangeH24: 1,
              url: null,
              dexId: "meteora",
              quoteSymbol: "SOL",
              pairAddress: "pair-new",
              tokenName: "TOKEN",
            },
          ]
        : []),
    ],
    fetchTrades: async (pairAddress) => ({
      data: [
        {
          attributes: {
            ...geckoBuy.attributes,
            tx_hash: pairAddress === "pair-new" ? "new-pool-buy" : "initial-buy",
            block_timestamp:
              pairAddress === "pair-new" ? "2026-08-31T20:00:01.000Z" : "2026-08-31T19:59:59.000Z",
          },
        },
      ],
    }),
    now: () => watchedAt,
  });

  poller.onTrade((buy) => received.push(buy.signature));
  poller.setMints([mint]);
  await poller.pollNow();
  expect(received).toEqual([]);

  includeNewPool = true;
  await poller.pollNow();
  expect(received).toEqual(["new-pool-buy"]);
  poller.stop();
});

test("pool trade poller preserves buys after enabling while baseline pools wait", async () => {
  const received: string[] = [];
  const watchedAt = Date.parse("2026-08-31T20:00:00.000Z");
  const trade = (signature: string, blockTimestamp: string) => ({
    attributes: {
      ...geckoBuy.attributes,
      tx_hash: signature,
      block_timestamp: blockTimestamp,
    },
  });
  const poller = createPoolTradePoller({
    intervalMs: 60_000,
    minRequestIntervalMs: 0,
    poolsPerCycle: 1,
    fetchPoolStats: async () => [
      {
        priceUsd: 1,
        marketCapUsd: 1,
        priceChangeH24: 1,
        url: null,
        dexId: "raydium",
        quoteSymbol: "SOL",
        pairAddress: "pair-a",
        tokenName: "TOKEN",
      },
      {
        priceUsd: 1,
        marketCapUsd: 1,
        priceChangeH24: 1,
        url: null,
        dexId: "pump-fun",
        quoteSymbol: "SOL",
        pairAddress: "pair-b",
        tokenName: "TOKEN",
      },
    ],
    fetchTrades: async (pairAddress) => ({
      data:
        pairAddress === "pair-a"
          ? [trade("old-a", "2026-08-31T19:59:59.000Z")]
          : [
              trade("after-enable", "2026-08-31T20:00:01.000Z"),
              trade("old-b", "2026-08-31T19:59:59.000Z"),
            ],
    }),
    now: () => watchedAt,
  });

  poller.onTrade((buy) => received.push(buy.signature));
  poller.setMints([mint]);
  await poller.pollNow();

  expect(received).toEqual(["after-enable"]);
  poller.stop();
});
