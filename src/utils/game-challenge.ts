import type { Context } from "grammy";
import type { Message, User } from "grammy/types";
import type { ChallengedPlayer } from "./game-database";
import { escapeHtml } from "./format-amount";
import { formatNameList } from "./game-ui";
import { getTelegramUserDisplayName } from "./telegram-display";
import {
  findNamedUsers,
  normalizeUsername,
  resolveNamedUser,
  usernameVerificationFailedMessage,
  type NamedUser,
  type NamedUsers,
  type UsernameDirectory,
} from "./user-mention";

/**
 * A coinflip sent as a reply to someone's message challenges that person.
 * Replies to bots, channels, anonymous admins or one's own message are not challenges.
 */
export const resolveChallengeTarget = (
  message: Pick<Message, "reply_to_message"> | undefined,
  creatorTelegramId: bigint,
): ChallengedPlayer | null => {
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
export const findChallengeNames = (
  message: Pick<Message, "text" | "entities" | "reply_to_message"> | undefined,
): NamedUsers | null => {
  const replied = message?.reply_to_message;
  return replied?.from && !replied.forum_topic_created ? null : findNamedUsers(message);
};

const unknownNameMessage = (username: string): string =>
  `I don't know who <code>${escapeHtml(username)}</code> is. Reply to one of their messages to challenge them.`;

// A reply challenges only the person it answers, so a challenge naming several
// people cannot be fixed by replying: whoever the bot could not find has to
// reach it once, which saves their username.
const USE_THE_BOT_FIRST = "Ask them to use the bot here, then try again.";

const CHALLENGE_SELF_MESSAGE = "You can't challenge yourself.";
const CHALLENGE_BOT_MESSAGE = "You can't challenge a bot.";

export const CHALLENGE_REPLY_OR_NAME_MESSAGE =
  "To challenge someone, reply to their message or name them without replying.";

const namesUser = (named: Pick<NamedUser, "user" | "username">, user: User): boolean =>
  named.user
    ? named.user.id === user.id
    : !!user.username &&
      !!named.username &&
      normalizeUsername(named.username) === normalizeUsername(user.username);

/**
 * Why a coinflip that replies to someone and also names someone cannot open, or
 * null. Naming anyone but the replied user would otherwise be silently dropped:
 * a reply challenges only the person it answers.
 */
export const namedReplyRefusal = (
  message: Pick<Message, "text" | "entities" | "reply_to_message"> | undefined,
  creatorTelegramId: bigint,
): string | null => {
  const replied = message?.reply_to_message;
  const named = findNamedUsers(message);
  if (!replied?.from || replied.forum_topic_created || !named) return null;
  if (replied.sender_chat) return CHALLENGE_REPLY_OR_NAME_MESSAGE;
  if (replied.from.is_bot) return CHALLENGE_BOT_MESSAGE;
  if (BigInt(replied.from.id) === creatorTelegramId) return CHALLENGE_SELF_MESSAGE;
  const repliedUser = replied.from;
  return named.users.every((user) => namesUser(user, repliedUser))
    ? null
    : CHALLENGE_REPLY_OR_NAME_MESSAGE;
};

/** Who a coinflip naming someone challenges, or the HTML reply refusing it. */
export type NamedChallenge = { challenge: ChallengedPlayer } | { refusal: string };

/**
 * A coinflip that names someone challenges them, found as /tip finds them.
 * Unlike a reply, naming oneself or a bot is refused: the challenge was asked
 * for explicitly. With `several`, the challenge names other people too, so no
 * refusal suggests replying.
 */
export const resolveNamedChallenge = async (
  ctx: Context,
  named: Pick<NamedUser, "user" | "username">,
  creatorTelegramId: bigint,
  directory: UsernameDirectory,
  several = false,
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
      return {
        refusal: several
          ? `I don't know who <code>${escapeHtml(mentioned.username)}</code> is yet. ${USE_THE_BOT_FIRST}`
          : unknownNameMessage(mentioned.username),
      };
    case "verification_failed":
      return {
        refusal: several
          ? `I couldn't verify <code>${escapeHtml(mentioned.username)}</code>. ${USE_THE_BOT_FIRST}`
          : usernameVerificationFailedMessage(mentioned.username),
      };
    case "lookup_failed":
      console.error("Failed to look up the challenged user:", mentioned.error);
      return {
        refusal: several
          ? `I couldn't look up <code>${escapeHtml(mentioned.username)}</code>. Try again.`
          : `I couldn't look up <code>${escapeHtml(mentioned.username)}</code>. Try again, or reply to one of their messages.`,
      };
    case "unusable_id":
      return {
        refusal: several
          ? `I couldn't tell who one of them is. ${USE_THE_BOT_FIRST}`
          : "I couldn't tell who that is. Reply to one of their messages to challenge them.",
      };
    case "self":
      return { refusal: CHALLENGE_SELF_MESSAGE };
    case "bot":
      return { refusal: CHALLENGE_BOT_MESSAGE };
  }
};

