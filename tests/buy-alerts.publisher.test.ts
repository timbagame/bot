import { beforeEach, expect, spyOn, test } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { resetTestDatabase } from "./helpers/database";
import { attachBuyAlertFeed, createBuyAlertPublisher } from "../src/services/buy-alerts/publisher";
import type { BuyEvent } from "../src/services/buy-alerts/types";

const TIMBA_MINT = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

const event = (overrides: Partial<BuyEvent> = {}): BuyEvent => ({
  signature: "sig-1",
  mint: TIMBA_MINT,
  trader: "Trader11111111111111111111111111111111111",
  solAmount: 0.5,
  tokenAmount: 1000,
  dex: "pump",
  ...overrides,
});

const tokenManager = {
  getChatDefaultToken: () => null,
  getDefaultToken: () => ({ tokenMint: TIMBA_MINT, tokenTicker: "TIMBA" }),
};

beforeEach(() => {
  resetTestDatabase("chat-settings.sqlite");
  ChatDatabase.resetForTesting();
});

test("publisher posts to enabled chats watching the mint and skips dust", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-1, { enabled: true, min_sol_lamports: null });
  chatDb.upsertChatBuyAlerts(-2, { enabled: true, min_sol_lamports: 1_000_000_000 });
  chatDb.upsertChatBuyAlerts(-3, { enabled: false });

  const sent: Array<{ chatId: number; text: string }> = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    fetchPairStats: async () => null,
    fetchSolPriceUsd: async () => 100,
  });

  const first = await publisher.publish(event({ solAmount: 0.5 }));
  expect(first.posted).toBe(1);
  expect(first.skipped).toContain("dust:-2");
  expect(sent.map((item) => item.chatId)).toEqual([-1]);

  const duplicate = await publisher.publish(event({ solAmount: 0.5 }));
  expect(duplicate.posted).toBe(0);
  expect(duplicate.skipped).toEqual(["duplicate"]);
});

test("publisher rate-limits a noisy chat", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-9, { enabled: true });

  const sent: string[] = [];
  let clock = 1_000;
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (_chatId, text) => {
      sent.push(text);
    },
    fetchPairStats: async () => null,
    now: () => clock,
    maxAlertsPerMinute: 2,
  });

  expect((await publisher.publish(event({ signature: "a" }))).posted).toBe(1);
  clock += 10;
  expect((await publisher.publish(event({ signature: "b" }))).posted).toBe(1);
  clock += 10;
  const third = await publisher.publish(event({ signature: "c" }));
  expect(third.posted).toBe(0);
  expect(third.skipped).toContain("rate:-9");
});

test("publisher watches only enabled-chat mints and can send a test", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-1, { enabled: true });
  chatDb.upsertChatBuyAlerts(-2, {
    enabled: true,
    token_mint: "other-mint",
    token_ticker: "OTHER",
  });
  chatDb.upsertChatBuyAlerts(-3, { enabled: false });

  const sent: Array<{ chatId: number; text: string }> = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    fetchPairStats: async () => null,
  });

  expect(publisher.watchedMints().sort()).toEqual(["other-mint", TIMBA_MINT].sort());

  await publisher.sendTest(-4);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.chatId).toBe(-4);
  expect(sent[0]?.text).toContain("<b>💰 BUY - TIMBA</b>");
  expect(sent[0]?.text).toContain("New Holder!");
});

test("publisher attaches a Buy deep link for the mint", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-1, { enabled: true });

  const sent: Array<{ url?: string; button?: string }> = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (_chatId, _text, _media, keyboard) => {
      const button = keyboard?.inline_keyboard?.[0]?.[0];
      sent.push({
        url: button && "url" in button ? button.url : undefined,
        button: button?.text,
      });
    },
    fetchPairStats: async () => null,
    getBotUsername: () => "playtimbabot",
  });

  await publisher.publish(event({ signature: "buy-button" }));
  expect(sent).toEqual([
    {
      url: `https://t.me/playtimbabot?start=ba_${TIMBA_MINT}`,
      button: "BUY TIMBA",
    },
  ]);
});

