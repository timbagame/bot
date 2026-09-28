import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  MISSING_TELEGRAM_ID_MESSAGE,
  containsBalanceInfo,
  createMessageEditAdapter,
  getRequiredTelegramIdForContext,
  getTelegramId,
  getTelegramIdString,
  resolveTelegramIdOrRespond,
  safeAnswerCallbackQuery,
} from "../src/utils/context-helpers";
import { __test_resetGlobals } from "../src/utils/telegram-rate-limiter";

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  __test_resetGlobals();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  __test_resetGlobals();
});

describe("getTelegramId unusual inputs", () => {
  test("truncates fractional numeric ids", () => {
    expect(getTelegramId({ from: { id: 42.9 } })).toBe(42n);
  });

  test("returns the fallback for blank strings, NaN and non-coercible objects", () => {
    expect(getTelegramId({ from: { id: "   " } }, 5n)).toBe(5n);
    expect(getTelegramId({ from: { id: Number.NaN } }, 5n)).toBe(5n);
    expect(getTelegramId({ from: { id: { valueOf: () => "x" } } }, 5n)).toBe(5n);
    expect(getTelegramId({ from: { id: Symbol("id") } }, 5n)).toBe(5n);
    expect(getTelegramId(null, 5n)).toBe(5n);
  });

  test("getTelegramIdString hides the missing-id sentinel", () => {
    expect(getTelegramIdString({ from: { id: 77 } })).toBe("77");
    expect(getTelegramIdString({})).toBeUndefined();
  });
});

describe("missing identity notifications", () => {
  test("falls back to the Bot API when the context cannot reply", async () => {
    const sendMessage = mock(async () => ({}));
    const ctx = { chat: { id: -5 }, message: { message_id: 8 }, api: { sendMessage } } as any;

    expect(await getRequiredTelegramIdForContext(ctx, "x")).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(-5, MISSING_TELEGRAM_ID_MESSAGE, {
      reply_to_message_id: 8,
      link_preview_options: { is_disabled: true },
    });
  });

  test("stays silent when there is no chat to notify", async () => {
    const sendMessage = mock(async () => ({}));

    expect(await getRequiredTelegramIdForContext({ api: { sendMessage } } as any, "x")).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  test("logs a failed notification instead of throwing", async () => {
    const ctx = {
      reply: async () => {
        throw new Error("blocked by user");
      },
    } as any;

    expect(await getRequiredTelegramIdForContext(ctx, "x")).toBeNull();
    expect(errorSpy.mock.calls[0]?.[0]).toBe("Failed to send missing-id notification:");
  });

  test("logs a failing onMissing handler instead of throwing", async () => {
    const result = await getRequiredTelegramIdForContext({} as any, "x", {
      onMissing: () => {
        throw new Error("handler broke");
      },
    });

    expect(result).toBeNull();
    expect(errorSpy.mock.calls[0]?.[0]).toBe("Missing Telegram ID handler failed:");
  });

  test("rethrows unexpected errors while reading the id", async () => {
    const ctx = {
      get from(): never {
        throw new Error("boom");
      },
    } as any;

    await expect(getRequiredTelegramIdForContext(ctx, "x")).rejects.toThrow("boom");
  });

  test("resolveTelegramIdOrRespond answers the callback and logs the context", async () => {
    const answerCallbackQuery = mock(async () => true);
    const ctx = {
      callbackQuery: { id: "cb" },
      answerCallbackQuery,
      reply: async () => ({}),
    } as any;

    expect(await resolveTelegramIdOrRespond(ctx, "wrap confirmation")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("Missing Telegram ID for wrap confirmation");
    expect(answerCallbackQuery).toHaveBeenCalledWith("❌ Unable to resolve Telegram identity");
  });

  test("resolveTelegramIdOrRespond uses a custom log message", async () => {
    const ctx = { callbackQuery: { id: "cb" }, answerCallbackQuery: async () => true } as any;

    await resolveTelegramIdOrRespond(ctx, "x", { logMessage: "custom", onMissing: () => {} });

    expect(warnSpy).toHaveBeenCalledWith("custom");
  });

  test("resolveTelegramIdOrRespond returns the id when present", async () => {
    expect(await resolveTelegramIdOrRespond({ from: { id: 9 } } as any, "x")).toBe(9n);
  });
});

describe("containsBalanceInfo", () => {
  test.each([
    ["Your balance is 3 SOL", true],
    ["Insufficient funds for fee", true],
    ["You have 1.5 SOL available", true],
    ["you have 10 lamports", true],
    ["You have 250 BONK in your wallet", true],
    ["Not enough to play: you have 3", true],
    ["You have 2 but need 5", true],
    ["You have joined the game", false],
    ["Something went wrong", false],
    ["", false],
  ])("%p -> %p", (text, expected) => {
    expect(containsBalanceInfo(text)).toBe(expected);
  });

  test("rejects non-string input", () => {
    expect(containsBalanceInfo(undefined as any)).toBe(false);
  });
});

describe("createMessageEditAdapter", () => {
  test("requires a chat id", () => {
    expect(() => createMessageEditAdapter({ api: {} } as any, 1)).toThrow(
      "Cannot create edit adapter without a valid chat id",
    );
  });

  test("uses an explicit chat id when the context has no chat", async () => {
    const editMessageText = mock(async () => true);

    const adapter = createMessageEditAdapter({ api: { editMessageText } } as any, 7, -9);
    await adapter.editMessageText("hi", { parse_mode: "HTML" });

    expect(adapter.chat).toEqual({ id: -9 } as any);
    expect(editMessageText).toHaveBeenCalledWith(-9, 7, "hi", { parse_mode: "HTML" });
  });
});

describe("safeAnswerCallbackQuery error handling", () => {
  const failing = (error: unknown) =>
    ({
      callbackQuery: { id: "cb" },
      answerCallbackQuery: async () => {
        throw error;
      },
    }) as any;

  test("treats any 400 response as an expired query and previews long text", async () => {
    await safeAnswerCallbackQuery(
      failing({ error_code: 400, description: "Bad Request" }),
      "x".repeat(60),
    );

    expect(warnSpy).toHaveBeenCalledWith(`⚠️ Callback query timeout: ${"x".repeat(50)}...`);
  });

  test("recognises an invalid query id description", async () => {
    await safeAnswerCallbackQuery(failing({ description: "Bad Request: query ID is invalid" }));

    expect(warnSpy).toHaveBeenCalledWith("⚠️ Callback query timeout: ");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("logs other failures", async () => {
    const error = { error_code: 500, description: "Internal" };

    await safeAnswerCallbackQuery(failing(error), "hi");

    expect(errorSpy).toHaveBeenCalledWith("Failed to answer callback query:", error);
  });

  test("warns when the context cannot answer at all", async () => {
    await safeAnswerCallbackQuery({ callbackQuery: { id: "cb" } }, "hi");

    expect(warnSpy).toHaveBeenCalledWith("Unable to answer callback query - invalid context");
  });
});
