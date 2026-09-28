import type { Context } from "grammy";
import type { CallbackError, ErrorHandlingOptions } from "../types";
import { formatUserFriendlyError, truncateMessage } from "./errors";
import { isMissingAccountError } from "./account-errors";
import {
  getCallbackQueue,
  getRateLimiter,
  extractRetryAfter,
  isRateLimitError,
  isCallbackExpiredError,
} from "./telegram-rate-limiter";

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
  fallback: bigint = DEFAULT_TELEGRAM_ID_FALLBACK,
): bigint => {
  const rawId = ctx?.from?.id;

  if (typeof rawId === "bigint") {
    return rawId;
  }

  if (typeof rawId === "number") {
    return Number.isFinite(rawId) ? BigInt(Math.trunc(rawId)) : fallback;
  }

  if (typeof rawId === "string") {
    const trimmed = rawId.trim();
    if (!trimmed) {
      return fallback;
    }

    const normalized = trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
    // BigInt accepts a leading sign, so a string that passes this check cannot throw.
    return /^-?\d+$/.test(normalized) ? BigInt(trimmed) : fallback;
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

const MISSING_TELEGRAM_ID_CALLBACK_MESSAGE = "❌ Unable to resolve Telegram identity";

type MissingTelegramIdHandler = (message: string) => Promise<void> | void;

const notifyMissingTelegramId = async (
  ctx: Pick<Context, "reply" | "api" | "chat" | "message"> | any,
  message: string,
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
  options: { onMissing?: MissingTelegramIdHandler } = {},
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
          console.error("Missing Telegram ID handler failed:", handlerError);
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
  contextDescription: string = "operation",
): bigint => {
  const id = getTelegramId(ctx);
  if (id === 0n) {
    throw new MissingTelegramIdError(`Missing Telegram user id for ${contextDescription}`);
  }
  return id;
};

export const getTelegramIdString = (ctx: TelegramContextLike): string | undefined => {
  const id = getTelegramId(ctx);
  return id === 0n ? undefined : id.toString();
};

export const containsBalanceInfo = (text: string): boolean => {
  if (typeof text !== "string" || text.length === 0) {
    return false;
  }
  const normalized = text.toLowerCase();

  if (normalized.includes("your balance")) {
    return true;
  }

  if (normalized.includes("insufficient funds")) {
    return true;
  }

  const youHaveBalancePattern = /you have\s+[0-9][\d.,]*\s+(?:sol|lamports?|tokens?|coins?)/i;
  if (youHaveBalancePattern.test(normalized)) {
    return true;
  }

  // Case-sensitive so the ticker must be upper case, but the sentence may start with "You".
  const youHaveTickerPattern = /[Yy]ou have\s+[0-9][\d.,]*\s+[A-Z]{2,10}\b/;
  if (youHaveTickerPattern.test(text)) {
    return true;
  }

  const hasNotEnoughPrefix = normalized.includes("not enough") && /you have\s+[0-9]/i.test(text);
  const hasNeedQualifier = /you have\s+[0-9]/i.test(text) && /need/i.test(text);

  return hasNotEnoughPrefix || hasNeedQualifier;
};

/**
 * Creates a lightweight adapter that forces subsequent edits to target a specific message.
 * Useful when downstream helpers expect a context-like object with an `editMessageText` method.
 */
export const createMessageEditAdapter = <T extends Context>(
  ctx: T,
  messageId: number,
  chatId?: number,
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
      isMissingAccountError(error) || errorMessage.includes("could not find account"),
  };
};

// ================================
// CALLBACK ANSWER GRACE PERIOD
// ================================

/** How long a callback may run before Telegram's button spinner is answered early. */
export const CALLBACK_ANSWER_GRACE_MS = 350;

const CALLBACK_GRACE_KEY = "__callbackAnswerGrace";

type CallbackGraceState = {
  answered: boolean;
  answeredEarly: boolean;
  onLateAnswer?: (text: string) => Promise<unknown> | unknown;
};

const getCallbackGraceState = (ctx: any): CallbackGraceState | undefined => {
  const state = ctx?.[CALLBACK_GRACE_KEY];
  return state && typeof state === "object" ? (state as CallbackGraceState) : undefined;
};

export type AnswerCallbackWithGraceOptions = {
  /** Delay before answering early. Defaults to {@link CALLBACK_ANSWER_GRACE_MS}. */
  graceMs?: number;
  /** Toast shown when the work outlives the grace period. Silent when omitted. */
  pendingText?: string;
  /**
   * Receives texted answers issued after the early answer, which Telegram would
   * otherwise drop. Use it to surface failures another way (e.g. a reply).
   */
  onLateAnswer?: (text: string) => Promise<unknown> | unknown;
};

/**
 * Runs slow callback work while keeping the button responsive.
 *
 * Fast work answers the callback itself as usual. When the work is still running
 * after the grace period, the callback is answered once with `pendingText` (or
 * silently) and later `safeAnswerCallbackQuery` calls on the same context are
 * routed to `onLateAnswer` instead of hitting Telegram a second time. When the
 * work finishes without answering, the callback is answered silently so the
 * spinner never lingers. Errors propagate unchanged so existing handlers keep
 * reporting them.
 */
export const answerCallbackWithGrace = async <T>(
  ctx: any,
  work: () => Promise<T>,
  options: AnswerCallbackWithGraceOptions = {},
): Promise<T> => {
  if (!ctx || getCallbackGraceState(ctx)) {
    return await work();
  }

  const state: CallbackGraceState = {
    answered: false,
    answeredEarly: false,
    onLateAnswer: options.onLateAnswer,
  };
  ctx[CALLBACK_GRACE_KEY] = state;

  const timer = setTimeout(
    () => {
      if (state.answered) return;
      state.answered = true;
      state.answeredEarly = true;
      void answerCallbackQueryNow(ctx, options.pendingText);
    },
    Math.max(0, options.graceMs ?? CALLBACK_ANSWER_GRACE_MS),
  );

  try {
    const result = await work();
    clearTimeout(timer);
    if (!state.answered) {
      state.answered = true;
      await answerCallbackQueryNow(ctx);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Posts `text` as a quiet reply to the message that owns the callback button.
 * Intended as an `onLateAnswer` fallback for results that no longer fit in a toast.
 */
export const replyToCallbackMessage = async (ctx: any, text: string): Promise<void> => {
  if (typeof ctx?.reply !== "function") return;
  const messageId = ctx?.callbackQuery?.message?.message_id;
  await ctx.reply(text, {
    disable_notification: true,
    ...(typeof messageId === "number" ? { reply_to_message_id: messageId } : {}),
  });
};

/**
 * Safe callback query answering with fallback
 */
export const safeAnswerCallbackQuery = async (
  ctx: any,
  text?: string,
  options: { useQueue?: boolean } = {},
): Promise<void> => {
  const grace = getCallbackGraceState(ctx);
  if (grace) {
    if (grace.answeredEarly) {
      // Telegram accepts one answer per callback. The grace timer already used
      // it, so hand texted results to the caller's fallback instead.
      if (typeof text === "string" && text.length > 0 && grace.onLateAnswer) {
        try {
          await grace.onLateAnswer(text);
        } catch (error) {
          console.warn("Failed to deliver late callback answer:", error);
        }
      }
      return;
    }
    grace.answered = true;
  }

  await answerCallbackQueryNow(ctx, text, options);
};

const answerCallbackQueryNow = async (
  ctx: any,
  text?: string,
  options: { useQueue?: boolean } = {},
): Promise<void> => {
  const callbackId = ctx?.callbackQuery?.id;
  const chatId = ctx?.chat?.id;

  // Check if we should use the throttled queue
  const queue = getCallbackQueue();
  if (options.useQueue && queue && callbackId) {
    queue.enqueue(callbackId, text);
    return;
  }

  // Check rate limit status before attempting
  const rateLimiter = getRateLimiter();
  if (chatId && rateLimiter.isLimited(chatId)) {
    const waitMs = rateLimiter.getWaitTimeMs(chatId);
    console.warn(
      `⏳ Chat ${chatId} is rate limited, skipping callback answer (${Math.ceil(waitMs / 1000)}s remaining)`,
    );
    return;
  }

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
    // Handle rate limit errors - record for future proactive skipping
    if (isRateLimitError(error)) {
      const retryAfter = extractRetryAfter(error);
      if (retryAfter !== null && chatId) {
        rateLimiter.recordRateLimit(retryAfter, chatId);
        console.warn(`🚫 Chat ${chatId} rate limited for ${retryAfter}s on callback answer`);
      }
      return;
    }

    // Handle expired callback queries gracefully
    if (isCallbackExpiredError(error)) {
      const rawText = text ?? "";
      const preview = rawText.length > 50 ? `${rawText.substring(0, 50)}...` : rawText;
      console.warn(`⚠️ Callback query timeout: ${preview}`);
      return;
    }

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
  options: { logMessage?: string } = {},
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
  options: ResolveTelegramIdOptions = {},
): Promise<bigint | null> => {
  const telegramId = await getRequiredTelegramIdForContext(ctx, contextDescription, {
    onMissing: options.onMissing,
  });

  if (telegramId == null) {
    await respondMissingIdentity(ctx, {
      logMessage: options.logMessage ?? `Missing Telegram ID for ${contextDescription}`,
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
  options: ErrorHandlingOptions = {},
): Promise<void> => {
  console.error(`Error in callback ${action}:`, error);

  const categorizedError = categorizeError(error);

  if (categorizedError.isAccountNotFound) {
    await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
    return;
  }

  // Format without wallet context; formatter handles this gracefully
  const errorMessage = await formatUserFriendlyError(error);

  const { maxLength = 180 } = options;
  const truncatedMessage = truncateMessage(errorMessage, {
    maxLength,
    preserveSentences: true,
    wordBoundary: true,
  });
  await safeAnswerCallbackQuery(ctx, truncatedMessage);
};
