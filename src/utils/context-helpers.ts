import type { Context } from "grammy";
import type { CallbackError, ErrorHandlingOptions } from "../types";
import { formatUserFriendlyError, truncateMessage } from "./errors";

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

export class MissingTelegramIdError extends Error {
  constructor(message: string = "Missing Telegram user id") {
    super(message);
    this.name = "MissingTelegramIdError";
  }
}

export const MISSING_TELEGRAM_ID_MESSAGE =
  "❌ Unable to resolve your Telegram identity. Please open a direct chat with the bot and try again.";

const MISSING_TELEGRAM_ID_CALLBACK_MESSAGE =
  "❌ Unable to resolve Telegram identity";

type MissingTelegramIdHandler = (message: string) => Promise<void> | void;

const notifyMissingTelegramId = async (
  ctx: Pick<Context, "reply" | "api" | "chat" | "message"> | any,
  message: string
): Promise<void> => {
  try {
    if (typeof ctx?.reply === "function") {
      await ctx.reply(message, {
        reply_to_message_id: ctx.message?.message_id,
      });
      return;
    }

    const chatId = ctx?.chat?.id;
    if (ctx?.api && typeof chatId === "number") {
      await ctx.api.sendMessage(chatId, message, {
        reply_to_message_id: ctx.message?.message_id,
        link_preview_options: { is_disabled: true },
      });
    }
  } catch (notifyError) {
    console.error("Failed to send missing-id notification:", notifyError);
  }
};

export const getRequiredTelegramIdForContext = async (
  ctx: Context,
  contextDescription: string,
  options: { onMissing?: MissingTelegramIdHandler } = {}
): Promise<bigint | null> => {
  try {
    return requireTelegramId(ctx, contextDescription);
  } catch (error) {
    if (error instanceof MissingTelegramIdError) {
      const handler = options.onMissing;
      if (handler) {
        try {
          await handler(MISSING_TELEGRAM_ID_MESSAGE);
        } catch (handlerError) {
          console.error(
            "Missing Telegram ID handler failed:",
            handlerError
          );
        }
      } else {
        await notifyMissingTelegramId(ctx, MISSING_TELEGRAM_ID_MESSAGE);
      }
      return null;
    }
    throw error;
  }
};

export const requireTelegramId = (
  ctx: TelegramContextLike,
  contextDescription: string = "operation"
): bigint => {
  const id = getTelegramId(ctx);
  if (id === 0n) {
    throw new MissingTelegramIdError(
      `Missing Telegram user id for ${contextDescription}`
    );
  }
  return id;
};

export const getTelegramIdString = (
  ctx: TelegramContextLike
): string | undefined => {
  const id = getTelegramId(ctx);
  return id === 0n ? undefined : id.toString();
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

  const originalFrom = ctx.from ? { ...ctx.from } : undefined;

  const adapterTarget = { chatId: targetChatId, messageId };

  return {
    ...ctx,
    from: originalFrom,
    chat: ctx.chat ?? ({ id: targetChatId } as any),
    editMessageText: async (text: string, options: any) =>
      await ctx.api.editMessageText(targetChatId, messageId, text, options),
    editMessageCaption: async (options: any) =>
      await ctx.api.editMessageCaption(targetChatId, messageId, options),
    __editAdapterTarget: adapterTarget,
  } as T;
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
  text?: string
): Promise<void> => {
  try {
    const hasText = typeof text === "string" && text.length > 0;

    if (typeof ctx?.answerCallbackQuery === "function") {
      if (hasText) {
        await ctx.answerCallbackQuery(text);
      } else {
        await ctx.answerCallbackQuery();
      }
      return;
    }

    const callbackId = ctx?.callbackQuery?.id;

    if (ctx?.api && callbackId) {
      const payload = hasText ? { text } : {};
      await ctx.api.answerCallbackQuery(callbackId, payload);
      return;
    }

    if (!callbackId) {
      console.warn("Unable to answer callback query - missing callback id");
      return;
    }

    console.warn("Unable to answer callback query - invalid context");
  } catch (error: any) {
    const description = String(error?.description ?? "");
    if (
      description.includes("query is too old") ||
      description.includes("query ID is invalid") ||
      error?.error_code === 400
    ) {
      const rawText = text ?? "";
      const preview = rawText.length > 50 ? `${rawText.substring(0, 50)}...` : rawText;
      console.warn(`⚠️ Callback query timeout: ${preview}`);
      return;
    }

    console.error("Failed to answer callback query:", error);
  }
};

export const respondMissingIdentity = async (
  ctx: any,
  options: { logMessage?: string } = {}
): Promise<void> => {
  if (options.logMessage) {
    console.warn(options.logMessage);
  }

  await safeAnswerCallbackQuery(ctx, MISSING_TELEGRAM_ID_CALLBACK_MESSAGE);
};

export type ResolveTelegramIdOptions = {
  onMissing?: MissingTelegramIdHandler;
  logMessage?: string;
};

export const resolveTelegramIdOrRespond = async (
  ctx: Context,
  contextDescription: string,
  options: ResolveTelegramIdOptions = {}
): Promise<bigint | null> => {
  const telegramId = await getRequiredTelegramIdForContext(
    ctx,
    contextDescription,
    { onMissing: options.onMissing }
  );

  if (telegramId == null) {
    await respondMissingIdentity(ctx, {
      logMessage:
        options.logMessage ??
        `Missing Telegram ID for ${contextDescription}`,
    });
    return null;
  }

  return telegramId;
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

  const { maxLength = 180 } = options;
  const truncatedMessage = truncateMessage(errorMessage, {
    maxLength,
    preserveSentences: true,
    wordBoundary: true,
  });
  await safeAnswerCallbackQuery(ctx, truncatedMessage);
};
