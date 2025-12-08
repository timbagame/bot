import { formatDuration } from "../src/utils/format-time";
import { describe, expect, test } from "bun:test";

describe("formatDuration", () => {
  test("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(10)).toBe("10s");
    expect(formatDuration(59)).toBe("59s");
  });

  test("formats minutes", () => {
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(2700)).toBe("45m");
    expect(formatDuration(3599)).toBe("59m");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(3600)).toBe("1h");
    expect(formatDuration(4800)).toBe("1h 20m");
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(7200)).toBe("2h");
  });

  test("formats days", () => {
    expect(formatDuration(86400)).toBe("1d");
    expect(formatDuration(259200)).toBe("3d");
    expect(formatDuration(90000)).toBe("1d"); // 1d 1h -> 1d
  });

  test("handles fractional seconds by rounding", () => {
    expect(formatDuration(10.4)).toBe("10s");
    expect(formatDuration(10.5)).toBe("11s");
  });
});
