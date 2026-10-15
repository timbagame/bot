import type { Context } from "grammy";
import type { Message, User } from "grammy/types";
import type { GameChallenge } from "./game-database";
import { escapeHtml } from "./format-amount";
import { getTelegramUserDisplayName } from "./telegram-display";
import {
  findNamedUser,
  resolveNamedUser,
  usernameVerificationFailedMessage,
  type NamedUser,
  type UsernameDirectory,
} from "./user-mention";

/** A challenge is one on one, whatever player count the command asked for. */
export const CHALLENGE_PLAYERS = 2;

/**
 * A coinflip sent as a reply to someone's message challenges that person.
 * Replies to bots, channels, anonymous admins or one's own message are not challenges.
 */
export const resolveChallengeTarget = (
  message: Pick<Message, "reply_to_message"> | undefined,
  creatorTelegramId: bigint,
): GameChallenge | null => {
  const replied = message?.reply_to_message;
  // In forum topics every message replies to the topic's opening service message.
  if (!replied?.from || replied.forum_topic_created || replied.sender_chat) return null;
  if (replied.from.is_bot || BigInt(replied.from.id) === creatorTelegramId) return null;
  return {
    telegramId: String(replied.from.id),
    displayName: getTelegramUserDisplayName(replied.from, "Player"),
  };
};

/**
 * Who a coinflip that replies to no one names. The opening message of a forum
 * topic, which every message there answers, is no reply.
 */
export const findChallengeName = (
  message: Pick<Message, "text" | "entities" | "reply_to_message"> | undefined,
): NamedUser | null => {
  const replied = message?.reply_to_message;
  return replied?.from && !replied.forum_topic_created ? null : findNamedUser(message);
};

const unknownNameMessage = (username: string): string =>
  `I don't know who <code>${escapeHtml(username)}</code> is. Reply to one of their messages to challenge them.`;

const CHALLENGE_SELF_MESSAGE = "You can't challenge yourself.";
const CHALLENGE_BOT_MESSAGE = "You can't challenge a bot.";

export const CHALLENGE_REPLY_OR_NAME_MESSAGE =
  "To challenge someone, reply to their message or name them without replying.";

const namesUser = (named: NamedUser, user: User): boolean =>
  named.user
    ? named.user.id === user.id
    : !!user.username &&
      named.username?.replace(/^@/, "").toLowerCase() === user.username.toLowerCase();

/**
 * Why a coinflip that replies to someone and also names someone cannot open, or
 * null. Naming anyone but the replied user would otherwise be silently dropped.
 */
export const namedReplyRefusal = (
  message: Pick<Message, "text" | "entities" | "reply_to_message"> | undefined,
  creatorTelegramId: bigint,
): string | null => {
  const replied = message?.reply_to_message;
  const named = findNamedUser(message);
  if (!replied?.from || replied.forum_topic_created || !named) return null;
  if (replied.sender_chat) return CHALLENGE_REPLY_OR_NAME_MESSAGE;
  if (replied.from.is_bot) return CHALLENGE_BOT_MESSAGE;
  if (BigInt(replied.from.id) === creatorTelegramId) return CHALLENGE_SELF_MESSAGE;
  return namesUser(named, replied.from) ? null : CHALLENGE_REPLY_OR_NAME_MESSAGE;
};

/** Who a coinflip naming someone challenges, or the HTML reply refusing it. */
export type NamedChallenge = { challenge: GameChallenge } | { refusal: string };

/**
 * A coinflip that names someone challenges them, found as /tip finds them.
 * Unlike a reply, naming oneself or a bot is refused: the challenge was asked
 * for explicitly.
 */
export const resolveNamedChallenge = async (
  ctx: Context,
  named: NamedUser,
  creatorTelegramId: bigint,
  directory: UsernameDirectory,
): Promise<NamedChallenge> => {
  const mentioned = await resolveNamedUser(ctx, named, creatorTelegramId, directory);
  switch (mentioned.kind) {
    case "user":
      return {
        challenge: {
          telegramId: String(mentioned.telegramId),
          displayName: getTelegramUserDisplayName(mentioned.user, named.username ?? "Player"),
        },
      };
    case "unknown":
      return { refusal: unknownNameMessage(mentioned.username) };
    case "verification_failed":
      return { refusal: usernameVerificationFailedMessage(mentioned.username) };
    case "lookup_failed":
      console.error("Failed to look up the challenged user:", mentioned.error);
      return {
        refusal: `I couldn't look up <code>${escapeHtml(mentioned.username)}</code>. Try again, or reply to one of their messages.`,
      };
    case "unusable_id":
      return {
        refusal: "I couldn't tell who that is. Reply to one of their messages to challenge them.",
      };
    case "self":
      return { refusal: CHALLENGE_SELF_MESSAGE };
    case "bot":
      return { refusal: CHALLENGE_BOT_MESSAGE };
  }
};

/** Plain text: callback answers do not render HTML. */
export const challengeForSomeoneElseMessage = (challenge: GameChallenge): string =>
  `This challenge is for ${challenge.displayName}.`;

export const CHALLENGE_NEEDS_AMOUNT_MESSAGE =
  "To challenge someone, reply to their message with <code>/cf &lt;amount&gt; [TOKEN]</code>.";

export const CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE =
  "To challenge someone by name, use <code>/cf &lt;amount&gt; [TOKEN] @username</code>.";

export const CHALLENGE_SAME_CHAT_MESSAGE =
  "To challenge someone, reply to their message in this chat and topic.";

export const CHALLENGE_IN_GROUPS_MESSAGE = "Challenges only work in groups.";

export const CHALLENGE_JOIN_LABEL = "⚔️ Accept";
