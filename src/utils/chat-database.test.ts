import { expect, test, beforeEach, afterEach } from "bun:test";
import { ChatDatabase } from "./chat-database";
import { rmSync } from "fs";

let testDbName: string;
let db: ChatDatabase;

beforeEach(() => {
  testDbName = `chat-settings-test-${Date.now()}-${Math.random()}.sqlite`;
  // @ts-ignore - reset singleton for clean test
  ChatDatabase["instance"] = undefined;
});

afterEach(() => {
  if (db && (db as any).db) {
    try {
      (db as any).db.close();
    } catch {}
  }
  try {
    rmSync(testDbName, { force: true });
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
