import type { Context, NextFunction } from "grammy";
import { safeAnswerCallbackQuery } from "./context-helpers";

const DEFAULT_MAX_CALLBACK_AGE_SEC = 24 * 60 * 60; // 24 hours
const DEFAULT_MAX_MESSAGE_AGE_SEC = 60; // 1 minute

export function shouldDropUpdate(
  updateUnixSec: number,
  nowUnixSec: number,
  maxAgeSec: number = DEFAULT_MAX_CALLBACK_AGE_SEC,
): boolean {
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

function resolveMaxAgeSec(ctx: Context): number {
  const legacyOverride = process.env["MAX_UPDATE_AGE_SEC"];
  if (legacyOverride) {
    const parsed = Number(legacyOverride);
    if (!Number.isNaN(parsed)) return parsed;
  }

  const isCallback = Boolean((ctx as any).callbackQuery);
  const envKey = isCallback ? "MAX_CALLBACK_AGE_SEC" : "MAX_MESSAGE_AGE_SEC";
  const envValue = process.env[envKey];
  if (envValue) {
    const parsed = Number(envValue);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return isCallback ? DEFAULT_MAX_CALLBACK_AGE_SEC : DEFAULT_MAX_MESSAGE_AGE_SEC;
}

export async function recentUpdateGuard(ctx: Context, next: NextFunction) {
  // Allow game actions to work for the full game lifetime.
  // These callbacks are safe to process even for older messages because
  // we validate game status on-chain and in the DB in their handlers.
  const cbData = (ctx as any).callbackQuery?.data as string | undefined;
  if (cbData && (cbData.startsWith("join_") || cbData.startsWith("refresh_"))) {
    return next();
  }
  const updateUnix = getUpdateUnixSeconds(ctx);
  if (!updateUnix) return next();
  const nowSec = Math.floor(Date.now() / 1000);
  const maxAgeSec = resolveMaxAgeSec(ctx);
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
