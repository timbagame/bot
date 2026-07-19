import { expect, test, beforeEach, afterEach } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { resetTestDatabase } from "./helpers/database";

let db: ChatDatabase;

beforeEach(() => {
  resetTestDatabase("chat-settings.sqlite");
  ChatDatabase.resetForTesting();
});

afterEach(() => {
  if (db && (db as any).db) {
    try {
      (db as any).db.close();
    } catch {}
  }
  // Reset singleton so other tests get a fresh connection
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
