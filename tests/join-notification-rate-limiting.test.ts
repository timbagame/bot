import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import {
  __test_clearJoinNotificationBuckets,
  __test_getJoinNotificationBucket,
  __test_setChatDatabase,
  __test_resetChatDatabase,
} from "../src/bot";
import {
  DEFAULT_JOIN_NOTIFICATIONS_PER_MINUTE,
  DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL,
} from "../src/utils/constants";

describe("Join notification rate limiting", () => {
  beforeEach(() => {
    ChatDatabase.resetForTesting();
    const chatDb = ChatDatabase.getInstance();
    __test_setChatDatabase(chatDb);
    __test_clearJoinNotificationBuckets();
  });

  afterEach(() => {
    __test_resetChatDatabase();
    __test_clearJoinNotificationBuckets();
  });

  describe("Rate limit bucket behavior", () => {
    test("bucket starts undefined for new chat", () => {
      const chatId = 1001;

      // No bucket should exist initially
      expect(__test_getJoinNotificationBucket(chatId)).toBeUndefined();
    });

    test("default rate limit constant is 5", () => {
      expect(DEFAULT_JOIN_NOTIFICATIONS_PER_MINUTE).toBe(5);
    });

    test("default external notifications constant is false", () => {
      expect(DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL).toBe(false);
    });
  });

  describe("Database integration for rate limiting", () => {
    test("chat with rate limit 0 should be saved correctly", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 2001;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_per_minute: 0,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_per_minute).toBe(0);
    });

    test("chat with custom rate limit is persisted", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 2002;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_per_minute: 25,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_per_minute).toBe(25);
    });

    test("chat with external notifications enabled is saved", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 2003;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      // SQLite stores booleans as 0/1, so use truthy check
      expect(settings?.join_notifications_external).toBeTruthy();
    });

    test("chat with no settings returns null (defaults apply)", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 2004;

      // No settings - defaults apply
      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings).toBeNull();
    });

    test("both settings can be set together", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 2005;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
        join_notifications_per_minute: 15,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_external).toBeTruthy();
      expect(settings?.join_notifications_per_minute).toBe(15);
    });

    test("changing rate limit preserves external setting (regression test)", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 2007;

      // Step 1: Enable external notifications
      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
      });

      let settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_external).toBeTruthy();

      // Step 2: Change rate limit (should preserve external setting)
      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_per_minute: 20,
      });

      // Step 3: Verify external setting is still enabled
      settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_per_minute).toBe(20);
      expect(settings?.join_notifications_external).toBeTruthy();
    });

    test("settings can be reset to null", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 2006;

      // Set values
      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
        join_notifications_per_minute: 20,
      });

      // Reset to null
      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: null,
        join_notifications_per_minute: null,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_external).toBeNull();
      expect(settings?.join_notifications_per_minute).toBeNull();
    });
  });

  describe("Origin vs external chat behavior", () => {
    test("default behavior: external notifications are disabled", () => {
      // When no setting is configured, DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL (false) applies
      expect(DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL).toBe(false);
    });

    test("external chat can enable notifications explicitly", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 3003;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_external).toBeTruthy();
    });

    test("external chat can disable notifications explicitly", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 3004;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: false,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      // false is stored as 0 in SQLite
      expect(settings?.join_notifications_external).toBeFalsy();
    });
  });

  describe("Rate limit values", () => {
    test("rate limit 0 means disabled", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 4001;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_per_minute: 0,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_per_minute).toBe(0);
    });

    test("rate limit 1 through 30 are valid", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 4002;

      for (const rate of [1, 5, 10, 20, 30]) {
        chatDb.upsertChatGameSettings(chatId, {
          join_notifications_per_minute: rate,
        });

        const settings = chatDb.getChatGameSettings(chatId);
        expect(settings?.join_notifications_per_minute).toBe(rate);
      }
    });
  });
});
