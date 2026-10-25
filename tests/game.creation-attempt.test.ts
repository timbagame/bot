import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import { GameManager } from "../src/utils/game";

const GAME = "BPFLoader1111111111111111111111111111111111";
const MINT = "So11111111111111111111111111111111111111112";

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  GameManager.resetForTest();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  GameManager.resetForTest();
});

function makePending(overrides: Record<string, unknown> = {}): any {
  return {
    game_address: GAME,
    creator_telegram_id: "1",
    creator_display_name: "Alice",
    amount: 100,
    game_type: "coinflip",
    token_mint: MINT,
    token_ticker: "TOK",
    max_players: 2,
    min_players: 2,
    chat_id: 5,
    timeout_seconds: 3600,
    expires_at: Date.now() + 3_600_000,
    transaction_signature: "SIG",
    state: "submitted",
    is_private: null,
    transaction_blockhash: null,
    last_valid_block_height: null,
    signed_transaction_base64: null,
    creation_message_id: null,
    replacement_count: 0,
    attempts: 0,
    last_error: null,
    next_attempt_at: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

type Log = Array<[string, ...unknown[]]>;

/** Production-shaped database double; pass `undefined` to remove a method. */
function makeDb(
  log: Log,
  overrides: Record<string, unknown> = {},
  options: { pendingQueue?: any[]; pending?: any } = {},
) {
  const queue = options.pendingQueue ? [...options.pendingQueue] : null;
  return {
    getPendingGameCreation: () =>
      queue ? (queue.length > 1 ? queue.shift() : queue[0]) : (options.pending ?? null),
    setPendingGameCreationStateIfCurrent: (_a: string, from: string[], to: string) => {
      log.push(["setIfCurrent", to, from]);
      return true;
    },
    clearPendingGameCreationIfState: (_a: string, states: string[]) => {
      log.push(["clearIfState", states]);
    },
    setPendingGameCreationChainTiming: (_a: string, created: number, expires: number) => {
      log.push(["pendingTiming", created, expires]);
    },
    setGameChainTiming: (_a: string, created: number, expires: number) => {
      log.push(["gameTiming", created, expires]);
    },
    setGameOriginChat: (_a: string, chatId: number) => {
      log.push(["originChat", chatId]);
    },
    savePlayerMapping: (account: string, telegramId: string) => {
      log.push(["mapping", account, telegramId]);
    },
    getGame: () => null,
    ...overrides,
  };
}

async function makeAttempt(options: {
  db?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
  pending?: any;
  account?: any | null;
  dbOptions?: { pendingQueue?: any[] };
  creator?: Awaited<ReturnType<typeof Keypair.generate>>;
}) {
  const log: Log = [];
  const creator = options.creator ?? (await Keypair.generate());
  const pending = options.pending ?? makePending();
  const nowSec = Math.floor(Date.now() / 1000);
  const account =
    options.account === undefined
      ? {
          creator: creator.publicKey,
          tokenMint: MINT,
          gameType: { coinflip: {} },
          ticketAmount: 100,
          maxTickets: 2,
          minTickets: 2,
          timeout: 3600,
          createdAt: nowSec,
          isPrivate: false,
        }
      : options.account;
  const db = makeDb(log, options.db, { pending, ...options.dbOptions });
  const manager = GameManager.getInstance(
    { account: { game: { fetch: async () => ({}) } } } as any,
    { getKeyPair: async () => creator, ...options.wallet } as any,
    db as any,
  );
  (manager as any).fetchGameAccountForRecovery = async () => account;
  const delivered: any[][] = [];
  (manager as any).deliverPendingGameCreation = async (...args: any[]) => {
    delivered.push(args);
  };
  const hydrateCalls: any[][] = [];
  (manager as any).hydrateGameDataFromChain = async (...args: any[]) => {
    hydrateCalls.push(args);
    return { status: "active", token_ticker: "HYD" };
  };
  const ctx = { chat: { id: 5 }, api: {} } as any;
  return {
    manager,
    log,
    pending,
    account,
    creator,
    delivered,
    hydrateCalls,
    ctx,
    run: (override?: any) =>
      (manager as any).recoverPendingGameCreationAttempt(
        ctx,
        override ?? pending,
      ) as Promise<boolean>,
  };
}

describe("locally terminal games", () => {
  for (const localGame of [
    { status: "completed" },
    { status: "CANCELLED" },
    { status: "active", winner_address: "WinnerAddr" },
  ]) {
    test(`delivers and clears the intent (${JSON.stringify(localGame)})`, async () => {
      const t = await makeAttempt({ db: { getGame: () => localGame } });

      expect(await t.run()).toBe(true);

      expect(t.delivered).toHaveLength(1);
      expect(t.delivered[0]![2]).toBe(localGame);
      expect(t.log).toEqual([
        ["originChat", 5],
        ["setIfCurrent", "delivered", ["submitted", "unknown", "confirmed", "delivered"]],
        ["clearIfState", ["delivered"]],
      ]);
      expect(t.hydrateCalls).toEqual([]);
    });
  }

  test("uses the compatibility state setter and plain clear for focused doubles", async () => {
    const calls: Log = [];
    const t = await makeAttempt({
      db: {
        getGame: () => ({ status: "completed" }),
        setPendingGameCreationStateIfCurrent: undefined,
        clearPendingGameCreationIfState: undefined,
        setPendingGameCreationState: (_a: string, state: string) => calls.push(["set", state]),
        clearPendingGameCreation: () => calls.push(["clear"]),
      },
    });

    expect(await t.run()).toBe(true);
    expect(calls).toEqual([["set", "delivered"], ["clear"]]);
  });

  test("keeps the record when the delivered transition is lost to another worker", async () => {
    const t = await makeAttempt({
      db: {
        getGame: () => ({ status: "completed" }),
        setPendingGameCreationStateIfCurrent: () => false,
      },
    });

    await expect(t.run()).rejects.toThrow(
      "Pending game creation state changed while finalizing local delivery; keeping the current record",
    );
    expect(t.log.some(([name]) => name === "clearIfState")).toBe(false);
  });

  test("keeps the record when no state setter exists at all", async () => {
    const t = await makeAttempt({
      db: {
        getGame: () => ({ status: "completed" }),
        setPendingGameCreationStateIfCurrent: undefined,
      },
    });
    await expect(t.run()).rejects.toThrow(/state changed while finalizing local delivery/);
  });
});

describe("game account not yet visible", () => {
  test("wraps a failing transaction outcome lookup", async () => {
    const cause = new Error("rpc down");
    const t = await makeAttempt({
      account: null,
      wallet: {
        getTransactionOutcome: async () => {
          throw cause;
        },
      },
    });

    const error = await t.run().catch((e: any) => e);

    expect(error.message).toBe("Unable to determine the pending game transaction outcome");
    expect(error.cause).toBe(cause);
  });

  test("resolves a failed transaction through the compatibility setters", async () => {
    const calls: Log = [];
    const outcomeArgs: unknown[][] = [];
    const t = await makeAttempt({
      account: null,
      wallet: {
        getTransactionOutcome: async (...args: unknown[]) => {
          outcomeArgs.push(args);
          return "failed";
        },
      },
      db: {
        setPendingGameCreationStateIfCurrent: undefined,
        clearPendingGameCreationIfState: undefined,
        setPendingGameCreationState: (_a: string, state: string, meta: any) =>
          calls.push(["set", state, meta.error]),
        clearPendingGameCreation: () => calls.push(["clear"]),
      },
    });

    expect(await t.run()).toBe(true);
    expect(outcomeArgs).toEqual([["SIG", { requireFinalizedFailure: true }]]);
    expect(calls).toEqual([
      ["set", "failed", "Game creation transaction failed before the game account was created"],
      ["clear"],
    ]);
  });

  test("keeps the failure notice durable when a placeholder message exists", async () => {
    const t = await makeAttempt({
      account: null,
      pending: makePending({ creation_message_id: 9 }),
      wallet: { getTransactionOutcome: async () => "failed" },
    });

    expect(await t.run()).toBe(true);
    expect(t.log.map(([name]) => name)).toEqual(["setIfCurrent"]);
  });

  test("keeps the record when the failed transition loses the race", async () => {
    const t = await makeAttempt({
      account: null,
      wallet: { getTransactionOutcome: async () => "failed" },
      db: { setPendingGameCreationStateIfCurrent: () => false },
    });

    await expect(t.run()).rejects.toThrow(
      "Pending game creation state changed while resolving the failed transaction; keeping the current record",
    );
  });

  test("stays pending when the outcome is unknown and nothing can be rebroadcast", async () => {
    const t = await makeAttempt({
      account: null,
      wallet: { getTransactionOutcome: async () => "unknown" },
    });

    await expect(t.run()).rejects.toThrow(
      "Game account is not available yet and the transaction outcome is unknown; keeping the pending creation for recovery",
    );
  });

  describe("prepared transactions past their lifetime", () => {
    const expiredWallet = {
      getConnection: () => ({ getBlockHeight: async () => 50 }),
      getTransactionOutcome: async () => "unknown",
    };
    const prepared = (overrides: Record<string, unknown> = {}) =>
      makePending({
        state: "prepared",
        transaction_blockhash: "hash",
        last_valid_block_height: 10,
        ...overrides,
      });
    const reason = "Prepared game creation transaction expired before broadcast";

    test("fails the prepared intent and keeps a notice for an existing placeholder", async () => {
      const failCalls: unknown[][] = [];
      const t = await makeAttempt({
        account: null,
        wallet: expiredWallet,
        pending: prepared({ creation_message_id: 9 }),
        db: {
          failPreparedGameCreationIfCurrent: (...args: unknown[]) => {
            failCalls.push(args);
            return true;
          },
        },
      });

      expect(await t.run()).toBe(true);
      expect(failCalls).toHaveLength(1);
      expect(failCalls[0]![0]).toBe(GAME);
      expect(failCalls[0]![1]).toBe(reason);
      expect(t.log).toEqual([]);
    });

    test("fails the prepared intent and clears it when nobody is waiting", async () => {
      const t = await makeAttempt({
        account: null,
        wallet: expiredWallet,
        pending: prepared(),
        db: { failPreparedGameCreationIfCurrent: () => true },
      });

      expect(await t.run()).toBe(true);
      expect(t.log).toEqual([["clearIfState", ["failed"]]]);
    });

    test("falls back to a plain clear when only the compatibility clear exists", async () => {
      const calls: Log = [];
      const t = await makeAttempt({
        account: null,
        wallet: expiredWallet,
        pending: prepared(),
        db: {
          failPreparedGameCreationIfCurrent: () => true,
          clearPendingGameCreationIfState: undefined,
          clearPendingGameCreation: () => calls.push(["clear"]),
        },
      });

      expect(await t.run()).toBe(true);
      expect(calls).toEqual([["clear"]]);
    });

    test("retains a submission that another worker admitted during expiry", async () => {
      const t = await makeAttempt({
        account: null,
        wallet: expiredWallet,
        pending: prepared(),
        db: { failPreparedGameCreationIfCurrent: () => false },
        dbOptions: { pendingQueue: [prepared(), prepared({ state: "submitted" })] },
      });

      await expect(t.run()).rejects.toThrow(
        "Pending game creation submission was admitted while expiry was being resolved; keeping it reserved",
      );
    });

    test("keeps the prepared row when the database cannot re-read it", async () => {
      const t = await makeAttempt({
        account: null,
        wallet: expiredWallet,
        pending: prepared(),
        db: { failPreparedGameCreationIfCurrent: () => false },
        dbOptions: { pendingQueue: [prepared()] },
      });
      // Remove the re-read helper only after the first (initial) read is not needed.
      (t.manager as any).gameDb.getPendingGameCreation = undefined;

      await expect(t.run()).rejects.toThrow(/could not be resolved atomically/);
    });

    test("reports an unresolved atomic expiry when the row is still prepared", async () => {
      const t = await makeAttempt({
        account: null,
        wallet: expiredWallet,
        pending: prepared(),
        db: { failPreparedGameCreationIfCurrent: () => false },
        dbOptions: { pendingQueue: [prepared()] },
      });

      await expect(t.run()).rejects.toThrow(
        "Prepared game creation expiry could not be resolved atomically; keeping the pending creation reserved",
      );
    });

    test("without the atomic helper it fails the intent through the generic setter", async () => {
      const t = await makeAttempt({
        account: null,
        wallet: expiredWallet,
        pending: prepared(),
      });

      expect(await t.run()).toBe(true);
      expect(t.log).toEqual([
        ["setIfCurrent", "failed", ["prepared", "submitted", "unknown"]],
        ["clearIfState", ["failed"]],
      ]);
    });

    test("without the atomic helper a lost generic transition keeps the intent reserved", async () => {
      const t = await makeAttempt({
        account: null,
        wallet: expiredWallet,
        pending: prepared(),
        db: { setPendingGameCreationStateIfCurrent: () => false },
      });

      await expect(t.run()).rejects.toThrow(/could not be resolved atomically/);
    });
  });
});

describe("confirmed account validation", () => {
  test("accepts a base58 string creator", async () => {
    const creator = await Keypair.generate();
    const t = await makeAttempt({
      creator,
      account: {
        creator: creator.publicKey.toBase58(),
        tokenMint: MINT,
        gameType: { coinflip: {} },
        ticketAmount: 100,
        maxTickets: 2,
        minTickets: 2,
        timeout: 3600,
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    expect(await t.run()).toBe(true);
    expect(t.log[0]).toEqual(["mapping", creator.publicKey.toBase58(), "1"]);
  });

  test("rejects an account created by a different wallet", async () => {
    const stranger = await Keypair.generate();
    const t = await makeAttempt({
      wallet: { getKeyPair: async () => stranger },
    });

    await expect(t.run()).rejects.toThrow(
      "Pending game creator does not match the confirmed game account",
    );
    expect(t.delivered).toEqual([]);
  });

  const mismatches: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    [
      "token mint",
      {},
      { tokenMint: "11111111111111111111111111111112" },
      "Pending game token mint does not match the confirmed game account",
    ],
    [
      "game type",
      {},
      { gameType: { giveaway: {} } },
      "Pending game type does not match the confirmed game account",
    ],
    [
      "amount",
      {},
      { ticketAmount: 99 },
      "Pending game amount does not match the confirmed game account",
    ],
    [
      "max players",
      {},
      { maxTickets: 3 },
      "Pending game player limit does not match the confirmed game account",
    ],
    [
      "min players",
      {},
      { minTickets: 1 },
      "Pending game minimum player limit does not match the confirmed game account",
    ],
    [
      "timeout",
      {},
      { timeout: 60 },
      "Pending game timeout does not match the confirmed game account",
    ],
    [
      "visibility",
      { is_private: 1 },
      { isPrivate: false },
      "Pending game visibility does not match the confirmed game account",
    ],
    [
      "timing",
      {},
      { createdAt: 0, timeout: 3600 },
      "Confirmed game account is missing authoritative creation timing",
    ],
  ];

  for (const [label, pendingOverrides, accountOverrides, message] of mismatches) {
    test(`rejects a mismatching ${label}`, async () => {
      const creator = await Keypair.generate();
      const base = {
        creator: creator.publicKey,
        tokenMint: MINT,
        gameType: { coinflip: {} },
        ticketAmount: 100,
        maxTickets: 2,
        minTickets: 2,
        timeout: 3600,
        createdAt: Math.floor(Date.now() / 1000),
        isPrivate: false,
      };
      const t = await makeAttempt({
        creator,
        pending: makePending(pendingOverrides),
        account: { ...base, ...accountOverrides },
      });

      await expect(t.run()).rejects.toThrow(message);
      expect(t.delivered).toEqual([]);
      expect(t.log.some(([name]) => name === "setIfCurrent")).toBe(false);
    });
  }
});

describe("confirmed account delivery", () => {
  test("persists confirmation and chain timing before delivering from authoritative data", async () => {
    const creator = await Keypair.generate();
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const t = await makeAttempt({
      creator,
      account: {
        creator: creator.publicKey,
        tokenMint: MINT,
        gameType: { coinflip: {} },
        ticketAmount: 100,
        timeout: 3600,
        createdAt,
      },
    });

    expect(await t.run()).toBe(true);

    expect(t.log.map(([name]) => name)).toEqual([
      "mapping",
      "setIfCurrent",
      "pendingTiming",
      "gameTiming",
      "originChat",
      "setIfCurrent",
      "clearIfState",
    ]);
    expect(t.log[1]).toEqual([
      "setIfCurrent",
      "confirmed",
      ["prepared", "submitted", "unknown", "confirmed"],
    ]);
    expect(t.log[5]).toEqual(["setIfCurrent", "delivered", ["confirmed", "delivered"]]);
    expect(t.hydrateCalls).toEqual([[GAME, { allowExpired: true }]]);
    const gameData = t.delivered[0]![2];
    // Missing on-chain limits fall back to the pending request values.
    expect(gameData.max_players).toBe(2);
    expect(gameData.min_players).toBe(2);
    expect(gameData.created_at).toBe(createdAt * 1000);
    expect(gameData.expires_at).toBe((createdAt + 3600) * 1000);
    expect(gameData.token_ticker).toBe("HYD");
    expect(gameData.amount).toBe(100);
  });

  test("prefers the on-chain player limits when present", async () => {
    const t = await makeAttempt({ pending: makePending({ max_players: 0, min_players: 0 }) });
    await t.run();
    expect(t.delivered[0]![2].max_players).toBe(2);
    expect(t.delivered[0]![2].min_players).toBe(2);
  });

  test("retains the pending creation when the confirmed transition is lost", async () => {
    const t = await makeAttempt({
      db: { setPendingGameCreationStateIfCurrent: () => false },
    });

    await expect(t.run()).rejects.toThrow(
      "Confirmed game could not be durably marked confirmed; retaining the pending creation",
    );
    expect(t.delivered).toEqual([]);
  });

  test("uses the compatibility setters for confirmation and delivery", async () => {
    const calls: Log = [];
    const t = await makeAttempt({
      db: {
        setPendingGameCreationStateIfCurrent: undefined,
        clearPendingGameCreationIfState: undefined,
        setPendingGameCreationState: (_a: string, state: string) => calls.push(["set", state]),
        clearPendingGameCreation: () => calls.push(["clear"]),
        setPendingGameCreationChainTiming: undefined,
        setGameChainTiming: undefined,
      },
    });

    expect(await t.run()).toBe(true);
    expect(calls).toEqual([["set", "confirmed"], ["set", "delivered"], ["clear"]]);
  });

  test("keeps the record when the delivered transition is lost", async () => {
    const t = await makeAttempt({
      db: {
        setPendingGameCreationStateIfCurrent: (_a: string, _from: string[], to: string) =>
          to === "confirmed",
      },
    });

    await expect(t.run()).rejects.toThrow(
      "Pending game creation state changed while finalizing delivery; keeping the current record",
    );
    expect(t.delivered).toHaveLength(1);
  });

  test("keeps the record when delivery cannot be recorded at all", async () => {
    const calls: Log = [];
    const t = await makeAttempt({
      db: {
        setPendingGameCreationStateIfCurrent: undefined,
        setPendingGameCreationState: (_a: string, state: string) => {
          calls.push(["set", state]);
        },
        clearPendingGameCreationIfState: undefined,
        clearPendingGameCreation: undefined,
      },
    });

    // Compatibility setter marks it delivered, but with no clear helper nothing is deleted.
    expect(await t.run()).toBe(true);
    expect(calls).toEqual([
      ["set", "confirmed"],
      ["set", "delivered"],
    ]);
  });
});

describe("confirmed but already expired accounts", () => {
  async function expiredAttempt(
    handleExpired: () => Promise<unknown>,
    db: Record<string, unknown> = {},
  ) {
    const creator = await Keypair.generate();
    const createdAt = Math.floor(Date.now() / 1000) - 7200;
    const t = await makeAttempt({
      creator,
      db,
      account: {
        creator: creator.publicKey,
        tokenMint: MINT,
        gameType: { coinflip: {} },
        ticketAmount: 100,
        maxTickets: 2,
        minTickets: 2,
        timeout: 3600,
        createdAt,
      },
    });
    const expiredCalls: any[][] = [];
    (t.manager as any).handleExpiredGame = async (...args: any[]) => {
      expiredCalls.push(args);
      return handleExpired();
    };
    return { ...t, expiredCalls };
  }

  test("delivers a cancelled card, completes the game and clears the intent", async () => {
    const completions: unknown[][] = [];
    const t = await expiredAttempt(async () => ({ cancelled: true, amount: 5 }), {
      completeGame: (...args: unknown[]) => completions.push(args),
    });

    expect(await t.run()).toBe(true);

    expect(t.expiredCalls).toHaveLength(1);
    expect(t.expiredCalls[0]![0].toBase58()).toBe(GAME);
    expect(completions).toHaveLength(1);
    expect(completions[0]!.slice(0, 2)).toEqual([GAME, "cancelled"]);
    expect(completions[0]![3]).toBe(5);
    const gameData = t.delivered[0]![2];
    expect(gameData).toMatchObject({
      status: "completed",
      winner_address: "cancelled",
      total_amount: 5,
    });
    expect(t.log.map(([name]) => name)).toEqual([
      "mapping",
      "setIfCurrent",
      "pendingTiming",
      "gameTiming",
      "originChat",
      "setIfCurrent",
      "clearIfState",
    ]);
    expect(t.log[5]![2]).toEqual(["prepared", "submitted", "unknown", "confirmed", "delivered"]);
  });

  test("finishes a cancelled card through the compatibility setters", async () => {
    const calls: Log = [];
    const t = await expiredAttempt(async () => ({ cancelled: true }), {
      setPendingGameCreationStateIfCurrent: undefined,
      clearPendingGameCreationIfState: undefined,
      setPendingGameCreationState: (_a: string, state: string) => calls.push(["set", state]),
      clearPendingGameCreation: () => calls.push(["clear"]),
    });

    expect(await t.run()).toBe(true);
    expect(calls).toEqual([["set", "confirmed"], ["set", "delivered"], ["clear"]]);
    expect(t.delivered[0]![2].total_amount).toBeUndefined();
  });

  test("keeps the record when the cancelled delivery transition is lost", async () => {
    const t = await expiredAttempt(async () => ({ cancelled: true }), {
      setPendingGameCreationStateIfCurrent: (_a: string, _from: string[], to: string) =>
        to === "confirmed",
    });

    await expect(t.run()).rejects.toThrow(
      "Pending game creation state changed while finalizing expired-game delivery; keeping the current record",
    );
  });

  for (const outcome of [undefined, false, { cancelled: false }]) {
    test(`requires another cleanup sweep when the cancellation is ${JSON.stringify(outcome)}`, async () => {
      const t = await expiredAttempt(async () => outcome);

      await expect(t.run()).rejects.toThrow("expired confirmed game still requires cleanup");
      expect(t.delivered).toEqual([]);
    });
  }
});
