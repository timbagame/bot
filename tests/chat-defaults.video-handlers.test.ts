import { beforeEach, describe, expect, test } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { CHAT_MEDIA_DISABLED_SENTINEL } from "../src/utils/constants";
import { resetTestDatabase } from "./helpers/database";
import { __test_buildSettingsSummary as buildSettingsSummary } from "../src/handlers/chat-defaults";
import { GameDatabase } from "../src/utils/game-database";
import { TokenManager } from "../src/utils/token-manager";

describe("Chat defaults video settings handlers", () => {
  let chatDb: ChatDatabase;
  let gameDb: GameDatabase;

  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    resetTestDatabase("games.sqlite");
    ChatDatabase.resetForTesting();
    GameDatabase.resetForTesting();
    chatDb = ChatDatabase.getInstance();
    gameDb = GameDatabase.getInstance();
  });

  describe("upsertChatGameSettings for video settings", () => {
    test("setting coinflip video preserves other settings", () => {
      // First set some other settings
      chatDb.upsertChatGameSettings(123, {
        timeout_seconds: 600,
        coinflip_max_players: 5,
        set_by_telegram_id: "admin1",
      });

      // Now set coinflip video
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_video_id",
        coinflip_media_type: "video",
        set_by_telegram_id: "admin2",
      });

      const settings = chatDb.getChatGameSettings(123);
      expect(settings?.timeout_seconds).toBe(600);
      expect(settings?.coinflip_max_players).toBe(5);
      expect(settings?.coinflip_video_id).toBe("custom_video_id");
      expect(settings?.coinflip_media_type).toBe("video");
    });

    test("setting giveaway video preserves coinflip video", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "coinflip_custom",
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      chatDb.upsertChatGameSettings(123, {
        giveaway_video_id: "giveaway_custom",
        giveaway_media_type: "animation",
        set_by_telegram_id: "admin",
      });

      const settings = chatDb.getChatGameSettings(123);
      expect(settings?.coinflip_video_id).toBe("coinflip_custom");
      expect(settings?.coinflip_media_type).toBe("photo");
      expect(settings?.giveaway_video_id).toBe("giveaway_custom");
      expect(settings?.giveaway_media_type).toBe("animation");
    });

    test("disabling coinflip video uses sentinel value", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });

      const settings = chatDb.getChatGameSettings(123);
      expect(settings?.coinflip_video_id).toBe(CHAT_MEDIA_DISABLED_SENTINEL);
      expect(settings?.coinflip_media_type).toBeNull();
    });

    test("clearing coinflip video uses empty string", () => {
      // First set a custom video
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_id",
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      // Clear it
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "",
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });

      const settings = chatDb.getChatGameSettings(123);
      expect(settings?.coinflip_video_id).toBe("");
      expect(settings?.coinflip_media_type).toBeNull();
    });
  });

  describe("buildSettingsSummary video display", () => {
    const createMockDeps = () => ({
      bot: {} as any,
      chatDb,
      gameDb,
      getTokenManager: () =>
        ({
          getChatDefaultToken: () => null,
          getDefaultToken: () => ({ tokenTicker: "TIMBA", tokenMint: "mock_mint" }),
          getSupportedGameTokens: () => [],
        }) as unknown as TokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: ((fn: any) => fn) as any,
      getOracleMaxPlayers: () => 20,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
    });

    test("displays bot default when no video settings", async () => {
      const deps = createMockDeps();
      const summary = await buildSettingsSummary(123, deps);

      expect(summary).toContain("Coinflip: 2 players · Public 🌍 · Default media");
      expect(summary).toContain("Giveaway: 10 players · Private 🔒 · Default media");
    });

    test("displays a compact custom media state", async () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "AgACAgIAAxkBAAIBZ2dZNpCv", // 26 chars
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      const deps = createMockDeps();
      const summary = await buildSettingsSummary(123, deps);

      expect(summary).toContain("Coinflip: 2 players · Public 🌍 · Custom media");
    });

    test("displays disabled state", async () => {
      chatDb.upsertChatGameSettings(123, {
        giveaway_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
        giveaway_media_type: null,
        set_by_telegram_id: "admin",
      });

      const deps = createMockDeps();
      const summary = await buildSettingsSummary(123, deps);

      expect(summary).toContain("Giveaway: 10 players · Private 🔒 · Text only");
    });

    test("displays cleared state as bot default", async () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "",
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });

      const deps = createMockDeps();
      const summary = await buildSettingsSummary(123, deps);

      expect(summary).toContain("Coinflip: 2 players · Public 🌍 · Default media");
    });

    test("does not expose custom media IDs in the compact summary", async () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "<script>alert(1)</script>",
        coinflip_media_type: "video",
        set_by_telegram_id: "admin",
      });

      const deps = createMockDeps();
      const summary = await buildSettingsSummary(123, deps);

      // Should escape < and >
      expect(summary).not.toContain("<script>");
      expect(summary).not.toContain("&lt;script&gt;");
      expect(summary).toContain("Custom media");
    });
  });

  describe("media type persistence", () => {
    test("persists photo media type correctly", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "photo_id",
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      const settings = chatDb.getChatGameSettings(123);
      expect(settings?.coinflip_media_type).toBe("photo");
    });

    test("persists video media type correctly", () => {
      chatDb.upsertChatGameSettings(123, {
        giveaway_video_id: "video_id",
        giveaway_media_type: "video",
        set_by_telegram_id: "admin",
      });

      const settings = chatDb.getChatGameSettings(123);
      expect(settings?.giveaway_media_type).toBe("video");
    });

    test("persists animation media type correctly", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "animation_id",
        coinflip_media_type: "animation",
        set_by_telegram_id: "admin",
      });

      const settings = chatDb.getChatGameSettings(123);
      expect(settings?.coinflip_media_type).toBe("animation");
    });

    test("allows null media type", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "some_id",
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });

      const settings = chatDb.getChatGameSettings(123);
      expect(settings?.coinflip_video_id).toBe("some_id");
      expect(settings?.coinflip_media_type).toBeNull();
    });
  });

  describe("state transitions", () => {
    test("custom -> disabled -> cleared -> custom", () => {
      // Set custom
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_1",
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });
      expect(chatDb.getChatGameSettings(123)?.coinflip_video_id).toBe("custom_1");

      // Disable
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });
      expect(chatDb.getChatGameSettings(123)?.coinflip_video_id).toBe(CHAT_MEDIA_DISABLED_SENTINEL);

      // Clear (use bot default)
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "",
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });
      expect(chatDb.getChatGameSettings(123)?.coinflip_video_id).toBe("");

      // Set new custom
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_2",
        coinflip_media_type: "animation",
        set_by_telegram_id: "admin",
      });
      expect(chatDb.getChatGameSettings(123)?.coinflip_video_id).toBe("custom_2");
      expect(chatDb.getChatGameSettings(123)?.coinflip_media_type).toBe("animation");
    });
  });
});
