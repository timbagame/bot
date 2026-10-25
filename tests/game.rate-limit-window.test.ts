import { describe, expect, test } from "bun:test";
import { __test_formatRateLimitWindow as formatRateLimitWindow } from "../src/utils/game";

describe("formatRateLimitWindow", () => {
  test("reports sub-second windows in whole milliseconds, rounded up", () => {
    expect(formatRateLimitWindow(250.4)).toBe("251ms");
    expect(formatRateLimitWindow(999)).toBe("999ms");
  });

  test("falls back to a generic label for missing or invalid windows", () => {
    expect(formatRateLimitWindow(0)).toBe("recent window");
    expect(formatRateLimitWindow(-5)).toBe("recent window");
    expect(formatRateLimitWindow(Number.NaN)).toBe("recent window");
    expect(formatRateLimitWindow(Number.POSITIVE_INFINITY)).toBe("recent window");
  });

  test("reports longer windows as a duration", () => {
    expect(formatRateLimitWindow(120_000)).toBe("2m");
  });
});
