import { afterEach, describe, expect, test } from "bun:test";
import { createSolConversionUtilities } from "../src/bot/flows/sol-conversion";
import {
  storePendingTransaction,
  getPendingTransaction,
} from "../src/utils/user-state";

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

    const unauthorized = validatePendingTransaction(
      { from: { id: 777 } } as any,
      txId,
      "send"
    );
    expect(unauthorized.status).toBe("unauthorized");
    expect(getPendingTransaction(txId, false)).toBeDefined();

    const authorized = validatePendingTransaction(
      { from: { id: 555 } } as any,
      txId,
      "send"
    );
    expect(authorized.status).toBe("success");
    if (authorized.status === "success") {
      expect(authorized.transaction.userId).toBe("555");
    }
    expect(getPendingTransaction(txId, false)).toBeUndefined();
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

      const expired = validatePendingTransaction(
        { from: { id: 123 } } as any,
        txId,
        "send"
      );

      expect(expired.status).toBe("expired");
      expect(getPendingTransaction(txId, false)).toBeUndefined();
    } finally {
      Date.now = originalNow;
    }
  });
});
