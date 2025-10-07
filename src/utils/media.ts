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

export async function trySendVideoWithFallback(
  sendVideo: () => Promise<any>,
  fallbackToText: () => Promise<any>
): Promise<void> {
  try {
    await sendVideo();
  } catch (error) {
    if (isRecoverableMediaError(error)) {
      console.warn("Falling back to text after video send failure:", error);
      await fallbackToText();
      return;
    }
    throw error;
  }
}
