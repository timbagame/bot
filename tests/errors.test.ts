import { expect, test } from "bun:test";
import { parseTransactionError, truncateMessage } from "../src/utils/errors";

test("truncateMessage returns original message when under limit", () => {
  const message = "short error";
  expect(truncateMessage(message, { maxLength: 20 })).toBe(message);
});

test("truncateMessage truncates long message and appends ellipsis", () => {
  const longMessage = "a".repeat(50);
  expect(truncateMessage(longMessage, { maxLength: 10 })).toBe("a".repeat(7) + "...");
});

test("parseTransactionError formats insufficient lamports message", async () => {
  const error = new Error("insufficient lamports 100, need 200");
  const message = await parseTransactionError(error);
  expect(message).toContain("This transaction needs about 0.000001 SOL more");
  expect(message).toContain("Add SOL and try again");
  expect(message).not.toContain("SOL more SOL");
});

test("parseTransactionError handles transaction timeout with signature", async () => {
  const signature = "A".repeat(88);
  const error = new Error(`Transaction confirmation timeout. signature ${signature}`);
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

test("parseTransactionError handles Jupiter failed quote errors", async () => {
  const error = new Error(
    'Jupiter order failed: 400 Bad Request - {"requestId":"req","error":"Failed to get quotes"}',
  );
  const message = await parseTransactionError(error);
  expect(message).toContain("Swap route missing");
  expect(message).toContain("Keep some SOL");
});

test("parseTransactionError handles address lookup table errors", async () => {
  const error = new Error("Jupiter: address table account not found in AddressTableLookup");
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
    "Failed to get swap quote: Unable to connect. Is the computer able to access the url?",
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

test("parseTransactionError does not echo opaque diagnostics from recognized errors", async () => {
  const opaque = "database credential xyz exploded";
  const message = await parseTransactionError(new Error(`swaps under the minimum: ${opaque}`));

  expect(message).toContain("Swap amount is too small");
  expect(message).not.toContain(opaque);
});

test("parseTransactionError owns the complete wrap failure message", async () => {
  const message = await parseTransactionError(
    new Error("Failed to wrap SOL automatically: RPC unavailable"),
  );
  expect(message).toStartWith("🪙 Failed to wrap SOL automatically.");
  expect(message).not.toContain("❌ ❌");
});

test("parseTransactionError handles 'no record of prior credit' Solana error", async () => {
  const error = new Error(
    "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
  );
  const message = await parseTransactionError(error);
  expect(message).toContain("Insufficient token balance");
  expect(message).toContain("/balance");
});

test("parseTransactionError handles 'attempt to debit' variant", async () => {
  const error = new Error("Simulation failed. Message: Attempt to debit an account.");
  const message = await parseTransactionError(error);
  expect(message).toContain("Insufficient token balance");
});
