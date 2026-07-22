import { describe, expect, it } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  fetchFinanceTransactions,
  referralDeltaFromTransaction,
} from "../src/services/finance-ledger";

const ACCOUNT = new PublicKey("11111111111111111111111111111111");
const OTHER = new PublicKey("So11111111111111111111111111111111111111112");
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const transaction = (pre: string, post: string, legacy = false) =>
  ({
    transaction: {
      message: legacy
        ? { staticAccountKeys: [OTHER, ACCOUNT] }
        : { staticAccountKeys: [OTHER], addressTableLookups: [] },
    },
    meta: {
      loadedAddresses: legacy ? undefined : { writable: [ACCOUNT], readonly: [] },
      preTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: pre } }],
      postTokenBalances: [{ accountIndex: 1, mint: MINT, uiTokenAmount: { amount: post } }],
    },
  }) as any;

describe("Jupiter referral ledger", () => {
  it("reads earned fees from versioned-transaction token deltas", () => {
    expect(referralDeltaFromTransaction(transaction("100", "125"), ACCOUNT.toBase58())).toEqual({
      mint: MINT,
      delta: 25n,
    });
  });

  it("reads claims as negative deltas in legacy transactions", () => {
    expect(referralDeltaFromTransaction(transaction("125", "0", true), ACCOUNT.toBase58())).toEqual(
      { mint: MINT, delta: -125n },
    );
  });
});

describe("finance RPC batching", () => {
  it("splits batches rejected as too large without losing transactions", async () => {
    const requestedBatchSizes: number[] = [];
    const connection = {
      getTransactions: async (signatures: string[]) => {
        requestedBatchSizes.push(signatures.length);
        if (signatures.length > 2) throw new Error("413 Payload Too Large");
        return signatures.map(() => ({ meta: { err: null } }));
      },
    };
    const signatures = Array.from({ length: 5 }, (_, index) => ({
      signature: `signature-${index}`,
      blockTime: 1,
      slot: index,
    }));

    const result = await fetchFinanceTransactions(connection as any, signatures);

    expect(result).toHaveLength(5);
    expect(requestedBatchSizes[0]).toBe(5);
    expect(
      requestedBatchSizes.filter((size) => size <= 2).reduce((sum, size) => sum + size, 0),
    ).toBe(5);
  });
});
