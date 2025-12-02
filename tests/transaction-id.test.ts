import { describe, expect, test } from "bun:test";
import { generateTransactionId } from "../src/utils/transaction-id";

const TRANSACTION_ID_PATTERN = /^tx_\d{10,}_[A-Za-z0-9_-]{20,}$/;

describe("generateTransactionId", () => {
  test("includes timestamp and cryptographically random segment", () => {
    const id = generateTransactionId();
    expect(TRANSACTION_ID_PATTERN.test(id)).toBe(true);
  });

  test("produces unique, high-entropy identifiers across many generations", () => {
    const iterations = 250;
    const ids = Array.from({ length: iterations }, () => generateTransactionId());
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(iterations);
    for (const value of ids) {
      expect(value).toMatch(TRANSACTION_ID_PATTERN);
    }
  });
});
