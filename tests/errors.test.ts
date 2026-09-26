import { expect, test, describe } from "bun:test";
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
  expect(message).toContain("This needs about 0.000001 SOL more");
  expect(message).toContain("Top up with /deposit and try again");
  expect(message).not.toContain("SOL more SOL");
});

test("parseTransactionError handles transaction timeout with signature", async () => {
  const signature = "A".repeat(88);
  const error = new Error(`Transaction confirmation timeout. signature ${signature}`);
  const message = await parseTransactionError(error);
  expect(message).toContain(`Signature: ${signature}`);
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
  expect(message).toContain("No swap route");
});

test("parseTransactionError handles Jupiter failed quote errors", async () => {
  const error = new Error(
    'Jupiter order failed: 400 Bad Request - {"requestId":"req","error":"Failed to get quotes"}',
  );
  const message = await parseTransactionError(error);
  expect(message).toContain("No swap route");
  expect(message).toContain("Keep some SOL");
});

test("parseTransactionError handles address lookup table errors", async () => {
  const error = new Error("Jupiter: address table account not found in AddressTableLookup");
  const message = await parseTransactionError(error);
  expect(message).toContain("No swap route");
});

test("parseTransactionError handles slippage errors", async () => {
  const error = new Error("Jupiter: slippage exceeded");
  const message = await parseTransactionError(error);
  expect(message).toContain("Price moved");
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
  expect(message).toContain("Swaps temporarily unavailable");
  expect(message).toContain("Wait a moment");
});

test("parseTransactionError returns default message for unknown errors", async () => {
  const error = new Error("some random error");
  const message = await parseTransactionError(error);
  expect(message).toContain("Something went wrong");
  expect(message).toContain("Try again in a moment");
});

test("parseTransactionError does not echo opaque diagnostics from recognized errors", async () => {
  const opaque = "database credential xyz exploded";
  const message = await parseTransactionError(new Error(`swaps under the minimum: ${opaque}`));

  expect(message).toContain("Increase the swap amount");
  expect(message).not.toContain(opaque);
});

test("parseTransactionError owns the complete wrap failure message", async () => {
  const message = await parseTransactionError(
    new Error("Failed to wrap SOL automatically: RPC unavailable"),
  );
  expect(message).toStartWith("🪙 Couldn't convert SOL");
  expect(message).not.toContain("❌ ❌");
});

test("parseTransactionError handles 'no record of prior credit' Solana error", async () => {
  const error = new Error(
    "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
  );
  const message = await parseTransactionError(error);
  expect(message).toContain("Not enough tokens");
  expect(message).toContain("/balance");
});

test("parseTransactionError handles 'attempt to debit' variant", async () => {
  const error = new Error("Simulation failed. Message: Attempt to debit an account.");
  const message = await parseTransactionError(error);
  expect(message).toContain("Not enough tokens");
});

const walletStub = {
  formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
} as any;

describe("parseTransactionError guidance", () => {
  test("lamports error gives a concise shortfall and action", async () => {
    const msg = await parseTransactionError(
      new Error("insufficient lamports 100, need 200"),
      walletStub,
    );
    expect(msg).toContain("This needs about 0.000001 SOL more");
    expect(msg).toContain("Top up with /deposit and try again.");
    expect(msg).not.toContain("rent and fees");
  });

  test("generic insufficient maps to helpful guidance", async () => {
    const msg = await parseTransactionError(new Error("insufficient funds for fee"));
    expect(msg).toContain("Not enough SOL for fees");
  });

  test("account missing maps to setup guidance", async () => {
    const msg = await parseTransactionError(new Error("Account does not exist"));
    expect(msg).toContain("Account setup needed");
  });

  test("simulation failure maps to fee guidance", async () => {
    const msg = await parseTransactionError(
      new Error("simulation failed: custom program error: 0x1"),
    );
    expect(msg).toContain("Transaction failed");
    expect(msg).toContain("network rejected it");
  });

  test("quote unavailable maps to friendly retry guidance", async () => {
    const msg = await parseTransactionError(new Error("Jupiter quote failed: quote failed"));
    expect(msg).toContain("No price available");
  });

  test("token not tradable surfaces actionable message", async () => {
    const msg = await parseTransactionError(new Error("token_not_tradable on Jupiter"));
    expect(msg).toContain("Token can't be swapped");
    expect(msg).toContain("Try a more liquid pair");
  });

  test("same token swap error explains restriction", async () => {
    const msg = await parseTransactionError(
      new Error("Jupiter: input and output mints are not allowed to be equal"),
    );
    expect(msg).toContain("Same token");
  });

  test("percentage rounding guidance highlights fee buffer", async () => {
    const msg = await parseTransactionError(new Error("Percentage results in zero amount"));
    expect(msg).toContain("Amount too small");
    expect(msg).toContain("Pick a larger one or type a custom amount.");
  });

  test("rent shortfall error explains SOL top up instead of dumping logs", async () => {
    const rentError = new Error(
      "Transaction simulation failed: Transaction results in an account (0) with insufficient funds for rent.",
    ) as Error & { transactionLogs?: string[] };
    rentError.transactionLogs = [
      "Program log: Instruction: InitializeImmutableOwner",
      "Program log: Please upgrade to SPL Token 2022 for immutable owner support",
      "Program log: Instruction: InitializeAccount3",
      "Program log: Transaction results in an account (0) with insufficient funds for rent",
    ];

    const msg = await parseTransactionError(rentError, walletStub);
    expect(msg).toContain("Opening a token account needs a small deposit");
    expect(msg).toContain("Keep at least");
    expect(msg).not.toContain("InitializeImmutableOwner");
    expect(msg).not.toContain("SPL Token 2022");
  });
});
