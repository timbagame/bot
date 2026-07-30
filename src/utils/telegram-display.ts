const ZERO_WIDTH_WORD_JOINER = "\u2060";
const DEFAULT_FALLBACK_NAME = "Player";

type SanitizeOptions = {
  preventMention?: boolean;
};

export const sanitizeTelegramDisplayName = (
  value: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK_NAME,
  options?: SanitizeOptions,
): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const normalized = trimmed.length > 0 ? trimmed : fallback;

  if (!options?.preventMention || !normalized.includes("@")) {
    return normalized;
  }

  return normalized.replace(/@+/g, (match) => `${match}${ZERO_WIDTH_WORD_JOINER}`);
};

export const sanitizeTelegramDisplayNameWithoutMention = (
  value: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK_NAME,
): string => sanitizeTelegramDisplayName(value, fallback, { preventMention: true });

export const getTelegramUserDisplayName = (
  user:
    | {
        username?: string;
        first_name?: string;
        last_name?: string;
      }
    | null
    | undefined,
  fallback: string = "User",
): string => {
  const username = user?.username?.trim().replace(/^@+/, "");
  if (username) return `@${username}`;

  const fullName = [user?.first_name, user?.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return sanitizeTelegramDisplayName(fullName, fallback);
};
