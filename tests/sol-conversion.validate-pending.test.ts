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
});
