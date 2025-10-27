import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __test_handleWrapAmountInput as handleWrapAmountInput,
  __test_getUserState as getUserState,
  __test_clearUserState as clearUserState,
} from "../src/bot";

const USER_ID = "123";
const BASE_STATE = {
  type: "wrap_custom_amount",
  chatId: 777,
  messageId: 555,
};

type CtxOptions = {
  failEdit?: boolean;
  fallbackMessage?: { message_id: number; chat?: { id: number } };
};

const createCtx = (options: CtxOptions = {}) => {
  const calls: { edits: any[]; replies: any[] } = { edits: [], replies: [] };

  const ctx: any = {
    from: { id: Number(USER_ID) },
    chat: { id: BASE_STATE.chatId },
    api: {
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
        opts: any
      ) => {
        calls.edits.push({ chatId, messageId, text, opts });
        if (options.failEdit) {
          const err: any = new Error("no text");
          err.description = "Bad Request: there is no text in the message to edit";
          throw err;
        }
        return { ok: true };
      },
    },
    reply: async (text: string, opts: any) => {
      calls.replies.push({ text, opts });
      return (
        options.fallbackMessage ?? {
          message_id: 601,
          chat: { id: BASE_STATE.chatId },
        }
      );
    },
  };

  ctx.__calls = calls;
  return ctx;
};

describe("handleWrapAmountInput", () => {
  beforeEach(() => {
    clearUserState(USER_ID);
  });

  afterEach(() => {
    clearUserState(USER_ID);
  });

  test("edits existing confirmation message when Telegram accepts update", async () => {
    const ctx = createCtx();

    await handleWrapAmountInput(ctx, BASE_STATE, "0.01");

    const calls = ctx.__calls;
    expect(calls.edits.length).toBe(1);
    expect(calls.replies.length).toBe(0);

    const state = getUserState(USER_ID);
    expect(state?.messageId).toBe(BASE_STATE.messageId);
    expect(state?.chatId).toBe(BASE_STATE.chatId);
  });

  test("falls back to sending a fresh message when edit fails", async () => {
    const fallback = { message_id: 777, chat: { id: 888 } };
    const ctx = createCtx({ failEdit: true, fallbackMessage: fallback });

    await handleWrapAmountInput(ctx, BASE_STATE, "0.02");

    const calls = ctx.__calls;
    expect(calls.edits.length).toBe(1);
    expect(calls.replies.length).toBe(1);

    const state = getUserState(USER_ID);
    expect(state?.messageId).toBe(fallback.message_id);
    expect(state?.chatId).toBe(fallback.chat.id);
  });
});