/** Everyone a coinflip naming people challenges, or the HTML reply refusing it. */
export type NamedChallenges = { challenge: ChallengedPlayer[] } | { refusal: string };

/** Few enough that the card, which mentions each of them, stays well within Telegram's limit. */
export const CHALLENGE_MAX_PEOPLE = 5;

const tooManyChallengedMessage = (maxChallenged: number): string =>
  `You can challenge up to ${maxChallenged} ${maxChallenged === 1 ? "person" : "people"} at once.`;

// Someone picked from Telegram's list and the same username typed are one person.
const nameKey = (named: Pick<NamedUser, "user" | "username">): string => {
  const username = named.user ? named.user.username : named.username;
  return username ? `@${normalizeUsername(username)}` : `id ${named.user?.id}`;
};

/**
 * A coinflip that names people challenges each of them, found one by one as
 * resolveNamedChallenge finds them. Any refusal refuses the whole challenge,
 * and someone named twice is challenged once.
 */
export const resolveNamedChallenges = async (
  ctx: Context,
  named: NamedUsers,
  creatorTelegramId: bigint,
  directory: UsernameDirectory,
  maxChallenged: number,
): Promise<NamedChallenges> => {
  // The same name typed twice is looked up and counted once.
  const keys = new Set<string>();
  const users = named.users.filter((user) => {
    const key = nameKey(user);
    const isNew = !keys.has(key);
    keys.add(key);
    return isNew;
  });
  // Counted before any lookup, so a long list costs no Telegram calls.
  if (users.length > maxChallenged) {
    return { refusal: tooManyChallengedMessage(maxChallenged) };
  }
  const challenge: ChallengedPlayer[] = [];
  for (const user of users) {
    const target = await resolveNamedChallenge(
      ctx,
      user,
      creatorTelegramId,
      directory,
      users.length > 1,
    );
    if ("refusal" in target) return target;
    if (!challenge.some((player) => player.telegramId === target.challenge.telegramId)) {
      challenge.push(target.challenge);
    }
  }
  return { challenge };
};

/** Whether a game's challenge keeps this player out; other games keep no one out. */
export const challengeKeepsOut = (
  challenge: readonly ChallengedPlayer[],
  telegramId: bigint,
): boolean =>
  challenge.length > 0 && !challenge.some((player) => player.telegramId === telegramId.toString());

// Telegram shows no callback answer longer than this.
const CALLBACK_ANSWER_CHAR_LIMIT = 200;

/** Plain text: callback answers do not render HTML. Names that do not fit are left out. */
export const challengeForSomeoneElseMessage = (challenge: readonly ChallengedPlayer[]): string => {
  const named = `This challenge is for ${formatNameList(challenge.map((player) => player.displayName))}.`;
  return named.length <= CALLBACK_ANSWER_CHAR_LIMIT ? named : "This challenge isn't for you.";
};

export const CHALLENGE_NEEDS_AMOUNT_MESSAGE =
  "To challenge someone, reply to their message with <code>/cf &lt;amount&gt; [TOKEN]</code>.";

export const CHALLENGE_NAMED_NEEDS_AMOUNT_MESSAGE =
  "To challenge someone by name, use <code>/cf &lt;amount&gt; [TOKEN] @username</code>.";

export const CHALLENGE_SAME_CHAT_MESSAGE =
  "To challenge someone, reply to their message in this chat and topic.";

export const CHALLENGE_IN_GROUPS_MESSAGE = "Challenges only work in groups.";

export const CHALLENGE_JOIN_LABEL = "⚔️ Accept";
