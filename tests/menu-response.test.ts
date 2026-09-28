import { describe, expect, spyOn, test } from "bun:test";
import { InlineKeyboard } from "grammy";
import { respondWithMenu } from "../src/utils/menu-response";

const basePayload = {
  text: "<b>Hello</b>",
  keyboard: new InlineKeyboard().text("OK", "noop"),
};

type MakeCtxOptions = {
  message?: Record<string, unknown>;
  replyResult?: Record<string, unknown>;
  api?: Record<string, unknown>;
};

const makeCtx = (options: MakeCtxOptions = {}) => {
  const calls: Array<{ type: string; args: any[] }> = [];
  const message = Object.assign(
    {
      chat: { id: 42 },
      message_id: 99,
    },
    options.message ?? {},
  );

  const defaultReply = {
    message_id: 123,
    chat: { id: (message as any)?.chat?.id ?? 42 },
  };

  const ctx: any = {
    callbackQuery: {
      message,
    },
    api: Object.assign(
      {
        editMessageText: async (_chatId: number, _messageId: number, _text: string, opts: any) => {
          calls.push({ type: "api_text", args: [_chatId, _messageId, _text, opts] });
          return { ok: true };
        },
      },
      options.api ?? {},
    ),
    editMessageCaption: async (opts: any) => {
      calls.push({ type: "caption", args: [opts] });
      return { ok: true };
    },
    editMessageText: async (_text: string, opts: any) => {
      calls.push({ type: "text", args: [opts] });
      return { ok: true };
    },
    reply: async (text: string, opts: any) => {
      calls.push({ type: "reply", args: [text, opts] });
      return options.replyResult ?? defaultReply;
    },
  };

  ctx.__calls = calls;

  return ctx;
};

