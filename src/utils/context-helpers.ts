import type { Context } from "grammy";
import type { CallbackError, ErrorHandlingOptions } from "../types";
import { formatUserFriendlyError } from "./errors";

// ================================
// ERROR HANDLING UTILITIES
// ================================

type TelegramContextLike = Pick<Context, "from"> | { from?: { id?: unknown } } | null | undefined;

const DEFAULT_TELEGRAM_ID_FALLBACK = 0n;

/**
 * Safely extracts a Telegram user identifier from a context-like object.
 *
 * The helper tolerates undefined contexts, stringified identifiers, and other
 * unexpected shapes. When extraction fails it returns the provided fallback
 * (default `0n`).
 */
export const getTelegramId = (
  ctx: TelegramContextLike,
  fallback: bigint = DEFAULT_TELEGRAM_ID_FALLBACK
): bigint => {
  const rawId = ctx?.from?.id;

  if (typeof rawId === "bigint") {
    return rawId;
  }

  if (typeof rawId === "number") {
    if (!Number.isFinite(rawId)) {
      return fallback;
    }
    try {
      return BigInt(Math.trunc(rawId));
    } catch {
      return fallback;
    }
  }

  if (typeof rawId === "string") {
    const trimmed = rawId.trim();
    if (!trimmed) {
      return fallback;
    }

    const normalized = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
    if (!/^-?\d+$/.test(normalized)) {
      return fallback;
    }

    try {
      return BigInt(trimmed);
    } catch {
      return fallback;
    }
  }

  if (rawId == null) {
    return fallback;
  }

  try {
    return BigInt(rawId as any);
  } catch {
    return fallback;
  }
};

/**
 * Creates a lightweight adapter that forces subsequent edits to target a specific message.
 * Useful when downstream helpers expect a context-like object with an `editMessageText` method.
 */
export const createMessageEditAdapter = <T extends Context>(
  ctx: T,
  messageId: number,
  chatId?: number
): T => {
  const targetChatId = chatId ?? ctx.chat?.id;
  if (typeof targetChatId !== "number") {
    throw new Error("Cannot create edit adapter without a valid chat id");
  }

  return {
    ...ctx,
    chat: ctx.chat ?? ({ id: targetChatId } as any),
    editMessageText: async (text: string, options: any) =>
      await ctx.api.editMessageText(targetChatId, messageId, text, options),
  };
};

/**
 * Safely truncates error messages for callback queries with better context preservation
 */
export const truncateErrorMessage = (
  message: string,
  options: ErrorHandlingOptions = {}
): string => {
  const { maxLength = 180 } = options;

  if (message.length <= maxLength) {
    return message;
  }

  // Try to preserve important parts of the error message
  const importantPrefixes = ["❌", "⚠️", "Error:", "Failed:", "Invalid:"];
  const hasImportantPrefix = importantPrefixes.some((prefix) =>
    message.startsWith(prefix)
  );

  if (hasImportantPrefix) {
    // Find the first sentence or important part
    const sentenceEnd = message.indexOf(". ");
    if (sentenceEnd > 0 && sentenceEnd < maxLength - 3) {
      return message.substring(0, sentenceEnd + 1);
    }
  }

  // Truncate but try to end at a word boundary
  const truncated = message.substring(0, maxLength - 3);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > maxLength * 0.7) {
    // Only use word boundary if it's not too short
    return truncated.substring(0, lastSpace) + "...";
  }

  return truncated + "...";
};

/**
 * Categorizes errors for better handling
 */
export const categorizeError = (error: any): CallbackError => {
  const errorMessage = error?.message || error?.toString() || "Unknown error";

  return {
    message: errorMessage,
    code: error?.code,
    isAccountNotFound:
      errorMessage.includes("Account does not exist") ||
      errorMessage.includes("could not find account"),
  };
};

/**
 * Safe callback query answering with fallback
 */
export const safeAnswerCallbackQuery = async (
  ctx: any,
  text: string
): Promise<void> => {
  try {
    if (ctx?.answerCallbackQuery) {
      await ctx.answerCallbackQuery(text);
    } else if (ctx?.api && ctx?.callbackQuery?.id) {
      await ctx.api.answerCallbackQuery(ctx.callbackQuery.id, { text });
    } else {
      console.warn("Unable to answer callback query - invalid context");
    }
  } catch (error: any) {
    const description = String(error?.description ?? "");
    if (
      description.includes("query is too old") ||
      description.includes("query ID is invalid") ||
      error?.error_code === 400
    ) {
      const preview = text.length > 50 ? `${text.substring(0, 50)}...` : text;
      console.warn(`⚠️ Callback query timeout: ${preview}`);
      return;
    }

    console.error("Failed to answer callback query:", error);
  }
};

/**
 * Enhanced error handler for callback queries
 */
export const handleCallbackErrorSafe = async (
  ctx: any,
  error: any,
  action: string,
  options: ErrorHandlingOptions = {}
): Promise<void> => {
  console.error(`Error in callback ${action}:`, error);

  const categorizedError = categorizeError(error);

  if (categorizedError.isAccountNotFound) {
    await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
    return;
  }

  // Format without wallet context; formatter handles this gracefully
  const errorMessage = formatUserFriendlyError(error);

  const truncatedMessage = truncateErrorMessage(errorMessage, options);
  await safeAnswerCallbackQuery(ctx, truncatedMessage);
};
