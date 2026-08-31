import { expect, test } from "bun:test";
import {
  createPoolTradePoller,
  parseGeckoPoolTrade,
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
  });
});

test("parseGeckoPoolTrade skips trades whose output is another mint", () => {
  expect(
    parseGeckoPoolTrade(mint, {
      attributes: { ...geckoBuy.attributes, kind: "sell", to_token_address: WSOL_MINT },
    }),
  ).toBeNull();
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
