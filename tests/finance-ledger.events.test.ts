import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PublicKey } from "#solana";
import { FinanceLedgerService } from "../src/services/finance-ledger";
import { EVENT_DISCRIMINATORS } from "@timbagame/protocol/contracts/events";
import { contractCapabilities } from "../src/utils/contract-idl";
import { __test_resetReferralConfig, __test_setReferralConfig } from "../src/utils/token-registry";

const PROGRAM = new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5");
const PAYER = new PublicKey("11111111111111111111111111111112");
const GAME = new PublicKey("11111111111111111111111111111113");
const PLAYER = new PublicKey("11111111111111111111111111111114");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const REFERRAL = new PublicKey("GPBNTRmo26MRoaLSvRXwhWaQZhYjwVWgEkgwRZVU6x9U");
const REFERRAL_TOKEN = new PublicKey("So11111111111111111111111111111111111111112");
const BUILD_FEE = new PublicKey("3Zakc3mEdWa6v4Sd5ywDJgUrcz5VK7FrdnHnV4DT1hbQ");

const event = (name: keyof typeof EVENT_DISCRIMINATORS, size: number) => {
  const bytes = Buffer.alloc(size);
  Buffer.from(EVENT_DISCRIMINATORS[name]).copy(bytes, 0);
  return bytes;
};

const gameInitialized = (game = GAME, mint = MINT) => {
  const bytes = event("GameInitialized", 146);
  game.toBuffer().copy(bytes, 8);
  PLAYER.toBuffer().copy(bytes, 40);
  bytes.writeUInt8(0, 72);
  mint.toBuffer().copy(bytes, 97);
  return bytes;
};

const gameCompleted = (fee: bigint, timestamp: bigint, game = GAME) => {
  const bytes = event("GameCompleted", 100);
  game.toBuffer().copy(bytes, 8);
  PLAYER.toBuffer().copy(bytes, 40);
  bytes.writeBigUInt64LE(fee, 84);
  bytes.writeBigUInt64LE(timestamp, 92);
  return bytes;
};

const feeWithdrawn = (amount: bigint) => {
  const bytes = event("TokenFeeWithdrawn", 80);
  PAYER.toBuffer().copy(bytes, 8);
  MINT.toBuffer().copy(bytes, 40);
  bytes.writeBigUInt64LE(amount, 72);
  return bytes;
};

const programTransaction = (
  events: Buffer[],
  options: {
    payer?: PublicKey;
    fee?: number;
    blockTime?: number | null;
    tokenMints?: string[];
    err?: unknown;
  } = {},
) =>
  ({
    blockTime: options.blockTime === undefined ? 200 : options.blockTime,
    transaction: { message: { staticAccountKeys: [options.payer ?? PAYER, PROGRAM] } },
    meta: {
      err: options.err ?? null,
      fee: options.fee,
      preTokenBalances: (options.tokenMints ?? []).map((mint, index) => ({
        accountIndex: index,
        mint,
        uiTokenAmount: { amount: "0" },
      })),
      postTokenBalances: [],
      logMessages: [
        `Program ${PROGRAM.toBase58()} invoke [1]`,
        ...events.map((bytes) => `Program data: ${bytes.toString("base64")}`),
        `Program ${PROGRAM.toBase58()} success`,
      ],
    },
  }) as any;

type Source = {
  sourceKey: string;
  sourceType: "discovery" | "program" | "jupiter";
  address: string;
  beforeSignature: string | null;
  startTimeMs: number;
  completed: boolean;
  processedTransactions: number;
  lastError: string | null;
};

const programSource: Source = {
  sourceKey: `program:${PROGRAM.toBase58()}`,
  sourceType: "program",
  address: PROGRAM.toBase58(),
  beforeSignature: null,
  startTimeMs: 0,
  completed: false,
  processedTransactions: 0,
  lastError: null,
};

