import { describe, expect, it } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { FinanceLedgerService, referralDeltaFromTransaction } from "../src/services/finance-ledger";

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

describe("incremental finance backfill", () => {
  const source = {
    sourceKey: `jupiter:${ACCOUNT.toBase58()}`,
    sourceType: "jupiter" as const,
    address: ACCOUNT.toBase58(),
    beforeSignature: null,
    startTimeMs: 0,
    completed: false,
    processedTransactions: 0,
    lastError: null,
  };

  const createHistory = (
    nextSource: {
      sourceKey: string;
      sourceType: "discovery" | "program" | "jupiter";
      address: string;
      beforeSignature: string | null;
      startTimeMs: number;
      completed: boolean;
      processedTransactions: number;
      lastError: string | null;
    } = source,
  ) => {
    const advances: Array<{
      signature: string | null;
      completed: boolean;
      processed: number;
    }> = [];
    const events: any[] = [];
    const errors: string[] = [];
    return {
      advances,
      events,
      errors,
      store: {
        recordFinanceEvent: (event: any) => events.push(event),
        ensureFinanceBackfillSource: () => undefined,
        getNextFinanceBackfillSource: () => nextSource,
        advanceFinanceBackfillSource: (
          _key: string,
          signature: string | null,
          completed: boolean,
          processed: number,
        ) => advances.push({ signature, completed, processed }),
        recordFinanceBackfillError: (_key: string, error: string) => errors.push(error),
        getFinanceBackfillProgress: () => ({
          totalSources: 1,
          completedSources: 0,
          processedTransactions: advances.reduce((sum, item) => sum + item.processed, 0),
          lastError: errors.at(-1) ?? null,
        }),
      },
    };
  };

  const program = {
    programId: OTHER,
    coder: {},
    account: { gameToken: { all: async () => [] } },
  } as any;
  const referralReader = {
    getReferralTokenAccountsV2: async () => ({ tokenAccounts: [], token2022Accounts: [] }),
  } as any;

  it("persists a cursor after every transaction", async () => {
    const history = createHistory();
    const connection = {
      getSignaturesForAddress: async () => [
        { signature: "signature-1", blockTime: 100, slot: 1 },
        { signature: "signature-2", blockTime: 90, slot: 2 },
      ],
      getTransaction: async (signature: string) => {
        return {
          ...transaction(signature === "signature-1" ? "100" : "125", "150"),
          blockTime: 100,
        };
      },
    };
    const service = new FinanceLedgerService(
      connection as any,
      program,
      history.store as any,
      undefined,
      referralReader,
      { batchSize: 2, requestDelayMs: 0 },
    );

    await service.backfillNextBatch(0);

    expect(history.advances).toEqual([
      { signature: "signature-1", completed: false, processed: 1 },
      { signature: "signature-2", completed: false, processed: 1 },
    ]);
    expect(history.events).toHaveLength(2);
  });

  it("keeps completed transaction progress when a later request is rate-limited", async () => {
    const history = createHistory();
    const connection = {
      getSignaturesForAddress: async () => [
        { signature: "signature-1", blockTime: 100, slot: 1 },
        { signature: "signature-2", blockTime: 90, slot: 2 },
      ],
      getTransaction: async (signature: string) => {
        if (signature === "signature-2") throw new Error("429 Too Many Requests");
        return { ...transaction("100", "125"), blockTime: 100 };
      },
    };
    const service = new FinanceLedgerService(
      connection as any,
      program,
      history.store as any,
      undefined,
      referralReader,
      { batchSize: 2, requestDelayMs: 0 },
    );

    await expect(service.backfillNextBatch(0)).rejects.toThrow("429 Too Many Requests");

    expect(history.advances).toEqual([
      { signature: "signature-1", completed: false, processed: 1 },
    ]);
    expect(history.errors.at(-1)).toContain("429 Too Many Requests");
  });

  it("advances past program txs when current IDL throws on legacy event layouts", async () => {
    const programSource = {
      ...source,
      sourceKey: `program:${OTHER.toBase58()}`,
      sourceType: "program" as const,
      address: OTHER.toBase58(),
    };
    const history = createHistory(programSource);

    const throwingProgram = {
      ...program,
      coder: {
        events: {
          decode: () => {
            throw new Error("Invalid option movedParticipant");
          },
        },
      },
    };
    const connection = {
      getSignaturesForAddress: async () => [
        { signature: "legacy-unjoin", blockTime: 100, slot: 1 },
        { signature: "older-tx", blockTime: 90, slot: 2 },
      ],
      getTransaction: async () => ({
        transaction: { message: { staticAccountKeys: [OTHER] } },
        meta: {
          err: null,
          logMessages: [
            `Program ${OTHER.toBase58()} invoke [1]`,
            "Program data: AAAA",
            `Program ${OTHER.toBase58()} success`,
          ],
        },
        blockTime: 100,
      }),
    };
    const service = new FinanceLedgerService(
      connection as any,
      throwingProgram as any,
      history.store as any,
      undefined,
      referralReader,
      { batchSize: 2, requestDelayMs: 0 },
    );

    const result = await service.backfillNextBatch(0);

    expect(result.processedTransactions).toBe(2);
    expect(history.errors).toEqual([]);
    expect(history.advances).toEqual([
      { signature: "legacy-unjoin", completed: false, processed: 1 },
      { signature: "older-tx", completed: false, processed: 1 },
    ]);
  });
});
