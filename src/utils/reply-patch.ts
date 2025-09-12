import type { Context } from "grammy";

/**
 * Patch ctx.reply and ctx.replyWithVideo to:
 * - Default to replying to the triggering message
 * - Retry without reply_to_message_id if Telegram returns "message to be replied not found"
 */
export function patchReplyBehavior(ctx: Context): void {
  const replyId = ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id;

  const origReply = (ctx as any).reply?.bind(ctx);
  if (origReply) {
    (ctx as any).reply = async (text: string, other?: any) => {
      const base = other ?? {};
      if (replyId && (base.reply_to_message_id === undefined || base.reply_to_message_id === null)) {
        base.reply_to_message_id = replyId;
      }
      try {
        return await origReply(text, base);
      } catch (err: any) {
        const desc: string = err?.description || err?.message || "";
        if (desc.includes("message to be replied not found")) {
          const retry = { ...base };
          delete retry.reply_to_message_id;
          return await origReply(text, retry);
        }
        throw err;
      }
    };
  }

  const origReplyWithVideo = (ctx as any).replyWithVideo?.bind(ctx);
  if (origReplyWithVideo) {
    (ctx as any).replyWithVideo = async (video: any, other?: any) => {
      const base = other ?? {};
      if (replyId && (base.reply_to_message_id === undefined || base.reply_to_message_id === null)) {
        base.reply_to_message_id = replyId;
      }
      try {
        return await origReplyWithVideo(video, base);
      } catch (err: any) {
        const desc: string = err?.description || err?.message || "";
        if (desc.includes("message to be replied not found")) {
          const retry = { ...base };
          delete retry.reply_to_message_id;
          return await origReplyWithVideo(video, retry);
        }
        throw err;
      }
    };
  }
}

