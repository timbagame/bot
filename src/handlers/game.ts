import { parseGameCommandInput } from "./game-command-input";
import type { Context } from "grammy";
import { getRequiredTelegramIdForContext } from "../utils/context-helpers";

export type GameTokenOverride = {
  tokenMint: string;
  tokenTicker: string;
  tokenDecimals: number;
};

export type CoinflipDeps = {
  isGroupChat: (ctx: Context) => boolean;
  showInteractiveSetup: (
    ctx: Context & { message?: any },
    telegramId: bigint,
    tokenOverride?: GameTokenOverride,
  ) => Promise<void>;
  createGameViaCommand: (
    ctx: Context & { message?: any },
    args: string[],
    telegramId: bigint,
  ) => Promise<void>;
  resolveTokenOverride: (tokenInput: string, chatId?: number) => Promise<GameTokenOverride | null>;
};

export async function handleCoinflipCommand(ctx: Context & { message?: any }, deps: CoinflipDeps) {
  // DM games are allowed but will be forced to public visibility

  const telegramId = await getRequiredTelegramIdForContext(ctx, "coinflip command");
  if (telegramId == null) {
    return;
  }
  const args = ctx.message?.text?.trim().split(/\s+/) ?? [];
  const input = parseGameCommandInput(args.slice(1));
  if (input.mode === "menu") {
    const override = input.token
      ? await deps.resolveTokenOverride(input.token, ctx.chat?.id)
      : undefined;
    if (input.token && !override) {
      await ctx.reply("Token unavailable. Check its symbol or address.");
      return;
    }
    await deps.showInteractiveSetup(ctx, telegramId, override ?? undefined);
    return;
  }

  await deps.createGameViaCommand(ctx, args, telegramId);
}
