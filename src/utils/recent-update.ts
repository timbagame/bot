import type { Context, NextFunction } from "grammy";
import { safeAnswerCallbackQuery } from "./context-helpers";

const DEFAULT_MAX_AGE_SEC = 600; // 10 minutes

export function shouldDropUpdate(updateUnixSec: number, nowUnixSec: number, maxAgeSec: number = DEFAULT_MAX_AGE_SEC): boolean {
  return nowUnixSec - updateUnixSec > maxAgeSec;
}

function getUpdateUnixSeconds(ctx: Context): number | null {
  if ((ctx as any).message?.date) return (ctx as any).message.date as number;
  if ((ctx as any).editedMessage?.edit_date) return (ctx as any).editedMessage.edit_date as number;
  if ((ctx as any).channelPost?.date) return (ctx as any).channelPost.date as number;
  if ((ctx as any).editedChannelPost?.edit_date) return (ctx as any).editedChannelPost.edit_date as number;
  if ((ctx as any).callbackQuery?.message?.date) return (ctx as any).callbackQuery.message.date as number;
  return null;
}

export async function recentUpdateGuard(ctx: Context, next: NextFunction) {
  // Allow game actions to work for the full game lifetime.
  // These callbacks are safe to process even for older messages because
  // we validate game status on-chain and in the DB in their handlers.
  const cbData = (ctx as any).callbackQuery?.data as string | undefined;
  if (cbData && (cbData.startsWith("join_") || cbData.startsWith("refresh_"))) {
    return next();
  }
  const envVal = process.env["MAX_UPDATE_AGE_SEC"];
  const maxAgeSec = envVal ? Number(envVal) : DEFAULT_MAX_AGE_SEC;
  const updateUnix = getUpdateUnixSeconds(ctx);
  if (!updateUnix) return next();
  const nowSec = Math.floor(Date.now() / 1000);
  if (shouldDropUpdate(updateUnix, nowSec, maxAgeSec)) {
    if (ctx.callbackQuery) {
      try {
        await safeAnswerCallbackQuery(
          ctx,
          "⏱️ This action expired. Please open a new menu."
        );
      } catch {}
    }
    return; // drop silently for old messages
  }
  await next();
}
