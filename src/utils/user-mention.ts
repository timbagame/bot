import type { Context } from "grammy";
import type { Message, User } from "grammy/types";
import { escapeHtml } from "./format-amount";

/** Someone a command names instead of replying to one of their messages. */
export type NamedUser = {
  /** Sent by Telegram when they were picked from the mention list. */
  user: User | null;
  /** The picked user's @username, else the one marked or typed; looked up when no one was picked. */
  username: string | null;
  /** The mention's text, or the picked user's first name. */
  label: string | null;
  /** The command's words without the ones that name them. */
  args: string[];
  /** Where each of those words sits among the command's words. */
  positions: number[];
};

/** Looks people up by the usernames the bot has seen. Reading may throw. */
export type UsernameDirectory = {
  findTelegramIdByUsername: (username: string) => string | null | undefined;
  invalidateUsernameMapping?: (username: string, telegramId: string) => void;
};

export const usernameVerificationFailedMessage = (username: string): string =>
  `I couldn't verify <code>${escapeHtml(username)}</code>. Reply to their message or pick them from Telegram's mention list.`;

export type MentionedUser =
  | {
      kind: "user";
      /** The id as picked or stored. */
      id: string;
      telegramId: bigint;
      /** Telegram's details, from the mention or the chat member lookup. */
      user: User | null;
      /** Telegram's chat member details, when it answered. */
      member: User | null;
    }
  | { kind: "unknown"; username: string }
  /** Reading the usernames failed, which says nothing about whether they exist. */
  | { kind: "lookup_failed"; username: string; error: unknown }
  | { kind: "verification_failed"; username: string }
  | { kind: "unusable_id" }
  | { kind: "self" }
  | { kind: "bot" };

type LooseEntity = { type?: unknown; offset?: unknown; length?: unknown; user?: User };

/** Which command words an entity covers: the first one and how many. */
const entityWords = (
  entity: LooseEntity,
  text: string,
): { index: number | null; length: number | null } => {
  if (typeof entity.offset !== "number" || entity.offset < 0) {
    return { index: null, length: null };
  }

  const trimmedBefore = text.slice(0, entity.offset).trim();
  const index = trimmedBefore.length === 0 ? 0 : trimmedBefore.split(/\s+/).length;

  if (typeof entity.length !== "number" || entity.length <= 0) {
    return { index, length: null };
  }

  const words = text
    .slice(entity.offset, entity.offset + entity.length)
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  return { index, length: words.length > 0 ? words.length : null };
};

const entityText = (entity: LooseEntity, text: string): string | null =>
  typeof entity.offset === "number" && typeof entity.length === "number"
    ? text.slice(entity.offset, entity.offset + entity.length)
    : null;

/**
 * Finds who a command names: a user picked from Telegram's mention list, else
 * an @username mention. Without an @username from those, the first typed word
 * starting with "@" is the one.
 */
export const findNamedUser = (
  message: Pick<Message, "text" | "entities"> | undefined,
): NamedUser | null => {
  const text = message?.text ?? "";
  const words = text.trim().length > 0 ? text.trim().split(/\s+/) : [];
  const entities: LooseEntity[] = Array.isArray(message?.entities) ? message.entities : [];

  let user: User | null = null;
  let username: string | null = null;
  let label: string | null = null;
  let covered: { index: number | null; length: number | null } = { index: null, length: null };

  for (const entity of entities) {
    if (!entity || typeof entity.type !== "string") {
      continue;
    }

    if (entity.type === "text_mention" && entity.user) {
      user = entity.user;
      const slice = entityText(entity, text);
      if (entity.user.username) {
        username = `@${entity.user.username}`;
      } else if (slice?.startsWith("@")) {
        username = slice;
      }
      label = slice && slice.trim().length > 0 ? slice : (entity.user.first_name ?? null);
      covered = entityWords(entity, text);
      break;
    }

    if (entity.type === "mention") {
      const slice = entityText(entity, text);
      if (slice) {
        username = slice;
        label = slice;
        covered = entityWords(entity, text);
        break;
      }
    }
  }

  if (!user && !username) {
    const index = words.findIndex(
      (word, position) => position > 0 && word.startsWith("@") && word.length > 1,
    );
    if (index !== -1) {
      username = words[index]!;
      covered = { index, length: 1 };
    }
  }

  if (!user && !username) {
    return null;
  }

  // The command word itself is never removed.
  const start = covered.index ?? 0;
  const count = start >= 1 ? (covered.length ?? 1) : 0;
  const positions = words
    .map((_word, position) => position)
    .filter((position) => position < start || position >= start + count);

  return {
    user,
    username,
    label,
    args: positions.map((position) => words[position]!),
    positions,
  };
};

/**
 * Resolves who a command names to a Telegram account, refusing the sender and
 * bots. A typed username must still belong to the account Telegram returns.
 */
export const resolveNamedUser = async (
  ctx: Context,
  named: NamedUser,
  senderId: bigint,
  directory: UsernameDirectory,
): Promise<MentionedUser> => {
  let resolvedId: string;
  if (named.user) {
    resolvedId = String(named.user.id);
  } else {
    // findNamedUser always sets a username when there is no user.
    const username = named.username!;
    let found: string | null | undefined;
    try {
      found = directory.findTelegramIdByUsername(username);
    } catch (error) {
      return { kind: "lookup_failed", username, error };
    }
    if (!found) {
      return { kind: "unknown", username };
    }
    resolvedId = found;
  }

  if (typeof resolvedId !== "string" || !/^\d+$/.test(resolvedId)) return { kind: "unusable_id" };
  const telegramId = BigInt(resolvedId);
  if (telegramId <= 0n) return { kind: "unusable_id" };

  if (telegramId === senderId) {
    return { kind: "self" };
  }

  let isBot = named.user?.is_bot === true;
  let member: User | null = null;
  const chatId = ctx.chat?.id;
  if (!isBot && chatId && typeof ctx.api?.getChatMember === "function") {
    const candidate = Number(resolvedId);
    if (Number.isSafeInteger(candidate)) {
      try {
        member = (await ctx.api.getChatMember(chatId, candidate))?.user ?? null;
      } catch {
        // A picked user carries a Telegram ID; a typed username must be verified below.
      }
    }
  }
  if (member?.is_bot) {
    isBot = true;
  }
  if (isBot) {
    return { kind: "bot" };
  }

  if (!named.user) {
    const username = named.username!;
    if (!member || String(member.id) !== resolvedId) {
      return { kind: "verification_failed", username };
    }
    const requested = username.trim().replace(/^@/, "").toLowerCase();
    if (!member.username || member.username.toLowerCase() !== requested) {
      try {
        directory.invalidateUsernameMapping?.(username, resolvedId);
      } catch (error) {
        return { kind: "lookup_failed", username, error };
      }
      return { kind: "verification_failed", username };
    }
  }

  return { kind: "user", id: resolvedId, telegramId, user: named.user ?? member, member };
};

/**
 * Swaps one word of a command's text, moving the entities after it so a
 * mention still covers its words.
 */
export const replaceCommandWord = <T extends Pick<Message, "text" | "entities">>(
  message: T,
  index: number,
  value: string,
): T => {
  const text = message.text ?? "";
  const word = [...text.matchAll(/\S+/g)][index]!;
  const end = word.index + word[0].length;
  const shift = value.length - word[0].length;
  return {
    ...message,
    text: text.slice(0, word.index) + value + text.slice(end),
    entities: message.entities?.map((entity) =>
      entity.offset >= end ? { ...entity, offset: entity.offset + shift } : entity,
    ),
  };
};