const createHistory = (source: Source | null, progress = { total: 2, completed: 1 }) => {
  const events: any[] = [];
  const ensured: any[] = [];
  const advances: Array<[string, string | null, boolean, number]> = [];
  const errors: string[] = [];
  return {
    events,
    ensured,
    advances,
    errors,
    store: {
      recordFinanceEvent: (value: any) => events.push(value),
      ensureFinanceBackfillSource: (value: any) => ensured.push(value),
      getNextFinanceBackfillSource: () => source,
      advanceFinanceBackfillSource: (
        key: string,
        signature: string | null,
        completed: boolean,
        processed: number,
      ) => advances.push([key, signature, completed, processed]),
      recordFinanceBackfillError: (_key: string, error: string) => errors.push(error),
      getFinanceBackfillProgress: () => ({
        totalSources: progress.total,
        completedSources: progress.completed,
        processedTransactions: 0,
        lastError: null,
      }),
    },
  };
};

const noReferrals = {
  getReferralTokenAccountsV2: async () => ({ tokenAccounts: [], token2022Accounts: [] }),
} as any;

const serviceFor = (
  history: ReturnType<typeof createHistory>,
  connection: Record<string, unknown>,
  options: {
    payer?: PublicKey;
    referralReader?: any;
    resolveGameMint?: (game: string) => string | null;
    batchSize?: number;
    gameTokens?: unknown[] | (() => Promise<unknown[]>);
  } = {},
) =>
  new FinanceLedgerService(
    connection as any,
    {
      programId: PROGRAM,
      account: {
        gameToken: {
          all:
            typeof options.gameTokens === "function"
              ? options.gameTokens
              : async () => options.gameTokens ?? [],
        },
      },
    } as any,
    history.store as any,
    options.payer,
    options.referralReader ?? noReferrals,
    {
      batchSize: options.batchSize ?? 5,
      requestDelayMs: 0,
      now: () => 999_000,
      resolveGameMint: options.resolveGameMint,
    },
  );

const singleTransaction = (transaction: unknown, blockTime: number | null = 150) => ({
  getSignaturesForAddress: async () => [{ signature: "sig-1", blockTime, slot: 7 }],
  getTransaction: async () => transaction,
});

let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  __test_resetReferralConfig();
});
afterEach(() => {
  warnSpy.mockRestore();
  __test_resetReferralConfig();
});

describe("program finance events", () => {
  test("records a completed game's fee in the mint the game was created with", async () => {
    const history = createHistory(programSource);
    const transaction = programTransaction([gameInitialized(), gameCompleted(7n, 1_700n)], {
      fee: 5000,
    });

    await serviceFor(history, singleTransaction(transaction), { payer: PAYER }).backfillNextBatch(
      0,
    );

    expect(history.events).toEqual([
      {
        eventId: `program:sig-1:game:${GAME.toBase58()}`,
        source: "program",
        category: "game_fee",
        kind: "earned",
        signature: "sig-1",
        account: GAME.toBase58(),
        mint: MINT.toBase58(),
        amountRaw: "7",
        networkFeeLamports: "5000",
        timestamp: 1_700_000,
        slot: 7,
      },
    ]);
  });

  test("uses the injected mint resolver for games created in earlier transactions", async () => {
    const history = createHistory(programSource);
    const transaction = programTransaction([gameCompleted(3n, 0n)], { blockTime: null });

    await serviceFor(history, singleTransaction(transaction, 120), {
      resolveGameMint: (game) => (game === GAME.toBase58() ? "resolved-mint" : null),
    }).backfillNextBatch(0);

    expect(history.events[0]).toMatchObject({
      mint: "resolved-mint",
      amountRaw: "3",
      // No event timestamp or transaction block time: fall back to the signature's.
      timestamp: 120_000,
      // Without a configured payer the fee is always attributed.
      networkFeeLamports: null,
    });
  });

  test("infers the mint from the transaction's single token balance", async () => {
    const history = createHistory(programSource);
    const transaction = programTransaction([gameCompleted(0n, 0n)], {
      tokenMints: ["inferred-mint", "inferred-mint"],
      fee: 10,
    });

    await serviceFor(history, singleTransaction(transaction)).backfillNextBatch(0);

    // Completed games are recorded even with a zero fee.
    expect(history.events[0]).toMatchObject({
      mint: "inferred-mint",
      amountRaw: "0",
      timestamp: 200_000,
      networkFeeLamports: "10",
    });
  });

  test("skips a completed game whose mint cannot be determined", async () => {
    const history = createHistory(programSource);
    const transaction = programTransaction([gameCompleted(5n, 1n)], {
      tokenMints: ["a", "b"],
    });

    await serviceFor(history, singleTransaction(transaction)).backfillNextBatch(0);

    expect(history.events).toEqual([]);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("unable to resolve token mint");
    expect(history.advances[0]).toEqual([programSource.sourceKey, "sig-1", false, 1]);
  });

  test("records fee withdrawals, ignores empty ones, and skips other payers' fees", async () => {
    const history = createHistory(programSource);
    const transaction = programTransaction([feeWithdrawn(40n), feeWithdrawn(0n)], {
      payer: PLAYER,
      fee: 5000,
      blockTime: null,
    });

    await serviceFor(history, singleTransaction(transaction, null), {
      payer: PAYER,
    }).backfillNextBatch(0);

    expect(history.events).toEqual([
      {
        eventId: `program:sig-1:claim:${MINT.toBase58()}`,
        source: "program",
        category: "game_fee",
        kind: "claimed",
        signature: "sig-1",
        mint: MINT.toBase58(),
        amountRaw: "40",
        networkFeeLamports: null,
        timestamp: 999_000,
        slot: 7,
      },
    ]);
  });

  test("failed transactions are skipped but still advance the cursor", async () => {
    const history = createHistory(programSource);
    const transaction = programTransaction([feeWithdrawn(40n)], { err: { Custom: 1 } });

    await serviceFor(history, singleTransaction(transaction)).backfillNextBatch(0);

    expect(history.events).toEqual([]);
    expect(history.advances).toEqual([
      [programSource.sourceKey, "sig-1", false, 1],
      [programSource.sourceKey, "sig-1", true, 0],
    ]);
  });
});

