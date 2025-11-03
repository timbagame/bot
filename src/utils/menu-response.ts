import type { Context, InlineKeyboard } from "grammy";
import { awaitTelegramRetry } from "./media";
import { isMessageNotModified, shouldFallbackToReply } from "./telegram-errors";

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
      message?.caption !== undefined
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
  status: "edited" | "skipped" | "fallback" | "error";
  error?: unknown;
};

const attemptEdit = async (
  _kind: MenuEditKind,
  performEdit: () => Promise<unknown>
): Promise<EditAttemptResult> => {
  try {
    await performEdit();
    return { status: "edited" };
  } catch (error) {
    if (isMessageNotModified(error)) {
      return { status: "skipped" };
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
  kind: MenuEditKind
): Promise<EditAttemptResult> =>
  attemptEdit(kind, async () => {
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
  options: MenuResponseOptions = {}
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
    const hasExplicitTarget =
      typeof targetChatId === "number" && typeof targetMessageId === "number";

    if (hasExplicitTarget) {
      const explicitEdit = await attemptEdit("text", () =>
        ctx.api.editMessageText(
          targetChatId,
          targetMessageId,
          payload.text,
          buildMenuTextOptions(payload)
        )
      );

      if (explicitEdit.status === "edited" || explicitEdit.status === "skipped") {
        return {
          messageId: targetMessageId,
          chatId: targetChatId,
          respondedWithReply: false,
        };
      }

      if (explicitEdit.error) {
        console.warn(
          `${logLabel}: editMessageText failed for explicit target, replying instead:`,
          explicitEdit.error
        );
      }
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

      if (typeof (ctx as any).editMessageCaption === "function") {
        const captionAttempt = await editMenuMessage(ctx, payload, "caption");

        if (captionAttempt.status === "edited" || captionAttempt.status === "skipped") {
          return {
            messageId,
            chatId,
            respondedWithReply: false,
          };
        }

        if (captionAttempt.error) {
          console.warn(
            `${logLabel}: adapter editMessageCaption failed, attempting text edit:`,
            captionAttempt.error
          );
        }
      }

      const textAttempt = await editMenuMessage(ctx, payload, "text");
      if (textAttempt.status === "edited" || textAttempt.status === "skipped") {
        return {
          messageId,
          chatId,
          respondedWithReply: false,
        };
      }

      if (textAttempt.error) {
        console.warn(
          `${logLabel}: adapter editMessageText failed, replying instead:`,
          textAttempt.error
        );
      }
    }

    if (allowContextEdit && ctx.callbackQuery && message) {
      const supportsCaption = messageSupportsCaption(message);
      const messageId = typeof message?.message_id === "number" ? message.message_id : null;
      const chatId =
        (message as any)?.chat?.id ??
        (typeof ctx.chat?.id === "number" ? ctx.chat.id : null);

      if (supportsCaption) {
        const captionAttempt = await editMenuMessage(ctx, payload, "caption");

        if (captionAttempt.status === "edited" || captionAttempt.status === "skipped") {
          return {
            messageId,
            chatId,
            respondedWithReply: false,
          };
        }

        if (captionAttempt.error) {
          console.warn(
            `${logLabel}: editMessageCaption failed, attempting text edit:`,
            captionAttempt.error
          );
        }
      }

      const textAttempt = await editMenuMessage(ctx, payload, "text");
      if (textAttempt.status === "edited" || textAttempt.status === "skipped") {
        return {
          messageId,
          chatId,
          respondedWithReply: false,
        };
      }

      if (textAttempt.error) {
        const messageText =
          supportsCaption
            ? `${logLabel}: editMessageText failed after caption fallback, replying instead:`
            : `${logLabel}: editMessageText failed, falling back to reply:`;
        console.warn(messageText, textAttempt.error);
      }
    }
  }

  const replyToId =
    options.replyToMessageId ??
    ctx.message?.message_id ??
    ctx.callbackQuery?.message?.message_id;

  const sentMessage = await awaitTelegramRetry(() =>
    ctx.reply(payload.text, {
      ...buildMenuTextOptions(payload),
      reply_to_message_id: replyToId ?? undefined,
    })
  );

  return {
    messageId:
      typeof (sentMessage as any)?.message_id === "number"
        ? (sentMessage as any).message_id
        : null,
    chatId:
      (sentMessage as any)?.chat?.id ??
      (typeof ctx.chat?.id === "number" ? ctx.chat.id : null),
    respondedWithReply: true,
  };
};
