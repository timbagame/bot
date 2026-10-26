import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PublicKey } from "#solana";
import { FinanceLedgerService, referralDeltaFromTransaction } from "../src/services/finance-ledger";
import * as eventParser from "../src/utils/program-event-parser";

const ACCOUNT = new PublicKey("11111111111111111111111111111111");
const PROGRAM = new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const tokenTransaction = (pre: unknown, post: unknown) =>
  ({
    transaction: { message: { staticAccountKeys: [ACCOUNT] } },
    meta: {
      preTokenBalances: [{ accountIndex: 0, mint: MINT, uiTokenAmount: { amount: pre } }],
      postTokenBalances: [{ accountIndex: 0, mint: MINT, uiTokenAmount: { amount: post } }],
    },
  }) as any;

describe("referral delta amount parsing", () => {
  test("treats a malformed raw token amount as zero instead of failing", () => {
    // Unparseable "pre" amount counts as 0, so the delta is the whole post balance.
    expect(
      referralDeltaFromTransaction(tokenTransaction("not-a-number", "40"), ACCOUNT.toBase58()),
    ).toEqual({ mint: MINT, delta: 40n });
    // Both malformed: no change is observed.
    expect(
      referralDeltaFromTransaction(tokenTransaction("1.5", "abc"), ACCOUNT.toBase58()),
    ).toBeNull();
  });

  test("treats a missing raw token amount as zero", () => {
    const transaction = tokenTransaction("10", undefined);
    expect(referralDeltaFromTransaction(transaction, ACCOUNT.toBase58())).toEqual({
      mint: MINT,
      delta: -10n,
    });
  });
});

describe("program event identifiers", () => {
  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("accepts plain string and missing identifiers from decoded events", async () => {
    const parseSpy = spyOn(eventParser, "parseProgramEventsFromTransaction").mockReturnValue([
      { name: "GameCreated", data: { gameKey: "game-string", tokenMint: "mint-string" } },
      { name: "GameCompleted", data: { gameKey: "game-string", feeAmount: 9n, timestamp: 50n } },
      { name: "TokenFeeWithdrawn", data: { amount: 3n } },
    ]);
    try {
      const recorded: any[] = [];
      const source = {
        sourceKey: `program:${PROGRAM.toBase58()}`,
        sourceType: "program" as const,
        address: PROGRAM.toBase58(),
        beforeSignature: null,
        startTimeMs: 0,
        completed: false,
        processedTransactions: 0,
        lastError: null,
      };
      const store = {
        recordFinanceEvent: (event: any) => recorded.push(event),
        ensureFinanceBackfillSource: () => undefined,
        getNextFinanceBackfillSource: () => source,
        advanceFinanceBackfillSource: () => undefined,
        recordFinanceBackfillError: () => undefined,
        getFinanceBackfillProgress: () => ({
          totalSources: 1,
          completedSources: 0,
          processedTransactions: 0,
          lastError: null,
        }),
      };
      const connection = {
        getSignaturesForAddress: async () => [{ signature: "sig-s", blockTime: 100, slot: 3 }],
        getTransaction: async () => ({
          blockTime: 100,
          transaction: { message: { staticAccountKeys: [PROGRAM] } },
          meta: { err: null, logMessages: [] },
        }),
      };
      const service = new FinanceLedgerService(
        connection as any,
        { programId: PROGRAM, account: { gameToken: { all: async () => [] } } } as any,
        store as any,
        undefined,
        {
          getReferralTokenAccountsV2: async () => ({ tokenAccounts: [], token2022Accounts: [] }),
        } as any,
        { batchSize: 1, requestDelayMs: 0, now: () => 999_000 },
      );

      await service.backfillNextBatch(0);

      expect(recorded.map((e) => [e.category, e.kind, e.account, e.mint, e.amountRaw])).toEqual([
        ["game_fee", "earned", "game-string", "mint-string", "9"],
        // A withdrawal event with no mint is recorded under the empty string.
        ["game_fee", "claimed", undefined, "", "3"],
      ]);
    } finally {
      parseSpy.mockRestore();
    }
  });
});
