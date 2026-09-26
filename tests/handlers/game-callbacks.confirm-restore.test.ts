import { describe, expect, test } from "bun:test";
import {
  CONFIRM_RETRY_LABEL,
  buildRestoredConfirmMessage,
  restoreConfirmMessage,
  snapshotConfirmMessage,
} from "../../src/handlers/game-callbacks/confirm-restore";

const NOTICE = "❌ Failed to create game. Please try again.";

describe("confirm card snapshot", () => {
  test("ignores messages without text", () => {
    expect(snapshotConfirmMessage(undefined)).toBeNull();
    expect(snapshotConfirmMessage({ caption: "video" })).toBeNull();
    expect(snapshotConfirmMessage({ text: "" })).toBeNull();
  });

  test("keeps text, entities and inline keyboard", () => {
    const keyboard = { inline_keyboard: [[{ text: "✅ Create Game", callback_data: "cg|x" }]] };
    expect(
      snapshotConfirmMessage({
        text: "Coinflip",
        entities: [{ type: "bold", offset: 0, length: 8 }],
        reply_markup: keyboard,
      }),
    ).toEqual({
      text: "Coinflip",
      entities: [{ type: "bold", offset: 0, length: 8 }],
      replyMarkup: keyboard,
    });
    expect(snapshotConfirmMessage({ text: "Coinflip", reply_markup: {} })).toEqual({
      text: "Coinflip",
      entities: undefined,
      replyMarkup: undefined,
    });
  });
});

describe("restored confirm card", () => {
  test("without a snapshot it shows the notice and a Try again button", () => {
    expect(buildRestoredConfirmMessage(null, NOTICE, "cg|payload")).toEqual({
      text: NOTICE,
      entities: [{ type: "bold", offset: 0, length: NOTICE.length }],
      replyMarkup: {
        inline_keyboard: [[{ text: CONFIRM_RETRY_LABEL, callback_data: "cg|payload" }]],
      },
    });
    expect(buildRestoredConfirmMessage(null, NOTICE).replyMarkup).toBeUndefined();
  });

  test("a snapshot without a keyboard still gets Try again", () => {
    const restored = buildRestoredConfirmMessage({ text: "Coinflip" }, NOTICE, "cg|payload");
    expect(restored.text).toBe(`${NOTICE}\n\nCoinflip`);
    expect(restored.replyMarkup?.inline_keyboard[0]?.[0]?.text).toBe(CONFIRM_RETRY_LABEL);
  });

  test("restore edits the message and tolerates not-modified", async () => {
    const calls: any[] = [];
    const api = {
      editMessageText: async (...args: any[]) => {
        calls.push(args);
        return true;
      },
    };
    const restored = buildRestoredConfirmMessage({ text: "Coinflip" }, NOTICE);
    expect(await restoreConfirmMessage(api, { chatId: 1, messageId: 2 }, restored)).toBe(true);
    expect(calls[0].slice(0, 3)).toEqual([1, 2, restored.text]);
    expect(calls[0][3].reply_markup).toBeUndefined();

    const notModified = {
      editMessageText: async () => {
        throw Object.assign(new Error("Bad Request: message is not modified"), {
          description: "Bad Request: message is not modified",
        });
      },
    };
    expect(await restoreConfirmMessage(notModified, { chatId: 1, messageId: 2 }, restored)).toBe(
      true,
    );
  });
});
