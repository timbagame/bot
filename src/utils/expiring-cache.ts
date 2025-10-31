export interface ExpiringCache<TValue> {
  setWithTTL(key: string, value: TValue, ttlMs?: number): void;
  get(key: string): TValue | undefined;
  /**
   * Return the most recently cached value without considering TTL expiry.
   * Useful when a caller wants to fallback to stale data on upstream errors.
   */
  peek(key: string): TValue | undefined;
  delete(key: string): boolean;
  has(key: string): boolean;
  clear(): void;
}

const NO_TTL = 0;

class ExpiringCacheImpl<TValue> implements ExpiringCache<TValue> {
  private readonly entries = new Map<string, { value: TValue; expiresAt: number }>();
  private readonly staleEntries = new Map<string, TValue>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly defaultTtlMs: number) {}

  setWithTTL(key: string, value: TValue, ttlMs: number = this.defaultTtlMs): void {
    this.clearTimer(key);
    this.staleEntries.delete(key);

    const ttl = ttlMs > NO_TTL ? ttlMs : this.defaultTtlMs;
    const expiresAt = ttl > NO_TTL ? Date.now() + ttl : Number.POSITIVE_INFINITY;

    if (ttl > NO_TTL) {
      const timer = setTimeout(() => {
        const entry = this.entries.get(key);
        if (entry && entry.expiresAt <= Date.now()) {
          this.entries.delete(key);
          this.staleEntries.set(key, entry.value);
        }
        this.timers.delete(key);
      }, ttl);
      if (typeof (timer as NodeJS.Timeout).unref === "function") {
        (timer as NodeJS.Timeout).unref();
      }
      this.timers.set(key, timer);
    }

    this.entries.set(key, { value, expiresAt });
  }

  get(key: string): TValue | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.staleEntries.set(key, entry.value);
      return undefined;
    }

    return entry.value;
  }

  peek(key: string): TValue | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      return entry.value;
    }
    return this.staleEntries.get(key);
  }

  delete(key: string): boolean {
    const existed = this.entries.delete(key) || this.staleEntries.delete(key);
    this.clearTimer(key);
    return existed;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  clear(): void {
    for (const key of this.timers.keys()) {
      this.clearTimer(key);
    }
    this.entries.clear();
    this.staleEntries.clear();
  }

  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}

export const createExpiringCache = <TValue>(
  defaultTtlMs: number
): ExpiringCache<TValue> => {
  if (defaultTtlMs <= NO_TTL) {
    throw new Error("ExpiringCache requires a positive default TTL");
  }

  return new ExpiringCacheImpl<TValue>(defaultTtlMs);
};
