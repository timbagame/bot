import { describe, expect, test } from "bun:test";
import { PumpFunClient } from "../src/utils/pump-fun";

describe("PumpFunClient.parseAmountLamports", () => {
  const getClient = () => Object.create(PumpFunClient.prototype) as PumpFunClient;

  test("parses integer strings into lamports using mint decimals", () => {
    const client = getClient();
    const amount = (client as any).parseAmountLamports("2", 9);
    expect(amount).toBe(2_000_000_000n);
  });

  test("parses decimal strings with fractional values", () => {
    const client = getClient();
    const amount = (client as any).parseAmountLamports("0.125", 6);
    expect(amount).toBe(125_000n);
  });

  test("rejects zero when allowZero is false", () => {
    const client = getClient();
    expect(() => (client as any).parseAmountLamports("0", 9)).toThrow(
      "Amount must be greater than zero"
    );
  });

  test("allows zero when explicitly permitted", () => {
    const client = getClient();
    const amount = (client as any).parseAmountLamports("0", 9, { allowZero: true });
    expect(amount).toBe(0n);
  });

  test("rejects whitespace-only input unless zero allowed", () => {
    const client = getClient();
    expect(() => (client as any).parseAmountLamports("   \t", 9)).toThrow(
      "Amount must be greater than zero"
    );

    const zero = (client as any).parseAmountLamports("   \n", 9, {
      allowZero: true,
    });
    expect(zero).toBe(0n);
  });
});
