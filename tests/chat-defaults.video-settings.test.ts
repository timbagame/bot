import { beforeEach, describe, expect, test } from "bun:test";
import { ChatDatabase } from "../src/utils/chat-database";
import { CHAT_MEDIA_DISABLED_SENTINEL } from "../src/utils/constants";
import { resetTestDatabase } from "./helpers/database";

describe("Chat defaults video settings isolation", () => {
  let chatDb: ChatDatabase;

  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    ChatDatabase.resetForTesting();
    chatDb = ChatDatabase.getInstance();
  });

  test("setting coinflip video should not affect giveaway video", () => {
    // Set coinflip video
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "coinflip_video_id_123",
      coinflip_media_type: "photo",
      set_by_telegram_id: "admin",
    });

    const settings1 = chatDb.getChatGameSettings(99);
    expect(settings1?.coinflip_video_id).toBe("coinflip_video_id_123");
    expect(settings1?.coinflip_media_type).toBe("photo");
    expect(settings1?.giveaway_video_id).toBeNull();
    expect(settings1?.giveaway_media_type).toBeNull();

    // Set giveaway video - coinflip should remain unchanged
    chatDb.upsertChatGameSettings(99, {
      giveaway_video_id: "giveaway_video_id_456",
      giveaway_media_type: "video",
      set_by_telegram_id: "admin",
    });

    const settings2 = chatDb.getChatGameSettings(99);
    expect(settings2?.coinflip_video_id).toBe("coinflip_video_id_123");
    expect(settings2?.coinflip_media_type).toBe("photo");
    expect(settings2?.giveaway_video_id).toBe("giveaway_video_id_456");
    expect(settings2?.giveaway_media_type).toBe("video");
  });

  test("disabling giveaway video should not affect coinflip video", () => {
    // Set coinflip video first
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "coinflip_custom_photo",
      coinflip_media_type: "photo",
      set_by_telegram_id: "admin",
    });

    // Disable giveaway video
    chatDb.upsertChatGameSettings(99, {
      giveaway_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
      giveaway_media_type: null,
      set_by_telegram_id: "admin",
    });

    const settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_video_id).toBe("coinflip_custom_photo");
    expect(settings?.coinflip_media_type).toBe("photo");
    expect(settings?.giveaway_video_id).toBe(CHAT_MEDIA_DISABLED_SENTINEL);
    expect(settings?.giveaway_media_type).toBeNull();
  });

  test("disabling coinflip video should not affect giveaway video", () => {
    // Set giveaway video first
    chatDb.upsertChatGameSettings(99, {
      giveaway_video_id: "giveaway_custom_video",
      giveaway_media_type: "video",
      set_by_telegram_id: "admin",
    });

    // Disable coinflip video
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
      coinflip_media_type: null,
      set_by_telegram_id: "admin",
    });

    const settings = chatDb.getChatGameSettings(99);
    expect(settings?.giveaway_video_id).toBe("giveaway_custom_video");
    expect(settings?.giveaway_media_type).toBe("video");
    expect(settings?.coinflip_video_id).toBe(CHAT_MEDIA_DISABLED_SENTINEL);
    expect(settings?.coinflip_media_type).toBeNull();
  });

  test("clearing coinflip video should not affect giveaway video", () => {
    // Set both videos
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "coinflip_123",
      coinflip_media_type: "photo",
      giveaway_video_id: "giveaway_456",
      giveaway_media_type: "animation",
      set_by_telegram_id: "admin",
    });

    // Clear coinflip (set to empty string for "use bot default")
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "",
      coinflip_media_type: null,
      set_by_telegram_id: "admin",
    });

    const settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_video_id).toBe("");
    expect(settings?.coinflip_media_type).toBeNull();
    expect(settings?.giveaway_video_id).toBe("giveaway_456");
    expect(settings?.giveaway_media_type).toBe("animation");
  });

  test("clearing giveaway video should not affect coinflip video", () => {
    // Set both videos
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "coinflip_123",
      coinflip_media_type: "photo",
      giveaway_video_id: "giveaway_456",
      giveaway_media_type: "animation",
      set_by_telegram_id: "admin",
    });

    // Clear giveaway (set to empty string for "use bot default")
    chatDb.upsertChatGameSettings(99, {
      giveaway_video_id: "",
      giveaway_media_type: null,
      set_by_telegram_id: "admin",
    });

    const settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_video_id).toBe("coinflip_123");
    expect(settings?.coinflip_media_type).toBe("photo");
    expect(settings?.giveaway_video_id).toBe("");
    expect(settings?.giveaway_media_type).toBeNull();
  });

  test("updating coinflip video type should preserve giveaway settings", () => {
    // Set both with different types
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "coinflip_photo",
      coinflip_media_type: "photo",
      giveaway_video_id: "giveaway_animation",
      giveaway_media_type: "animation",
      set_by_telegram_id: "admin",
    });

    // Update coinflip to video type
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "coinflip_new_video",
      coinflip_media_type: "video",
      set_by_telegram_id: "admin",
    });

    const settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_video_id).toBe("coinflip_new_video");
    expect(settings?.coinflip_media_type).toBe("video");
    expect(settings?.giveaway_video_id).toBe("giveaway_animation");
    expect(settings?.giveaway_media_type).toBe("animation");
  });

  test("all three states: custom, disabled, and default", () => {
    // Set coinflip to custom photo
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "custom_photo_id",
      coinflip_media_type: "photo",
      set_by_telegram_id: "admin",
    });

    // Disable giveaway
    chatDb.upsertChatGameSettings(99, {
      giveaway_video_id: CHAT_MEDIA_DISABLED_SENTINEL,
      giveaway_media_type: null,
      set_by_telegram_id: "admin",
    });

    const settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_video_id).toBe("custom_photo_id");
    expect(settings?.coinflip_media_type).toBe("photo");
    expect(settings?.giveaway_video_id).toBe(CHAT_MEDIA_DISABLED_SENTINEL);
    expect(settings?.giveaway_media_type).toBeNull();

    // Clear coinflip (use bot default)
    chatDb.upsertChatGameSettings(99, {
      coinflip_video_id: "",
      coinflip_media_type: null,
      set_by_telegram_id: "admin",
    });

    const settings2 = chatDb.getChatGameSettings(99);
    expect(settings2?.coinflip_video_id).toBe("");
    expect(settings2?.coinflip_media_type).toBeNull();
    // Giveaway should still be disabled
    expect(settings2?.giveaway_video_id).toBe(CHAT_MEDIA_DISABLED_SENTINEL);
    expect(settings2?.giveaway_media_type).toBeNull();
  });
});
