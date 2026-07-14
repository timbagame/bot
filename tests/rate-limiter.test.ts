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
    const now = 0;
    const limiter = new SlidingWindowRateLimiter(1_000, () => now);
    const budget = 1;

    const results = await Promise.all(
      Array.from({ length: 2 }, () => {
        return new Promise((resolve) => {
          setTimeout(() => resolve(limiter.consume("user", budget)), 0);
        });
      }),
    );

    const allowedCount = results.filter((result: any) => result.allowed).length;
    expect(allowedCount).toBe(1);
    expect(results.some((result: any) => !result.allowed)).toBe(true);
  });

  test("rejects invalid budgets before touching buckets", () => {
    const windowMs = 5_000;
    const limiter = new SlidingWindowRateLimiter(windowMs, () => 0);
    const invalidBudgets = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];

    for (const invalid of invalidBudgets) {
      const result = limiter.consume("user", invalid);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.resetInMs).toBe(windowMs);
    }

    expect(limiter.getActiveEntries()).toBe(0);

    const valid = limiter.consume("user", 1);
    expect(valid.allowed).toBe(true);
  });
});
