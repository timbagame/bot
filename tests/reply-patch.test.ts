import { test, expect } from "bun:test";
import { patchReplyBehavior } from "../src/utils/reply-patch";

function makeCtx(messageId?: number) {
  const calls: any[] = [];
  const ctx: any = {
    message: messageId ? { message_id: messageId } : undefined,
    reply: async (text: string, opts?: any) => { calls.push(["reply", text, opts]); return { ok: true }; },
    replyWithVideo: async (vid: any, opts?: any) => { calls.push(["video", vid, opts]); return { ok: true }; },
    __calls: calls,
  };
  return ctx;
}

test("patchReplyBehavior sets reply_to_message_id and retries on not found", async () => {
  const ctx: any = makeCtx(123);
  // Simulate error on first call when reply_to_message_id is set
  const orig = ctx.reply;
  ctx.reply = async (text: string, opts?: any) => {
    if (opts && opts.reply_to_message_id) {
      // record the attempt that includes reply_to_message_id, then throw
      await orig(text, opts);
      const err: any = new Error("message to be replied not found");
      err.description = "message to be replied not found";
      throw err;
    }
    return await orig(text, opts);
  };
  patchReplyBehavior(ctx as any);
  await ctx.reply("hello");
  const calls = ctx.__calls;
  // First attempt then retry without reply_to_message_id
  expect(calls[0][2].reply_to_message_id).toBe(123);
  expect(calls[1][2].reply_to_message_id).toBeUndefined();
});

test("patchReplyBehavior also patches replyWithVideo similarly", async () => {
  const ctx: any = makeCtx(99);
  const orig = ctx.replyWithVideo;
  ctx.replyWithVideo = async (vid: any, opts?: any) => {
    if (opts && opts.reply_to_message_id) {
      // record the attempt with reply_to_message_id, then throw
      await orig(vid, opts);
      const err: any = new Error("message to be replied not found");
      err.description = "message to be replied not found";
      throw err;
    }
    return await orig(vid, opts);
  };
  patchReplyBehavior(ctx as any);
  await ctx.replyWithVideo("vid");
  const calls = ctx.__calls;
  expect(calls[0][2].reply_to_message_id).toBe(99);
  expect(calls[1][2].reply_to_message_id).toBeUndefined();
});

test("retry removes reply_to_message_id before delegating", async () => {
  const attempts: any[] = [];
  const err: any = new Error("message to be replied not found");
  err.description = "message to be replied not found";
  const ctx: any = {
    message: { message_id: 55 },
    reply: async (_text: string, opts?: any) => {
      attempts.push(opts ?? {});
      if (opts?.reply_to_message_id) {
        throw err;
      }
      return { ok: true };
    },
  };

  patchReplyBehavior(ctx);
  await ctx.reply("hi there");
  expect(attempts.length).toBe(2);
  expect(attempts[0]?.reply_to_message_id).toBe(55);
  expect(attempts[1]?.reply_to_message_id).toBeUndefined();
});

test("does not override provided reply_to_message_id", async () => {
  const ctx: any = makeCtx(321);
  patchReplyBehavior(ctx as any);
  await ctx.reply("explicit", { reply_to_message_id: 777 });
  expect(ctx.__calls[0][2].reply_to_message_id).toBe(777);
});

test("treats null reply_to_message_id as needing default", async () => {
  const ctx: any = makeCtx(654);
  patchReplyBehavior(ctx as any);
  await ctx.reply("nullish", { reply_to_message_id: null });
  expect(ctx.__calls[0][2].reply_to_message_id).toBe(654);
});
