import type { Context, InlineKeyboard } from "grammy";
import { awaitTelegramRetry } from "./media";
import {
  getErrorDescription,
  isMessageMissing,
  isMessageNotModified,
} from "./telegram-errors";

export type MenuPayload = {
  text: string;
  keyboard?: InlineKeyboard;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
};

export type MenuResponseOptions = {
  replyToMessageId?: number | null;
};

const shouldFallbackToCaptionOrReply = (description: string): boolean => {
  const normalized = description.toLowerCase();

  return (
    isMessageMissing(description) ||
    normalized.includes("message can't be edited") ||
    normalized.includes("have no access to the chat") ||
    normalized.includes("bot was blocked by the user") ||
    normalized.includes("message with the same content already exists") ||
    normalized.includes("there is no text in the message to edit") ||
    normalized.includes("there is no caption in the message to edit")
  );
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
    const description = getErrorDescription(error);
    if (isMessageNotModified(description)) {
      return true;
    }
    if (shouldFallbackToCaptionOrReply(description)) {
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
): Promise<void> => {
  const message = ctx.callbackQuery?.message;

  if (ctx.callbackQuery && message) {
    const supportsCaption = messageSupportsCaption(message);

    if (supportsCaption) {
      try {
        const captionEdited = await tryEditCaption(ctx, payload);
        if (captionEdited) {
          return;
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
        return;
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

  await awaitTelegramRetry(() =>
    ctx.reply(payload.text, {
      parse_mode: payload.parseMode ?? "HTML",
      reply_markup: payload.keyboard,
      reply_to_message_id: replyToId ?? undefined,
      link_preview_options: { is_disabled: true },
    })
  );
};
