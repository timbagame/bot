/**
 * Shared helpers for working with Telegram error objects.
 */

const extractDescription = (error: unknown): unknown => {
  if (!error || typeof error !== "object") {
    return "";
  }

  const description = (error as any).description ?? (error as any).message;
  return description;
};

export const getTelegramErrorDescription = (error: unknown): string => {
  const description = extractDescription(error);
  return typeof description === "string" ? description : "";
};

export const isTooManyRequestsError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }

  if ((error as any).error_code === 429) {
    return true;
  }

  const description = getTelegramErrorDescription(error);
  if (!description) {
    return false;
  }

  return description.toLowerCase().includes("too many requests");
};

export const parseRetryAfterSeconds = (error: unknown): number => {
  if (!error || typeof error !== "object") {
    return 1;
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

  const description = getTelegramErrorDescription(error);
  if (description) {
    const match = description.match(/retry after (\d+)/i);
    if (match) {
      const [, retryAfterDigits] = match;
      if (retryAfterDigits) {
        const parsed = Number.parseInt(retryAfterDigits, 10);
        if (!Number.isNaN(parsed)) {
          return Math.max(0, parsed);
        }
      }
    }
  }

  return 1;
};

export const isMessageNotModifiedError = (error: unknown): boolean => {
  const description = getTelegramErrorDescription(error);
  if (!description) {
    return false;
  }

  return description.toLowerCase().includes("message is not modified");
};
