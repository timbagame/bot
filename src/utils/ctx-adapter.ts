import type { Context } from "grammy";

/**
 * Create a minimal context-like adapter for editing a specific message in DMs.
 * Ensures identity fields are preserved and methods target the given chat/message.
 */
export function createDmMessageAdapter(ctx: Context, chatId: number, initialMessageId: number) {
  let currentMessageId = initialMessageId;

  return {
    // Preserve identity fields so downstream code can derive telegramId
    from: ctx.from,
    chat: ctx.chat,

    // Pass-through API for text edits
    editMessageText: async (text: string, options: any) => {
      // @ts-ignore accessing raw api
      return await ctx.api.editMessageText(chatId, currentMessageId, text, options);
    },

    // Pass-through API for media edits
    editMessageMedia: async (media: any, other?: any) => {
      // @ts-ignore accessing raw api
      return await ctx.api.editMessageMedia(chatId, currentMessageId, media, other);
    },

    // Safe delete
    deleteMessage: async () => {
      try {
        // @ts-ignore accessing raw api
        await ctx.api.deleteMessage(chatId, currentMessageId);
      } catch {}
    },

    // Reply with video and update currentMessageId for future edits
    replyWithVideo: async (...args: any[]) => {
      // @ts-ignore grammy context method
      const sent: any = await (ctx as any).replyWithVideo(...(args as any));
      if (sent && sent.message_id) currentMessageId = sent.message_id;
      return sent;
    },
  } as any;
}

