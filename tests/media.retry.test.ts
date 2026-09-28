import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import {
  awaitTelegramRetry,
  editMediaWithFallback,
  isRecoverableMediaError,
  sendMediaWithFallback,
  trySendVideoWithFallback,
} from "../src/utils/media";

const originalSetTimeout = setTimeout;

describe("media retry helpers", () => {
  test("awaitTelegramRetry stops when error not retryable", async () => {
    let attempts = 0;
    const error = new Error("forbidden");
    await expect(
      awaitTelegramRetry(
        async () => {
          attempts += 1;
          throw error;
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(1);
  });

  test("awaitTelegramRetry respects retry-after metadata (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 5 }),
        async (maxAttempts: number, retryAfter: number) => {
          const delays: number[] = [];
          // @ts-ignore override timers for deterministic measurement
          globalThis.setTimeout = ((cb: (...args: any[]) => void, ms?: number) => {
            delays.push(ms ?? 0);
            cb();
            return 0 as any;
          }) as any;

          const err: any = new Error(`Too many requests: retry after ${retryAfter}`);
          err.error_code = 429;

          let attempts = 0;
          try {
            await expect(
              awaitTelegramRetry(
                async () => {
                  attempts += 1;
                  throw err;
                },
                { maxAttempts },
              ),
            ).rejects.toBe(err);

            expect(attempts).toBe(maxAttempts);
            if (maxAttempts > 1) {
              expect(delays.length).toBe(maxAttempts - 1);
              expect(delays.every((d) => d === retryAfter * 1000)).toBe(true);
            }
          } finally {
            globalThis.setTimeout = originalSetTimeout;
          }
        },
      ),
      { seed: 9123, numRuns: 15 },
    );
  });

  test("trySendVideoWithFallback returns fallback on recoverable error", async () => {
    const error: any = new Error("wrong file identifier");
    error.description = "Bad Request: wrong file identifier specified";

    let fallbackCalls = 0;
    const result = await trySendVideoWithFallback(
      async () => {
        throw error;
      },
      async () => {
        fallbackCalls += 1;
        return { text: "fallback" };
      },
      { logLabel: "test video" },
    );

    expect(result).toEqual({ result: { text: "fallback" }, usedFallback: true });
    expect(fallbackCalls).toBe(1);
  });

  test("sendMediaWithFallback skips edit when message unchanged", async () => {
    const response = await sendMediaWithFallback({
      videoFileId: "abc",
      sendText: async () => ({ text: "sent" }),
      sendVideo: async () => ({ id: "video" }),
      editMessage: async () => {
        const err: any = new Error("Message is not modified");
        err.description = "Bad Request: message is not modified";
        throw err;
      },
    });

    expect(response).toEqual({
      result: null,
      usedVideo: false,
      usedFallback: false,
      skippedEdit: true,
    });
  });

  test("sendMediaWithFallback falls back when video send unavailable", async () => {
    const result = await sendMediaWithFallback({
      videoFileId: null,
      sendText: async () => ({ ok: true }),
    });

    expect(result).toEqual({
      result: { ok: true },
      usedVideo: false,
      usedFallback: true,
      skippedEdit: false,
    });
  });

  test("editMediaWithFallback triggers onFallback hook when recovery happens", async () => {
    let hookCalled = 0;
    const error: any = new Error("wrong file id");
    error.description = "Bad Request: wrong file id";

    const result = await editMediaWithFallback({
      edit: async () => {
        throw error;
      },
      fallback: async () => ({ id: "new" }),
      onFallback: () => {
        hookCalled += 1;
      },
    });

    expect(result).toEqual({ result: { id: "new" }, usedFallback: true, skipped: false });
    expect(hookCalled).toBe(1);
  });
  test("awaitTelegramRetry rethrows the last 429 once attempts are exhausted", async () => {
    let attempts = 0;
    const error: any = new Error("Too Many Requests");
    error.error_code = 429;
    error.parameters = { retry_after: 0 };

    await expect(
      awaitTelegramRetry(
        async () => {
          attempts += 1;
          throw error;
        },
        { maxAttempts: 2 },
      ),
    ).rejects.toBe(error);
    expect(attempts).toBe(2);
  });

  test("awaitTelegramRetry waits one second when a 429 carries no retry-after hint", async () => {
    const delays: number[] = [];
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      callback();
      return 0 as any;
    }) as any;
    let attempts = 0;
    try {
      const result = await awaitTelegramRetry(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error("Too Many Requests"), { error_code: 429 });
        }
        return "sent";
      });
      expect(result).toBe("sent");
      expect(delays).toEqual([1000]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("isRecoverableMediaError ignores unchanged messages and empty errors", () => {
    expect(isRecoverableMediaError(null)).toBe(false);
    expect(isRecoverableMediaError({})).toBe(false);
    expect(
      isRecoverableMediaError({
        description: "Bad Request: message is not modified: there is no caption in the message",
      }),
    ).toBe(false);
    expect(isRecoverableMediaError({ description: "Bad Request: wrong file id" })).toBe(true);
  });

  test("trySendVideoWithFallback rethrows unrecoverable errors without falling back", async () => {
    const error = new Error("Forbidden: bot was blocked by the user");
    let fallbackCalls = 0;

    await expect(
      trySendVideoWithFallback(
        async () => {
          throw error;
        },
        async () => {
          fallbackCalls += 1;
          return "text";
        },
      ),
    ).rejects.toBe(error);
    expect(fallbackCalls).toBe(0);
  });

  test("sendMediaWithFallback sends a new video when the edit fails unrecoverably", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const editError = new Error("Bad Request: message can't be edited");
    let textCalls = 0;
    try {
      const response = await sendMediaWithFallback({
        videoFileId: "abc",
        logLabel: "game card",
        sendText: async () => {
          textCalls += 1;
          return { text: "sent" };
        },
        sendVideo: async () => ({ id: "video" }),
        editMessage: async () => {
          throw editError;
        },
      });

      expect(response).toEqual({
        result: { id: "video" },
        usedVideo: true,
        usedFallback: false,
        skippedEdit: false,
      });
      expect(textCalls).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith("game card edit failed, attempting send", editError);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
