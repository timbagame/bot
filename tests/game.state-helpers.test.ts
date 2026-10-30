import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GameManager } from "../src/utils/game";
import { FeeBudgetManager } from "../src/utils/fee-budget";

const GAME = "BPFLoader1111111111111111111111111111111111";

type TimerCall = { callback: () => unknown; delay: number };

const captureTimers = () => {
  const original = globalThis.setTimeout;
  const calls: TimerCall[] = [];
  globalThis.setTimeout = ((callback: () => unknown, delay?: number) => {
    calls.push({ callback, delay: delay ?? 0 });
    return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  return {
    calls,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
};

const makeManager = (
  gameDb: any = {},
  program: any = { account: { game: {} } },
  wallet: any = {},
) => GameManager.getInstance(program, wallet, gameDb) as any;

describe("GameManager message update bookkeeping", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("a newer completion keeps winner, pot and signature from the previous completion", () => {
    const gm = makeManager();
    gm.rememberGameMessageUpdateRequest(GAME, 1, {
      status: "Completed",
      winnerAddress: "winner-a",
      totalPot: 5,
      winnerSignature: "sig-a",
    });
    gm.rememberGameMessageUpdateRequest(GAME, 2, { status: "Completed" });

    expect(gm.gameMessageCompletionMetadata.get(GAME)).toEqual({
      status: "Completed",
      generation: 2,
      winnerAddress: "winner-a",
      totalPot: 5,
      winnerSignature: "sig-a",
    });
  });

  test("an older completion only fills the fields a newer completion is missing", () => {
    const gm = makeManager();
    gm.rememberGameMessageUpdateRequest(GAME, 5, { status: "Completed" });
    gm.rememberGameMessageUpdateRequest(GAME, 2, {
      status: "Completed",
      winnerAddress: "winner-old",
      totalPot: 7,
      winnerSignature: "sig-old",
    });

    expect(gm.gameMessageCompletionMetadata.get(GAME)).toEqual({
      status: "Completed",
      generation: 5,
      winnerAddress: "winner-old",
      totalPot: 7,
      winnerSignature: "sig-old",
    });
  });

  test("an older completion never overwrites fields a newer completion already has", () => {
    const gm = makeManager();
    gm.rememberGameMessageUpdateRequest(GAME, 5, {
      status: "Completed",
      winnerAddress: "winner-new",
      totalPot: 9,
      winnerSignature: "sig-new",
    });
    gm.rememberGameMessageUpdateRequest(GAME, 2, {
      status: "Completed",
      winnerAddress: "winner-old",
      totalPot: 7,
      winnerSignature: "sig-old",
    });

    expect(gm.gameMessageCompletionMetadata.get(GAME)).toEqual({
      status: "Completed",
      generation: 5,
      winnerAddress: "winner-new",
      totalPot: 9,
      winnerSignature: "sig-new",
    });
  });

  test("isSupersededActiveGameMessageUpdate without a generation is never superseded", () => {
    const gm = makeManager();
    expect(gm.isSupersededActiveGameMessageUpdate(GAME, { status: "Active" })).toBe(false);
  });

  test("an older completion is not superseded when no newer request is remembered", () => {
    const gm = makeManager();
    gm.nextGameMessageUpdateGeneration(GAME);
    gm.nextGameMessageUpdateGeneration(GAME);
    expect(gm.isSupersededActiveGameMessageUpdate(GAME, { status: "Completed" }, 1)).toBe(false);
  });

  test("an older completion matching the newer completion is not superseded", () => {
    const gm = makeManager();
    const first = gm.nextGameMessageUpdateGeneration(GAME);
    const second = gm.nextGameMessageUpdateGeneration(GAME);
    const rich = { status: "Completed", winnerAddress: "w", totalPot: 3, winnerSignature: "s" };
    gm.rememberGameMessageUpdateRequest(GAME, second, rich);

    expect(gm.isSupersededActiveGameMessageUpdate(GAME, rich, first)).toBe(false);
    expect(
      gm.isSupersededActiveGameMessageUpdate(GAME, { ...rich, winnerSignature: "other" }, first),
    ).toBe(true);
  });

  test("a newer non-completed request does not supersede an older completion", () => {
    const gm = makeManager();
    const first = gm.nextGameMessageUpdateGeneration(GAME);
    const second = gm.nextGameMessageUpdateGeneration(GAME);
    gm.rememberGameMessageUpdateRequest(GAME, second, { status: "Active" });

    expect(gm.isSupersededActiveGameMessageUpdate(GAME, { status: "Completed" }, first)).toBe(
      false,
    );
  });
});

describe("GameManager persistCompletionSignature", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("skips persisting when a newer completion metadata holds a different signature", () => {
    const record: unknown[] = [];
    const gm = makeManager({
      recordGameCompletionFinance: (...args: unknown[]) => record.push(args),
    });
    gm.gameMessageCompletionMetadata.set(GAME, {
      status: "Completed",
      generation: 4,
      winnerSignature: "sig-new",
    });

    gm.persistCompletionSignature(GAME, 1, { status: "Completed", winnerSignature: "sig-old" });

    expect(record).toHaveLength(0);
  });

  test("skips persisting when the stored completion signature differs", () => {
    const record: unknown[] = [];
    const gm = makeManager({
      getGame: () => ({ completion_signature: "sig-stored" }),
      recordGameCompletionFinance: (...args: unknown[]) => record.push(args),
    });

    gm.persistCompletionSignature(GAME, 1, { status: "Completed", winnerSignature: "sig-other" });

    expect(record).toHaveLength(0);
  });

  test("persists when the stored signature matches", () => {
    const record: unknown[][] = [];
    const gm = makeManager({
      getGame: () => ({ completion_signature: "sig-same" }),
      recordGameCompletionFinance: (...args: unknown[]) => record.push(args),
    });

    gm.persistCompletionSignature(GAME, 1, { status: "Completed", winnerSignature: "sig-same" });

    expect(record).toEqual([[GAME, { signature: "sig-same" }]]);
  });

  test("logs a warning when persisting the signature throws", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = new Error("db locked");
      const gm = makeManager({
        recordGameCompletionFinance: () => {
          throw failure;
        },
      });

      gm.persistCompletionSignature(GAME, 1, { status: "Completed", winnerSignature: "sig" });

      expect(warn).toHaveBeenCalledWith(
        `Failed to persist completion signature for ${GAME}:`,
        failure,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GameManager getPersistedTerminalUpdate", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("returns null when the database lookup throws", () => {
    const gm = makeManager({
      getGame: () => {
        throw new Error("db closed");
      },
    });
    expect(gm.getPersistedTerminalUpdate(GAME, "Completed", "w", 1, "s")).toBeNull();
  });
});

describe("GameManager fetchGameAccountForRecovery", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("returns null when the account is missing", async () => {
    const gm = makeManager(
      {},
      {
        account: {
          game: {
            fetch: async () => {
              throw new Error("Account does not exist or has no data");
            },
          },
        },
      },
    );
    expect(await gm.fetchGameAccountForRecovery(GAME)).toBeNull();
  });

  test("rethrows other fetch errors", async () => {
    const failure = new Error("rpc exploded");
    const gm = makeManager(
      {},
      {
        account: {
          game: {
            fetch: async () => {
              throw failure;
            },
          },
        },
      },
    );
    await expect(gm.fetchGameAccountForRecovery(GAME)).rejects.toBe(failure);
  });
});

