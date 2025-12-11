import { beforeEach, describe, expect, test } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { __test_resolveGameMedia as resolveGameMedia } from "../src/utils/game";
import {
  CHAT_MEDIA_DISABLED_SENTINEL,
  getCoinflipVideoId,
  getGiveawayVideoId,
} from "../src/utils/constants";
import { resetTestDatabase } from "./helpers/database";

const defaultCoinflipVideoId = getCoinflipVideoId();
const defaultGiveawayVideoId = getGiveawayVideoId();

describe("resolveGameMedia", () => {
  let chatDb: ChatDatabase;

  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    ChatDatabase.resetForTesting();
    chatDb = ChatDatabase.getInstance();
  });

  describe("without chat settings", () => {
    test("returns bot default video for coinflip", () => {
      const result = resolveGameMedia("coinflip", undefined);
      expect(result).toEqual({
        fileId: defaultCoinflipVideoId,
        mediaType: "video",
      });
    });

    test("returns bot default video for giveaway", () => {
      const result = resolveGameMedia("giveaway", undefined);
      expect(result).toEqual({
        fileId: defaultGiveawayVideoId,
        mediaType: "video",
      });
    });

    test("returns undefined for unknown game type", () => {
      const result = resolveGameMedia("unknown", undefined);
      expect(result).toBeUndefined();
    });

    test("is case insensitive for game type", () => {
      expect(resolveGameMedia("COINFLIP", undefined)).toEqual({
        fileId: defaultCoinflipVideoId,
        mediaType: "video",
      });
      expect(resolveGameMedia("GIVEAWAY", undefined)).toEqual({
        fileId: defaultGiveawayVideoId,
        mediaType: "video",
      });
    });
  });

  describe("with chat-specific custom media", () => {
    test("returns custom photo for coinflip", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_coinflip_photo_id",
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("coinflip", 123);
      expect(result).toEqual({
        fileId: "custom_coinflip_photo_id",
        mediaType: "photo",
      });
    });

    test("returns custom video for coinflip", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_coinflip_video_id",
        coinflip_media_type: "video",
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("coinflip", 123);
      expect(result).toEqual({
        fileId: "custom_coinflip_video_id",
        mediaType: "video",
      });
    });

    test("returns custom animation/GIF for coinflip", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_coinflip_gif_id",
        coinflip_media_type: "animation",
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("coinflip", 123);
      expect(result).toEqual({
        fileId: "custom_coinflip_gif_id",
        mediaType: "animation",
      });
    });

    test("returns custom photo for giveaway", () => {
      chatDb.upsertChatGameSettings(123, {
        giveaway_video_id: "custom_giveaway_photo_id",
        giveaway_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("giveaway", 123);
      expect(result).toEqual({
        fileId: "custom_giveaway_photo_id",
        mediaType: "photo",
      });
    });

    test("defaults to video if media_type is not set", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_coinflip_id",
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("coinflip", 123);
      expect(result).toEqual({
        fileId: "custom_coinflip_id",
        mediaType: "video",
      });
    });
  });

  describe("with disabled media (sentinel value)", () => {
    test("returns undefined when coinflip media is explicitly disabled", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("coinflip", 123);
      expect(result).toBeUndefined();
    });

    test("returns undefined when giveaway media is explicitly disabled", () => {
      chatDb.upsertChatGameSettings(123, {
        giveaway_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
        giveaway_media_type: null,
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("giveaway", 123);
      expect(result).toBeUndefined();
    });

    test("disabled coinflip does not affect giveaway", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
        giveaway_video_id: "custom_giveaway_id",
        giveaway_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      expect(resolveGameMedia("coinflip", 123)).toBeUndefined();
      expect(resolveGameMedia("giveaway", 123)).toEqual({
        fileId: "custom_giveaway_id",
        mediaType: "photo",
      });
    });
  });

  describe("with cleared media (empty string - use bot default)", () => {
    test("returns bot default when coinflip media is cleared", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "",
        coinflip_media_type: null,
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("coinflip", 123);
      expect(result).toEqual({
        fileId: defaultCoinflipVideoId,
        mediaType: "video",
      });
    });

    test("returns bot default when giveaway media is cleared", () => {
      chatDb.upsertChatGameSettings(123, {
        giveaway_video_id: "",
        giveaway_media_type: null,
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("giveaway", 123);
      expect(result).toEqual({
        fileId: defaultGiveawayVideoId,
        mediaType: "video",
      });
    });
  });

  describe("with null media (not set - use bot default)", () => {
    test("returns bot default when coinflip media is null (not set)", () => {
      // Create a row but don't set the video fields
      chatDb.upsertChatGameSettings(123, {
        timeout_seconds: 300,
        set_by_telegram_id: "admin",
      });

      const result = resolveGameMedia("coinflip", 123);
      expect(result).toEqual({
        fileId: defaultCoinflipVideoId,
        mediaType: "video",
      });
    });
  });

  describe("isolation between game types", () => {
    test("custom coinflip does not affect giveaway", () => {
      chatDb.upsertChatGameSettings(123, {
        coinflip_video_id: "custom_coinflip_id",
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      expect(resolveGameMedia("coinflip", 123)).toEqual({
        fileId: "custom_coinflip_id",
        mediaType: "photo",
      });
      expect(resolveGameMedia("giveaway", 123)).toEqual({
        fileId: defaultGiveawayVideoId,
        mediaType: "video",
      });
    });

    test("custom giveaway does not affect coinflip", () => {
      chatDb.upsertChatGameSettings(123, {
        giveaway_video_id: "custom_giveaway_id",
        giveaway_media_type: "animation",
        set_by_telegram_id: "admin",
      });

      expect(resolveGameMedia("coinflip", 123)).toEqual({
        fileId: defaultCoinflipVideoId,
        mediaType: "video",
      });
      expect(resolveGameMedia("giveaway", 123)).toEqual({
        fileId: "custom_giveaway_id",
        mediaType: "animation",
      });
    });
  });

  describe("chat isolation", () => {
    test("different chats have independent settings", () => {
      chatDb.upsertChatGameSettings(100, {
        coinflip_video_id: "chat100_coinflip",
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      chatDb.upsertChatGameSettings(200, {
        coinflip_video_id: "chat200_coinflip",
        coinflip_media_type: "animation",
        set_by_telegram_id: "admin",
      });

      expect(resolveGameMedia("coinflip", 100)).toEqual({
        fileId: "chat100_coinflip",
        mediaType: "photo",
      });
      expect(resolveGameMedia("coinflip", 200)).toEqual({
        fileId: "chat200_coinflip",
        mediaType: "animation",
      });
    });

    test("chat without settings uses bot default", () => {
      chatDb.upsertChatGameSettings(100, {
        coinflip_video_id: "custom_id",
        coinflip_media_type: "photo",
        set_by_telegram_id: "admin",
      });

      // Chat 200 has no settings
      expect(resolveGameMedia("coinflip", 200)).toEqual({
        fileId: defaultCoinflipVideoId,
        mediaType: "video",
      });
    });
  });
});
