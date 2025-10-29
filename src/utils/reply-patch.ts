import type { Context } from "grammy";

type ReplyMethod = "reply" | "replyWithVideo";

const wrapReplyMethod = (
  ctx: Context,
  method: ReplyMethod,
  original: ((...args: any[]) => Promise<unknown>) | undefined,
  replyId?: number
): void => {
  if (!original) {
    return;
  }

  (ctx as any)[method] = async (payload: any, other?: any) => {
    const base = other ?? {};
    if (
      replyId &&
      (base.reply_to_message_id === undefined || base.reply_to_message_id === null)
    ) {
      base.reply_to_message_id = replyId;
    }

    try {
      return await original(payload, base);
    } catch (err: any) {
      const desc: string = err?.description || err?.message || "";
      if (desc.includes("message to be replied not found")) {
        const retry = { ...base };
        delete retry.reply_to_message_id;
        return await original(payload, retry);
      }
      throw err;
    }
  };
};

/**
 * Patch ctx.reply and ctx.replyWithVideo to:
 * - Default to replying to the triggering message
 * - Retry without reply_to_message_id if Telegram returns "message to be replied not found"
 */
export function patchReplyBehavior(ctx: Context): void {
  const replyId =
    ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id;

  wrapReplyMethod(ctx, "reply", (ctx as any).reply?.bind(ctx), replyId);
  wrapReplyMethod(
    ctx,
    "replyWithVideo",
    (ctx as any).replyWithVideo?.bind(ctx),
    replyId
  );
}