describe("backfill source handling", () => {
  test("reports completion when every source is done", async () => {
    const history = createHistory(null, { total: 3, completed: 3 });

    const result = await serviceFor(history, {}).backfillNextBatch(0);

    expect(result).toMatchObject({ complete: true, processedTransactions: 0 });
    expect(history.ensured.map((source) => source.sourceType)).toEqual(["discovery", "program"]);
  });

  test("discovery registers a Jupiter source per referral token account", async () => {
    __test_setReferralConfig({ referralAccount: REFERRAL.toBase58() });
    const discovery: Source = {
      ...programSource,
      sourceKey: "discovery:jupiter",
      sourceType: "discovery",
      address: REFERRAL.toBase58(),
    };
    const history = createHistory(discovery, { total: 3, completed: 3 });
    const referralReader = {
      getReferralTokenAccountsV2: async (address: string) => {
        expect(address).toBe(REFERRAL.toBase58());
        return {
          tokenAccounts: [{ pubkey: REFERRAL_TOKEN, account: { mint: MINT, amount: 1n } }],
          token2022Accounts: [],
        };
      },
    };

    const result = await serviceFor(history, {}, { referralReader }).backfillNextBatch(42);

    expect(history.ensured.at(-1)).toEqual({
      sourceKey: `jupiter:${REFERRAL_TOKEN.toBase58()}`,
      sourceType: "jupiter",
      address: REFERRAL_TOKEN.toBase58(),
      startTimeMs: 42,
    });
    expect(history.advances).toEqual([["discovery:jupiter", null, true, 0]]);
    expect(result.complete).toBe(true);
  });

  test("a failed discovery is recorded and rethrown", async () => {
    const discovery: Source = {
      ...programSource,
      sourceKey: "discovery:jupiter",
      sourceType: "discovery",
    };
    const history = createHistory(discovery);
    const referralReader = {
      getReferralTokenAccountsV2: async () => {
        throw new Error("rpc down");
      },
    };

    await expect(serviceFor(history, {}, { referralReader }).backfillNextBatch(0)).rejects.toThrow(
      "rpc down",
    );
    expect(history.errors).toEqual(["Error: rpc down"]);
  });

  test("an invalid source address is recorded and rethrown", async () => {
    const history = createHistory({ ...programSource, address: "not-an-address" });

    await expect(serviceFor(history, {}).backfillNextBatch(0)).rejects.toThrow();
    expect(history.errors).toHaveLength(1);
  });

  test("a failed signature listing is recorded and rethrown", async () => {
    const history = createHistory(programSource);
    const connection = {
      getSignaturesForAddress: async () => {
        throw new Error("429");
      },
    };

    await expect(serviceFor(history, connection).backfillNextBatch(0)).rejects.toThrow("429");
    expect(history.errors).toEqual(["Error: 429"]);
  });

  test("a source with no more signatures is completed", async () => {
    const history = createHistory({ ...programSource, beforeSignature: "cursor" });

    const result = await serviceFor(history, {
      getSignaturesForAddress: async () => [],
    }).backfillNextBatch(0);

    expect(result.processedTransactions).toBe(0);
    expect(history.advances).toEqual([[programSource.sourceKey, "cursor", true, 0]]);
  });

  test("stops at signatures older than the backfill start", async () => {
    const history = createHistory({ ...programSource, startTimeMs: 100_000 });
    const connection = {
      getSignaturesForAddress: async () => [
        { signature: "new", blockTime: 150, slot: 2 },
        { signature: "old", blockTime: 50, slot: 1 },
      ],
      getTransaction: async () => programTransaction([]),
    };

    const result = await serviceFor(history, connection).backfillNextBatch(0);

    expect(result.processedTransactions).toBe(1);
    expect(history.advances).toEqual([
      [programSource.sourceKey, "new", false, 1],
      [programSource.sourceKey, "new", true, 0],
    ]);
  });
});

