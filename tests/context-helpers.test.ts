import { expect, test } from "bun:test";
import {
  truncateErrorMessage,
  categorizeError,
  getTelegramId,
} from "../src/utils/context-helpers";

test("truncateErrorMessage returns original message when under limit", () => {
  const message = "short error";
  expect(truncateErrorMessage(message)).toBe(message);
});

test("truncateErrorMessage preserves important prefix and first sentence", () => {
  const message =
    "❌ Error: something bad happened. Additional details that are not needed.";
  expect(truncateErrorMessage(message, { maxLength: 40 })).toBe(
    "❌ Error: something bad happened."
  );
});

test("truncateErrorMessage truncates long message at word boundary", () => {
  const message =
    "This is a very long message that should be truncated properly";
  expect(truncateErrorMessage(message, { maxLength: 40 })).toBe(
    "This is a very long message that..."
  );
});

test("categorizeError flags account not found errors", () => {
  const error = new Error("Account does not exist");
  const categorized = categorizeError(error);
  expect(categorized.isAccountNotFound).toBe(true);
});

test("categorizeError returns message and code", () => {
  const error = { message: "oops", code: "500" };
  const categorized = categorizeError(error);
  expect(categorized).toEqual({
    message: "oops",
    code: "500",
    isAccountNotFound: false,
  });
});

test("getTelegramId normalizes various id shapes", () => {
  const ctxNumber = { from: { id: 123456 } } as any;
  const ctxString = { from: { id: "987654" } } as any;
  const ctxBigInt = { from: { id: 123n } } as any;

  expect(getTelegramId(ctxNumber)).toBe(123456n);
  expect(getTelegramId(ctxString)).toBe(987654n);
  expect(getTelegramId(ctxBigInt)).toBe(123n);
});

test("getTelegramId returns fallback for invalid identifiers", () => {
  const ctxMissing = {} as any;
  const ctxGarbage = { from: { id: "abc" } } as any;
  const ctxInfinity = { from: { id: Number.POSITIVE_INFINITY } } as any;

  expect(getTelegramId(ctxMissing, 42n)).toBe(42n);
  expect(getTelegramId(ctxGarbage, 99n)).toBe(99n);
  expect(getTelegramId(ctxInfinity)).toBe(0n);
});
