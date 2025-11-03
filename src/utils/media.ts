/**
 * Utility helpers for dealing with Telegram media operations.
 */

import { getErrorDescription, isMessageNotModified } from "./telegram-errors";

const isTooManyRequestsError = (error: any): boolean => {
  if (!error || typeof error !== "object") return false;
  if ((error as any).error_code === 429) {
    return true;
  }

  const description = getErrorDescription(error);
  return description.toLowerCase().includes("too many requests");
};

const parseRetryAfterSeconds = (error: any): number => {
  if (!error || typeof error !== "object") return 1;

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

  const description = getErrorDescription(error);
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

  return 1;
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

export const awaitTelegramRetry = async <T>(
  operation: () => Promise<T>,
  options: { maxAttempts?: number } = {}
): Promise<T> => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  let attempt = 0;

  while (attempt < maxAttempts) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      if (!isTooManyRequestsError(error) || attempt >= maxAttempts) {
        throw error;
      }

      const delaySeconds = parseRetryAfterSeconds(error);
      await sleep(delaySeconds * 1000);
    }
  }

  throw new Error("awaitTelegramRetry exhausted attempts");
};

export const isRecoverableMediaError = (error: any): boolean => {
  if (!error) return false;
  const description = getErrorDescription(error);
  if (!description) return false;
  const normalized = description.toLowerCase();

  if (normalized.includes("message is not modified")) {
    return false;
  }

  return (
    normalized.includes("wrong file identifier") ||
    normalized.includes("wrong file id") ||
    normalized.includes("http url specified") ||
    normalized.includes("file reference") ||
    normalized.includes("message is not a media message")
  );
};

export type MediaSendResult<Primary, Fallback = Primary> = {
  result: Primary | Fallback;
  usedFallback: boolean;
};

export async function trySendVideoWithFallback<Primary, Fallback = Primary>(
  sendVideo: () => Promise<Primary>,
  fallbackToText: () => Promise<Fallback>,
  options: { logLabel?: string } = {}
): Promise<MediaSendResult<Primary, Fallback>> {
  const { logLabel = "video send" } = options;
  try {
    const result = await sendVideo();
    return { result, usedFallback: false };
  } catch (error) {
    if (isRecoverableMediaError(error)) {
      console.warn(`Falling back to text after ${logLabel} failure:`, error);
      const result = await fallbackToText();
      return { result, usedFallback: true };
    }
    throw error;
  }
}

export type EditMediaWithFallbackOptions<Primary, Fallback = Primary> = {
  edit: () => Promise<Primary>;
  fallback?: () => Promise<Fallback>;
  logLabel?: string;
  onFallback?: () => void;
  maxAttempts?: number;
};

export type EditMediaWithFallbackResult<Primary, Fallback = Primary> = {
  result: Primary | Fallback | null;
  usedFallback: boolean;
  skipped: boolean;
};

export async function editMediaWithFallback<Primary, Fallback = Primary>({
  edit,
  fallback,
  logLabel = "media edit",
  onFallback,
  maxAttempts,
}: EditMediaWithFallbackOptions<Primary, Fallback>): Promise<
  EditMediaWithFallbackResult<Primary, Fallback>
> {
  try {
    const result = await awaitTelegramRetry(edit, { maxAttempts });
    return { result, usedFallback: false, skipped: false };
  } catch (error) {
    if (isMessageNotModified(error)) {
      return { result: null, usedFallback: false, skipped: true };
    }

    if (fallback && isRecoverableMediaError(error)) {
      console.warn(`Falling back to text after ${logLabel} failure:`, error);
      const result = await fallback();
      onFallback?.();
      return { result, usedFallback: true, skipped: false };
    }

    throw error;
  }
}

export type SendMediaWithFallbackOptions<Primary, Fallback = Primary> = {
  videoFileId?: string | null;
  logLabel?: string;
  sendText: () => Promise<Fallback>;
  sendVideo?: () => Promise<Primary>;
  editMessage?: () => Promise<Primary>;
};

export type SendMediaWithFallbackResult<Primary, Fallback = Primary> = {
  result: Primary | Fallback | null;
  usedVideo: boolean;
  usedFallback: boolean;
  skippedEdit: boolean;
};

const buildSendMediaResult = <Primary, Fallback>(
  result: Primary | Fallback | null,
  options: { usedVideo: boolean; usedFallback: boolean; skippedEdit: boolean }
): SendMediaWithFallbackResult<Primary, Fallback> => ({
  result,
  usedVideo: options.usedVideo,
  usedFallback: options.usedFallback,
  skippedEdit: options.skippedEdit,
});

export async function sendMediaWithFallback<Primary, Fallback = Primary>({
  videoFileId,
  logLabel = "media",
  sendText,
  sendVideo,
  editMessage,
}: SendMediaWithFallbackOptions<Primary, Fallback>): Promise<
  SendMediaWithFallbackResult<Primary, Fallback>
> {
  if (!videoFileId) {
    const result = await sendText();
    return buildSendMediaResult<Primary, Fallback>(result as Primary | Fallback, {
      usedVideo: false,
      usedFallback: true,
      skippedEdit: false,
    });
  }

  if (editMessage) {
    try {
      const editResult = await editMediaWithFallback<Primary, Fallback>({
        edit: editMessage,
        fallback: sendText,
        logLabel: `${logLabel} edit`,
      });

      if (editResult.skipped) {
        return buildSendMediaResult<Primary, Fallback>(
          editResult.result as Primary | Fallback | null,
          {
            usedVideo: false,
            usedFallback: editResult.usedFallback,
            skippedEdit: true,
          }
        );
      }

      return buildSendMediaResult<Primary, Fallback>(
        editResult.result as Primary | Fallback | null,
        {
          usedVideo: !editResult.usedFallback,
          usedFallback: editResult.usedFallback,
          skippedEdit: false,
        }
      );
    } catch (error) {
      console.warn(`${logLabel} edit failed, attempting send`, error);
    }
  }

  if (!sendVideo) {
    const result = await sendText();
    return buildSendMediaResult<Primary, Fallback>(result as Primary | Fallback, {
      usedVideo: false,
      usedFallback: true,
      skippedEdit: false,
    });
  }

  const { result, usedFallback } = await trySendVideoWithFallback<Primary, Fallback>(
    () => sendVideo(),
    () => sendText(),
    { logLabel: `${logLabel} send` }
  );

  return buildSendMediaResult<Primary, Fallback>(result as Primary | Fallback | null, {
    usedVideo: !usedFallback,
    usedFallback,
    skippedEdit: false,
  });
}
