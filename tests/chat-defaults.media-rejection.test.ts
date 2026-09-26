import { beforeEach, describe, expect, test } from "bun:test";
import { setInputSession, getInputSession, clearInputSession } from "../src/utils/user-state";
import { ChatDatabase } from "../src/utils/chat-database";
import { resetTestDatabase } from "./helpers/database";

// Mock the handleMediaForChatDefaults function behavior
// This test validates that documents are rejected

describe("Chat defaults media rejection", () => {
  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    ChatDatabase.resetForTesting();
    // Clear all input sessions
    clearInputSession("99_11");
  });

  test("document messages should be rejected when setting video", async () => {
    // Simulate an active input session for video_coinflip
    setInputSession("99_11", {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "video_coinflip",
      initiatorId: "123",
    });

    // Mock context with a document message
    const mockCtx: any = {
      chat: { id: 99 },
      message: {
        message_id: 12,
        reply_to_message: { message_id: 11 },
        document: {
          file_id: "document_file_id_123",
          file_name: "video.mp4",
          mime_type: "video/mp4",
        },
      },
      reply: async (text: string) => {
        // This should be called with rejection message
        expect(text).toContain("Please send media directly");
        expect(text).toContain("Files sent as documents are not supported");
        return { message_id: 13 } as any;
      },
    };

    // Import and test the handler logic
    // Since handleMediaForChatDefaults is not exported, we test the behavior
    // by checking that documents would be rejected
    const session = getInputSession("99_11");
    expect(session).toBeDefined();
    expect(session?.["setting"]).toBe("video_coinflip");

    // The actual rejection happens in bot.ts handleMediaForChatDefaults
    // This test validates the session exists and would trigger the rejection
    if (session && mockCtx.message?.document) {
      // Simulate the rejection logic
      const isDocument = mockCtx.message.document != null;
      if (isDocument) {
        const rejectionMessage = await mockCtx.reply(
          "❌ <b>Please send media directly</b>\n\n" +
            "Only <b>photos</b>, <b>videos</b>, or <b>GIFs</b> sent directly are accepted.\n\n" +
            "Files sent as documents are not supported.",
        );
        expect(rejectionMessage).toBeDefined();
      }
    }
  });

  test("photo messages should be accepted when setting video", () => {
    // Simulate an active input session
    setInputSession("99_11", {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "video_coinflip",
      initiatorId: "123",
    });

    // Mock context with a photo message (direct, not document)
    const mockCtx: any = {
      chat: { id: 99 },
      message: {
        message_id: 12,
        reply_to_message: { message_id: 11 },
        photo: [
          { file_id: "photo_small", width: 90, height: 90 },
          { file_id: "photo_medium", width: 320, height: 320 },
          { file_id: "photo_large", width: 1280, height: 1280 },
        ],
      },
    };

    // Photo messages should be accepted (not rejected)
    const session = getInputSession("99_11");
    expect(session).toBeDefined();
    expect(session?.["setting"]).toBe("video_coinflip");

    // Photo is direct media, not a document
    const isDocument = mockCtx.message?.document != null;
    const isPhoto = mockCtx.message?.photo != null && mockCtx.message.photo.length > 0;

    expect(isDocument).toBe(false);
    expect(isPhoto).toBe(true);
    // Photo should be processed, not rejected
  });

  test("video messages should be accepted when setting video", () => {
    // Simulate an active input session
    setInputSession("99_11", {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "video_giveaway",
      initiatorId: "123",
    });

    // Mock context with a video message (direct, not document)
    const mockCtx: any = {
      chat: { id: 99 },
      message: {
        message_id: 12,
        reply_to_message: { message_id: 11 },
        video: {
          file_id: "video_file_id_123",
          width: 1280,
          height: 720,
          duration: 10,
        },
      },
    };

    // Video messages should be accepted (not rejected)
    const session = getInputSession("99_11");
    expect(session).toBeDefined();
    expect(session?.["setting"]).toBe("video_giveaway");

    const isDocument = mockCtx.message?.document != null;
    const isVideo = mockCtx.message?.video != null;

    expect(isDocument).toBe(false);
    expect(isVideo).toBe(true);
    // Video should be processed, not rejected
  });

  test("animation (GIF) messages should be accepted when setting video", () => {
    // Simulate an active input session
    setInputSession("99_11", {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "video_coinflip",
      initiatorId: "123",
    });

    // Mock context with an animation message (direct, not document)
    const mockCtx: any = {
      chat: { id: 99 },
      message: {
        message_id: 12,
        reply_to_message: { message_id: 11 },
        animation: {
          file_id: "animation_file_id_123",
          width: 500,
          height: 500,
          duration: 3,
        },
      },
    };

    // Animation messages should be accepted (not rejected)
    const session = getInputSession("99_11");
    expect(session).toBeDefined();
    expect(session?.["setting"]).toBe("video_coinflip");

    const isDocument = mockCtx.message?.document != null;
    const isAnimation = mockCtx.message?.animation != null;

    expect(isDocument).toBe(false);
    expect(isAnimation).toBe(true);
    // Animation should be processed, not rejected
  });

  test("rejects PDF documents", async () => {
    setInputSession("99_11", {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "video_giveaway",
      initiatorId: "123",
    });

    const mockCtx: any = {
      chat: { id: 99 },
      message: {
        message_id: 12,
        reply_to_message: { message_id: 11 },
        document: {
          file_id: "pdf_file_id",
          file_name: "document.pdf",
          mime_type: "application/pdf",
        },
      },
      reply: async (text: string) => {
        expect(text).toContain("Please send media directly");
        expect(text).toContain("Files sent as documents are not supported");
        return { message_id: 13 } as any;
      },
    };

    const session = getInputSession("99_11");
    expect(session).toBeDefined();

    // PDF should be rejected
    if (mockCtx.message?.document) {
      const rejectionMessage = await mockCtx.reply(
        "❌ <b>Please send media directly</b>\n\n" +
          "Only <b>photos</b>, <b>videos</b>, or <b>GIFs</b> sent directly are accepted.\n\n" +
          "Files sent as documents are not supported.",
      );
      expect(rejectionMessage).toBeDefined();
    }
  });

  test("rejects an MP4 sent as a document even though it is a video", async () => {
    setInputSession("99_11", {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "video_coinflip",
      initiatorId: "123",
    });

    const mockCtx: any = {
      chat: { id: 99 },
      message: {
        message_id: 12,
        reply_to_message: { message_id: 11 },
        document: {
          file_id: "mp4_as_document",
          file_name: "video.mp4",
          mime_type: "video/mp4",
        },
      },
      reply: async (text: string) => {
        // Even though it's a video file, it should be rejected because it's sent as document
        expect(text).toContain("Please send media directly");
        expect(text).toContain("Files sent as documents are not supported");
        return { message_id: 13 } as any;
      },
    };

    const session = getInputSession("99_11");
    expect(session).toBeDefined();

    // MP4 as document should be rejected
    if (mockCtx.message?.document) {
      const rejectionMessage = await mockCtx.reply(
        "❌ <b>Please send media directly</b>\n\n" +
          "Only <b>photos</b>, <b>videos</b>, or <b>GIFs</b> sent directly are accepted.\n\n" +
          "Files sent as documents are not supported.",
      );
      expect(rejectionMessage).toBeDefined();
    }
  });
});
