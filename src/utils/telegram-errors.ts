const getErrorString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const description = (value as any).description ?? (value as any).message;
  return typeof description === "string" ? description : "";
};

const normalize = (value: unknown): string => getErrorString(value).toLowerCase();

const matchesAny = (value: unknown, phrases: string[]): boolean => {
  const description = normalize(value);
  if (!description) {
    return false;
  }
  return phrases.some((phrase) => description.includes(phrase));
};

export const getErrorDescription = (error: unknown): string => getErrorString(error);

export const isMessageNotModified = (error: unknown): boolean =>
  matchesAny(error, ["message is not modified"]);

export const isMessageMissing = (error: unknown): boolean =>
  matchesAny(error, [
    "message to edit not found",
    "message to delete not found",
    "message not found",
  ]);

export const isEditProhibited = (error: unknown): boolean =>
  matchesAny(error, ["message can't be edited", "message cant be edited"]);

export const isChatInaccessible = (error: unknown): boolean =>
  matchesAny(error, ["have no access to the chat", "bot was blocked by the user"]);

export const isBotInitiationForbidden = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as any).error_code;
  if (code !== 403) {
    return false;
  }

  return (
    matchesAny(error, ["bot can't initiate conversation"]) ||
    isChatInaccessible(error)
  );
};

export const isMissingEditableContent = (error: unknown): boolean =>
  matchesAny(error, [
    "there is no text in the message to edit",
    "there is no caption in the message to edit",
  ]);

export const isDuplicateContent = (error: unknown): boolean =>
  matchesAny(error, ["message with the same content already exists"]);

export const isRateLimited = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as any).error_code;
  if (code === 429) {
    return true;
  }

  return matchesAny(error, ["too many requests", "retry after"]);
};

export const getRetryAfterSeconds = (error: unknown): number | null => {
  if (!error || typeof error !== "object") {
    return null;
  }

  const parameters = (error as any).parameters;
  const retryAfter =
    (parameters && typeof parameters.retry_after === "number"
      ? parameters.retry_after
      : undefined) ??
    (typeof (error as any).retry_after === "number"
      ? (error as any).retry_after
      : undefined);

  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return Math.max(0, retryAfter);
  }

  const description = getErrorString(error);
  const match = description.match(/retry after (\d+)/i);
  if (match && match[1]) {
    const parsed = Number.parseInt(match[1], 10);
    if (!Number.isNaN(parsed)) {
      return Math.max(0, parsed);
    }
  }

  return null;
};

export const shouldFallbackToReply = (error: unknown): boolean =>
  isMessageMissing(error) ||
  isEditProhibited(error) ||
  isChatInaccessible(error) ||
  isDuplicateContent(error) ||
  isMissingEditableContent(error);
