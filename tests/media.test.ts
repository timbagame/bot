import { describe, expect, test } from "bun:test";
import { editMediaWithFallback, enqueueMessageMediaEdit } from "../src/utils/media";

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

const createDeferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("enqueueMessageMediaEdit", () => {
  test("serializes edits and drops superseded pending entries", async () => {
    const key = "1:2";
    const steps: string[] = [];
    const firstDeferred = createDeferred<void>();

    const firstPromise = enqueueMessageMediaEdit(key, async () => {
      steps.push("first-start");
      await firstDeferred.promise;
      steps.push("first-end");
      return "first";
    });

    const secondPromise = enqueueMessageMediaEdit(key, async () => {
      steps.push("second");
      return "second";
    });

    const thirdPromise = enqueueMessageMediaEdit(key, async () => {
      steps.push("third");
      return "third";
    });

    const secondResult = await secondPromise;
    expect(secondResult).toEqual({ result: null, skipped: true });

    firstDeferred.resolve();

    const firstResult = await firstPromise;
    const thirdResult = await thirdPromise;

    expect(firstResult).toEqual({ result: "first", skipped: false });
    expect(thirdResult).toEqual({ result: "third", skipped: false });
    expect(steps).toEqual(["first-start", "first-end", "third"]);
  });

  test("runs queued edit when only one pending entry exists", async () => {
    const key = "3:4";
    const firstDeferred = createDeferred<void>();

    const firstPromise = enqueueMessageMediaEdit(key, async () => {
      await firstDeferred.promise;
      return "first";
    });

    const secondPromise = enqueueMessageMediaEdit(key, async () => "second");

    firstDeferred.resolve();

    const firstResult = await firstPromise;
    const secondResult = await secondPromise;

    expect(firstResult).toEqual({ result: "first", skipped: false });
    expect(secondResult).toEqual({ result: "second", skipped: false });
  });
});
