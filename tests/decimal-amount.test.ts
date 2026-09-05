import { expect, test } from "bun:test";
import { parseDecimalAmount } from "../src/utils/amount";

test("rejects precision loss before constructing a transfer", () => {
  expect(() => parseDecimalAmount("1.001", 2)).toThrow("2 decimal places");
  expect(() => parseDecimalAmount("0.001", 2, { returnType: "bigint" })).toThrow(
    "2 decimal places",
  );
});

test("retains bot zero and safe-number policies around exact conversion", () => {
  expect(() => parseDecimalAmount("0", 0)).toThrow("greater than zero");
  expect(parseDecimalAmount("0", 0, { allowZero: true })).toBe(0);
  expect(() => parseDecimalAmount("9007199254740993", 0)).toThrow("too large");
  expect(parseDecimalAmount("9007199254740993", 0, { returnType: "bigint" })).toBe(
    9007199254740993n,
  );
});
