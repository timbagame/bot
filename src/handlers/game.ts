import { parseGameCommandInput } from "./game-command-input";
import type { Context } from "grammy";
import { getRequiredTelegramIdForContext, replyEphemeralToSender } from "../utils/context-helpers";
import {
  CHALLENGE_IN_GROUPS_MESSAGE,
  CHALLENGE_MAX_PEOPLE,
  CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE,
  CHALLENGE_NEEDS_AMOUNT_MESSAGE,
  CHALLENGE_SAME_CHAT_MESSAGE,
  findChallengeNames,
  namedReplyRefusal,
  resolveChallengeTarget,
  resolveNamedChallenges,
} from "../utils/game-challenge";
import type { ChallengedPlayer } from "../utils/game-database";
import { findNamedUsers, type UsernameDirectory } from "../utils/user-mention";

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
    challenge?: ChallengedPlayer[],
  ) => Promise<void>;
  resolveTokenOverride: (tokenInput: string, chatId?: number) => Promise<GameTokenOverride | null>;
  usernames: UsernameDirectory;
  /** The most players a coinflip can have, its creator included. */
  getMaxPlayers: () => number;
};

export async function handleCoinflipCommand(ctx: Context & { message?: any }, deps: CoinflipDeps) {
  // DM games are allowed but will be forced to public visibility

  const telegramId = await getRequiredTelegramIdForContext(ctx, "coinflip command");
  if (telegramId == null) {
    return;
  }
  // A coinflip that replies to no one and names people challenges them.
  const named = findChallengeNames(ctx.message);
  if (named) {
    if (!deps.isGroupChat(ctx)) {
      await ctx.reply(CHALLENGE_IN_GROUPS_MESSAGE);
      return;
    }
    if (parseGameCommandInput(named.args.slice(1)).mode === "menu") {
      await replyEphemeralToSender(ctx, CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE, {
        parse_mode: "HTML",
      });
      return;
    }
    const target = await resolveNamedChallenges(
      ctx,
      named,
      telegramId,
      deps.usernames,
      Math.min(CHALLENGE_MAX_PEOPLE, deps.getMaxPlayers() - 1),
    );
    if ("refusal" in target) {
      await replyEphemeralToSender(ctx, target.refusal, { parse_mode: "HTML" });
      return;
    }
    await deps.createGameViaCommand(ctx, named.args, telegramId, target.challenge);
    return;
  }
  // A reply may also name the replied user, but no one else.
  const replyRefusal = namedReplyRefusal(ctx.message, telegramId);
  if (replyRefusal) {
    await replyEphemeralToSender(ctx, replyRefusal);
    return;
  }
  const args = findNamedUsers(ctx.message)?.args ?? ctx.message?.text?.trim().split(/\s+/) ?? [];
  // Replies to another chat or forum topic name no one here, so they cannot be
  // challenges; refuse them instead of opening a game anyone could join.
  if (ctx.message?.external_reply) {
    await replyEphemeralToSender(ctx, CHALLENGE_SAME_CHAT_MESSAGE);
    return;
  }
  const input = parseGameCommandInput(args.slice(1));
  if (input.mode === "menu") {
    // The setup menu cannot carry a challenge, so ask for the amount instead of
    // opening a game anyone could join.
    if (resolveChallengeTarget(ctx.message, telegramId)) {
      await replyEphemeralToSender(ctx, CHALLENGE_NEEDS_AMOUNT_MESSAGE, { parse_mode: "HTML" });
      return;
    }
    const override = input.token
      ? await deps.resolveTokenOverride(input.token, ctx.chat?.id)
      : undefined;
    if (input.token && !override) {
      await replyEphemeralToSender(ctx, "Token unavailable. Check its symbol or address.");
      return;
    }
    await deps.showInteractiveSetup(ctx, telegramId, override ?? undefined);
    return;
  }

  await deps.createGameViaCommand(ctx, args, telegramId);
}
