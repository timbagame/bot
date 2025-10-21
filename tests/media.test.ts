import { describe, expect, test } from "bun:test";
import {
  editMediaWithFallback,
  getTelegramErrorDescription,
  isMessageNotModifiedError,
  isTooManyRequestsError,
  parseRetryAfterSeconds,
} from "../src/utils/media";

describe("editMediaWithFallback", () => {
  test("retries edit when Telegram responds with 429", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number) => {
      delays.push(ms ?? 0);
      callback();
      return 0 as any;
    }) as any;

    let attempts = 0;
    const edit = async () => {
      attempts += 1;
      if (attempts < 3) {
        const error: any = new Error("Too Many Requests");
        error.error_code = 429;
        error.parameters = { retry_after: 2 };
        throw error;
      }
      return { ok: true };
    };

    try {
      const result = await editMediaWithFallback({ edit });
      expect(result).toEqual({ result: { ok: true }, usedFallback: false, skipped: false });
      expect(attempts).toBe(3);
      expect(delays).toEqual([2000, 2000]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

describe("telegram error helpers", () => {
  test("getTelegramErrorDescription reads description and message fields", () => {
    expect(getTelegramErrorDescription(null)).toBe("");
    expect(getTelegramErrorDescription({ description: "Bad Request" })).toBe(
      "Bad Request"
    );
    expect(getTelegramErrorDescription({ message: "Fallback" })).toBe("Fallback");
    expect(getTelegramErrorDescription({ description: 42 })).toBe("");
  });

  test("isTooManyRequestsError checks error code and description", () => {
    const errorWithCode: any = { error_code: 429 };
    expect(isTooManyRequestsError(errorWithCode)).toBe(true);
    const errorWithDescription: any = {
      description: "429: Too Many Requests: retry after 2",
    };
    expect(isTooManyRequestsError(errorWithDescription)).toBe(true);
    expect(isTooManyRequestsError({ description: "Bad Request" })).toBe(false);
  });

  test("parseRetryAfterSeconds extracts retry_after hints", () => {
    expect(parseRetryAfterSeconds(null)).toBe(1);
    expect(
      parseRetryAfterSeconds({ parameters: { retry_after: 5 } })
    ).toBe(5);
    expect(parseRetryAfterSeconds({ retry_after: 3 })).toBe(3);
    expect(
      parseRetryAfterSeconds({ description: "Please retry after 7 seconds" })
    ).toBe(7);
    expect(parseRetryAfterSeconds({ description: "no retry hint" })).toBe(1);
  });

  test("isMessageNotModifiedError detects message not modified responses", () => {
    expect(isMessageNotModifiedError(null)).toBe(false);
    expect(
      isMessageNotModifiedError({ description: "Bad Request: message is not modified" })
    ).toBe(true);
  });
});