test("publisher falls back to a callback Buy button without a bot username", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-1, { enabled: true });

  const sent: Array<{ data?: string; url?: string; button?: string }> = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (_chatId, _text, _media, keyboard) => {
      const button = keyboard?.inline_keyboard?.[0]?.[0];
      sent.push({
        data: button && "callback_data" in button ? button.callback_data : undefined,
        url: button && "url" in button ? button.url : undefined,
        button: button?.text,
      });
    },
    fetchPairStats: async () => null,
  });

  await publisher.publish(event({ signature: "buy-callback-fallback" }));
  expect(sent).toEqual([{ data: `buy_alert_${TIMBA_MINT}`, url: undefined, button: "BUY TIMBA" }]);
});

test("publisher attaches configured chat media", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-5, {
    enabled: true,
    media_file_id: "AgAD-buy",
    media_type: "photo",
  });

  const sent: Array<{ chatId: number; media?: { fileId: string; mediaType: string } | null }> = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (chatId, _text, media) => {
      sent.push({ chatId, media });
    },
    fetchPairStats: async () => null,
  });

  await publisher.publish({
    signature: "media-sig",
    mint: TIMBA_MINT,
    trader: "Trader11111111111111111111111111111111111",
    solAmount: 1,
    tokenAmount: 10,
    dex: "pump",
  });

  expect(sent).toEqual([{ chatId: -5, media: { fileId: "AgAD-buy", mediaType: "photo" } }]);
});

test("publisher routes buys to chats by their default token", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-10, { enabled: true });
  chatDb.upsertChatBuyAlerts(-11, { enabled: true });
  chatDb.upsertChatBuyAlerts(-12, { enabled: false });

  const otherMint = "other-mint";
  const sent: number[] = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager: {
      getChatDefaultToken: (chatId) =>
        chatId === -11 ? { token_mint: otherMint, token_ticker: "OTHER" } : null,
      getDefaultToken: () => ({ tokenMint: TIMBA_MINT, tokenTicker: "TIMBA" }),
    },
    sendHtml: async (chatId) => {
      sent.push(chatId);
    },
    fetchPairStats: async () => null,
  });

  expect(publisher.watchedMints().sort()).toEqual([otherMint, TIMBA_MINT].sort());

  expect((await publisher.publish(event({ signature: "timba-buy" }))).posted).toBe(1);
  expect(sent).toEqual([-10]);

  expect((await publisher.publish(event({ signature: "other-buy", mint: otherMint }))).posted).toBe(
    1,
  );
  expect(sent).toEqual([-10, -11]);
});

test("publisher skips unknown-size buys when a minimum is configured", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-1, { enabled: true, min_sol_lamports: null });
  chatDb.upsertChatBuyAlerts(-2, { enabled: true, min_sol_lamports: 100_000_000 });

  const sent: number[] = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (chatId) => {
      sent.push(chatId);
    },
    fetchPairStats: async () => null,
  });

  const unknown = await publisher.publish(event({ signature: "unknown-size", solAmount: null }));
  expect(unknown.posted).toBe(1);
  expect(unknown.skipped).toContain("dust:-2");
  expect(sent).toEqual([-1]);
});

test("publisher includes new-holder when the resolver reports it", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-7, { enabled: true });

  const sent: string[] = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (_chatId, text) => {
      sent.push(text);
    },
    fetchPairStats: async () => null,
    resolveNewHolder: async () => true,
  });

  await publisher.publish(event({ signature: "holder-sig" }));
  expect(sent[0]).toContain("New Holder!");
});

test("publisher retries a signature when every delivery fails", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-20, { enabled: true });

  let attempts = 0;
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary Telegram failure");
      }
    },
    fetchPairStats: async () => null,
  });

  expect((await publisher.publish(event({ signature: "retry-all" }))).posted).toBe(0);
  expect((await publisher.publish(event({ signature: "retry-all" }))).posted).toBe(1);
  expect((await publisher.publish(event({ signature: "retry-all" }))).skipped).toEqual([
    "duplicate",
  ]);
  expect(attempts).toBe(2);
});

