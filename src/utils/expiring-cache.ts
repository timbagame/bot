export interface ExpiringCache<TValue> {
  setWithTTL(key: string, value: TValue, ttlMs?: number): void;
  get(key: string): TValue | undefined;
  delete(key: string): boolean;
  has(key: string): boolean;
  clear(): void;
}

const NO_TTL = 0;

class ExpiringCacheImpl<TValue> implements ExpiringCache<TValue> {
  private readonly entries = new Map<string, { value: TValue; expiresAt: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly defaultTtlMs: number) {}

  setWithTTL(key: string, value: TValue, ttlMs: number = this.defaultTtlMs): void {
    this.clearTimer(key);

    const ttl = ttlMs > NO_TTL ? ttlMs : this.defaultTtlMs;
    const expiresAt = ttl > NO_TTL ? Date.now() + ttl : Number.POSITIVE_INFINITY;

    if (ttl > NO_TTL) {
      const timer = setTimeout(() => {
        this.entries.delete(key);
        this.timers.delete(key);
      }, ttl);
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
      this.delete(key);
      return undefined;
    }

    return entry.value;
  }

  delete(key: string): boolean {
    const existed = this.entries.delete(key);
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