describe("finance snapshot", () => {
  const referralReader = {
    getReferralTokenAccountsV2: async () => ({
      tokenAccounts: [
        { pubkey: REFERRAL_TOKEN, account: { mint: MINT, amount: 25n } },
        { pubkey: PLAYER, account: { mint: PLAYER, amount: 0n } },
      ],
      token2022Accounts: [],
    }),
  };

  test("reports claimable game and swap fees with complete coverage", async () => {
    __test_setReferralConfig({
      referralAccount: REFERRAL.toBase58(),
      buildFeeAccount: BUILD_FEE.toBase58(),
    });
    const history = createHistory(null, { total: 2, completed: 2 });
    const connection = {
      getParsedAccountInfo: async (address: PublicKey) => {
        expect(address.toBase58()).toBe(BUILD_FEE.toBase58());
        return {
          value: {
            data: {
              parsed: { info: { mint: GAME.toBase58(), tokenAmount: { amount: "9" } } },
            },
          },
        };
      },
    };

    const snapshot = await serviceFor(history, connection, {
      referralReader,
      gameTokens: [
        { account: { tokenMint: MINT, feeAmount: { toString: () => "12" } } },
        { account: { tokenMint: PLAYER, feeAmount: 0 } },
      ],
    }).getSnapshot();

    expect(snapshot.coverage).toBe("complete");
    expect(snapshot.swapClaimable).toEqual([
      { mint: MINT.toBase58(), amountRaw: 25n },
      { mint: GAME.toBase58(), amountRaw: 9n },
    ]);
    expect(snapshot.gameClaimable).toEqual(
      contractCapabilities.gameTokenAccount ? [{ mint: MINT.toBase58(), amountRaw: 12n }] : [],
    );
  });

  test("ignores a build fee account that is not a parsed token account", async () => {
    __test_setReferralConfig({
      referralAccount: REFERRAL.toBase58(),
      buildFeeAccount: BUILD_FEE.toBase58(),
    });
    const history = createHistory(null, { total: 0, completed: 0 });
    const connection = { getParsedAccountInfo: async () => ({ value: null }) };

    const snapshot = await serviceFor(history, connection, { referralReader }).getSnapshot();

    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.swapClaimable).toEqual([{ mint: MINT.toBase58(), amountRaw: 25n }]);
  });

  test("falls back to empty balances when claimable lookups fail", async () => {
    const history = createHistory(null, { total: 2, completed: 2 });
    const failingReader = {
      getReferralTokenAccountsV2: async () => {
        throw new Error("rpc down");
      },
    };

    const snapshot = await serviceFor(history, {}, { referralReader: failingReader }).getSnapshot();

    expect(snapshot).toMatchObject({ gameClaimable: [], swapClaimable: [], coverage: "partial" });
    expect(warnSpy.mock.calls[0]?.[0]).toBe("Unable to load current claimable finance balances:");
  });
});
