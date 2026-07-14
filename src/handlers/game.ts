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
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 2) {
    await deps.showInteractiveSetup(ctx, telegramId);
    return;
  }

  if (args.length === 2) {
    const tokenCandidate = args[1]?.trim();
    if (tokenCandidate && !/^[0-9]+(?:\.[0-9]+)?$/.test(tokenCandidate)) {
      const override = await deps.resolveTokenOverride(tokenCandidate, ctx.chat?.id);
      if (override) {
        await deps.showInteractiveSetup(ctx, telegramId, override);
        return;
      }
    }
  }

  await deps.createGameViaCommand(ctx, args, telegramId);
}
