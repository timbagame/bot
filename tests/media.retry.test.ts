import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  awaitTelegramRetry,
  editMediaWithFallback,
  sendMediaWithFallback,
  trySendVideoWithFallback,
} from "../src/utils/media";

const originalSetTimeout = setTimeout;

describe("media retry helpers", () => {
  test("awaitTelegramRetry stops when error not retryable", async () => {
    let attempts = 0;
    const error = new Error("forbidden");
    await expect(
      awaitTelegramRetry(async () => {
        attempts += 1;
        throw error;
      }, { maxAttempts: 2 })
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
              awaitTelegramRetry(async () => {
                attempts += 1;
                throw err;
              }, { maxAttempts })
            ).rejects.toBe(err);

            expect(attempts).toBe(maxAttempts);
            if (maxAttempts > 1) {
              expect(delays.length).toBe(maxAttempts - 1);
              expect(delays.every((d) => d === retryAfter * 1000)).toBe(true);
            }
          } finally {
            globalThis.setTimeout = originalSetTimeout;
          }
        }
      ),
      { seed: 9123, numRuns: 15 }
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
      { logLabel: "test video" }
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
});
