import { expect, test } from "bun:test";
import { createDmMessageAdapter } from "../src/utils/ctx-adapter";

test("createDmMessageAdapter preserves from/chat and targets given message id", async () => {
  const calls: any[] = [];
  const fakeCtx: any = {
    from: { id: 1234 },
    chat: { id: 1234, type: "private" },
    api: {
      editMessageText: async (chatId: number, messageId: number, text: string, opts: any) => {
        calls.push(["editMessageText", chatId, messageId, text, opts]);
        return { ok: true } as any;
      },
      editMessageMedia: async (chatId: number, messageId: number, media: any, opts: any) => {
        calls.push(["editMessageMedia", chatId, messageId, media, opts]);
        return { ok: true } as any;
      },
      deleteMessage: async (chatId: number, messageId: number) => {
        calls.push(["deleteMessage", chatId, messageId]);
        return { ok: true } as any;
      },
    },
    replyWithVideo: async (_video: any, _opts: any) => ({ message_id: 777 }),
  };

  const adapter: any = createDmMessageAdapter(fakeCtx, 1234, 555);
  expect(adapter.from.id).toBe(1234);
  expect(adapter.chat.id).toBe(1234);

  await adapter.editMessageText("hello", { parse_mode: "HTML" });
  await adapter.editMessageMedia({ type: "video", media: "file_id" }, { caption: "cap" });
  await adapter.deleteMessage();
  // Simulate sending a new video and ensure subsequent edits target new id
  await adapter.replyWithVideo("file_id", {});
  await adapter.editMessageText("after", {});

  // Verify the last edit used the new message id (777)
  const last = calls[calls.length - 1];
  expect(last[0]).toBe("editMessageText");
  expect(last[2]).toBe(777);
});
