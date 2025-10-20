import { describe, expect, test } from "bun:test";
import { InlineKeyboard } from "grammy";
import { respondWithMenu } from "../src/utils/menu-response";

const basePayload = {
  text: "<b>Hello</b>",
  keyboard: new InlineKeyboard().text("OK", "noop"),
};

const makeCtx = () => {
  const calls: Array<{ type: string; args: any[] }> = [];
  const ctx: any = {
    callbackQuery: {
      message: {
        chat: { id: 42 },
        message_id: 99,
      },
    },
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
      return { ok: true };
    },
    __calls: calls,
  };
  return ctx;
};

describe("respondWithMenu", () => {
  test("edits caption first when message supports caption", async () => {
    const ctx = makeCtx();
    ctx.callbackQuery.message.caption = "previous caption";

    await respondWithMenu(ctx as any, basePayload);

    const calls = ctx.__calls;
    expect(calls[0]?.type).toBe("caption");
    expect(calls.find((c: any) => c.type === "reply")).toBeUndefined();
  });

  test("falls back to reply when both caption and text edits fail with missing-content errors", async () => {
    const ctx = makeCtx();
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

    await respondWithMenu(ctx as any, basePayload);

    const replies = ctx.__calls.filter((c: any) => c.type === "reply");
    expect(replies.length).toBe(1);
    const replyArgs = replies[0].args;
    expect(replyArgs[0]).toBe(basePayload.text);
  });

  test("edits text when caption not supported", async () => {
    const ctx = makeCtx();

    await respondWithMenu(ctx as any, basePayload);

    const calls = ctx.__calls;
    expect(calls[0]?.type).toBe("text");
    expect(calls.find((c: any) => c.type === "reply")).toBeUndefined();
  });
});

