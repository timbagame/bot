import { expect, test } from "bun:test";
import { createPoolTradePoller, parseGeckoPoolTrade } from "../src/services/buy-alerts/pool-trades";
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
    tokenAmount: 1_270_000,
    dex: "raydium",
  });
});

test("parseGeckoPoolTrade skips sells and other mints", () => {
  expect(
    parseGeckoPoolTrade(mint, {
      attributes: { ...geckoBuy.attributes, kind: "sell", to_token_address: WSOL_MINT },
    }),
  ).toBeNull();
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
