import { describe, expect, test, beforeAll } from "bun:test";
import {
  categorizeError,
  getTelegramId,
  requireTelegramId,
  MissingTelegramIdError,
  getRequiredTelegramIdForContext,
  MISSING_TELEGRAM_ID_MESSAGE,
  createMessageEditAdapter,
  handleCallbackErrorSafe,
  safeAnswerCallbackQuery,
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

test("safeAnswerCallbackQuery falls back to ctx.api.answerCallbackQuery when no direct method", async () => {
  let answered = false;
  const ctx: any = {
    callbackQuery: { id: "cb-xyz" },
    api: {
      answerCallbackQuery: async (id: string, opts: { text: string }) => {
        answered = id === "cb-xyz" && typeof opts.text === "string" && opts.text.length > 0;
      },
    },
  };

  await safeAnswerCallbackQuery(ctx, "sample message");
  expect(answered).toBe(true);
});

test("safeAnswerCallbackQuery exits early when callback id missing", async () => {
  let called = false;
  const ctx: any = {
    callbackQuery: {},
    api: {
      answerCallbackQuery: async () => {
        called = true;
      },
    },
  };

  await expect(safeAnswerCallbackQuery(ctx, "ignored")).resolves.toBeUndefined();
  expect(called).toBe(false);
});

test("safeAnswerCallbackQuery suppresses stale direct callback errors", async () => {
  let fallbackCalled = false;
  const err: any = new Error("query is too old");
  err.description = "query is too old";
  err.error_code = 400;

  const ctx: any = {
    callbackQuery: { id: "cb-123" },
    answerCallbackQuery: async () => {
      throw err;
    },
    api: {
      answerCallbackQuery: async () => {
        fallbackCalled = true;
      },
    },
  };

  await expect(safeAnswerCallbackQuery(ctx, "stale")).resolves.toBeUndefined();
  expect(fallbackCalled).toBe(false);
});

test("truncateMessage honors important prefix and first sentence", () => {
  const msg =
    "❌ Failure: Something bad happened. Additional verbose context that should be dropped.";
  const truncated = truncateMessage(msg, {
    maxLength: 60,
    preserveSentences: true,
    wordBoundary: true,
  });
  // Should keep just the first sentence due to important prefix
  expect(truncated).toBe("❌ Failure: Something bad happened.");
});

test("handleCallbackErrorSafe responds with account not found message", async () => {
  let answeredText: string | undefined;
  const ctx: any = {
    answerCallbackQuery: async (text: string) => {
      answeredText = text;
    },
  };

  const error = new Error("Account does not exist");

  await handleCallbackErrorSafe(ctx, error, "test action");

  expect(answeredText).toBe("This game is no longer active!");
});

describe("handleCallbackErrorSafe with a minimal environment", () => {
  beforeAll(() => {
    // Minimal env so dynamic imports in handler are safe
    process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
    process.env.MNEMONIC =
      process.env.MNEMONIC ||
      "test walk nut penalty hip pave soap entry language right filter choice";
  });

  test("handleCallbackErrorSafe: account not found shortcut", async () => {
    const calls: string[] = [];
    const ctx = {
      answerCallbackQuery: async (text: string) => {
        calls.push(text);
      },
    } as any;

    await handleCallbackErrorSafe(ctx, new Error("Account does not exist"), "join");

    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("no longer active");
  });

  test("handleCallbackErrorSafe: formats generic errors via utilities", async () => {
    const calls: string[] = [];
    const ctx = {
      answerCallbackQuery: async (text: string) => {
        calls.push(text);
      },
    } as any;

    await handleCallbackErrorSafe(
      ctx,
      new Error("simulation failed: custom program error: 0x1"),
      "swap",
      { maxLength: 200 },
    );

    expect(calls.length).toBe(1);
    // Default formatter in errors.ts for simulation/custom program errors
    expect(calls[0]).toContain("Transaction failed");
  });

  test("handleCallbackErrorSafe uses Telegram API fallback when direct helper missing", async () => {
    const answered: { id: string; text: string }[] = [];
    const originalError = console.error;

    try {
      console.error = () => {};
      const ctx = {
        api: {
          answerCallbackQuery: async (id: string, opts: { text: string }) => {
            answered.push({ id, text: opts.text });
          },
        },
        callbackQuery: { id: "cb-123" },
      };

      await handleCallbackErrorSafe(
        ctx,
        new Error(
          "Unhandled failure that should be relayed back to the user with truncation safeguards in place.",
        ),
        "fallback",
        { maxLength: 60 },
      );

      expect(answered.length).toBe(1);
      const firstCall = answered[0];
      expect(firstCall).toBeDefined();
      expect(firstCall!.id).toBe("cb-123");
      expect(firstCall!.text.length).toBeGreaterThan(0);
    } finally {
      console.error = originalError;
    }
  });

  test("handleCallbackErrorSafe logs a warning when no callback answer is possible", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;

    try {
      console.warn = (...args: any[]) => warnings.push(args.join(" "));
      console.error = () => {};

      await handleCallbackErrorSafe(
        {},
        new Error("Generic failure that should trigger a warning path"),
        "missing-context",
        { maxLength: 30 },
      );

      expect(warnings.some((msg) => msg.includes("Unable to answer callback query"))).toBe(true);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
  });

  test("handleCallbackErrorSafe swallows failures thrown while answering callback", async () => {
    const errorLogs: string[] = [];
    const originalError = console.error;
    let attempts = 0;

    try {
      console.error = (...args: any[]) => errorLogs.push(args.join(" "));
      const ctx = {
        answerCallbackQuery: async () => {
          attempts += 1;
          throw new Error("telegram down");
        },
      } as any;

      await handleCallbackErrorSafe(ctx, new Error("Unexpected runtime failure"), "answer-error");

      expect(attempts).toBe(1);
      expect(errorLogs.some((msg) => msg.includes("Failed to answer callback query"))).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
