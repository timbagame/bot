import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import { isMessageNotModified } from "../../utils/telegram-errors";

/** Label of the fallback button offered when the original keyboard is unavailable. */
export const CONFIRM_RETRY_LABEL = "🔁 Try again";

export type ConfirmMessageSnapshot = {
  text: string;
  entities?: MessageEntity[];
  replyMarkup?: InlineKeyboardMarkup;
};

/**
 * Captures the confirm card before it is replaced with "Creating game…", so a
 * failed or interrupted creation can put the same card (and its buttons) back.
 * Returns null for messages without text (nothing to restore).
 */
export const snapshotConfirmMessage = (message: unknown): ConfirmMessageSnapshot | null => {
  const source = message as
    | { text?: unknown; entities?: unknown; reply_markup?: { inline_keyboard?: unknown } }
    | null
    | undefined;
  if (!source || typeof source.text !== "string" || source.text.length === 0) {
    return null;
  }

  const entities = Array.isArray(source.entities)
    ? (source.entities as MessageEntity[])
    : undefined;
  const replyMarkup =
    source.reply_markup && Array.isArray(source.reply_markup.inline_keyboard)
      ? (source.reply_markup as InlineKeyboardMarkup)
      : undefined;

  return { text: source.text, entities, replyMarkup };
};

export type RestoredConfirmMessage = {
  text: string;
  entities: MessageEntity[];
  replyMarkup?: InlineKeyboardMarkup;
};

/**
 * Builds the restored card: the failure notice in bold on top of the original
 * confirm text. Telegram entity offsets are UTF-16 code units, which match
 * JavaScript string lengths, so the original entities shift by the prefix length.
 * Without an original keyboard, a single Try again button re-sends `retryData`.
 */
export const buildRestoredConfirmMessage = (
  snapshot: ConfirmMessageSnapshot | null,
  notice: string,
  retryData?: string,
): RestoredConfirmMessage => {
  const noticeEntity: MessageEntity = { type: "bold", offset: 0, length: notice.length };
  const fallbackMarkup: InlineKeyboardMarkup | undefined = retryData
    ? { inline_keyboard: [[{ text: CONFIRM_RETRY_LABEL, callback_data: retryData }]] }
    : undefined;

  if (!snapshot) {
    return { text: notice, entities: [noticeEntity], replyMarkup: fallbackMarkup };
  }

  const prefix = `${notice}\n\n`;
  const shifted = (snapshot.entities ?? []).map((entity) => ({
    ...entity,
    offset: entity.offset + prefix.length,
  }));

  return {
    text: `${prefix}${snapshot.text}`,
    entities: [noticeEntity, ...shifted],
    replyMarkup: snapshot.replyMarkup ?? fallbackMarkup,
  };
};

type EditMessageTextApi = {
  editMessageText: (
    chatId: number,
    messageId: number,
    text: string,
    other?: Record<string, unknown>,
  ) => Promise<unknown>;
};

/**
 * Replaces the "Creating game…" placeholder with the restored confirm card.
 * Returns false when the edit fails so callers can fall back to a new message.
 */
export const restoreConfirmMessage = async (
  api: EditMessageTextApi,
  target: { chatId: number; messageId: number },
  restored: RestoredConfirmMessage,
): Promise<boolean> => {
  try {
    await api.editMessageText(target.chatId, target.messageId, restored.text, {
      entities: restored.entities,
      link_preview_options: { is_disabled: true },
      ...(restored.replyMarkup ? { reply_markup: restored.replyMarkup } : {}),
    });
    return true;
  } catch (error) {
    if (isMessageNotModified(error)) {
      return true;
    }
    console.warn("Failed to restore game confirmation after creation failure:", error);
    return false;
  }
};
