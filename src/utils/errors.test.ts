import { expect, test } from "bun:test";
import { parseTransactionError, truncateErrorForCallback } from "./errors";

test("truncateErrorForCallback returns original message when under limit", () => {
  const message = "short error";
  expect(truncateErrorForCallback(message, 20)).toBe(message);
});

test("truncateErrorForCallback truncates long message and appends ellipsis", () => {
  const longMessage = "a".repeat(50);
  expect(truncateErrorForCallback(longMessage, 10)).toBe(
    "a".repeat(10) + "..."
  );
});

test("parseTransactionError formats insufficient lamports message", () => {
  const error = new Error("insufficient lamports 100, need 200");
  const message = parseTransactionError(error);
  expect(message).toContain("Insufficient SOL");
});

test("parseTransactionError handles transaction timeout with signature", () => {
  const signature = "A".repeat(88);
  const error = new Error(
    `Transaction confirmation timeout. signature ${signature}`
  );
  const message = parseTransactionError(error);
  expect(message).toContain(`/checktx ${signature}`);
});

test("parseTransactionError handles transaction timeout without signature", () => {
  const error = new Error("transaction was not confirmed");
  const message = parseTransactionError(error);
  expect(message).not.toContain("/checktx");
});

test("parseTransactionError handles Jupiter no route errors", () => {
  const error = new Error("Jupiter error: no route found");
  const message = parseTransactionError(error);
  expect(message).toContain("No swap route available");
});

test("parseTransactionError returns default message for unknown errors", () => {
  const error = new Error("some random error");
  const message = parseTransactionError(error);
  expect(message).toContain("Transaction failed");
  expect(message).toContain("some random error");
});
