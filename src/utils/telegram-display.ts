const ZERO_WIDTH_WORD_JOINER = "\u2060";
const DEFAULT_FALLBACK_NAME = "Player";

export const sanitizeTelegramDisplayName = (
  value: string | null | undefined,
  fallback: string = DEFAULT_FALLBACK_NAME
): string => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const normalized = trimmed.length > 0 ? trimmed : fallback;
  if (!normalized.includes("@")) {
    return normalized;
  }
  return normalized.replace(/@+/g, (match) => `${match}${ZERO_WIDTH_WORD_JOINER}`);
};
