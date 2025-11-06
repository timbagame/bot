import { describe, expect, test } from "bun:test";

import { SlidingWindowRateLimiter } from "../src/utils/rate-limiter";

describe("SlidingWindowRateLimiter", () => {
  test("enforces budget within the configured window", () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(1_000, () => now);
    const budget = 3;

    expect(limiter.consume("user", budget)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect(limiter.consume("user", budget)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(limiter.consume("user", budget)).toMatchObject({
      allowed: true,
      remaining: 0,
    });

    const blocked = limiter.consume("user", budget);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetInMs).toBeGreaterThan(0);

    now = 1_000;
    const afterReset = limiter.consume("user", budget);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(budget - 1);
  });

  test("maintains independent windows per key", () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(2_000, () => now);
    const budget = 2;

    expect(limiter.consume("user-a", budget).allowed).toBe(true);
    expect(limiter.consume("user-b", budget).allowed).toBe(true);
    expect(limiter.consume("user-a", budget).allowed).toBe(true);
    expect(limiter.consume("user-a", budget).allowed).toBe(false);

    now = 2_000;
    expect(limiter.consume("user-a", budget).allowed).toBe(true);
    expect(limiter.consume("user-b", budget).allowed).toBe(true);
  });

  test("denies simultaneous consumes beyond limit", async () => {
    let now = 0;
    const limiter = new SlidingWindowRateLimiter(1_000, () => now);
    const budget = 1;

    const results = await Promise.all(
      Array.from({ length: 2 }, () => {
        return new Promise(resolve => {
          setTimeout(() => resolve(limiter.consume("user", budget)), 0);
        });
      }),
    );

    const allowedCount = results.filter((result: any) => result.allowed).length;
    expect(allowedCount).toBe(1);
    expect(results.some((result: any) => !result.allowed)).toBe(true);
  });
});
