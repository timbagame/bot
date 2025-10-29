import { expect, test } from "bun:test";
import { parseTransactionError, truncateErrorForCallback } from "../src/utils/errors";

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
  expect(message).toContain(`Transaction signature: ${signature}`);
  expect(message).toContain("Solscan");
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

test("parseTransactionError handles address lookup table errors", () => {
  const error = new Error(
    "Jupiter: address table account not found in AddressTableLookup"
  );
  const message = parseTransactionError(error);
  expect(message).toContain("Swap route unavailable");
});

test("parseTransactionError handles slippage errors", () => {
  const error = new Error("Jupiter: slippage exceeded");
  const message = parseTransactionError(error);
  expect(message).toContain("Slippage error");
});

test("parseTransactionError handles price impact errors", () => {
  const error = new Error("Jupiter: price impact too high");
  const message = parseTransactionError(error);
  expect(message).toContain("Price impact too high");
});

test("parseTransactionError handles Jupiter connectivity errors", () => {
  const error = new Error(
    "Failed to get swap quote: Unable to connect. Is the computer able to access the url?"
  );
  const message = parseTransactionError(error);
  expect(message).toContain("Jupiter is temporarily unavailable");
  expect(message).toContain("Try again in a moment");
});

test("parseTransactionError returns default message for unknown errors", () => {
  const error = new Error("some random error");
  const message = parseTransactionError(error);
  expect(message).toContain("Something went wrong");
  expect(message).toContain("Please try again");
});
