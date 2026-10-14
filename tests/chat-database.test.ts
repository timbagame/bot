import { expect, test, beforeEach, afterEach } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { resetTestDatabase } from "./helpers/database";

let db: ChatDatabase;

beforeEach(() => {
  resetTestDatabase("chat-settings.sqlite");
  ChatDatabase.resetForTesting();
});

afterEach(() => {
  // The bot may still hold this shared connection.
  ChatDatabase.resetForTesting();
  resetTestDatabase("chat-settings.sqlite");
});

test("ChatDatabase manages chat token configs", () => {
  db = ChatDatabase.getInstance();

  // Clear any existing data first
  const existingChats = (db as any).db.query("SELECT chat_id FROM chat_settings").all();
  for (const chat of existingChats) {
    db.removeChatDefaultToken(chat.chat_id);
  }

  db.setChatDefaultToken(123, "mint", "TOK", "user1");

  const config = db.getChatDefaultToken(123);
  expect(config?.token_mint).toBe("mint");

  expect(db.getChatCount()).toBe(1);

  db.removeChatDefaultToken(123);
  expect(db.getChatDefaultToken(123)).toBeNull();
});

test("ChatDatabase stores chat game settings", () => {
  db = ChatDatabase.getInstance();

  const stored = db.upsertChatGameSettings(42, {
    coinflip_max_players: 5,
    set_by_telegram_id: "admin",
  });

  expect(stored.coinflip_max_players).toBe(5);
  expect(stored.giveaway_max_players).toBeNull();
  expect(stored.timeout_seconds).toBeNull();

  const updated = db.upsertChatGameSettings(42, {
    giveaway_max_players: 10,
    timeout_seconds: 1800,
  });

  expect(updated.coinflip_max_players).toBe(5);
  expect(updated.giveaway_max_players).toBe(10);
  expect(updated.timeout_seconds).toBe(1800);

  db.clearChatGameSettings(42);
  expect(db.getChatGameSettings(42)).toBeNull();
});

test("ChatDatabase returns only chats subscribed to the global public game feed", () => {
  db = ChatDatabase.getInstance();

  db.upsertChatGameSettings(-1001, { global_public_game_feed: true });
  db.upsertChatGameSettings(-1002, { global_public_game_feed: false });
  db.upsertChatGameSettings(-1003, { coinflip_max_players: 4 });

  expect(db.getGlobalPublicGameFeedChatIds()).toEqual([-1001]);
});

test("ChatDatabase stores per-chat buy alert settings off by default", () => {
  db = ChatDatabase.getInstance();

  expect(db.getChatBuyAlerts(55)).toBeNull();
  expect(db.getEnabledChatBuyAlerts()).toEqual([]);

  const stored = db.upsertChatBuyAlerts(55, {
    enabled: true,
    token_mint: "mint-timba",
    token_ticker: "TIMBA",
    min_sol_lamports: 100_000_000,
    set_by_telegram_id: "admin",
  });

  expect(stored.enabled).toBe(true);
  expect(stored.token_mint).toBe("mint-timba");
  expect(stored.min_sol_lamports).toBe(100_000_000);

  db.upsertChatBuyAlerts(55, { enabled: false });
  expect(db.getChatBuyAlerts(55)?.enabled).toBe(false);
  expect(db.getChatBuyAlerts(55)?.token_mint).toBe("mint-timba");
  expect(db.getEnabledChatBuyAlerts()).toEqual([]);

  db.upsertChatBuyAlerts(56, { enabled: true });
  expect(db.getEnabledChatBuyAlerts().map((row) => row.chat_id)).toEqual([56]);

  db.upsertChatBuyAlerts(56, {
    media_file_id: "AgAD-gif",
    media_type: "animation",
  });
  expect(db.getChatBuyAlerts(56)?.media_file_id).toBe("AgAD-gif");
  expect(db.getChatBuyAlerts(56)?.media_type).toBe("animation");
});

test("ChatDatabase: chat info save/get and counts", () => {
  const db = ChatDatabase.getInstance();

  // Token configs ordering and count
  db.setChatDefaultToken(1, "mint1", "AAA", "user1");
  db.setChatDefaultToken(2, "mint2", "BBB", "user2");
  const all = db.getAllChatTokenConfigs();
  expect(all.length).toBe(2);
  expect(db.getChatCount()).toBe(2);

  // Chat info roundtrip
  db.saveChatInfo(10, "Cool Chat", "supergroup");
  const info = db.getChatInfo(10)!;
  expect(info.chat_id).toBe(10);
  expect(info.chat_title).toBe("Cool Chat");
  expect(info.chat_type).toBe("supergroup");
});

test("ChatDatabase migrates every chat-scoped table to the supergroup id", () => {
  db = ChatDatabase.getInstance();
  const oldId = -500;
  const newId = -1_000_000_500;
  db.setChatDefaultToken(oldId, "mint", "TOK", "admin");
  db.upsertChatGameSettings(oldId, { coinflip_max_players: 4 });
  db.upsertChatBuyAlerts(oldId, { enabled: true, token_mint: "mint" });

  db.migrateChatId(oldId, newId);

  expect(db.getChatDefaultToken(oldId)).toBeNull();
  expect(db.getChatGameSettings(oldId)).toBeNull();
  expect(db.getChatBuyAlerts(oldId)).toBeNull();
  expect(db.getChatDefaultToken(newId)?.token_mint).toBe("mint");
  expect(db.getChatGameSettings(newId)?.coinflip_max_players).toBe(4);
  expect(db.getChatBuyAlerts(newId)).toMatchObject({ enabled: true, token_mint: "mint" });
});

test("ChatDatabase migration replaces stale settings already stored under the new id", () => {
  db = ChatDatabase.getInstance();
  db.upsertChatGameSettings(-2, { coinflip_max_players: 9 });
  db.upsertChatGameSettings(-1, { coinflip_max_players: 3 });

  db.migrateChatId(-1, -2);

  expect(db.getChatGameSettings(-2)?.coinflip_max_players).toBe(3);
  expect(db.getChatGameSettings(-1)).toBeNull();
});

test("ChatDatabase migration to the same id changes nothing", () => {
  db = ChatDatabase.getInstance();
  db.upsertChatGameSettings(-7, { coinflip_max_players: 2 });

  db.migrateChatId(-7, -7);

  expect(db.getChatGameSettings(-7)?.coinflip_max_players).toBe(2);
});
