import { describe, expect, test } from "bun:test";
import { editMediaWithFallback } from "../src/utils/media";

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
