import { test, expect } from "bun:test";
import {
  formatAmount,
  formatCompactTokenDisplay,
  formatRate,
  formatTokenDisplay,
  formatUsdValue,
} from "../src/utils/format-amount";

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

test("formatAmount handles explicit plus sign prefix", () => {
  expect(formatAmount("+00045", 2)).toBe("0.45");
});

test("formatAmount falls back to numeric parsing when string has decimals", () => {
  expect(formatAmount("12.34", 2)).toBe("0.12");
});

test("formatAmount rounds fractional carry when integer part is empty", () => {
  expect(formatAmount(5, 3, { maxFractionDigits: 2 })).toBe("0.01");
});

test("formatAmount shows tiny non-zero values with full precision by default", () => {
  expect(formatAmount(1, 9)).toBe("0.000000001");
  expect(formatAmount(5, 9)).toBe("0.000000005");
  expect(formatAmount(1234, 9)).toBe("0.000001234");
});

test("formatAmount default maxFractionDigits equals decimals", () => {
  expect(formatAmount(1500000000, 9)).toBe("1.5");
  expect(formatAmount(1000000, 6)).toBe("1");
  expect(formatAmount(1, 18)).toBe("0.000000000000000001");
});

test("formatTokenDisplay respects provided decimals", () => {
  expect(
    formatTokenDisplay(1.2, {
      decimals: 4,
    })
  ).toBe("1.2000");
});

test("formatTokenDisplay infers precision when decimals are omitted", () => {
  expect(formatTokenDisplay(1234.567)).toBe("1,234.567");
});

test("formatTokenDisplay clamps to six fractional digits", () => {
  expect(
    formatTokenDisplay(0.123456789, {
      decimals: 9,
    })
  ).toBe("0.123457");
});

test("formatTokenDisplay handles non-finite values", () => {
  expect(formatTokenDisplay(Number.NaN)).toBe("0");
});

test("formatCompactTokenDisplay abbreviates thousands", () => {
  expect(formatCompactTokenDisplay("267,980")).toBe("267.9k");
});

test("formatCompactTokenDisplay preserves small decimal values", () => {
  expect(formatCompactTokenDisplay("12.3400")).toBe("12.34");
  expect(formatCompactTokenDisplay("0.000123")).toBe("0.000123");
});

test("formatCompactTokenDisplay keeps integers under one thousand intact", () => {
  expect(formatCompactTokenDisplay("950")).toBe("950");
});

test("formatCompactTokenDisplay handles negative numbers", () => {
  expect(formatCompactTokenDisplay(-15500)).toBe("-15.5k");
});

test("formatCompactTokenDisplay scales to large suffixes", () => {
  expect(formatCompactTokenDisplay(2_500_000_000)).toBe("2.5B");
  expect(formatCompactTokenDisplay(1_000_000_000_000_000)).toBe("1P");
});

test("formatCompactTokenDisplay falls back to raw string for invalid numbers", () => {
  expect(formatCompactTokenDisplay("not-a-number")).toBe("not-a-number");
  expect(formatCompactTokenDisplay(" ")).toBe("0");
});

test("formatUsdValue omits trailing decimals for integer values", () => {
  expect(formatUsdValue(1250)).toBe("1,250");
});

test("formatUsdValue keeps significant decimals for non-integer values", () => {
  expect(formatUsdValue(12.5)).toBe("12.5");
});

test("formatUsdValue formats approximate amounts without padding", () => {
  expect(formatUsdValue(42, { approximate: true })).toBe("≈ $42");
});

test("formatUsdValue uses the same rounding when marked approximate", () => {
  expect(
    formatUsdValue(0.345, {
      approximate: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  ).toBe("≈ $0.35");
});

test("formatUsdValue respects maximum fractional digits with trimming", () => {
  expect(
    formatUsdValue(1.234, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  ).toBe("1.23");
  expect(
    formatUsdValue(1.2, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  ).toBe("1.2");
});

test("formatUsdValue uses fallback when input is not finite", () => {
  expect(formatUsdValue(Number.NaN, { fallback: "n/a" })).toBe("n/a");
});

test("formatUsdValue default fallback respects fractional digit options", () => {
  expect(
    formatUsdValue(Number.NaN, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  ).toBe("0.00");
});

test("formatUsdValue approximate fallback includes currency and fraction digits", () => {
  expect(
    formatUsdValue(Number.POSITIVE_INFINITY, {
      approximate: true,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  ).toBe("≈ $0.00");
});

test("formatRate renders tiny values without scientific notation", () => {
  expect(formatRate(8e-12)).toBe("0.000000000008");
  expect(formatRate(3.456e-9)).toBe("0.000000003456");
});

test("formatRate falls back to exponential for extremely small values", () => {
  expect(formatRate(4e-13)).toBe("4.00e-13");
});
