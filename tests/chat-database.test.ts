import { expect, test, beforeEach, afterEach } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { rmSync } from "fs";

let db: ChatDatabase;

beforeEach(() => {
  try {
    rmSync("chat-settings.sqlite", { force: true });
  } catch {}
  // @ts-ignore - reset singleton for clean test
  ChatDatabase["instance"] = undefined;
});

afterEach(() => {
  if (db && (db as any).db) {
    try {
      (db as any).db.close();
    } catch {}
  }
  // Reset singleton so other tests get a fresh connection
  // @ts-ignore
  ChatDatabase["instance"] = undefined;
  try {
    rmSync("chat-settings.sqlite", { force: true });
  } catch {}
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