describe("GameManager unavailable state recovery timers", () => {
  let timers: ReturnType<typeof captureTimers>;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    timers = captureTimers();
    warn = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    timers.restore();
    warn.mockRestore();
    GameManager.resetForTest();
  });

  const ctx = { chat: { id: 77 } } as any;

  test("a second schedule for the same game and chat is ignored", () => {
    const gm = makeManager({ getGame: () => ({}) });
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");
    expect(timers.calls).toHaveLength(1);
    expect(gm.unavailableStateRecoveryTimers.size).toBe(1);
  });

  test("stops quietly when the game database cannot look games up", async () => {
    const gm = makeManager({});
    const update = spyOn(gm, "updateGameMessageFromData").mockResolvedValue(undefined);
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");
    await timers.calls[0]!.callback();
    expect(update).not.toHaveBeenCalled();
    expect(timers.calls).toHaveLength(1);
    expect(gm.unavailableStateRecoveryTimers.size).toBe(0);
  });

  test("stops quietly when the game lookup throws", async () => {
    const gm = makeManager({
      getGame: () => {
        throw new Error("db closed");
      },
    });
    const update = spyOn(gm, "updateGameMessageFromData").mockResolvedValue(undefined);
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");
    await timers.calls[0]!.callback();
    expect(update).not.toHaveBeenCalled();
    expect(timers.calls).toHaveLength(1);
    expect(gm.unavailableStateRecoveryTimers.size).toBe(0);
  });

  test("stops quietly when the game no longer exists", async () => {
    const gm = makeManager({ getGame: () => null });
    const update = spyOn(gm, "updateGameMessageFromData").mockResolvedValue(undefined);
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");
    await timers.calls[0]!.callback();
    expect(update).not.toHaveBeenCalled();
    expect(timers.calls).toHaveLength(1);
  });

  test("reschedules the next attempt when the recovery refresh fails", async () => {
    const gm = makeManager({ getGame: () => ({ status: "active" }) });
    const failure = new Error("rpc down");
    spyOn(gm, "fetchGameAccountForRecovery").mockRejectedValue(failure);
    const update = spyOn(gm, "updateGameMessageFromData").mockResolvedValue(undefined);
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");
    const firstDelay = timers.calls[0]!.delay;

    await timers.calls[0]!.callback();

    expect(update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(`Game state recovery attempt failed for ${GAME}:`, failure);
    expect(timers.calls).toHaveLength(2);
    expect(timers.calls[1]!.delay).toBeGreaterThan(firstDelay);
  });

  test("stops when the persisted lookup throws after a successful refresh", async () => {
    let lookups = 0;
    const gm = makeManager({
      getGame: () => {
        lookups += 1;
        if (lookups > 1) throw new Error("db closed");
        return { status: "active" };
      },
    });
    spyOn(gm, "fetchGameAccountForRecovery").mockResolvedValue({});
    const update = spyOn(gm, "updateGameMessageFromData").mockResolvedValue(undefined);
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");

    await timers.calls[0]!.callback();

    expect(update).toHaveBeenCalledWith(ctx, GAME, "Active");
    expect(timers.calls).toHaveLength(1);
  });

  test("reschedules when the game is still not completed after a refresh", async () => {
    const gm = makeManager({ getGame: () => ({ status: "active" }) });
    spyOn(gm, "fetchGameAccountForRecovery").mockResolvedValue({});
    spyOn(gm, "updateGameMessageFromData").mockResolvedValue(undefined);
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");

    await timers.calls[0]!.callback();

    expect(timers.calls).toHaveLength(2);
  });

  test("does not reschedule when the refreshed game is completed", async () => {
    const gm = makeManager({ getGame: () => ({ status: "completed" }) });
    spyOn(gm, "fetchGameAccountForRecovery").mockResolvedValue({});
    spyOn(gm, "updateGameMessageFromData").mockResolvedValue(undefined);
    gm.scheduleUnavailableStateRecovery(ctx, GAME, "coinflip");

    await timers.calls[0]!.callback();

    expect(timers.calls).toHaveLength(1);
  });
});

