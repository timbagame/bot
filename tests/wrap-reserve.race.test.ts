import { describe, expect, test } from "bun:test";
import { __test_getSolWrapRentReserveLamports as getCachedWrap } from "../src/bot";

describe("wrap rent reserve refresh concurrency", () => {
  test("parallel calls return the same refreshed value", async () => {
    const original = await getCachedWrap();
    const [a, b] = await Promise.all([getCachedWrap(), getCachedWrap()]);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(original);
  });
});
