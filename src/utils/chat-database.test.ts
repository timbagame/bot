import { ChatDatabase } from "./chat-database";
import { rmSync } from "fs";

test("ChatDatabase manages chat token configs", () => {
  rmSync("chat-settings.sqlite", { force: true });
  // @ts-ignore - reset singleton for clean test
  ChatDatabase["instance"] = undefined;

  const db = ChatDatabase.getInstance();
  db.setChatDefaultToken(123, "mint", "TOK", "user1");

  const config = db.getChatDefaultToken(123);
  expect(config?.token_mint).toBe("mint");

  expect(db.getChatCount()).toBe(1);

  db.removeChatDefaultToken(123);
  expect(db.getChatDefaultToken(123)).toBeNull();
});
