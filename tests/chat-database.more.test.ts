import { expect, test, beforeEach } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { resetTestDatabase } from "./helpers/database";

beforeEach(() => {
  resetTestDatabase("chat-settings.sqlite");
  // @ts-ignore reset singleton
  ChatDatabase["instance"] = undefined;
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
