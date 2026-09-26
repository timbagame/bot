/**
 * Collapses every `setTimeout` delay to 0ms so retry/backoff/poll sleeps in the
 * code under test do not burn wall-clock time. Callbacks still run
 * asynchronously (on a real 0ms timer), so ordering relative to promises is
 * preserved. Requested delays are recorded in `delays`. Call `restore()` in
 * `afterEach` (or a `finally`).
 */
export const stubInstantTimers = () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    delays.push(ms ?? 0);
    return originalSetTimeout(callback, 0, ...args);
  }) as typeof setTimeout;
  return {
    delays,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout;
    },
  };
};
