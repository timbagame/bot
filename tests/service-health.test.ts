import { expect, test } from "bun:test";
import { checkServiceHealth } from "../src/utils/service-health";

test("checkServiceHealth returns true on ok: true", async () => {
  const okFetch = async () => ({ ok: true }) as any;
  const res = await checkServiceHealth("https://example.com/health", 100, okFetch as any);
  expect(res).toBe(true);
});

test("checkServiceHealth returns false on ok: false", async () => {
  const badFetch = async () => ({ ok: false }) as any;
  const res = await checkServiceHealth("https://example.com/health", 100, badFetch as any);
  expect(res).toBe(false);
});

test("checkServiceHealth handles errors and returns false", async () => {
  const throwingFetch = async () => {
    throw new Error("network");
  };
  const res = await checkServiceHealth("https://example.com/health", 100, throwingFetch as any);
  expect(res).toBe(false);
});

test("checkServiceHealth clears timeout when fetch rejects", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  const timers: Array<{ cleared?: boolean }> = [];

  globalThis.setTimeout = ((_fn: (...args: any[]) => void, _delay?: number) => {
    const timer = { cleared: false };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as any;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    const timer = id as unknown as { cleared?: boolean };
    timer.cleared = true;
  }) as any;

  try {
    const rejectingFetch = async () => {
      throw new Error("boom");
    };

    const res = await checkServiceHealth("https://example.com/health", 50, rejectingFetch as any);

    expect(res).toBe(false);
    expect(timers[0]?.cleared).toBe(true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
