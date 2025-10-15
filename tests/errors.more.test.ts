import { describe, test, expect } from "bun:test";
import { parseTransactionError } from "../src/utils/errors";

const walletStub = {
  formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
} as any;

describe("errors extras", () => {
  test("lamports error with wallet shows detailed balances", () => {
    const msg = parseTransactionError(new Error("insufficient lamports 100, need 200"), walletStub);
    expect(msg).toContain("Current:");
    expect(msg).toContain("Required:");
    expect(msg).toContain("Missing:");
  });

  test("generic insufficient maps to helpful guidance", () => {
    const msg = parseTransactionError(new Error("insufficient funds for fee"));
    expect(msg).toContain("Insufficient funds");
  });

  test("account missing maps to setup guidance", () => {
    const msg = parseTransactionError(new Error("Account does not exist"));
    expect(msg).toContain("Account setup required");
  });

  test("simulation failure maps to fee guidance", () => {
    const msg = parseTransactionError(new Error("simulation failed: custom program error: 0x1"));
    expect(msg).toContain("Transaction failed");
    expect(msg).toContain("network couldn't process");
  });

  test("quote unavailable maps to friendly retry guidance", () => {
    const msg = parseTransactionError(new Error("Jupiter quote failed: quote failed"));
    expect(msg).toContain("Quote unavailable right now");
  });

  test("token not tradable surfaces actionable message", () => {
    const msg = parseTransactionError(new Error("token_not_tradable on Jupiter"));
    expect(msg).toContain("Token not tradable");
    expect(msg).toContain("liquidity");
  });

  test("same token swap error explains restriction", () => {
    const msg = parseTransactionError(new Error("Jupiter: input and output mints are not allowed to be equal"));
    expect(msg).toContain("Cannot swap same token");
  });
});
