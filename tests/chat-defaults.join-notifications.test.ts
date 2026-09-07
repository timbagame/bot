import { describe, test, expect, beforeEach } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import {
  DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL,
  DEFAULT_JOIN_NOTIFICATIONS_PER_MINUTE,
  MAX_JOIN_NOTIFICATIONS_PER_MINUTE,
} from "../src/utils/constants";

describe("Join notification settings", () => {
  beforeEach(() => {
    ChatDatabase.resetForTesting();
  });

  describe("ChatDatabase join notification settings", () => {
    test("upsertChatGameSettings stores join_notifications_external true", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12345;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      // SQLite stores booleans as INTEGER 0/1
      expect(settings?.join_notifications_external).toBeTruthy();
    });

    test("upsertChatGameSettings stores join_notifications_external false", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12346;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: false,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      // SQLite stores false as 0, which is falsy
      expect(settings?.join_notifications_external).toBeFalsy();
    });

    test("upsertChatGameSettings stores join_notifications_per_minute", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12347;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_per_minute: 15,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_per_minute).toBe(15);
    });

    test("upsertChatGameSettings stores both settings together", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12348;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
        join_notifications_per_minute: 20,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_external).toBeTruthy();
      expect(settings?.join_notifications_per_minute).toBe(20);
    });

    test("upsertChatGameSettings preserves other settings when updating join notifications", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12349;

      // Set initial settings
      chatDb.upsertChatGameSettings(chatId, {
        coinflip_max_players: 8,
        timeout_seconds: 300,
      });

      // Update only join notification settings
      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
        join_notifications_per_minute: 10,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.coinflip_max_players).toBe(8);
      expect(settings?.timeout_seconds).toBe(300);
      expect(settings?.join_notifications_external).toBeTruthy();
      expect(settings?.join_notifications_per_minute).toBe(10);
    });

    test("getChatGameSettings returns null for join_notifications when not set", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12350;

      chatDb.upsertChatGameSettings(chatId, {
        coinflip_max_players: 5,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_external).toBeNull();
      expect(settings?.join_notifications_per_minute).toBeNull();
    });

    test("upsertChatGameSettings allows clearing settings to null", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12351;

      // Set initial values
      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: true,
        join_notifications_per_minute: 15,
      });

      // Clear to null (reset to defaults)
      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_external: null,
        join_notifications_per_minute: null,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_external).toBeNull();
      expect(settings?.join_notifications_per_minute).toBeNull();
    });

    test("upsertChatGameSettings stores 0 rate limit (disabled)", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12352;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_per_minute: 0,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_per_minute).toBe(0);
    });

    test("upsertChatGameSettings stores max rate limit", () => {
      const chatDb = ChatDatabase.getInstance();
      const chatId = 12353;

      chatDb.upsertChatGameSettings(chatId, {
        join_notifications_per_minute: MAX_JOIN_NOTIFICATIONS_PER_MINUTE,
      });

      const settings = chatDb.getChatGameSettings(chatId);
      expect(settings?.join_notifications_per_minute).toBe(MAX_JOIN_NOTIFICATIONS_PER_MINUTE);
    });
  });

  describe("Constants defaults", () => {
    test("DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL is false", () => {
      expect(DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL).toBe(false);
    });

    test("DEFAULT_JOIN_NOTIFICATIONS_PER_MINUTE is disabled", () => {
      expect(DEFAULT_JOIN_NOTIFICATIONS_PER_MINUTE).toBe(0);
    });

    test("MAX_JOIN_NOTIFICATIONS_PER_MINUTE is 30", () => {
      expect(MAX_JOIN_NOTIFICATIONS_PER_MINUTE).toBe(30);
    });
  });
});