describe("respondWithMenu", () => {
  test("edits caption first when message supports caption", async () => {
    const ctx = makeCtx();
    ctx.callbackQuery.message.caption = "previous caption";

    const result = await respondWithMenu(ctx as any, basePayload);

    const calls = ctx.__calls;
    expect(calls[0]?.type).toBe("caption");
    expect(calls.find((c: any) => c.type === "reply")).toBeUndefined();
    expect(result).toEqual({
      messageId: 99,
      chatId: 42,
      respondedWithReply: false,
    });
  });

  test("falls back to reply when both caption and text edits fail with missing-content errors", async () => {
    const ctx = makeCtx({
      replyResult: { message_id: 314, chat: { id: 900 } },
    });
    ctx.callbackQuery.message.photo = [{ file_id: "abc" }];

    ctx.editMessageCaption = async () => {
      const err: any = new Error("no caption");
      err.description = "Bad Request: there is no caption in the message to edit";
      throw err;
    };
    ctx.editMessageText = async () => {
      const err: any = new Error("no text");
      err.description = "Bad Request: there is no text in the message to edit";
      throw err;
    };

    const result = await respondWithMenu(ctx as any, basePayload);

    const replies = ctx.__calls.filter((c: any) => c.type === "reply");
    expect(replies.length).toBe(1);
    const replyArgs = replies[0].args;
    expect(replyArgs[0]).toBe(basePayload.text);
    expect(result).toEqual({
      messageId: 314,
      chatId: 900,
      respondedWithReply: true,
    });
  });

  test("does not reply when edit fails due to Telegram rate limits", async () => {
    const ctx = makeCtx();

    ctx.editMessageText = async () => {
      const err: any = new Error("Too Many Requests");
      err.error_code = 429;
      err.description = "Too Many Requests: retry after 33";
      throw err;
    };

    const result = await respondWithMenu(ctx as any, basePayload);

    expect(result).toEqual({
      messageId: 99,
      chatId: 42,
      respondedWithReply: false,
    });

    const replies = ctx.__calls.filter((c: any) => c.type === "reply");
    expect(replies.length).toBe(0);
  });

  test("does not reply when explicit target edits are rate limited", async () => {
    const ctx = makeCtx({
      api: {
        editMessageText: async () => {
          const err: any = new Error("Too Many Requests");
          err.error_code = 429;
          err.description = "Too Many Requests: retry after 10";
          throw err;
        },
      },
    });

    const result = await respondWithMenu(ctx as any, basePayload, {
      targetChatId: 777,
      targetMessageId: 888,
    });

    expect(result).toEqual({
      messageId: 888,
      chatId: 777,
      respondedWithReply: false,
    });

    const replies = ctx.__calls.filter((c: any) => c.type === "reply");
    expect(replies.length).toBe(0);
  });

  test("edits text when caption not supported", async () => {
    const ctx = makeCtx();

    const result = await respondWithMenu(ctx as any, basePayload);

    const calls = ctx.__calls;
    expect(calls[0]?.type).toBe("text");
    expect(calls.find((c: any) => c.type === "reply")).toBeUndefined();
    expect(result).toEqual({
      messageId: 99,
      chatId: 42,
      respondedWithReply: false,
    });
  });

  test("skips edits and replies directly when skipEdit is true", async () => {
    const ctx = makeCtx();

    const result = await respondWithMenu(ctx as any, basePayload, { skipEdit: true });

    const calls = ctx.__calls;
    expect(calls.some((c: any) => c.type === "caption")).toBe(false);
    expect(calls.some((c: any) => c.type === "text")).toBe(false);

    const replies = calls.filter((c: any) => c.type === "reply");
    expect(replies.length).toBe(1);
    const [text, opts] = replies[0].args;
    expect(text).toBe(basePayload.text);
    expect(opts.reply_to_message_id).toBe(99);
    expect(result).toEqual({
      messageId: 123,
      chatId: 42,
      respondedWithReply: true,
    });
  });

  test("retries reply when Telegram responds with 429", async () => {
    const ctx = makeCtx();
    ctx.callbackQuery = undefined;

    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number) => {
      delays.push(ms ?? 0);
      callback();
      return 0 as any;
    }) as any;

    let attempts = 0;
    const replyResult: any = { message_id: 777, chat: { id: 501 } };
    ctx.reply = async (text: string, opts: any) => {
      attempts += 1;
      if (attempts === 1) {
        const error: any = new Error("Too Many Requests");
        error.error_code = 429;
        error.parameters = { retry_after: 1 };
        throw error;
      }
      ctx.__calls.push({ type: "reply", args: [text, opts] });
      return replyResult;
    };

    try {
      const result = await respondWithMenu(ctx as any, basePayload);
      expect(result).toEqual({
        messageId: replyResult.message_id,
        chatId: replyResult.chat.id,
        respondedWithReply: true,
      });
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(attempts).toBe(2);
    expect(delays).toEqual([1000]);
    const replies = ctx.__calls.filter((c: any) => c.type === "reply");
    expect(replies.length).toBe(1);
  });

  test("uses adapter target metadata to edit without callback context", async () => {
    const ctx = makeCtx();
    ctx.callbackQuery = undefined;
    ctx.__editAdapterTarget = { chatId: 777, messageId: 888 };

    const result = await respondWithMenu(ctx as any, basePayload);

    const calls = ctx.__calls;
    expect(calls[0]?.type).toBe("caption");
    expect(calls.find((c: any) => c.type === "reply")).toBeUndefined();
    expect(result).toEqual({
      messageId: 888,
      chatId: 777,
      respondedWithReply: false,
    });
  });

  test("does not reply when adapter target edits are rate limited", async () => {
    const ctx = makeCtx();
    ctx.callbackQuery = undefined;
    ctx.__editAdapterTarget = { chatId: 321, messageId: 654 };

    ctx.editMessageText = async () => {
      const err: any = new Error("Too Many Requests");
      err.error_code = 429;
      err.description = "Too Many Requests: retry after 25";
      throw err;
    };

    const result = await respondWithMenu(ctx as any, basePayload);

    expect(result).toEqual({
      messageId: 654,
      chatId: 321,
      respondedWithReply: false,
    });

    const replies = ctx.__calls.filter((c: any) => c.type === "reply");
    expect(replies.length).toBe(0);
  });

  test("falls back to reply when adapter edits cannot proceed", async () => {
    const ctx = makeCtx({
      replyResult: { message_id: 222, chat: { id: 333 } },
    });
    ctx.callbackQuery = undefined;
    ctx.__editAdapterTarget = { chatId: 777, messageId: 888 };

    ctx.editMessageCaption = async () => {
      const err: any = new Error("no caption");
      err.description = "Bad Request: there is no caption in the message to edit";
      throw err;
    };
    ctx.editMessageText = async () => {
      const err: any = new Error("no text");
      err.description = "Bad Request: there is no text in the message to edit";
      throw err;
    };

    const result = await respondWithMenu(ctx as any, basePayload);

    const replies = ctx.__calls.filter((c: any) => c.type === "reply");
    expect(replies.length).toBe(1);
    expect(result).toEqual({
      messageId: 222,
      chatId: 333,
      respondedWithReply: true,
    });
  });

  test("treats an unchanged message as a successful edit", async () => {
    const ctx = makeCtx();
    ctx.callbackQuery.message.caption = "same";
    ctx.editMessageCaption = async () => {
      const err: any = new Error("not modified");
      err.description = "Bad Request: message is not modified";
      throw err;
    };

    const result = await respondWithMenu(ctx as any, basePayload);

    expect(ctx.__calls).toEqual([]);
    expect(result).toEqual({ messageId: 99, chatId: 42, respondedWithReply: false });
  });

  test("explicit caption edit errors skip the text edit for that target and log why", async () => {
    const captionError: any = new Error("forbidden");
    captionError.description = "Bad Request: message can't be edited";
    const ctx = makeCtx({
      api: {
        editMessageCaption: async () => {
          throw captionError;
        },
      },
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await respondWithMenu(ctx as any, basePayload, {
        targetChatId: 777,
        targetMessageId: 888,
        logLabel: "menu",
      });

      expect(ctx.__calls.map((c: any) => c.type)).toEqual(["text"]);
      expect(result).toEqual({ messageId: 99, chatId: 42, respondedWithReply: false });
      expect(warnSpy).toHaveBeenCalledWith(
        "menu: editMessageCaption failed for explicit target, replying instead:",
        captionError,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("explicit caption edits fall through to text edits when the message has no caption", async () => {
    const captionError: any = new Error("no caption");
    captionError.description = "Bad Request: there is no caption in the message to edit";
    const ctx = makeCtx({
      api: {
        editMessageCaption: async () => {
          throw captionError;
        },
      },
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await respondWithMenu(ctx as any, basePayload, {
        targetChatId: 777,
        targetMessageId: 888,
        logLabel: "menu",
      });

      expect(ctx.__calls.map((c: any) => c.type)).toEqual(["api_text"]);
      expect(result).toEqual({ messageId: 888, chatId: 777, respondedWithReply: false });
      expect(warnSpy).toHaveBeenCalledWith(
        "menu: editMessageCaption failed (missing caption), attempting text edit:",
        captionError,
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("adapter targets fall back to the context chat id, or null when unknown", async () => {
    const withChat = makeCtx();
    withChat.callbackQuery = undefined;
    withChat.chat = { id: 555 };
    withChat.__editAdapterTarget = { messageId: 10 };
    expect(await respondWithMenu(withChat as any, basePayload)).toEqual({
      messageId: 10,
      chatId: 555,
      respondedWithReply: false,
    });

    const withoutChat = makeCtx();
    withoutChat.callbackQuery = undefined;
    withoutChat.__editAdapterTarget = { chatId: "bad", messageId: "bad" };
    expect(await respondWithMenu(withoutChat as any, basePayload)).toEqual({
      messageId: null,
      chatId: null,
      respondedWithReply: false,
    });
  });
});
