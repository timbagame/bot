import { parseGameCommandInput } from "./game-command-input";
import type { Context } from "grammy";
import { getRequiredTelegramIdForContext } from "../utils/context-helpers";
import {
  CHALLENGE_IN_GROUPS_MESSAGE,
  CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE,
  CHALLENGE_NEEDS_AMOUNT_MESSAGE,
  CHALLENGE_SAME_CHAT_MESSAGE,
  findChallengeName,
  namedReplyRefusal,
  resolveChallengeTarget,
  resolveNamedChallenge,
} from "../utils/game-challenge";
import type { GameChallenge } from "../utils/game-database";
import { findNamedUser, type UsernameDirectory } from "../utils/user-mention";

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
    challenge?: GameChallenge,
  ) => Promise<void>;
  resolveTokenOverride: (tokenInput: string, chatId?: number) => Promise<GameTokenOverride | null>;
  usernames: UsernameDirectory;
};

export async function handleCoinflipCommand(ctx: Context & { message?: any }, deps: CoinflipDeps) {
  // DM games are allowed but will be forced to public visibility

  const telegramId = await getRequiredTelegramIdForContext(ctx, "coinflip command");
  if (telegramId == null) {
    return;
  }
  // A coinflip that replies to no one and names someone challenges them.
  const named = findChallengeName(ctx.message);
  if (named) {
    if (!deps.isGroupChat(ctx)) {
      await ctx.reply(CHALLENGE_IN_GROUPS_MESSAGE);
      return;
    }
    if (parseGameCommandInput(named.args.slice(1)).mode === "menu") {
      await ctx.reply(CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE, { parse_mode: "HTML" });
      return;
    }
    const target = await resolveNamedChallenge(ctx, named, telegramId, deps.usernames);
    if ("refusal" in target) {
      await ctx.reply(target.refusal, { parse_mode: "HTML" });
      return;
    }
    await deps.createGameViaCommand(ctx, named.args, telegramId, target.challenge);
    return;
  }
  // A reply may also name the replied user, but no one else.
  const replyRefusal = namedReplyRefusal(ctx.message, telegramId);
  if (replyRefusal) {
    await ctx.reply(replyRefusal);
    return;
  }
  const args = findNamedUser(ctx.message)?.args ?? ctx.message?.text?.trim().split(/\s+/) ?? [];
  // Replies to another chat or forum topic name no one here, so they cannot be
  // challenges; refuse them instead of opening a game anyone could join.
  if (ctx.message?.external_reply) {
    await ctx.reply(CHALLENGE_SAME_CHAT_MESSAGE);
    return;
  }
  const input = parseGameCommandInput(args.slice(1));
  if (input.mode === "menu") {
    // The setup menu cannot carry a challenge, so ask for the amount instead of
    // opening a game anyone could join.
    if (resolveChallengeTarget(ctx.message, telegramId)) {
      await ctx.reply(CHALLENGE_NEEDS_AMOUNT_MESSAGE, { parse_mode: "HTML" });
      return;
    }
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
