import { USER_WALLET_RPC_WINDOW_MS } from "./constants";

export type RateLimiterConsumeResult = {
  allowed: boolean;
  remaining: number;
  resetInMs: number;
};

export class RateLimitExceededError extends Error {
  public readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RateLimitExceededError";
    this.retryAfterMs = Math.max(0, Math.round(retryAfterMs));
  }
}

type SlidingWindowEntry = {
  windowStart: number;
  count: number;
};

export class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, SlidingWindowEntry>();

  constructor(windowMs: number = USER_WALLET_RPC_WINDOW_MS, now: () => number = () => Date.now()) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("SlidingWindowRateLimiter requires a positive window duration");
    }
    this.windowMs = windowMs;
    this.now = now;
  }

  consume(key: string | number | bigint, limit: number): RateLimiterConsumeResult {
    const normalizedKey = typeof key === "bigint" ? key.toString() : String(key);
    const normalizedLimit = Number(limit);

    if (!Number.isFinite(normalizedLimit) || normalizedLimit <= 0) {
      return { allowed: false, remaining: 0, resetInMs: this.windowMs };
    }

    const now = this.now();
    const entry = this.buckets.get(normalizedKey);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.buckets.set(normalizedKey, { windowStart: now, count: 1 });
      return {
        allowed: true,
        remaining: Math.max(0, normalizedLimit - 1),
        resetInMs: this.windowMs,
      };
    }

    if (entry.count >= normalizedLimit) {
      const resetInMs = Math.max(entry.windowStart + this.windowMs - now, 0);
      return { allowed: false, remaining: 0, resetInMs };
    }

    entry.count += 1;
    const remaining = Math.max(0, normalizedLimit - entry.count);
    const resetInMs = Math.max(entry.windowStart + this.windowMs - now, 0);
    return { allowed: true, remaining, resetInMs };
  }

  reset(key?: string | number | bigint): void {
    if (typeof key === "undefined") {
      this.buckets.clear();
      return;
    }
    const normalizedKey = typeof key === "bigint" ? key.toString() : String(key);
    this.buckets.delete(normalizedKey);
  }

  getActiveEntries(): number {
    return this.buckets.size;
  }
}