test("publisher retries only chats whose delivery failed", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-21, { enabled: true });
  chatDb.upsertChatBuyAlerts(-22, { enabled: true });

  const attempts: number[] = [];
  let failedOnce = false;
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (chatId) => {
      attempts.push(chatId);
      if (chatId === -22 && !failedOnce) {
        failedOnce = true;
        throw new Error("temporary Telegram failure");
      }
    },
    fetchPairStats: async () => null,
  });

  expect((await publisher.publish(event({ signature: "retry-partial" }))).posted).toBe(1);
  expect((await publisher.publish(event({ signature: "retry-partial" }))).posted).toBe(1);
  expect(attempts).toEqual([-22, -21, -22]);
});

test("publisher forgets delivered signatures after the deduplication TTL", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-30, { enabled: true });

  let clock = 1_000;
  let sent = 0;
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    now: () => clock,
    sendHtml: async () => {
      sent += 1;
    },
    fetchPairStats: async () => null,
  });

  expect((await publisher.publish(event({ signature: "ttl-signature" }))).posted).toBe(1);
  expect((await publisher.publish(event({ signature: "ttl-signature" }))).posted).toBe(0);

  clock += 60 * 60 * 1000 + 1;
  expect((await publisher.publish(event({ signature: "ttl-signature" }))).posted).toBe(1);
  expect(sent).toBe(2);
});

test("publisher keeps a known new-holder flag without asking the resolver", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-8, { enabled: true });

  const sent: string[] = [];
  let resolverCalls = 0;
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (_chatId, text) => {
      sent.push(text);
    },
    fetchPairStats: async () => null,
    resolveNewHolder: async () => {
      resolverCalls += 1;
      return true;
    },
  });

  await publisher.publish(event({ signature: "known-holder", newHolder: false }));
  expect(resolverCalls).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain("New Holder!");
});

test("publisher treats a signature still being delivered as a duplicate", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-11, { enabled: true });

  let releasePair!: () => void;
  const pairGate = new Promise<null>((resolve) => {
    releasePair = () => resolve(null);
  });
  const sent: number[] = [];
  const publisher = createBuyAlertPublisher({
    chatDb,
    tokenManager,
    sendHtml: async (chatId) => {
      sent.push(chatId);
    },
    fetchPairStats: () => pairGate,
  });

  const first = publisher.publish(event({ signature: "in-flight" }));
  const concurrent = await publisher.publish(event({ signature: "in-flight" }));
  expect(concurrent).toEqual({ posted: 0, skipped: ["duplicate"] });

  releasePair();
  expect(await first).toEqual({ posted: 1, skipped: [] });
  expect(sent).toEqual([-11]);
});

test("publisher skips chats whose alerts were disabled after being listed", async () => {
  const chatDb = ChatDatabase.getInstance();
  chatDb.upsertChatBuyAlerts(-12, { enabled: true });
  const enabledSnapshot = chatDb.getEnabledChatBuyAlerts();
  chatDb.upsertChatBuyAlerts(-12, { enabled: false });

  const sent: number[] = [];
  const publisher = createBuyAlertPublisher({
    chatDb: {
      getEnabledChatBuyAlerts: () => enabledSnapshot,
      getChatBuyAlerts: (chatId: number) => chatDb.getChatBuyAlerts(chatId),
    } as unknown as ChatDatabase,
    tokenManager,
    sendHtml: async (chatId) => {
      sent.push(chatId);
    },
    fetchPairStats: async () => null,
  });

  expect(await publisher.publish(event({ signature: "disabled-race" }))).toEqual({
    posted: 0,
    skipped: [],
  });
  expect(sent).toEqual([]);
});

test("attachBuyAlertFeed forwards trades and logs publish failures", async () => {
  let handler: ((event: BuyEvent) => void) | undefined;
  const feed = {
    setMints: () => {},
    onTrade: (next: (event: BuyEvent) => void) => {
      handler = next;
    },
    stop: () => {},
  };
  const failure = new Error("telegram down");
  const published: string[] = [];
  const errorSpy = spyOn(console, "error").mockImplementation(() => {});
  try {
    attachBuyAlertFeed(feed, async (trade) => {
      published.push(trade.signature);
      throw failure;
    });
    handler!(event({ signature: "feed-sig" }));
    await Promise.resolve();
    await Promise.resolve();

    expect(published).toEqual(["feed-sig"]);
    expect(errorSpy).toHaveBeenCalledWith("Failed to publish buy alert for feed-sig:", failure);
  } finally {
    errorSpy.mockRestore();
  }
});
