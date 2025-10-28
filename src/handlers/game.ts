import type { Context } from "grammy";
import { requireTelegramId, MissingTelegramIdError } from "../utils/context-helpers";

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

  let telegramId: bigint;
  try {
    telegramId = requireTelegramId(ctx, "coinflip command");
  } catch (error) {
    if (error instanceof MissingTelegramIdError) {
      await ctx.reply(
        "❌ Unable to resolve your Telegram identity. Please open a direct chat with the bot and try again."
      );
      return;
    }
    throw error;
  }
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 2) {
    await deps.showInteractiveSetup(ctx, telegramId);
    return;
  }

  await deps.createGameViaCommand(ctx, args, telegramId);
}
