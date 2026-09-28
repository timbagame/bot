import { afterEach, describe, expect, test } from "bun:test";
import { createSolConversionUtilities } from "../src/bot/flows/sol-conversion";
import { storePendingTransaction, getPendingTransaction } from "../src/utils/user-state";

describe("validatePendingTransaction", () => {
  const utilities = createSolConversionUtilities({
    wallet: {
      confirmTransaction: async () => {},
    } as any,
    clearWalletCache: () => {},
    buildTransactionLinkMessage: () => ({
      message: null,
      solscanUrl: null,
      previewDisabled: false,
      displaySignature: null,
    }),
    getPendingTransaction,
    getSolFeeBufferLamports: () => 0,
  });

  const { validatePendingTransaction } = utilities;
  const txId = "tx-validate-send";

  afterEach(() => {
    getPendingTransaction(txId, true);
  });

  test("keeps transaction cached when callback unauthorized", () => {
    storePendingTransaction(txId, {
      type: "send",
      userId: "555",
      token: "SOL",
      amount: "1.5",
      address: "HhEWJstpJE6vvrYGS3BaK5ZJbdVAXqGmQ2MBM8FyiPvy",
    });

    const unauthorized = validatePendingTransaction({ from: { id: 777 } } as any, txId, "send");
    expect(unauthorized.status).toBe("unauthorized");
    expect(getPendingTransaction(txId, false)).toBeDefined();

    const authorized = validatePendingTransaction({ from: { id: 555 } } as any, txId, "send");
    expect(authorized.status).toBe("success");
    if (authorized.status === "success") {
      expect(authorized.transaction.userId).toBe("555");
    }
    expect(getPendingTransaction(txId, false)).toBeUndefined();
  });

  test("only first validation succeeds per pending transaction", () => {
    storePendingTransaction(txId, {
      type: "send",
      userId: "100",
      token: "SOL",
      amount: "2",
      address: "FhvxPt3M79xMBZZhNX3eVfn3DrM6vjrE1rjhyu5x1t8L",
    });

    const first = validatePendingTransaction({ from: { id: 100 } } as any, txId, "send");
    expect(first.status).toBe("success");

    const second = validatePendingTransaction({ from: { id: 100 } } as any, txId, "send");
    expect(second.status).toBe("expired");
  });

  test("returns expired when transaction timestamp exceeds input timeout", () => {
    const originalNow = Date.now;
    try {
      let current = 10_000;
      Date.now = () => current;

      storePendingTransaction(txId, {
        type: "send",
        userId: "123",
        token: "SOL",
        amount: "1",
        address: "FhvxPt3M79xMBZZhNX3eVfn3DrM6vjrE1rjhyu5x1t8L",
      });

      current += 16 * 60 * 1000; // advance beyond INPUT_TIMEOUT_MS (15 min default)

      const expired = validatePendingTransaction({ from: { id: 123 } } as any, txId, "send");

      expect(expired.status).toBe("expired");
      expect(getPendingTransaction(txId, false)).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("validatePendingTransaction timeout options", () => {
  const utilities = createSolConversionUtilities({
    wallet: {} as any,
    clearWalletCache: () => {},
    buildTransactionLinkMessage: (() => ({})) as any,
    getPendingTransaction,
    getSolFeeBufferLamports: () => 0,
  });
  const txId = "tx-validate-timeout";
  const store = () =>
    storePendingTransaction(txId, {
      type: "send",
      userId: "9",
      token: "SOL",
      amount: "1",
      address: "FhvxPt3M79xMBZZhNX3eVfn3DrM6vjrE1rjhyu5x1t8L",
    });

  afterEach(() => {
    getPendingTransaction(txId, true);
  });

  test("a shorter caller timeout expires and drops the entry", () => {
    store();
    const result = utilities.validatePendingTransaction({ from: { id: 9 } }, txId, "send", {
      timeoutMs: 1_000,
      now: Date.now() + 1_001,
    });

    expect(result.status).toBe("expired");
    expect(getPendingTransaction(txId, false)).toBeUndefined();
  });

  test("an entry exactly at the caller timeout is still valid", () => {
    store();
    const stored = getPendingTransaction(txId, false) as { timestamp: number };
    const result = utilities.validatePendingTransaction({ from: { id: 9 } }, txId, "send", {
      timeoutMs: 1_000,
      now: stored.timestamp + 1_000,
    });

    expect(result.status).toBe("success");
  });

  test("a zero timeout disables the age check", () => {
    store();
    const result = utilities.validatePendingTransaction({ from: { id: 9 } }, txId, "send", {
      timeoutMs: 0,
      now: Date.now() + 10 * 60_000,
    });

    expect(result.status).toBe("success");
  });

  test("removeFromCache false keeps the entry for a later step", () => {
    store();
    const result = utilities.validatePendingTransaction({ from: { id: 9 } }, txId, "send", {
      removeFromCache: false,
    });

    expect(result.status).toBe("success");
    if (result.status === "success") expect(result.transaction).not.toHaveProperty("timestamp");
    expect(getPendingTransaction(txId, false)).toBeDefined();
  });

  test("a different transaction type is treated as expired and dropped", () => {
    store();

    expect(utilities.validatePendingTransaction({ from: { id: 9 } }, txId, "buy").status).toBe(
      "expired",
    );
    expect(getPendingTransaction(txId, false)).toBeUndefined();
  });

  test("falls back to the chat id when there is no sender", () => {
    store();

    expect(utilities.validatePendingTransaction({ chat: { id: 9 } }, txId, "send").status).toBe(
      "success",
    );
  });

  test("rejects a context with neither sender nor chat", () => {
    store();

    expect(utilities.validatePendingTransaction({}, txId, "send").status).toBe("unauthorized");
  });
});
