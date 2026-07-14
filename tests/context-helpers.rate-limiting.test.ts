/**
 * Tests for safeAnswerCallbackQuery rate limiting and throttling integration
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  safeAnswerCallbackQuery,
  safeAnswerCallbackQueryThrottled,
} from "../src/utils/context-helpers";
import {
  __test_resetGlobals,
  getRateLimiter,
  initCallbackQueue,
} from "../src/utils/telegram-rate-limiter";

describe("safeAnswerCallbackQuery with rate limiting", () => {
  beforeEach(() => {
    __test_resetGlobals();
  });

  afterEach(() => {
    __test_resetGlobals();
  });

  describe("rate limit tracking", () => {
    it("skips callback answer when chat is rate limited", async () => {
      const rateLimiter = getRateLimiter();
      rateLimiter.recordRateLimit(30, 12345); // Rate limit chat 12345 for 30s

      const answerCalls: any[] = [];
      const ctx = {
        chat: { id: 12345 },
        callbackQuery: { id: "cb123" },
        answerCallbackQuery: async (text?: string) => {
          answerCalls.push(text);
        },
      };

      // Capture console.warn
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));

      try {
        await safeAnswerCallbackQuery(ctx, "Test message");

        // Should NOT have called answerCallbackQuery
        expect(answerCalls).toHaveLength(0);

        // Should have logged rate limit skip
        expect(warnings.some((w) => w.includes("rate limited"))).toBe(true);
        expect(warnings.some((w) => w.includes("12345"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("records rate limit when 429 error is received", async () => {
      const rateLimiter = getRateLimiter();

      const ctx = {
        chat: { id: 99999 },
        callbackQuery: { id: "cb456" },
        answerCallbackQuery: async () => {
          const error = new Error("Too Many Requests: retry after 25") as any;
          error.error_code = 429;
          error.parameters = { retry_after: 25 };
          throw error;
        },
      };

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));

      try {
        await safeAnswerCallbackQuery(ctx, "Will trigger 429");

        // Should have recorded rate limit
        expect(rateLimiter.isLimited(99999)).toBe(true);
        expect(rateLimiter.getWaitTimeMs(99999)).toBeGreaterThan(20000);

        // Should have logged the rate limit
        expect(warnings.some((w) => w.includes("rate limited"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("proceeds when chat is not rate limited", async () => {
      const answerCalls: any[] = [];
      const ctx = {
        chat: { id: 77777 },
        callbackQuery: { id: "cb789" },
        answerCallbackQuery: async (text?: string) => {
          answerCalls.push(text);
        },
      };

      await safeAnswerCallbackQuery(ctx, "Normal message");

      expect(answerCalls).toEqual(["Normal message"]);
    });
  });

  describe("callback expired error handling", () => {
    it("handles query is too old gracefully", async () => {
      const ctx = {
        chat: { id: 111 },
        callbackQuery: { id: "old_cb" },
        answerCallbackQuery: async () => {
          throw new Error("query is too old");
        },
      };

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));

      try {
        // Should not throw
        await safeAnswerCallbackQuery(ctx, "Expired query");

        expect(warnings.some((w) => w.includes("Callback query timeout"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });

    it("handles query_id_invalid gracefully", async () => {
      const ctx = {
        chat: { id: 222 },
        callbackQuery: { id: "invalid_cb" },
        answerCallbackQuery: async () => {
          throw new Error("query_id_invalid");
        },
      };

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));

      try {
        await safeAnswerCallbackQuery(ctx, "Invalid query");

        expect(warnings.some((w) => w.includes("Callback query timeout"))).toBe(true);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe("queue integration", () => {
    it("uses queue when useQueue option is true and queue is initialized", async () => {
      const queuedItems: Array<{
        id: string;
        text?: string;
      }> = [];

      // Initialize the callback queue
      initCallbackQueue(async (id, text) => {
        queuedItems.push({ id, text });
        return true;
      });

      const ctx = {
        chat: { id: 333 },
        callbackQuery: { id: "queue_cb" },
        answerCallbackQuery: async () => {
          throw new Error("Should not be called directly");
        },
      };

      await safeAnswerCallbackQuery(ctx, "Queued message", { useQueue: true });

      // Wait for queue to process
      await new Promise((r) => setTimeout(r, 100));

      expect(queuedItems).toHaveLength(1);
      expect(queuedItems[0]).toEqual({ id: "queue_cb", text: "Queued message" });
    });

    it("falls back to direct call when queue is not initialized", async () => {
      __test_resetGlobals(); // Ensure queue is not initialized

      const answerCalls: any[] = [];
      const ctx = {
        chat: { id: 444 },
        callbackQuery: { id: "no_queue_cb" },
        answerCallbackQuery: async (text?: string) => {
          answerCalls.push(text);
        },
      };

      await safeAnswerCallbackQuery(ctx, "Direct message", { useQueue: true });

      expect(answerCalls).toEqual(["Direct message"]);
    });
  });
});

describe("safeAnswerCallbackQueryThrottled", () => {
  beforeEach(() => {
    __test_resetGlobals();
  });

  afterEach(() => {
    __test_resetGlobals();
  });

  it("uses the queue automatically", async () => {
    const queuedItems: Array<{ id: string; text?: string }> = [];

    initCallbackQueue(async (id, text) => {
      queuedItems.push({ id, text });
      return true;
    });

    const ctx = {
      chat: { id: 555 },
      callbackQuery: { id: "throttled_cb" },
      answerCallbackQuery: async () => {
        throw new Error("Should not be called directly");
      },
    };

    await safeAnswerCallbackQueryThrottled(ctx, "Throttled message");

    // Wait for queue to process
    await new Promise((r) => setTimeout(r, 100));

    expect(queuedItems).toHaveLength(1);
    expect(queuedItems[0]).toEqual({
      id: "throttled_cb",
      text: "Throttled message",
    });
  });

  it("falls back to direct when queue not initialized", async () => {
    __test_resetGlobals();

    const answerCalls: any[] = [];
    const ctx = {
      chat: { id: 666 },
      callbackQuery: { id: "fallback_cb" },
      answerCallbackQuery: async (text?: string) => {
        answerCalls.push(text);
      },
    };

    await safeAnswerCallbackQueryThrottled(ctx, "Fallback message");

    expect(answerCalls).toEqual(["Fallback message"]);
  });
});

describe("rate limiter state persistence across calls", () => {
  beforeEach(() => {
    __test_resetGlobals();
  });

  it("maintains rate limit state across multiple calls", async () => {
    // First call triggers 429
    const ctx1 = {
      chat: { id: 888 },
      callbackQuery: { id: "cb1" },
      answerCallbackQuery: async () => {
        const error = new Error("Too Many Requests") as any;
        error.error_code = 429;
        error.parameters = { retry_after: 10 };
        throw error;
      },
    };

    await safeAnswerCallbackQuery(ctx1, "First call");

    // Second call should be skipped due to rate limit
    const answerCalls: any[] = [];
    const ctx2 = {
      chat: { id: 888 },
      callbackQuery: { id: "cb2" },
      answerCallbackQuery: async (text?: string) => {
        answerCalls.push(text);
      },
    };

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      await safeAnswerCallbackQuery(ctx2, "Second call");

      expect(answerCalls).toHaveLength(0);
      expect(warnings.some((w) => w.includes("rate limited") && w.includes("888"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("different chats have independent rate limits", async () => {
    // Rate limit chat 1000
    getRateLimiter().recordRateLimit(30, 1000);

    // Chat 1000 should be limited
    const calls1: any[] = [];
    const ctx1 = {
      chat: { id: 1000 },
      callbackQuery: { id: "limited_cb" },
      answerCallbackQuery: async (text?: string) => {
        calls1.push(text);
      },
    };

    // Chat 2000 should NOT be limited
    const calls2: any[] = [];
    const ctx2 = {
      chat: { id: 2000 },
      callbackQuery: { id: "unlimited_cb" },
      answerCallbackQuery: async (text?: string) => {
        calls2.push(text);
      },
    };

    await safeAnswerCallbackQuery(ctx1, "To limited chat");
    await safeAnswerCallbackQuery(ctx2, "To unlimited chat");

    expect(calls1).toHaveLength(0); // Skipped due to rate limit
    expect(calls2).toEqual(["To unlimited chat"]); // Proceeded normally
  });
});
