import type { Context, InlineKeyboard } from "grammy";
import { awaitTelegramRetry } from "./media";
import {
  isMessageNotModified,
  isMissingEditableContent,
  isRateLimited,
  shouldFallbackToReply,
} from "./telegram-errors";

export type MenuPayload = {
  text: string;
  keyboard?: InlineKeyboard;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  disableLinkPreview?: boolean;
};

export type MenuResponseOptions = {
  replyToMessageId?: number | null;
  skipEdit?: boolean;
  targetChatId?: number;
  targetMessageId?: number;
  allowContextEdit?: boolean;
  logLabel?: string;
};

export type MenuResponseResult = {
  messageId: number | null;
  chatId: number | null;
  respondedWithReply: boolean;
};

const messageSupportsCaption = (message: any): boolean =>
  Boolean(
    message?.photo ||
    message?.video ||
    message?.animation ||
    message?.document ||
    message?.audio ||
    message?.caption !== undefined,
  );

const buildMenuTextOptions = (payload: MenuPayload) => ({
  parse_mode: payload.parseMode ?? "HTML",
  reply_markup: payload.keyboard,
  link_preview_options: {
    is_disabled: payload.disableLinkPreview ?? true,
  },
});

type MenuEditKind = "text" | "caption";

type EditAttemptResult = {
  status: "edited" | "skipped" | "fallback" | "error" | "rate_limited";
  error?: unknown;
};

type EditTargetAttempt = {
  invoke: () => Promise<EditAttemptResult>;
  continueOnFailure?: boolean;
  onFailure?: (result: EditAttemptResult) => void;
  shouldContinue?: (result: EditAttemptResult) => boolean;
};

type EditTarget = {
  messageId: number | null;
  chatId: number | null;
  attempts: EditTargetAttempt[];
};

const attemptEdit = async (performEdit: () => Promise<unknown>): Promise<EditAttemptResult> => {
  try {
    await performEdit();
    return { status: "edited" };
  } catch (error) {
    if (isMessageNotModified(error)) {
      return { status: "skipped" };
    }
    if (isRateLimited(error)) {
      return { status: "rate_limited", error };
    }
    if (shouldFallbackToReply(error)) {
      return { status: "fallback", error };
    }
    return { status: "error", error };
  }
};

const editMenuMessage = async (
  ctx: Context,
  payload: MenuPayload,
  kind: MenuEditKind,
): Promise<EditAttemptResult> =>
  attemptEdit(async () => {
    if (kind === "caption") {
      await ctx.editMessageCaption({
        caption: payload.text,
        parse_mode: payload.parseMode ?? "HTML",
        reply_markup: payload.keyboard,
      });
      return;
    }

    await ctx.editMessageText(payload.text, buildMenuTextOptions(payload));
  });