describe("GameManager getConnection resolution", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  const bare = (program: any, wallet: any) => {
    const gm = makeManager({}, program, wallet);
    gm.cachedConnection = undefined;
    return gm;
  };

  test("uses the cached connection first", () => {
    const connection = { tag: "cached" };
    const gm = makeManager();
    gm.cachedConnection = connection;
    expect(gm.getConnection()).toBe(connection);
  });

  test("falls back to the program provider connection and caches it", () => {
    const providerConnection = { rpcEndpoint: "http://provider.invalid" };
    const gm = bare({ account: { game: {} }, provider: { connection: providerConnection } }, {});
    expect(gm.getConnection()).toBe(providerConnection);
    expect(gm.cachedConnection).toBe(providerConnection);
  });

  test("falls back to wallet.getConnection and caches the result", () => {
    const walletConnection = { rpcEndpoint: "http://wallet-getter.invalid" };
    const gm = bare({ account: { game: {} } }, { getConnection: () => walletConnection });
    expect(gm.getConnection()).toBe(walletConnection);
    expect(gm.cachedConnection).toBe(walletConnection);
  });

  test("falls back to wallet.connection when getConnection returns nothing", () => {
    const walletConnection = { rpcEndpoint: "http://wallet-prop.invalid" };
    const walletStub: any = {};
    const gm = bare({ account: { game: {} } }, walletStub);
    walletStub.getConnection = () => undefined;
    walletStub.connection = walletConnection;
    expect(gm.getConnection()).toBe(walletConnection);
    expect(gm.cachedConnection).toBe(walletConnection);
  });

  test("throws when no connection can be resolved", () => {
    const gm = bare({ account: { game: {} } }, {});
    expect(() => gm.getConnection()).toThrow("Unable to resolve Solana connection");
  });
});

describe("GameManager dynamic fee budget priming", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("logs a warning when priming the dynamic fee budgets fails", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const connection = { rpcEndpoint: `http://test-state.invalid` } as any;
    const budget = FeeBudgetManager.getInstance(connection);
    const failure = new Error("fee estimate unavailable");
    const priming = spyOn(budget, "getSingleTransactionLamports").mockRejectedValue(failure);
    try {
      makeManager({}, { account: { game: {} } }, { getConnection: () => connection });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(priming).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("Failed to prime dynamic fee budgets:", failure);
    } finally {
      priming.mockRestore();
      warn.mockRestore();
    }
  });
});
