import { test, expect } from "bun:test";
import { formatAmount } from "./format-amount";

test("formatAmount formats basic integer", () => {
  expect(formatAmount(123456, 5)).toBe("1.23456");
});

test("formatAmount rounds and trims fractional digits", () => {
  expect(formatAmount(123456n, 5, { maxFractionDigits: 2 })).toBe("1.23");
});

test("formatAmount rounds with carry into integer part", () => {
  expect(formatAmount(199999n, 5, { maxFractionDigits: 2 })).toBe("2");
});

test("formatAmount handles negative amounts", () => {
  expect(formatAmount(-123400n, 2)).toBe("-1234");
});

test("formatAmount respects trim option", () => {
  expect(formatAmount(1200, 3, { trim: false })).toBe("1.200");
});

test("formatAmount rounds when no fractional digits requested", () => {
  expect(formatAmount(15, 1, { maxFractionDigits: 0 })).toBe("2");
});

test("formatAmount parses string inputs with whitespace", () => {
  expect(formatAmount(" -00123", 2)).toBe("-1.23");
});
