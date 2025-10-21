/**
 * Utility helpers for dealing with Telegram media operations.
 */
export const isRecoverableMediaError = (error: any): boolean => {
  if (!error) return false;
  const description = error.description ?? error.message;
  if (typeof description !== "string") return false;
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

export const isMessageNotModifiedError = (error: any): boolean => {
  if (!error) return false;
  const description = error.description ?? error.message;
  if (typeof description !== "string") return false;
  return description.toLowerCase().includes("message is not modified");
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
}: EditMediaWithFallbackOptions<Primary, Fallback>): Promise<
  EditMediaWithFallbackResult<Primary, Fallback>
> {
  try {
    const result = await edit();
    return { result, usedFallback: false, skipped: false };
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
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
