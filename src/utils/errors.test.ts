import { expect, test } from "bun:test";
import { parseTransactionError, truncateErrorForCallback } from "./errors";

test("truncateErrorForCallback returns original message when under limit", () => {
  const message = "short error";
  expect(truncateErrorForCallback(message, 20)).toBe(message);
});

test("truncateErrorForCallback truncates long message and appends ellipsis", () => {
  const longMessage = "a".repeat(50);
  expect(truncateErrorForCallback(longMessage, 10)).toBe("a".repeat(10) + "...");
});

test("parseTransactionError formats insufficient lamports message", () => {
  const error = new Error("insufficient lamports 100, need 200");
  const message = parseTransactionError(error);
  expect(message).toContain("Insufficient SOL");
});

