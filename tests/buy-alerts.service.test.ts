import { expect, test } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { resetTestDatabase } from "./helpers/database";
import { createBuyAlertService } from "../src/services/buy-alerts/service";
import type { BuyEvent, BuyFeed } from "../src/services/buy-alerts/types";

const TIMBA_MINT = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

test("buy alert service subscribes to enabled mints and publishes buys", async () => {
  resetTestDatabase("chat-settings.sqlite");
  ChatDatabase.resetForTesting();
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-11, { enabled: true });

  const sent: Array<{ chatId: number; text: string }> = [];
  let watched: readonly string[] = [];
  const handlers = new Set<(event: BuyEvent) => void>();
  const feed: BuyFeed = {
    setMints: (mints) => {
      watched = mints;
    },
    onTrade: (handler) => {
      handlers.add(handler);
    },
    stop: () => {
      watched = [];
    },
  };

  const service = createBuyAlertService({
    chatDb,
    getTokenManager: () => ({
      getChatDefaultToken: () => null,
      getDefaultToken: () => ({ tokenMint: TIMBA_MINT, tokenTicker: "TIMBA" }),
    }),
    sendHtml: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    fetchSolPriceUsd: async () => 100,
    feed,
  });

  service.start();
  expect(watched).toEqual([TIMBA_MINT]);

  const event: BuyEvent = {
    signature: "live-sig",
    mint: TIMBA_MINT,
    trader: "Trader11111111111111111111111111111111111",
    solAmount: 0.5,
    tokenAmount: 1000,
    dex: "pump",
  };
  for (const handler of handlers) {
    handler(event);
  }

  await Bun.sleep(10);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.chatId).toBe(-11);
  expect(sent[0]?.text).toContain("BUY - TIMBA");

  service.stop();
  expect(watched).toEqual([]);
});

test("buy alert service stays idle when no chat has alerts enabled", () => {
  resetTestDatabase("chat-settings.sqlite");
  ChatDatabase.resetForTesting();
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-11, { enabled: false });

  let watched: readonly string[] = ["unset"];
  const feed: BuyFeed = {
    setMints: (mints) => {
      watched = mints;
    },
    onTrade: () => {},
    stop: () => {
      watched = [];
    },
  };

  const service = createBuyAlertService({
    chatDb,
    getTokenManager: () => ({
      getChatDefaultToken: () => ({ token_mint: "chat-mint", token_ticker: "CHAT" }),
      getDefaultToken: () => ({ tokenMint: TIMBA_MINT, tokenTicker: "TIMBA" }),
    }),
    sendHtml: async () => {},
    feed,
  });

  service.start();
  expect(watched).toEqual([]);
});

test("buy alert service ingests externally observed buys through the publisher", async () => {
  resetTestDatabase("chat-settings.sqlite");
  ChatDatabase.resetForTesting();
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-21, { enabled: true });

  const sent: Array<{ chatId: number; text: string }> = [];
  const service = createBuyAlertService({
    chatDb,
    getTokenManager: () => ({
      getChatDefaultToken: () => null,
      getDefaultToken: () => ({ tokenMint: TIMBA_MINT, tokenTicker: "TIMBA" }),
    }),
    sendHtml: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    feed: { setMints: () => {}, onTrade: () => {}, stop: () => {} },
  });

  const event: BuyEvent = {
    signature: "ingested-sig",
    mint: TIMBA_MINT,
    trader: "Trader11111111111111111111111111111111111",
    solAmount: 0.25,
    tokenAmount: 500,
    dex: "raydium",
  };
  await service.ingest(event);
  await service.ingest(event);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.chatId).toBe(-21);
  expect(sent[0]?.text).toContain("BUY - TIMBA");
});