export const respondWithMenu = async (
  ctx: Context,
  payload: MenuPayload,
  options: MenuResponseOptions = {},
): Promise<MenuResponseResult> => {
  const message = ctx.callbackQuery?.message;
  const {
    skipEdit = false,
    targetChatId,
    targetMessageId,
    allowContextEdit = true,
    logLabel = "respondWithMenu",
  } = options;

  if (!skipEdit) {
    const editTargets: EditTarget[] = [];

    const hasExplicitTarget =
      typeof targetChatId === "number" && typeof targetMessageId === "number";

    if (hasExplicitTarget) {
      const shouldContinueOnMissingContent = (result: EditAttemptResult) =>
        result.status === "fallback" &&
        Boolean(result.error && isMissingEditableContent(result.error));

      const attempts: EditTargetAttempt[] = [];

      if (typeof ctx.api?.editMessageCaption === "function") {
        attempts.push({
          invoke: () =>
            attemptEdit(() =>
              ctx.api.editMessageCaption(targetChatId, targetMessageId, {
                caption: payload.text,
                parse_mode: payload.parseMode ?? "HTML",
                reply_markup: payload.keyboard,
              }),
            ),
          shouldContinue: shouldContinueOnMissingContent,
          onFailure: (result) => {
            if (!result.error) {
              return;
            }
            if (isMissingEditableContent(result.error)) {
              console.warn(
                `${logLabel}: editMessageCaption failed (missing caption), attempting text edit:`,
                result.error,
              );
              return;
            }
            console.warn(
              `${logLabel}: editMessageCaption failed for explicit target, replying instead:`,
              result.error,
            );
          },
        });
      }

      attempts.push({
        invoke: () =>
          attemptEdit(() =>
            ctx.api.editMessageText(
              targetChatId,
              targetMessageId,
              payload.text,
              buildMenuTextOptions(payload),
            ),
          ),
        continueOnFailure: false,
        onFailure: (result) => {
          if (result.error) {
            console.warn(
              `${logLabel}: editMessageText failed for explicit target, replying instead:`,
              result.error,
            );
          }
        },
      });

      editTargets.push({
        messageId: targetMessageId,
        chatId: targetChatId,
        attempts,
      });
    }

    const adapterTarget =
      allowContextEdit && (ctx as any).__editAdapterTarget
        ? (ctx as any).__editAdapterTarget
        : null;

    if (adapterTarget) {
      const messageId =
        typeof adapterTarget.messageId === "number" ? adapterTarget.messageId : null;
      const chatId =
        typeof adapterTarget.chatId === "number"
          ? adapterTarget.chatId
          : typeof ctx.chat?.id === "number"
            ? ctx.chat.id
            : null;

      const attempts: EditTargetAttempt[] = [];

      if (typeof (ctx as any).editMessageCaption === "function") {
        attempts.push({
          invoke: () => editMenuMessage(ctx, payload, "caption"),
          onFailure: (result) => {
            if (result.error) {
              console.warn(
                `${logLabel}: adapter editMessageCaption failed, attempting text edit:`,
                result.error,
              );
            }
          },
        });
      }

      attempts.push({
        invoke: () => editMenuMessage(ctx, payload, "text"),
        continueOnFailure: false,
        onFailure: (result) => {
          if (result.error) {
            console.warn(
              `${logLabel}: adapter editMessageText failed, replying instead:`,
              result.error,
            );
          }
        },
      });

      editTargets.push({ messageId, chatId, attempts });
    }

    if (allowContextEdit && ctx.callbackQuery && message) {
      const supportsCaption = messageSupportsCaption(message);
      const messageId = typeof message?.message_id === "number" ? message.message_id : null;
      const chatId =
        (message as any)?.chat?.id ?? (typeof ctx.chat?.id === "number" ? ctx.chat.id : null);

      const attempts: EditTargetAttempt[] = [];

      if (supportsCaption) {
        attempts.push({
          invoke: () => editMenuMessage(ctx, payload, "caption"),
          onFailure: (result) => {
            if (result.error) {
              console.warn(
                `${logLabel}: editMessageCaption failed, attempting text edit:`,
                result.error,
              );
            }
          },
        });
      }

      attempts.push({
        invoke: () => editMenuMessage(ctx, payload, "text"),
        continueOnFailure: false,
        onFailure: (result) => {
          if (result.error) {
            const messageText = supportsCaption
              ? `${logLabel}: editMessageText failed after caption fallback, replying instead:`
              : `${logLabel}: editMessageText failed, falling back to reply:`;
            console.warn(messageText, result.error);
          }
        },
      });

      editTargets.push({ messageId, chatId, attempts });
    }

    for (const target of editTargets) {
      for (const attempt of target.attempts) {
        const result = await attempt.invoke();
        if (result.status === "edited" || result.status === "skipped") {
          return {
            messageId: target.messageId,
            chatId: target.chatId,
            respondedWithReply: false,
          };
        }

        if (result.status === "rate_limited") {
          if (result.error) {
            console.warn(
              `${logLabel}: editMessage throttled, keeping current message`,
              result.error,
            );
          }

          return {
            messageId: target.messageId,
            chatId: target.chatId,
            respondedWithReply: false,
          };
        }

        if (attempt.onFailure && result.error) {
          attempt.onFailure(result);
        }

        const shouldContinue = attempt.shouldContinue
          ? attempt.shouldContinue(result)
          : attempt.continueOnFailure !== false;

        if (!shouldContinue) {
          break;
        }
      }
    }
  }

  const replyToId =
    options.replyToMessageId ?? ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id;

  const sentMessage = await awaitTelegramRetry(() =>
    ctx.reply(payload.text, {
      ...buildMenuTextOptions(payload),
      reply_to_message_id: replyToId ?? undefined,
    }),
  );

  return {
    messageId:
      typeof (sentMessage as any)?.message_id === "number" ? (sentMessage as any).message_id : null,
    chatId:
      (sentMessage as any)?.chat?.id ?? (typeof ctx.chat?.id === "number" ? ctx.chat.id : null),
    respondedWithReply: true,
  };
};
