import type { Context } from "grammy";
import { getRequiredTelegramIdForContext } from "../utils/context-helpers";

export type CoinflipDeps = {
  isGroupChat: (ctx: Context) => boolean;
  showInteractiveSetup: (
    ctx: Context & { message?: any },
    telegramId: bigint
  ) => Promise<void>;
  createGameViaCommand: (
    ctx: Context & { message?: any },
    args: string[],
    telegramId: bigint
  ) => Promise<void>;
};

export async function handleCoinflipCommand(
  ctx: Context & { message?: any },
  deps: CoinflipDeps
) {
  if (!deps.isGroupChat(ctx)) {
    await ctx.reply("❌ Coinflip games can only be created in groups!");
    return;
  }

  const telegramId = await getRequiredTelegramIdForContext(
    ctx,
    "coinflip command"
  );
  if (telegramId == null) {
    return;
  }
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 2) {
    await deps.showInteractiveSetup(ctx, telegramId);
    return;
  }

  await deps.createGameViaCommand(ctx, args, telegramId);
}
