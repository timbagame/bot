import type { Context, InlineKeyboard } from "grammy";
import { awaitTelegramRetry } from "./media";
import { isMessageNotModified, shouldFallbackToReply } from "./telegram-errors";

export type MenuPayload = {
  text: string;
  keyboard?: InlineKeyboard;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
};

export type MenuResponseOptions = {
  replyToMessageId?: number | null;
  skipEdit?: boolean;
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

const attemptEdit = async (
  _kind: "text" | "caption",
  performEdit: () => Promise<unknown>
): Promise<boolean> => {
  try {
    await performEdit();
    return true;
  } catch (error) {
    if (isMessageNotModified(error)) {
      return true;
    }
    if (shouldFallbackToReply(error)) {
      return false;
    }
    throw error;
  }
};

const tryEditText = async (
  ctx: Context,
  payload: MenuPayload
): Promise<boolean> =>
  attemptEdit("text", async () => {
    await ctx.editMessageText(payload.text, {
      parse_mode: payload.parseMode ?? "HTML",
      reply_markup: payload.keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

const tryEditCaption = async (
  ctx: Context,
  payload: MenuPayload
): Promise<boolean> =>
  attemptEdit("caption", async () => {
    await ctx.editMessageCaption({
      caption: payload.text,
      parse_mode: payload.parseMode ?? "HTML",
      reply_markup: payload.keyboard,
    });
  });

export const respondWithMenu = async (
  ctx: Context,
  payload: MenuPayload,
  options: MenuResponseOptions = {}
): Promise<MenuResponseResult> => {
  const message = ctx.callbackQuery?.message;

  if (!options.skipEdit && ctx.callbackQuery && message) {
    const supportsCaption = messageSupportsCaption(message);
    const messageId = typeof message?.message_id === "number" ? message.message_id : null;
    const chatId =
      (message as any)?.chat?.id ??
      (typeof ctx.chat?.id === "number" ? ctx.chat.id : null);

    if (supportsCaption) {
      try {
        const captionEdited = await tryEditCaption(ctx, payload);
        if (captionEdited) {
          return {
            messageId,
            chatId,
            respondedWithReply: false,
          };
        }
      } catch (error) {
        console.warn(
          "respondWithMenu: editMessageCaption failed, attempting text edit:",
          error
        );
      }
    }

    try {
      const edited = await tryEditText(ctx, payload);
      if (edited) {
        return {
          messageId,
          chatId,
          respondedWithReply: false,
        };
      }
    } catch (error) {
      if (!supportsCaption) {
        console.warn(
          "respondWithMenu: editMessageText failed, falling back to reply:",
          error
        );
      } else {
        console.warn(
          "respondWithMenu: editMessageText failed after caption fallback, replying instead:",
          error
        );
      }
    }
  }

  const replyToId =
    options.replyToMessageId ??
    ctx.message?.message_id ??
    ctx.callbackQuery?.message?.message_id;

  const sentMessage = await awaitTelegramRetry(() =>
    ctx.reply(payload.text, {
      parse_mode: payload.parseMode ?? "HTML",
      reply_markup: payload.keyboard,
      reply_to_message_id: replyToId ?? undefined,
      link_preview_options: { is_disabled: true },
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
