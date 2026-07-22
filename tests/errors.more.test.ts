import { describe, test, expect } from "bun:test";
import { parseTransactionError } from "../src/utils/errors";

const walletStub = {
  formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
} as any;

describe("errors extras", () => {
  test("lamports error gives a concise shortfall and action", async () => {
    const msg = await parseTransactionError(
      new Error("insufficient lamports 100, need 200"),
      walletStub,
    );
    expect(msg).toContain("This transaction needs about 0.000001 SOL more");
    expect(msg).toContain("Add SOL and try again.");
    expect(msg).not.toContain("rent and fees");
  });

  test("generic insufficient maps to helpful guidance", async () => {
    const msg = await parseTransactionError(new Error("insufficient funds for fee"));
    expect(msg).toContain("Not enough SOL for fees");
  });

  test("account missing maps to setup guidance", async () => {
    const msg = await parseTransactionError(new Error("Account does not exist"));
    expect(msg).toContain("Account setup required");
  });

  test("simulation failure maps to fee guidance", async () => {
    const msg = await parseTransactionError(
      new Error("simulation failed: custom program error: 0x1"),
    );
    expect(msg).toContain("Transaction failed");
    expect(msg).toContain("network couldn't process");
  });

  test("quote unavailable maps to friendly retry guidance", async () => {
    const msg = await parseTransactionError(new Error("Jupiter quote failed: quote failed"));
    expect(msg).toContain("Quote unavailable.");
  });

  test("token not tradable surfaces actionable message", async () => {
    const msg = await parseTransactionError(new Error("token_not_tradable on Jupiter"));
    expect(msg).toContain("Token not tradable.");
    expect(msg).toContain("Jupiter can't swap this token yet.");
  });

  test("same token swap error explains restriction", async () => {
    const msg = await parseTransactionError(
      new Error("Jupiter: input and output mints are not allowed to be equal"),
    );
    expect(msg).toContain("Cannot swap the same token.");
  });

  test("percentage rounding guidance highlights fee buffer", async () => {
    const msg = await parseTransactionError(new Error("Percentage results in zero amount"));
    expect(msg).toContain("Amount too small.");
    expect(msg).toContain("Try a larger percentage or type a custom amount.");
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
    expect(msg).toContain("Not enough SOL for rent-exempt accounts.");
    expect(msg).toContain("Keep at least");
    expect(msg).not.toContain("InitializeImmutableOwner");
    expect(msg).not.toContain("SPL Token 2022");
  });
});
