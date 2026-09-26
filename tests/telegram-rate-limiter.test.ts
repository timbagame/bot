/**
 * Tests for Telegram Rate Limiter utilities
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  TelegramRateLimiter,
  CallbackAnswerQueue,
  GameOperationQueue,
  createNextGuard,
  isCallbackExpiredError,
  isRateLimitError,
  extractRetryAfter,
  __test_resetGlobals,
  getRateLimiter,
  getGameOperationQueue,
} from "../src/utils/telegram-rate-limiter";

describe("TelegramRateLimiter", () => {
  let limiter: TelegramRateLimiter;

  beforeEach(() => {
    limiter = new TelegramRateLimiter();
    __test_resetGlobals();
  });

  describe("isLimited", () => {
    test("returns false when no limit is set", () => {
      expect(limiter.isLimited(123)).toBe(false);
      expect(limiter.isLimited()).toBe(false);
    });

    test("returns true when chat is rate limited", () => {
      limiter.recordRateLimit(5, 123);
      expect(limiter.isLimited(123)).toBe(true);
      expect(limiter.isLimited(456)).toBe(false);
    });

    test("returns true when globally rate limited", () => {
      limiter.recordRateLimit(5);
      expect(limiter.isLimited(123)).toBe(true);
      expect(limiter.isLimited()).toBe(true);
    });

    test("returns false after limit expires", async () => {
      limiter.recordRateLimit(0.01, 123); // 10ms
      expect(limiter.isLimited(123)).toBe(true);
      await new Promise((r) => setTimeout(r, 15));
      expect(limiter.isLimited(123)).toBe(false);
    });
  });

  describe("getWaitTimeMs", () => {
    test("returns 0 when no limit", () => {
      expect(limiter.getWaitTimeMs(123)).toBe(0);
    });

    test("returns remaining time when limited", () => {
      limiter.recordRateLimit(1, 123);
      const wait = limiter.getWaitTimeMs(123);
      expect(wait).toBeGreaterThan(900);
      expect(wait).toBeLessThanOrEqual(1000);
    });
  });

  describe("recordRateLimit", () => {
    test("records per-chat limit", () => {
      limiter.recordRateLimit(2, 123);
      expect(limiter.isLimited(123)).toBe(true);
      expect(limiter.isLimited(456)).toBe(false);
    });

    test("records global limit without chatId", () => {
      limiter.recordRateLimit(2);
      expect(limiter.isLimited(123)).toBe(true);
      expect(limiter.isLimited()).toBe(true);
    });
  });

  describe("clearLimit", () => {
    test("clears per-chat limit", () => {
      limiter.recordRateLimit(5, 123);
      limiter.clearLimit(123);
      expect(limiter.isLimited(123)).toBe(false);
    });

    test("clears global limit", () => {
      limiter.recordRateLimit(5);
      limiter.clearLimit();
      expect(limiter.isLimited()).toBe(false);
    });
  });

  describe("clearAll", () => {
    test("clears all limits", () => {
      limiter.recordRateLimit(5, 123);
      limiter.recordRateLimit(5, 456);
      limiter.recordRateLimit(5);
      limiter.clearAll();
      expect(limiter.isLimited(123)).toBe(false);
      expect(limiter.isLimited(456)).toBe(false);
      expect(limiter.isLimited()).toBe(false);
    });
  });

  describe("throttle", () => {
    test("executes immediately when not limited", async () => {
      const result = await limiter.throttle(123, async () => "success");
      expect(result).toBe("success");
    });

    test("throws when limit exceeds maxWait", async () => {
      limiter.recordRateLimit(10, 123);
      await expect(limiter.throttle(123, async () => "success", { maxWait: 100 })).rejects.toThrow(
        /exceeds max wait/,
      );
    });

    test("waits when limited but within maxWait", async () => {
      limiter.recordRateLimit(0.05, 123); // 50ms
      const start = Date.now();
      const result = await limiter.throttle(123, async () => "success", {
        maxWait: 1000,
      });
      expect(result).toBe("success");
      expect(Date.now() - start).toBeGreaterThanOrEqual(45);
    });
  });
});

describe("CallbackAnswerQueue", () => {
  let answerCalls: Array<{ id: string; text?: string; showAlert?: boolean }>;
  let queue: CallbackAnswerQueue;

  beforeEach(() => {
    answerCalls = [];
    queue = new CallbackAnswerQueue({
      answerFn: async (id, text, showAlert) => {
        answerCalls.push({ id, text, showAlert });
        return true;
      },
      throttleMs: 10,
      maxSize: 5,
    });
  });

  test("processes enqueued callbacks", async () => {
    queue.enqueue("cb1", "Hello");
    await new Promise((r) => setTimeout(r, 50));
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0]).toEqual({ id: "cb1", text: "Hello", showAlert: undefined });
  });

  test("throttles between callbacks", async () => {
    queue.enqueue("cb1", "First");
    queue.enqueue("cb2", "Second");
    queue.enqueue("cb3", "Third");
    await new Promise((r) => setTimeout(r, 100));
    expect(answerCalls).toHaveLength(3);
  });

  test("drops oldest when queue is full", () => {
    for (let i = 0; i < 10; i++) {
      queue.enqueue(`cb${i}`, `msg${i}`);
    }
    // Queue max is 5, so first 5 should be dropped
    expect(queue.length).toBeLessThanOrEqual(5);
  });

  test("clears the queue", () => {
    queue.enqueue("cb1", "test");
    queue.clear();
    expect(queue.length).toBe(0);
    expect(queue.isProcessing).toBe(false);
  });

  test("handles callback answer errors gracefully", async () => {
    let callCount = 0;
    const errorQueue = new CallbackAnswerQueue({
      answerFn: async () => {
        callCount++;
        throw new Error("Test error");
      },
      throttleMs: 5,
    });

    errorQueue.enqueue("cb1", "test");
    await new Promise((r) => setTimeout(r, 50));
    expect(callCount).toBe(1);
    // Should not throw, just log warning
  });

  test("ignores callback expired errors silently", async () => {
    let callCount = 0;
    const errorQueue = new CallbackAnswerQueue({
      answerFn: async () => {
        callCount++;
        throw new Error("query is too old");
      },
      throttleMs: 5,
    });

    errorQueue.enqueue("cb1", "test");
    await new Promise((r) => setTimeout(r, 50));
    expect(callCount).toBe(1);
  });
});

describe("GameOperationQueue", () => {
  let queue: GameOperationQueue;

  beforeEach(() => {
    queue = new GameOperationQueue({ timeoutMs: 500 });
    __test_resetGlobals();
  });

  test("executes operations immediately when no lock", async () => {
    const result = await queue.withLock("game1", "test op", async () => "success");
    expect(result).toBe("success");
    expect(queue.isLocked("game1")).toBe(false);
  });

  test("serializes operations on the same game", async () => {
    const order: number[] = [];

    const op1 = queue.withLock("game1", "op1", async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
      return 1;
    });

    const op2 = queue.withLock("game1", "op2", async () => {
      order.push(2);
      return 2;
    });

    const [r1, r2] = await Promise.all([op1, op2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(order).toEqual([1, 2]); // Must be in order
  });

  test("allows parallel operations on different games", async () => {
    const order: string[] = [];

    const op1 = queue.withLock("game1", "op1", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("game1");
    });

    const op2 = queue.withLock("game2", "op2", async () => {
      order.push("game2");
    });

    await Promise.all([op1, op2]);
    // game2 should complete before game1 since they run in parallel
    expect(order[0]).toBe("game2");
    expect(order[1]).toBe("game1");
  });

  test("releases lock after error", async () => {
    try {
      await queue.withLock("game1", "error op", async () => {
        throw new Error("Test error");
      });
    } catch {
      // Expected
    }
    expect(queue.isLocked("game1")).toBe(false);
  });

  test("reports active locks count", async () => {
    expect(queue.activeLocks).toBe(0);

    const op = queue.withLock("game1", "count op", async () => {
      expect(queue.activeLocks).toBe(1);
      await new Promise((r) => setTimeout(r, 20));
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(queue.activeLocks).toBe(1);

    await op;
    expect(queue.activeLocks).toBe(0);
  });

  test("clears all locks", async () => {
    const op1 = queue.withLock("game1", "clear op1", async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    const op2 = queue.withLock("game2", "clear op2", async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    await new Promise((r) => setTimeout(r, 10));
    queue.clear();
    expect(queue.activeLocks).toBe(0);

    // Operations should still complete
    await Promise.all([op1, op2]);
  });

  test("times out stuck operations", async () => {
    const fastQueue = new GameOperationQueue({ timeoutMs: 50 });

    let completed = false;
    const op = fastQueue.withLock("game1", "timeout op", async () => {
      await new Promise((r) => setTimeout(r, 200));
      completed = true;
    });

    await new Promise((r) => setTimeout(r, 100));
    // Lock should have timed out by now
    expect(fastQueue.isLocked("game1")).toBe(false);

    // But the operation continues
    await op;
    expect(completed).toBe(true);
  });
});

describe("createNextGuard", () => {
  test("calls next once", async () => {
    let callCount = 0;
    const next = async () => {
      callCount++;
    };

    const guarded = createNextGuard(next);
    await guarded();
    expect(callCount).toBe(1);
  });

  test("ignores duplicate calls", async () => {
    let callCount = 0;
    const next = async () => {
      callCount++;
    };

    const guarded = createNextGuard(next);
    await guarded();
    await guarded();
    await guarded();
    expect(callCount).toBe(1);
  });

  test("logs warning on duplicate call", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));

    try {
      const guarded = createNextGuard(async () => {}, "test-label");
      await guarded();
      await guarded();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("already called");
      expect(warnings[0]).toContain("test-label");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("Error helpers", () => {
  describe("isCallbackExpiredError", () => {
    test("returns true for query_id_invalid", () => {
      expect(isCallbackExpiredError(new Error("query_id_invalid"))).toBe(true);
    });

    test("returns true for query is too old", () => {
      expect(isCallbackExpiredError(new Error("Query is too old"))).toBe(true);
    });

    test("returns true for callback query expired", () => {
      expect(isCallbackExpiredError(new Error("callback query expired"))).toBe(true);
    });

    test("returns false for other errors", () => {
      expect(isCallbackExpiredError(new Error("some other error"))).toBe(false);
    });

    test("returns false for non-Error objects", () => {
      expect(isCallbackExpiredError("string error")).toBe(false);
      expect(isCallbackExpiredError(null)).toBe(false);
    });
  });

  describe("isRateLimitError", () => {
    test("returns true for 429 in message", () => {
      expect(isRateLimitError(new Error("Error 429"))).toBe(true);
    });

    test("returns true for Too Many Requests", () => {
      expect(isRateLimitError(new Error("Too Many Requests"))).toBe(true);
    });

    test("returns true for error_code 429", () => {
      const error = new Error("Rate limited") as any;
      error.error_code = 429;
      expect(isRateLimitError(error)).toBe(true);
    });

    test("returns false for other errors", () => {
      expect(isRateLimitError(new Error("Not found"))).toBe(false);
    });
  });

  describe("extractRetryAfter", () => {
    test("extracts from message pattern", () => {
      expect(extractRetryAfter(new Error("retry after 30"))).toBe(30);
      expect(extractRetryAfter(new Error("Retry After 45"))).toBe(45);
    });

    test("extracts from parameters object", () => {
      const error = new Error("Rate limited") as any;
      error.parameters = { retry_after: 25 };
      expect(extractRetryAfter(error)).toBe(25);
    });

    test("returns null when not found", () => {
      expect(extractRetryAfter(new Error("No retry info"))).toBe(null);
    });

    test("returns null for non-Error objects", () => {
      expect(extractRetryAfter("string")).toBe(null);
    });
  });
});

describe("Singleton getters", () => {
  beforeEach(() => {
    __test_resetGlobals();
  });

  test("getRateLimiter returns same instance", () => {
    const limiter1 = getRateLimiter();
    const limiter2 = getRateLimiter();
    expect(limiter1).toBe(limiter2);
  });

  test("getGameOperationQueue returns same instance", () => {
    const queue1 = getGameOperationQueue();
    const queue2 = getGameOperationQueue();
    expect(queue1).toBe(queue2);
  });
});
