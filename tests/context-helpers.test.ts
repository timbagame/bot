import { expect, test } from "bun:test";
import {
  categorizeError,
  getTelegramId,
  requireTelegramId,
  MissingTelegramIdError,
  getRequiredTelegramIdForContext,
  MISSING_TELEGRAM_ID_MESSAGE,
  createMessageEditAdapter,
} from "../src/utils/context-helpers";
import { truncateMessage } from "../src/utils/errors";

test("truncateMessage returns original message when under limit", () => {
  const message = "short error";
  expect(truncateMessage(message, { maxLength: 200 })).toBe(message);
});

test("truncateMessage preserves important prefix and first sentence", () => {
  const message = "❌ Error: something bad happened. Additional details that are not needed.";
  expect(truncateMessage(message, { maxLength: 40, preserveSentences: true })).toBe(
    "❌ Error: something bad happened.",
  );
});

test("truncateMessage truncates long message at word boundary", () => {
  const message = "This is a very long message that should be truncated properly";
  expect(truncateMessage(message, { maxLength: 40, wordBoundary: true })).toBe(
    "This is a very long message that...",
  );
});

test("categorizeError flags account not found errors", () => {
  const error = new Error("Account does not exist");
  const categorized = categorizeError(error);
  expect(categorized.isAccountNotFound).toBe(true);
});

test("categorizeError returns message and code", () => {
  const error = { message: "oops", code: "500" };
  const categorized = categorizeError(error);
  expect(categorized).toEqual({
    message: "oops",
    code: "500",
    isAccountNotFound: false,
  });
});

test("getTelegramId normalizes various id shapes", () => {
  const ctxNumber = { from: { id: 123456 } } as any;
  const ctxString = { from: { id: "987654" } } as any;
  const ctxBigInt = { from: { id: 123n } } as any;

  expect(getTelegramId(ctxNumber)).toBe(123456n);
  expect(getTelegramId(ctxString)).toBe(987654n);
  expect(getTelegramId(ctxBigInt)).toBe(123n);
});

test("getTelegramId returns fallback for invalid identifiers", () => {
  const ctxMissing = {} as any;
  const ctxGarbage = { from: { id: "abc" } } as any;
  const ctxInfinity = { from: { id: Number.POSITIVE_INFINITY } } as any;

  expect(getTelegramId(ctxMissing, 42n)).toBe(42n);
  expect(getTelegramId(ctxGarbage, 99n)).toBe(99n);
  expect(getTelegramId(ctxInfinity)).toBe(0n);
});

test("getTelegramId trims and normalizes string identifiers", () => {
  const ctxWithWhitespace = { from: { id: "  +12345  " } } as any;
  const ctxNegative = { from: { id: " -6789" } } as any;

  expect(getTelegramId(ctxWithWhitespace)).toBe(12345n);
  expect(getTelegramId(ctxNegative)).toBe(-6789n);
});

test("getTelegramId converts coercible identifier objects", () => {
  const customId = {
    valueOf: () => 777777,
  };
  const ctx = { from: { id: customId } } as any;

  expect(getTelegramId(ctx)).toBe(777777n);
});

test("requireTelegramId returns id when present", () => {
  const ctx = { from: { id: 123 } } as any;
  expect(requireTelegramId(ctx, "test")).toBe(123n);
});

test("requireTelegramId throws custom error when missing", () => {
  const ctx = { from: { id: undefined } } as any;
  expect(() => requireTelegramId(ctx, "test")).toThrow(MissingTelegramIdError);
});

test("getRequiredTelegramIdForContext notifies when identity missing", async () => {
  const replies: string[] = [];
  const ctx = {
    from: undefined,
    reply: async (message: string) => {
      replies.push(message);
    },
    message: { message_id: 42 },
  } as any;

  const result = await getRequiredTelegramIdForContext(ctx, "test command");
  expect(result).toBeNull();
  expect(replies).toEqual([MISSING_TELEGRAM_ID_MESSAGE]);
});

test("getRequiredTelegramIdForContext uses onMissing handler when provided", async () => {
  const replies: string[] = [];
  const handlerCalls: string[] = [];
  const ctx = {
    from: undefined,
    reply: async (message: string) => {
      replies.push(message);
    },
    message: { message_id: 10 },
  } as any;

  const result = await getRequiredTelegramIdForContext(ctx, "custom handler", {
    onMissing: async (message) => {
      handlerCalls.push(message);
    },
  });

  expect(result).toBeNull();
  expect(handlerCalls).toEqual([MISSING_TELEGRAM_ID_MESSAGE]);
  expect(replies).toHaveLength(0);
});

test("createMessageEditAdapter reuses API with pinned targets", async () => {
  const capturedTextCalls: Array<[number, number, string, any]> = [];
  const capturedCaptionCalls: Array<[number, number, any]> = [];

  const ctx = {
    from: { id: 555 },
    api: {
      editMessageText: async (chatId: number, messageId: number, text: string, options: any) => {
        capturedTextCalls.push([chatId, messageId, text, options]);
      },
      editMessageCaption: async (chatId: number, messageId: number, options: any) => {
        capturedCaptionCalls.push([chatId, messageId, options]);
      },
    },
  } as any;

  const adapter = createMessageEditAdapter(ctx, 222, 333);

  await adapter.editMessageText("hello", { parse_mode: "MarkdownV2" });
  await adapter.editMessageCaption({ caption: "world" });

  expect(capturedTextCalls).toEqual([[333, 222, "hello", { parse_mode: "MarkdownV2" }]]);
  expect(capturedCaptionCalls).toEqual([[333, 222, { caption: "world" }]]);
  expect(adapter.chat?.id).toBe(333);
  expect(adapter.__editAdapterTarget).toEqual({ chatId: 333, messageId: 222 });
  expect(adapter.from).toEqual({ id: 555 });
});
