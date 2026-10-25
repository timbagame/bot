import { describe, expect, test } from "bun:test";
import { SlidingWindowRateLimiter } from "../src/utils/rate-limiter";

describe("SlidingWindowRateLimiter edge cases", () => {
  test("rejects a window that is not a positive finite duration", () => {
    for (const windowMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new SlidingWindowRateLimiter(windowMs)).toThrow(
        "SlidingWindowRateLimiter requires a positive window duration",
      );
    }
  });

  test("an expired bucket that was not pruned yet starts a fresh window", () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(1_000, () => now);

    // Seeds the map without pruning (the map was empty).
    limiter.consume("seed", 5);
    now = 500;
    expect(limiter.consume("user", 2)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume("user", 2)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume("user", 2).allowed).toBe(false);

    // This prune pass removes "seed" only. "user" is still inside its window.
    now = 1_000;
    limiter.consume("other", 5);
    expect(limiter.getActiveEntries()).toBe(2);

    // "user" expired at 1500 but the prune pass is throttled, so consume itself resets it.
    now = 1_500;
    expect(limiter.consume("user", 2)).toEqual({ allowed: true, remaining: 1, resetInMs: 1_000 });
  });

  test("the default clock is the wall clock", () => {
    const limiter = new SlidingWindowRateLimiter(60_000);
    expect(limiter.consume("wall", 1).allowed).toBe(true);
    expect(limiter.consume("wall", 1).allowed).toBe(false);
  });
});
