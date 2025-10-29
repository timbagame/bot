import { describe, expect, test } from "bun:test";
import { createExpiringCache } from "../src/utils/expiring-cache";

describe("createExpiringCache", () => {
  test("throws when default TTL is non-positive", () => {
    expect(() => createExpiringCache<string>(0)).toThrow("positive default TTL");
  });
});

describe("ExpiringCache behavior", () => {
  test("entries expire and peek returns stale values", async () => {
    const cache = createExpiringCache<number>(20);
    cache.setWithTTL("key", 42);

    expect(cache.get("key")).toBe(42);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(cache.get("key")).toBeUndefined();
    expect(cache.peek("key")).toBe(42);
    expect(cache.has("key")).toBe(false);
  });

  test("delete removes entries and cancels timers", async () => {
    const cache = createExpiringCache<string>(20);
    cache.setWithTTL("key", "value", 50);

    cache.delete("key");

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cache.peek("key")).toBeUndefined();
    expect(cache.get("key")).toBeUndefined();
  });

  test("clear removes all entries and timers", async () => {
    const cache = createExpiringCache<string>(20);
    cache.setWithTTL("a", "one", 40);
    cache.setWithTTL("b", "two", 40);

    cache.clear();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("b")).toBeUndefined();
  });

  test("non-positive ttl arguments fall back to default ttl", async () => {
    const cache = createExpiringCache<number>(20);
    cache.setWithTTL("key", 1, 0);

    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(cache.peek("key")).toBe(1);
    expect(cache.get("key")).toBeUndefined();
  });
});
