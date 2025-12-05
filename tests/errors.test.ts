import { expect, test } from "bun:test";
import { parseTransactionError, truncateMessage } from "../src/utils/errors";

test("truncateMessage returns original message when under limit", () => {
  const message = "short error";
  expect(truncateMessage(message, { maxLength: 20 })).toBe(message);
});

test("truncateMessage truncates long message and appends ellipsis", () => {
  const longMessage = "a".repeat(50);
  expect(truncateMessage(longMessage, { maxLength: 10 })).toBe(
    "a".repeat(7) + "..."
  );
});

test("parseTransactionError formats insufficient lamports message", async () => {
  const error = new Error("insufficient lamports 100, need 200");
  const message = await parseTransactionError(error);
  expect(message).toContain("Not enough SOL to complete this");
  expect(message).toContain("You need about");
});

test("parseTransactionError handles transaction timeout with signature", async () => {
  const signature = "A".repeat(88);
  const error = new Error(
    `Transaction confirmation timeout. signature ${signature}`
  );
  const message = await parseTransactionError(error);
  expect(message).toContain(`Transaction signature: ${signature}`);
  expect(message).toContain("Solscan");
});

test("parseTransactionError handles transaction timeout without signature", async () => {
  const error = new Error("transaction was not confirmed");
  const message = await parseTransactionError(error);
  expect(message).not.toContain("/checktx");
});

test("parseTransactionError handles Jupiter no route errors", async () => {
  const error = new Error("Jupiter error: no route found");
  const message = await parseTransactionError(error);
  expect(message).toContain("Swap route missing");
});

test("parseTransactionError handles address lookup table errors", async () => {
  const error = new Error(
    "Jupiter: address table account not found in AddressTableLookup"
  );
  const message = await parseTransactionError(error);
  expect(message).toContain("Swap route unavailable");
});

test("parseTransactionError handles slippage errors", async () => {
  const error = new Error("Jupiter: slippage exceeded");
  const message = await parseTransactionError(error);
  expect(message).toContain("Slippage error");
});

test("parseTransactionError handles price impact errors", async () => {
  const error = new Error("Jupiter: price impact too high");
  const message = await parseTransactionError(error);
  expect(message).toContain("Price impact too high");
});

test("parseTransactionError handles Jupiter connectivity errors", async () => {
  const error = new Error(
    "Failed to get swap quote: Unable to connect. Is the computer able to access the url?"
  );
  const message = await parseTransactionError(error);
  expect(message).toContain("Jupiter is temporarily unavailable");
  expect(message).toContain("Wait a moment");
});

test("parseTransactionError returns default message for unknown errors", async () => {
  const error = new Error("some random error");
  const message = await parseTransactionError(error);
  expect(message).toContain("Something went wrong");
  expect(message).toContain("Please try again");
});
