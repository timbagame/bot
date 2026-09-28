import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  bot,
  botModule,
  lastText,
  overrideApiMethod,
  resetCalls,
  restoreStubs,
  texts,
  useBotHarness,
} from "./helpers/bot-harness";
import {
  clearAllInputSessions,
  getInputSession,
  markInputSessionProcessing,
  setInputSession,
} from "../src/utils/user-state";

useBotHarness();

let CHAT = -1_011_000;
const ADMIN = 7_001;
const PROMPT = 40;
let updateId = 91_000_000;
let errorSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let savedTokenManager: any;

beforeEach(() => {
  CHAT -= 1;
  resetCalls();
  clearAllInputSessions();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  // The confirmation menu shows the chat's default token; keep this suite
  // independent of whichever token manager an earlier suite left behind.
  savedTokenManager = botModule.__test_getTokenManager();
  botModule.__test_setTokenManager({
    getDefaultToken: () => ({
      token_mint: "So11111111111111111111111111111111111111112",
      token_ticker: "SOL",
      decimals: 9,
    }),
    getChatDefaultToken: () => ({
      token_mint: "So11111111111111111111111111111111111111112",
      token_ticker: "SOL",
      decimals: 9,
    }),
  } as any);
  overrideApiMethod("getChatMember", (payload) => ({
    status: "administrator",
    user: { id: payload.user_id },
  }));
});

afterEach(() => {
  botModule.__test_setTokenManager(savedTokenManager);
  restoreStubs();
  clearAllInputSessions();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

const prompt = (setting: string, initiatorId = String(ADMIN)) =>
  setInputSession(`${CHAT}_${PROMPT}`, {
    type: "chat_defaults",
    setting,
    chatId: CHAT,
    messageId: PROMPT,
    initiatorId,
  } as any);

const sendMedia = (
  media: Record<string, unknown>,
  options: { from?: number | null; replyTo?: number } = {},
) =>
  bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT, type: "supergroup", title: "Group" },
      ...(options.from === null
        ? {}
        : { from: { id: options.from ?? ADMIN, is_bot: false, first_name: "A" } }),
      ...(options.replyTo === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: options.replyTo,
              date: 1,
              chat: { id: CHAT, type: "supergroup", title: "Group" },
              text: "prompt",
            },
          }),
      ...media,
    },
  } as any);

const video = {
  video: { file_id: "video-file", file_unique_id: "v", width: 1, height: 1, duration: 1 },
};
const photo = {
  photo: [
    { file_id: "small", file_unique_id: "s", width: 1, height: 1 },
    { file_id: "large-photo", file_unique_id: "l", width: 2, height: 2 },
  ],
};
const gif = {
  animation: { file_id: "gif-file", file_unique_id: "g", width: 1, height: 1, duration: 1 },
};
const documentMessage = {
  document: { file_id: "doc-file", file_unique_id: "d", file_name: "a.mp4" },
};

describe("media replies for chat defaults", () => {
  test("a video reply sets the coinflip media", async () => {
    prompt("video_coinflip");

    await sendMedia(video, { replyTo: PROMPT });

    expect(botModule.__test_getChatDatabase().getChatGameSettings(CHAT)).toMatchObject({
      coinflip_video_id: "video-file",
      coinflip_media_type: "video",
    });
    expect(getInputSession(`${CHAT}_${PROMPT}`)).toBeUndefined();
  });

  test("a photo sent without replying still finds the open prompt", async () => {
    prompt("video_giveaway");

    await sendMedia(photo);

    expect(botModule.__test_getChatDatabase().getChatGameSettings(CHAT)).toMatchObject({
      giveaway_video_id: "large-photo",
      giveaway_media_type: "photo",
    });
  });

  test("a GIF sets the buy alert media", async () => {
    prompt("video_buy_alerts");

    await sendMedia(gif, { replyTo: PROMPT });

    expect(botModule.__test_getChatDatabase().getChatBuyAlerts(CHAT)).toMatchObject({
      media_file_id: "gif-file",
      media_type: "animation",
    });
  });

  test("files sent as documents are rejected and the prompt closes", async () => {
    prompt("video_coinflip");

    await sendMedia(documentMessage, { replyTo: PROMPT });

    expect(lastText()).toContain("Please send media directly");
    expect(getInputSession(`${CHAT}_${PROMPT}`)).toBeUndefined();
  });

  test("replies from another member are refused", async () => {
    prompt("video_coinflip", "9999");

    await sendMedia(video, { replyTo: PROMPT });

    expect(lastText()).toContain("This prompt is no longer active for you.");
    expect(botModule.__test_getChatDatabase().getChatGameSettings(CHAT)).toBeNull();
  });

  test("media is ignored without a matching media prompt", async () => {
    prompt("timeout");

    await sendMedia(video, { replyTo: PROMPT });
    await sendMedia(video);
    await sendMedia(video, { from: null });

    expect(texts()).toEqual([]);
    expect(getInputSession(`${CHAT}_${PROMPT}`)).toBeDefined();
  });

  test("a prompt already being processed is left alone", async () => {
    prompt("video_coinflip");
    markInputSessionProcessing(`${CHAT}_${PROMPT}`, "someone-else");

    await sendMedia(video, { replyTo: PROMPT });

    expect(botModule.__test_getChatDatabase().getChatGameSettings(CHAT)).toBeNull();
  });

  test("a failure while saving closes the prompt with an error", async () => {
    prompt("video_coinflip");
    const chatDb = botModule.__test_getChatDatabase();
    const upsert = spyOn(chatDb, "upsertChatGameSettings").mockImplementation(() => {
      throw new Error("db locked");
    });
    try {
      await sendMedia(video, { replyTo: PROMPT });
    } finally {
      upsert.mockRestore();
    }

    expect(lastText()).toContain("Error processing media");
    expect(getInputSession(`${CHAT}_${PROMPT}`)).toBeUndefined();
  });
});
