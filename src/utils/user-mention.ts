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

/** A username as Telegram compares them: without the "@" and in lower case. */
export const normalizeUsername = (username: string): string =>
  username.trim().replace(/^@/, "").toLowerCase();

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

/** Someone a command names, without the command's words. */
type NamedPerson = Pick<NamedUser, "user" | "username" | "label">;

/** Who a mention entity names, or null for any other entity. */
const entityPerson = (entity: LooseEntity, text: string): NamedPerson | null => {
  const slice = entityText(entity, text);
  if (entity.type === "text_mention" && entity.user) {
    return {
      user: entity.user,
      username: entity.user.username
        ? `@${entity.user.username}`
        : slice?.startsWith("@")
          ? slice
          : null,
      label: slice && slice.trim().length > 0 ? slice : (entity.user.first_name ?? null),
    };
  }
  return entity.type === "mention" && slice ? { user: null, username: slice, label: slice } : null;
};

const isTypedName = (word: string, position: number): boolean =>
  position > 0 && word.startsWith("@") && word.length > 1;

/** The command words a name covers. The command word itself is never removed. */
const coveredPositions = ({
  index,
  length,
}: {
  index: number | null;
  length: number | null;
}): number[] => {
  const start = index ?? 0;
  const count = start >= 1 ? (length ?? 1) : 0;
  return Array.from({ length: count }, (_value, offset) => start + offset);
};

const commandWords = (message: Pick<Message, "text" | "entities"> | undefined) => {
  const text = message?.text ?? "";
  const words = text.trim().length > 0 ? text.trim().split(/\s+/) : [];
  const entities: LooseEntity[] = Array.isArray(message?.entities) ? message.entities : [];
  return { text, words, entities };
};

const remainingWords = (words: string[], removed: ReadonlySet<number>) => {
  const positions = words
    .map((_word, position) => position)
    .filter((position) => !removed.has(position));
  return { args: positions.map((position) => words[position]!), positions };
};

/**
 * Finds who a command names: a user picked from Telegram's mention list, else
 * an @username mention. Without an @username from those, the first typed word
 * starting with "@" is the one.
 */
export const findNamedUser = (
  message: Pick<Message, "text" | "entities"> | undefined,
): NamedUser | null => {
  const { text, words, entities } = commandWords(message);

  let person: NamedPerson | null = null;
  let covered: { index: number | null; length: number | null } = { index: null, length: null };

  for (const entity of entities) {
    if (!entity || typeof entity.type !== "string") {
      continue;
    }
    person = entityPerson(entity, text);
    if (person) {
      covered = entityWords(entity, text);
      break;
    }
  }

  if (!person) {
    const index = words.findIndex(isTypedName);
    if (index !== -1) {
      person = { user: null, username: words[index]!, label: null };
      covered = { index, length: 1 };
    }
  }

  if (!person) {
    return null;
  }

  return { ...person, ...remainingWords(words, new Set(coveredPositions(covered))) };
};

/** Everyone a command names, in the order they appear, and the words left. */
export type NamedUsers = Pick<NamedUser, "args" | "positions"> & { users: NamedPerson[] };

type Span = { start: number; end: number };

/**
 * The characters an entity covers, or null when it cannot be placed. Without a
 * usable length it covers the word it starts in.
 */
const entityRange = (entity: LooseEntity, words: readonly Span[]): Span | null => {
  if (typeof entity.offset !== "number" || entity.offset < 0) {
    return null;
  }
  const start = entity.offset;
  if (typeof entity.length === "number" && entity.length > 0) {
    return { start, end: start + entity.length };
  }
  const word = words.find((span) => span.start <= start && start < span.end);
  return word ? { start, end: word.end } : null;
};

/**
 * Finds everyone a command names: users picked from Telegram's mention list,
 * @username mentions and every other typed word starting with "@". A word may
 * hold several names ("@ana,@bob"), so mentions are matched by the characters
 * they cover, and the rest of a word that names someone must be typed names
 * too: anything else ("@ana,usdc") makes the whole word a name no one has,
 * never a word quietly dropped.
 */
export const findNamedUsers = (
  message: Pick<Message, "text" | "entities"> | undefined,
): NamedUsers | null => {
  const { text, words, entities } = commandWords(message);
  const spans = [...text.matchAll(/\S+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const found: { person: NamedPerson; position: number }[] = [];
  const marked = new Set<number>();

  for (const entity of entities) {
    const person = entity && typeof entity.type === "string" ? entityPerson(entity, text) : null;
    if (!person) {
      continue;
    }
    const range = entityRange(entity, spans);
    const first = range
      ? spans.findIndex((span) => span.start < range.end && span.end > range.start)
      : -1;
    // Someone who cannot be placed goes last and keeps every word.
    found.push({ person, position: first === -1 ? words.length : first });
    if (range) {
      for (let index = range.start; index < Math.min(range.end, text.length); index += 1) {
        marked.add(index);
      }
    }
  }

  const removed = new Set<number>();
  spans.forEach((span, position) => {
    const word = words[position]!;
    let unmarked = "";
    for (let index = span.start; index < span.end; index += 1) {
      unmarked += marked.has(index) ? " " : text.charAt(index);
    }
    const mentioned = unmarked !== word;
    if (position === 0 || (!mentioned && !isTypedName(word, position))) {
      return;
    }
    const rest = unmarked
      .split(/[^\p{L}\p{N}_@]+/u)
      .filter((piece) => piece !== "" && piece !== "@");
    const typed = rest.every((piece) => piece.startsWith("@")) ? rest : [word];
    for (const username of typed) {
      found.push({ person: { user: null, username, label: null }, position });
    }
    removed.add(position);
  });
  if (found.length === 0) {
    return null;
  }

  return {
    users: found.sort((left, right) => left.position - right.position).map(({ person }) => person),
    ...remainingWords(words, removed),
  };
};

/**
 * Resolves who a command names to a Telegram account, refusing the sender and
 * bots. A typed username must still belong to the account Telegram returns.
 */
export const resolveNamedUser = async (
  ctx: Context,
  named: Pick<NamedUser, "user" | "username">,
  senderId: bigint,
  directory: UsernameDirectory,
): Promise<MentionedUser> => {
  let resolvedId: string;
  if (named.user) {
    resolvedId = String(named.user.id);
  } else {
    // Whoever is named without a picked user always has a username.
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
    if (!member.username || normalizeUsername(member.username) !== normalizeUsername(username)) {
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
