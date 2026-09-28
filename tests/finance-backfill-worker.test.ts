import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  FinanceBackfillWorker,
  financeBackfillRetryDelay,
} from "../src/services/finance-backfill-worker";

describe("finance backfill worker", () => {
  test("caps exponential retry delays", () => {
    expect(financeBackfillRetryDelay(1, 1_000, 8_000)).toBe(1_000);
    expect(financeBackfillRetryDelay(3, 1_000, 8_000)).toBe(4_000);
    expect(financeBackfillRetryDelay(8, 1_000, 8_000)).toBe(8_000);
  });

  test("exposes a single batch run for deterministic execution", async () => {
    const result = {
      complete: false,
      processedTransactions: 10,
      progress: {
        totalSources: 3,
        completedSources: 1,
        processedTransactions: 20,
        lastError: null,
      },
    };
    const worker = new FinanceBackfillWorker(async () => result);

    expect(await worker.runOnce()).toEqual(result);
  });
});

describe("finance backfill worker scheduling", () => {
  type Timer = { run: () => void; delay: number; cleared: boolean };
  let timers: Timer[];
  let setTimeoutSpy: ReturnType<typeof spyOn>;
  let clearTimeoutSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  const batch = (complete: boolean) => ({
    complete,
    processedTransactions: 5,
    progress: {
      totalSources: 4,
      completedSources: complete ? 4 : 2,
      processedTransactions: 9,
      lastError: null,
    },
  });
  const options = {
    initialDelayMs: 10,
    batchIntervalMs: 20,
    completeIntervalMs: 30,
    errorBaseDelayMs: 100,
    errorMaxDelayMs: 350,
  };
  const fire = async () => {
    const timer = timers.at(-1)!;
    timer.run();
    // Let the async batch settle and schedule the next timer.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const delays = () => timers.map((timer) => timer.delay);

  beforeEach(() => {
    timers = [];
    setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      delay: number,
    ) => {
      const timer: Timer = { run: fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    }) as any);
    clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: Timer) => {
      timer.cleared = true;
    }) as any);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("uses the documented defaults when no options are given", () => {
    const worker = new FinanceBackfillWorker(async () => batch(false));

    worker.start();

    expect(delays()).toEqual([10_000]);
    worker.stop();
  });

  test("start is idempotent and waits the initial delay", () => {
    const worker = new FinanceBackfillWorker(async () => batch(false), options);

    worker.start();
    worker.start();

    expect(delays()).toEqual([10]);
    worker.stop();
  });

  test("keeps batching until complete, then slows to the complete interval", async () => {
    const results = [batch(false), batch(true)];
    const worker = new FinanceBackfillWorker(async () => results.shift()!, options);

    worker.start();
    await fire();
    await fire();

    expect(delays()).toEqual([10, 20, 30]);
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      "Finance backfill: 2/4 sources complete, 9 transactions indexed",
    );
    worker.stop();
  });

  test("backs off exponentially on errors, caps the delay and resets after a success", async () => {
    let failures = 3;
    const worker = new FinanceBackfillWorker(async () => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("rpc down");
      }
      return batch(false);
    }, options);

    worker.start();
    await fire();
    await fire();
    await fire();
    await fire();

    expect(delays()).toEqual([10, 100, 200, 350, 20]);
    expect(warnSpy.mock.calls[0]).toEqual(["Finance backfill paused for 0s:", expect.any(Error)]);
    worker.stop();
  });

  test("stop cancels the pending timer and prevents rescheduling", async () => {
    const worker = new FinanceBackfillWorker(async () => batch(false), options);

    worker.start();
    const pending = timers[0]!;
    worker.stop();
    expect(pending.cleared).toBe(true);

    // A batch that was already running when stop() was called does not reschedule.
    await fire();
    expect(delays()).toEqual([10]);
  });

  test("stop before start is harmless and start still works afterwards", () => {
    const worker = new FinanceBackfillWorker(async () => batch(false), options);

    worker.stop();
    worker.start();

    expect(delays()).toEqual([10]);
    worker.stop();
  });
});
