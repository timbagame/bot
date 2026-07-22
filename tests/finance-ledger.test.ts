import { describe, expect, it } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { referralDeltaFromTransaction } from "../src/services/finance-ledger";

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
