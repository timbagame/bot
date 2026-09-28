import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PublicKey } from "#solana";
import {
  bot,
  botModule,
  callsTo,
  failApiMethod,
  resetCalls,
  restoreStubs,
  stub,
  useBotHarness,
} from "./helpers/bot-harness";
import { FaucetDatabase } from "../src/utils/faucet-database";
import { FEE_SWEEP_INTERVAL_MS, EXPIRED_GAMES_CHECK_INTERVAL_MS } from "../src/utils/constants";

useBotHarness();

type Intervals = Array<{ handler: () => unknown; ms: number }>;

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let originalGameManager: typeof botModule.gameManager;

beforeEach(async () => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  originalGameManager = botModule.gameManager;
  botModule.__test_setGameManager({
    reloadGameMessages: async () => {},
    recoverPendingGameCreation: async () => false,
  } as any);
  let listenerId = 0;
  botModule.__test_setProgram({
    programId: new PublicKey("11111111111111111111111111111112"),
    addEventListener: async () => ++listenerId,
    removeEventListener: async () => {},
    account: { game: {} },
  } as any);
});

afterEach(async () => {
  await botModule.__test_resetProgramEventState();
  botModule.__test_setGameManager(originalGameManager);
  botModule.__test_resetProgram();
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const logged = (spy: ReturnType<typeof spyOn>, text: string) =>
  spy.mock.calls.some((call: unknown[]) => String(call[0]).includes(text));

const createRuntime = (overrides: Record<string, unknown> = {}) => {
  const intervals: Intervals = [];
  const signals = new Map<string, () => void>();
  const exits: number[] = [];
  const served: Array<{ port: number; fetch: (request: Request) => Promise<Response> }> = [];
  const serverStop = mock(() => {});
  const handleStop = mock(async () => {});
  let resolveTask: () => void = () => {};
  let rejectTask: (error: Error) => void = () => {};
  const task = new Promise<void>((resolve, reject) => {
    resolveTask = resolve;
    rejectTask = reject;
  });
  const runtime = {
    setupProgram: async () => {},
    setInterval: (handler: () => unknown, ms: number) => {
      intervals.push({ handler, ms });
      return 0;
    },
    serve: (options: any) => {
      served.push(options);
      return { stop: serverStop };
    },
    runBot: () => ({ stop: handleStop, task: () => task }),
    onSignal: (signal: string, handler: () => void) => signals.set(signal, handler),
    exit: (code: number) => exits.push(code),
    feeSweeperEnabled: true,
    ...overrides,
  };
  return {
    runtime: runtime as any,
    intervals,
    signals,
    exits,
    served,
    serverStop,
    handleStop,
    resolveTask: () => resolveTask(),
    rejectTask: (error: Error) => rejectTask(error),
    interval: (ms: number) => intervals.find((entry) => entry.ms === ms)!,
  };
};

describe("startBot", () => {
  test("registers commands, schedules background jobs and serves the internal API", async () => {
    const env = createRuntime();
    process.env.BOT_INTERNAL_PORT = "4555";
    try {
      await botModule.startBot(env.runtime);
    } finally {
      delete process.env.BOT_INTERNAL_PORT;
    }

    const scopes = callsTo("setMyCommands").map((call) => call.payload.scope?.type ?? "default");
    expect(scopes).toEqual(["default", "all_private_chats", "all_group_chats"]);
    expect(env.intervals.map((entry) => entry.ms)).toEqual([
      3_000,
      60_000,
      FEE_SWEEP_INTERVAL_MS,
      24 * 60 * 60 * 1000,
      EXPIRED_GAMES_CHECK_INTERVAL_MS,
    ]);
    expect(env.served[0]!.port).toBe(4555);
    expect(env.served[0]!.fetch).toBe(botModule.handleInternalApiRequest);
    expect(botModule.__test_getProgramEventListenerState().programEventListenersReady).toBe(true);
    expect([...env.signals.keys()]).toEqual(["SIGINT", "SIGTERM"]);

    env.resolveTask();
    await Bun.sleep(0);
    expect(logged(logSpy, "Bot runner task completed")).toBe(true);

    env.signals.get("SIGTERM")!();
    await Bun.sleep(5);
    expect(env.handleStop).toHaveBeenCalledTimes(1);
    expect(env.serverStop).toHaveBeenCalledTimes(1);
    expect(env.exits).toEqual([0]);
  });

  test("a failing shutdown exits with an error code, and a failed runner is logged", async () => {
    const env = createRuntime();
    env.handleStop.mockImplementation(async () => {
      throw new Error("stop failed");
    });

    await botModule.startBot(env.runtime);
    env.rejectTask(new Error("polling crashed"));
    env.signals.get("SIGINT")!();
    await Bun.sleep(5);

    expect(env.exits).toEqual([1]);
    expect(logged(errorSpy, "Error during shutdown")).toBe(true);
    expect(logged(errorSpy, "Bot runner task failed")).toBe(true);
  });

  test("continues when the command menu cannot be registered", async () => {
    failApiMethod("setMyCommands", "Bad Request: too many commands");
    const env = createRuntime();

    await botModule.startBot(env.runtime);

    expect(logged(errorSpy, "Failed to register bot commands")).toBe(true);
    expect(env.served).toHaveLength(1);
  });

  test("does not start when the program client cannot be set up", async () => {
    const env = createRuntime({
      setupProgram: async () => {
        throw new Error("no operator key");
      },
    });

    await botModule.startBot(env.runtime);

    expect(logged(errorSpy, "Failed to set up program client")).toBe(true);
    expect(env.served).toEqual([]);
    expect(env.intervals).toEqual([]);
  });

  test("skips the fee sweeper when it is disabled", async () => {
    const env = createRuntime({ feeSweeperEnabled: false });

    await botModule.startBot(env.runtime);

    expect(env.intervals.some((entry) => entry.ms === FEE_SWEEP_INTERVAL_MS)).toBe(false);
    expect(logged(logSpy, "Automated fee sweeper disabled")).toBe(true);
  });

  test("scheduled jobs report their outcome and never throw", async () => {
    const env = createRuntime();
    await botModule.startBot(env.runtime);
    const faucets = FaucetDatabase.getInstance();
    const gameDb = botModule.__test_getGameDatabase();

    const expire = spyOn(faucets, "expireDue").mockReturnValue([{ id: 1 }] as any);
    stub(bot.api, "editMessageText", (async () => true) as any);
    await env.interval(60_000).handler();
    expect(logged(logSpy, "Expired 1 faucet")).toBe(true);
    expire.mockImplementation(() => {
      throw new Error("db locked");
    });
    await env.interval(60_000).handler();
    expect(logged(errorSpy, "Faucet expiry check failed")).toBe(true);
    expire.mockRestore();

    await env.interval(FEE_SWEEP_INTERVAL_MS).handler();
    expect(logged(errorSpy, "Automated fee sweep failed")).toBe(true);

    const cleanup = spyOn(gameDb, "cleanupOldGames").mockReturnValue({
      gamesDeleted: 2,
      participantsDeleted: 5,
    } as any);
    env.interval(24 * 60 * 60 * 1000).handler();
    expect(logged(logSpy, "removed 2 games and 5 participants")).toBe(true);
    cleanup.mockImplementation(() => {
      throw new Error("disk full");
    });
    env.interval(24 * 60 * 60 * 1000).handler();
    expect(logged(errorSpy, "Database cleanup failed")).toBe(true);
    cleanup.mockRestore();
  });
});

describe("autoStartBot", () => {
  test("starts the bot everywhere except under tests", () => {
    const start = mock(async () => {});

    botModule.autoStartBot("test", start);
    expect(start).not.toHaveBeenCalled();

    botModule.autoStartBot("production", start);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("expired game sweep", () => {
  test("cancels expired games and cleans up games whose account is gone", async () => {
    const expired = new PublicKey("So11111111111111111111111111111111111111112").toBase58();
    const orphan = new PublicKey("SysvarC1ock11111111111111111111111111111111").toBase58();
    const gameDb = botModule.__test_getGameDatabase();
    const completed: Array<[string, string]> = [];
    let batch = 0;
    stub(gameDb as any, "getGamesExpiringBefore", () =>
      batch++ === 0
        ? [
            { game_address: expired, status: "active" },
            { game_address: orphan, status: "active" },
          ]
        : [],
    );
    stub(gameDb as any, "getGame", (address: string) => ({
      game_address: address,
      status: "active",
    }));
    stub(gameDb as any, "getGameMessages", () => [{ chatId: -900, messageId: 5 }]);
    stub(gameDb as any, "completeGame", (address: string, winner: string) => {
      completed.push([address, winner]);
    });
    const handleExpiredGame = mock(async () => true);
    const updates: Array<[string, string, string | undefined]> = [];
    botModule.__test_setGameManager({
      reloadGameMessages: async () => {},
      recoverPendingGameCreation: async () => false,
      handleExpiredGame,
      getActiveGameMessages: () => new Map(),
      updateGameMessageFromData: async (
        _ctx: unknown,
        address: string,
        status: string,
        winner?: string,
      ) => {
        updates.push([address, status, winner]);
        if (address === orphan) throw new Error("message deleted");
      },
    } as any);
    botModule.__test_setProgram({
      programId: new PublicKey("11111111111111111111111111111112"),
      addEventListener: async () => 1,
      removeEventListener: async () => {},
      account: {
        game: {
          fetchMultiple: async () => [{ ticketsCount: 1, maxTickets: 2, expired: true }, null],
        },
      },
    } as any);
    stub(botModule.wallet as any, "getBlockchainTime", async () => 1_000);
    const isExpired = spyOn(
      (await import("../src/utils/game")).GameManager,
      "isExpired",
    ).mockImplementation((account: any) => account.expired === true);
    botModule.__test_setCompletionHistoryFetcher(async () => null);
    try {
      const env = createRuntime();
      await botModule.startBot(env.runtime);

      // Registered after the faucet expiry job, which may share the same period.
      const scans = env.intervals.filter((entry) => entry.ms === EXPIRED_GAMES_CHECK_INTERVAL_MS);
      await scans.at(-1)!.handler();

      expect((handleExpiredGame.mock.calls[0] as any[])[0].toBase58()).toBe(expired);
      expect(completed).toEqual([
        [expired, "cancelled"],
        [orphan, "cancelled"],
      ]);
      expect(updates).toEqual([
        [expired, "Completed", "cancelled"],
        [orphan, "Completed", "cancelled"],
      ]);
      expect(logged(warnSpy, `Could not update message for game ${orphan}:`)).toBe(true);
    } finally {
      isExpired.mockRestore();
      botModule.__test_resetCompletionHistoryFetcher();
    }
  });
});

describe("internal API", () => {
  const post = (body: unknown) =>
    botModule.handleInternalApiRequest(
      new Request("http://bot/internal/completed", {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  test("reports health", async () => {
    const response = await botModule.handleInternalApiRequest(new Request("http://bot/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  test("unknown routes and methods are not found", async () => {
    expect((await botModule.handleInternalApiRequest(new Request("http://bot/nope"))).status).toBe(
      404,
    );
    expect(
      (
        await botModule.handleInternalApiRequest(
          new Request("http://bot/health", { method: "POST" }),
        )
      ).status,
    ).toBe(404);
  });

  test("rejects invalid completion notifications", async () => {
    const response = await post({ gameAddress: "x" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid completion notification" });
  });

  test("processes valid completion notifications", async () => {
    const handled: unknown[][] = [];
    botModule.__test_setProcessGameCompletionHandler((async (...args: unknown[]) => {
      handled.push(args);
    }) as any);
    try {
      const response = await post({
        gameAddress: "So11111111111111111111111111111111111111112",
        winnerAddress: "11111111111111111111111111111112",
        winnerTxSignature: "5".repeat(88),
        totalPot: 10,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(handled[0]!.slice(0, 2)).toEqual([
        "So11111111111111111111111111111111111111112",
        "11111111111111111111111111111112",
      ]);
    } finally {
      botModule.__test_resetProcessGameCompletionHandler();
    }
  });

  test("malformed JSON is an internal error", async () => {
    const response = await post("{not json");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });
});

describe("program setup", () => {
  let saved: {
    tokenManager: any;
    swaps: ReturnType<typeof botModule.__test_getSwapManagers>;
  };
  beforeEach(() => {
    saved = {
      tokenManager: botModule.__test_getTokenManager(),
      swaps: botModule.__test_getSwapManagers(),
    };
  });
  afterEach(() => {
    botModule.__test_setTokenManager(saved.tokenManager);
    botModule.__test_setSwapManagers(saved.swaps);
  });

  const setup = async (options: {
    oracle?: Record<string, unknown> | Error;
    addToken?: (mint: string, ticker: string) => Promise<boolean>;
    createProgram?: () => unknown;
  }) => {
    const timbaProgram = await import("../src/utils/timba-program");
    const tokenManagerModule = await import("../src/utils/token-manager");
    const gameModule = await import("../src/utils/game");
    const oracleModule = await import("../src/utils/oracle");
    const readyListeners: unknown[] = [];
    const fakeProgram = {
      programId: new PublicKey("11111111111111111111111111111112"),
      account: {
        oracle: {
          fetch: async () => {
            if (options.oracle instanceof Error) throw options.oracle;
            return {
              operator: new PublicKey("11111111111111111111111111111113"),
              ...options.oracle,
            };
          },
        },
        gameToken: { fetch: async () => ({ minAmount: 2_000_000 }) },
      },
    };
    const added: string[] = [];
    const spies = [
      spyOn(timbaProgram, "createTimbaProgram").mockImplementation(
        (options.createProgram ?? (() => fakeProgram)) as any,
      ),
      spyOn(tokenManagerModule.TokenManager, "getInstance").mockReturnValue({
        addToken: async (mint: string, ticker: string) => {
          added.push(ticker);
          return options.addToken ? options.addToken(mint, ticker) : true;
        },
      } as any),
      spyOn(gameModule.GameManager, "getInstance").mockReturnValue({
        setGameMessageReadyListener: (listener: unknown) => readyListeners.push(listener),
      } as any),
      spyOn(oracleModule.OracleClient.getInstance(), "requireTokenPolicy").mockResolvedValue({
        minimumAmountRaw: "3000000",
        revision: 4,
      } as any),
    ];
    try {
      const outcome = await botModule.__test_setupProgram().then(
        () => "ok",
        (error: Error) => error,
      );
      return { outcome, added, readyListeners };
    } finally {
      for (const spy of spies) spy.mockRestore();
      botModule.__test_setGameManager(originalGameManager);
    }
  };

  test("initialises managers, tokens and oracle limits", async () => {
    const { outcome, added, readyListeners } = await setup({
      oracle: { maxTickets: 40n, oracleBufferTime: 30 },
    });

    expect(outcome).toBe("ok");
    expect(added.length).toBeGreaterThan(1);
    expect(readyListeners).toHaveLength(1);
    // The listener flushes player events that were waiting for a game card.
    botModule.__test_enqueuePendingPlayerEvent("ReadyGame", {
      event: { gameKey: { toString: () => "ReadyGame" } } as any,
      eventName: "PlayerJoined",
      receivedAt: Date.now(),
    });
    (readyListeners[0] as (address: string) => void)("ReadyGame");
    await Bun.sleep(0);
    expect(
      logged(warnSpy, "Message targets still unavailable for ReadyGame; will retry pending events"),
    ).toBe(true);
    botModule.__test_clearPendingPlayerEvents();
    expect(String(botModule.program.programId.toBase58())).toBe("11111111111111111111111111111112");
    expect(botModule.__test_getSwapManagers().swapManager).toBeDefined();
    expect(logged(logSpy, "Oracle max tickets set to 40")).toBe(true);
    expect(logged(logSpy, "Oracle buffer time set to 30 seconds")).toBe(true);
    expect(logged(logSpy, "token minimum:")).toBe(true);
  });

  test("keeps previous oracle limits when the values are unreadable", async () => {
    await setup({ oracle: { maxTickets: "lots", oracleBufferTime: null } });

    expect(logged(warnSpy, "Unable to determine oracle max tickets")).toBe(true);
    expect(logged(warnSpy, "Unable to determine oracle buffer time")).toBe(true);
  });

  test("tolerates a missing oracle and tokens that cannot be added", async () => {
    const { outcome } = await setup({
      oracle: new Error("not found"),
      addToken: async (_mint, ticker) => {
        if (ticker === "USDC") throw new Error("rpc down");
        return false;
      },
    });

    expect(outcome).toBe("ok");
    expect(logged(logSpy, "Oracle not found")).toBe(true);
    expect(logged(warnSpy, "Could not add approved token USDC")).toBe(true);
  });

  test("a token list that cannot even add the default token is only logged", async () => {
    await setup({
      oracle: new Error("not found"),
      addToken: async () => {
        throw new Error("db locked");
      },
    });

    expect(logged(warnSpy, "Error initializing approved tokens")).toBe(true);
  });

  test("fails loudly when the program client cannot be created", async () => {
    const { outcome } = await setup({
      createProgram: () => {
        throw new Error("bad IDL");
      },
    });

    expect((outcome as Error).message).toBe("bad IDL");
    expect(logged(errorSpy, "Error initializing Timba program")).toBe(true);
  });
});
