import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { PublicKey, Keypair } from "#solana";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameData } from "../src/types";

process.env["NODE_ENV"] = "test";
process.env["MNEMONIC"] ??= "test test test test test test test test test test test junk";
process.env["TELEGRAM_TOKEN"] ??= "TEST_TELEGRAM_TOKEN";
process.env["SOLANA_NETWORK"] ??= "http://localhost:8899";
process.env["BOT_DB_DIR"] ??= mkdtempSync(join(tmpdir(), "timba-bot-tests-"));

const botModulePromise = import("../src/bot");

const createTestGameAddress = async () => (await Keypair.generate()).publicKey.toBase58();

const createCompletionEvent = (
  gameAddress: string,
  overrides: Partial<Record<string, unknown>> = {},
) => ({
  name: "GameCompleted",
  data: {
    gameKey: {
      toBase58: () => gameAddress,
    },
    winner: {
      toBase58: () => "WinnerPubkey",
    },
    winnerAmount: {
      toNumber: () => 24_000,
    },
    feeAmount: {
      toNumber: () => 240,
      toString: () => "240",
    },
    ...overrides,
  },
});

describe("Game completion recovery", () => {
  let botModule: Awaited<typeof botModulePromise>;

  beforeAll(async () => {
    botModule = await botModulePromise;
  });

  beforeEach(() => {
    botModule.__test_setProgram({
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
      coder: {} as any,
    } as any);
  });

  afterEach(() => {
    botModule.__test_resetCompletionHistoryFetcher();
    botModule.__test_resetProcessGameCompletionHandler();
    botModule.__test_resetCompletionEventParserFactory();
    botModule.__test_resetCompletionJobs();
    botModule.__test_resetProgram();
  });

  test("parses completion data from logs", async () => {
    const gameAddress = await createTestGameAddress();
    const fakeParser = {
      *parseLogs(_logs: string[]) {
        yield createCompletionEvent(gameAddress);
      },
    } as any;

    const parsed = botModule.__test_parseCompletionEventFromLogs(
      ["Program log"],
      fakeParser,
      gameAddress,
    );

    expect(parsed).toEqual({
      winnerAddress: "WinnerPubkey",
      totalPot: 24_240,
      feeAmountRaw: "240",
      winnerAmount: 24_000,
    });
  });

  test("skips unrelated or incomplete events while parsing logs", async () => {
    const gameAddress = await createTestGameAddress();
    const events = [
      { name: "playerJoined", data: {} },
      { name: "gameCompleted" },
      createCompletionEvent("OtherGame"),
      createCompletionEvent(gameAddress, { winner: { toBase58: () => "" } }),
      createCompletionEvent(gameAddress, {
        winner: "PlainWinner",
        winnerAmount: {
          toNumber: () => {
            throw new Error("53 bits");
          },
          toString: () => "9007199254740993",
        },
        feeAmount: undefined,
      }),
    ];

    const parsed = botModule.__test_parseCompletionEventFromLogs(
      ["Program log"],
      { parseLogs: () => events } as any,
      gameAddress,
    );

    expect(parsed).toEqual({
      winnerAddress: "PlainWinner",
      // Parsed from the string form, so it matches Number() of that string.
      totalPot: Number("9007199254740993"),
      winnerAmount: Number("9007199254740993"),
      feeAmountRaw: undefined,
    });
  });

  test("accepts plain and bigint amounts and ignores unreadable ones", async () => {
    const gameAddress = await createTestGameAddress();
    const parse = (overrides: Record<string, unknown>) =>
      botModule.__test_parseCompletionEventFromLogs(
        ["Program log"],
        { parseLogs: () => [createCompletionEvent(gameAddress, overrides)] } as any,
        gameAddress,
      );

    expect(parse({ winnerAmount: 100, feeAmount: 5n })).toMatchObject({
      totalPot: 105,
      winnerAmount: 100,
      feeAmountRaw: "5",
    });
    expect(parse({ winnerAmount: "100", feeAmount: { toString: () => "n/a" } })).toMatchObject({
      totalPot: undefined,
      winnerAmount: undefined,
      feeAmountRaw: "n/a",
    });
    expect(parse({ winnerAmount: null, feeAmount: null })).toMatchObject({
      totalPot: undefined,
      feeAmountRaw: "",
    });
  });

  test("empty logs have no completion event", () => {
    expect(
      botModule.__test_parseCompletionEventFromLogs([], { parseLogs: () => [] } as any, "Game"),
    ).toBeNull();
    expect(
      botModule.__test_parseCompletionEventFromLogs(null, { parseLogs: () => [] } as any, "Game"),
    ).toBeNull();
  });

  test("the default parser reads events for the configured program", async () => {
    const gameAddress = await createTestGameAddress();
    const connectionStub = {
      getSignaturesForAddress: async () => [{ signature: "sig-1" }],
      getTransaction: async () => ({ meta: { logMessages: ["Program log: nothing here"] } }),
    };
    const originalGetConnection = botModule.wallet.getConnection.bind(botModule.wallet);
    botModule.wallet.getConnection = () => connectionStub as any;
    try {
      expect(await botModule.__test_fetchCompletionDetailsFromHistory(gameAddress)).toBeNull();
    } finally {
      botModule.wallet.getConnection = originalGetConnection;
    }
  });

  test("history lookups without a program, signatures or transactions find nothing", async () => {
    const gameAddress = await createTestGameAddress();
    const originalGetConnection = botModule.wallet.getConnection.bind(botModule.wallet);
    let signatures: Array<{ signature?: string }> = [];
    botModule.wallet.getConnection = () =>
      ({
        getSignaturesForAddress: async () => signatures,
        getTransaction: async () => null,
      }) as any;
    try {
      expect(await botModule.__test_fetchCompletionDetailsFromHistory(gameAddress)).toBeNull();

      signatures = [{ signature: "" }, { signature: "missing-tx" }];
      expect(await botModule.__test_fetchCompletionDetailsFromHistory(gameAddress)).toBeNull();

      botModule.__test_setProgram(undefined);
      expect(await botModule.__test_fetchCompletionDetailsFromHistory(gameAddress)).toBeNull();
    } finally {
      botModule.wallet.getConnection = originalGetConnection;
    }
  });

  test("completion details omit the network fee when the transaction has none", async () => {
    const gameAddress = await createTestGameAddress();
    const originalGetConnection = botModule.wallet.getConnection.bind(botModule.wallet);
    botModule.wallet.getConnection = () =>
      ({
        getSignaturesForAddress: async () => [{ signature: "no-fee" }],
        getTransaction: async () => ({ meta: { logMessages: ["Program log"] } }),
      }) as any;
    botModule.__test_setCompletionEventParserFactory(
      () => ({ parseLogs: () => [createCompletionEvent(gameAddress)] }) as any,
    );
    try {
      const details = await botModule.__test_fetchCompletionDetailsFromHistory(gameAddress);
      expect(details).not.toHaveProperty("networkFeeLamports");
      expect(details?.signature).toBe("no-fee");
    } finally {
      botModule.wallet.getConnection = originalGetConnection;
    }
  });

  test("RPC failures while reconstructing history are logged", async () => {
    const gameAddress = await createTestGameAddress();
    const originalGetConnection = botModule.wallet.getConnection.bind(botModule.wallet);
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    botModule.wallet.getConnection = () =>
      ({
        getSignaturesForAddress: async () => {
          throw new Error("429 Too Many Requests");
        },
      }) as any;
    try {
      expect(await botModule.__test_fetchCompletionDetailsFromHistory(gameAddress)).toBeNull();
      expect(errors[0]?.[0]).toBe(`Error reconstructing completion history for ${gameAddress}:`);
    } finally {
      console.error = originalError;
      botModule.wallet.getConnection = originalGetConnection;
    }
  });

  test("fetches completion details from transaction history", async () => {
    const gameAddress = await createTestGameAddress();
    const connectionStub = {
      getSignaturesForAddress: async () => [
        {
          signature: "completion-signature",
        },
      ],
      getTransaction: async () => ({
        meta: {
          logMessages: ["Program log"],
          fee: 7_000,
        },
      }),
    };

    const originalGetConnection = botModule.wallet.getConnection.bind(botModule.wallet);

    botModule.wallet.getConnection = () => connectionStub as any;

    botModule.__test_setCompletionEventParserFactory(
      () =>
        ({
          *parseLogs(_logs: string[]) {
            yield createCompletionEvent(gameAddress);
          },
        }) as any,
    );

    try {
      const details = await botModule.__test_fetchCompletionDetailsFromHistory(gameAddress);

      expect(details).toEqual({
        winnerAddress: "WinnerPubkey",
        totalPot: 24_240,
        signature: "completion-signature",
        feeAmountRaw: "240",
        networkFeeLamports: 7_000,
        winnerAmount: 24_000,
      });
    } finally {
      botModule.wallet.getConnection = originalGetConnection;
    }
  });

  test("fetch completion history continues after empty batches", async () => {
    const gameAddress = await createTestGameAddress();
    const signatures = Array.from({ length: 6 }, (_, index) => ({
      signature: `completion-${index}`,
    }));

    const transactionResponses: Array<{ meta: { logMessages: string[] } } | null> = [
      null,
      null,
      null,
      null,
      {
        meta: {
          logMessages: ["Program log for completion-4"],
        },
      },
      null,
    ];

    let txCallCount = 0;

    const connectionStub = {
      getSignaturesForAddress: async () => signatures,
      getTransaction: async () => {
        const response = transactionResponses[txCallCount];
        txCallCount += 1;
        return response ?? null;
      },
    };

    const originalGetConnection = botModule.wallet.getConnection.bind(botModule.wallet);

    botModule.wallet.getConnection = () => connectionStub as any;

    botModule.__test_setCompletionEventParserFactory(
      () =>
        ({
          *parseLogs(logs: string[] = []) {
            if (logs.some((message) => message.includes("completion-4"))) {
              yield createCompletionEvent(gameAddress);
            }
          },
        }) as any,
    );

    try {
      const details = await botModule.__test_fetchCompletionDetailsFromHistory(gameAddress);

      expect(details).toEqual({
        winnerAddress: "WinnerPubkey",
        totalPot: 24_240,
        signature: "completion-4",
        feeAmountRaw: "240",
        winnerAmount: 24_000,
      });
    } finally {
      botModule.wallet.getConnection = originalGetConnection;
    }
  });

  test("cleanup uses reconstructed completion details", async () => {
    const gameAddress = await createTestGameAddress();
    const gameDb = botModule.__test_getGameDatabase();
    const completionCalls: Array<[string, string, number | undefined, string | undefined]> = [];
    const historyCalls: string[] = [];

    const originalGetGame = gameDb.getGame.bind(gameDb);
    const originalCompleteGame = gameDb.completeGame.bind(gameDb);

    const stubGameRecord: GameData = {
      game_address: gameAddress,
      creator_telegram_id: "creator",
      amount: 12_000,
      created_at: Date.now(),
      status: "active",
      winner_address: undefined,
      completed_at: undefined,
      message_id: undefined,
      chat_id: undefined,
      game_type: "coinflip",
      token_mint: "Mint",
      token_ticker: "TIMBA",
      max_players: 2,
      min_players: 2,
    };

    const gameDbAny = gameDb as unknown as {
      getGame: typeof gameDb.getGame;
      completeGame: typeof gameDb.completeGame;
    };

    gameDbAny.getGame = (address: string) => {
      if (address === gameAddress) {
        return stubGameRecord as any;
      }
      return originalGetGame(address);
    };

    gameDbAny.completeGame = (address: string, winner: string, completedAt?: number) => {
      if (address === gameAddress) {
        stubGameRecord.status = "completed";
        stubGameRecord.winner_address = winner;
        stubGameRecord.completed_at = completedAt ?? Date.now();
        return;
      }
      originalCompleteGame(address, winner, completedAt);
    };

    botModule.__test_setCompletionHistoryFetcher(async () => {
      historyCalls.push(gameAddress);
      return {
        winnerAddress: "RecoveredWinner",
        totalPot: 42_000,
        signature: "sig123",
      };
    });

    botModule.__test_setProcessGameCompletionHandler(
      async (address, winner, totalPot, signature) => {
        completionCalls.push([address, winner, totalPot, signature]);
        gameDbAny.completeGame(address, winner, Date.now());
      },
    );

    try {
      await botModule.__test_cleanupOrphanedGame(gameAddress);
    } finally {
      gameDbAny.getGame = originalGetGame;
      gameDbAny.completeGame = originalCompleteGame;
    }

    expect(historyCalls).toEqual([gameAddress]);
    expect(completionCalls).toEqual([[gameAddress, "RecoveredWinner", 42_000, "sig123"]]);

    expect(stubGameRecord.status).toBe("completed");
    expect(stubGameRecord.winner_address).toBe("RecoveredWinner");
  });

  test("cleanup skips when completion is already running", async () => {
    const gameAddress = await createTestGameAddress();
    const gameDb = botModule.__test_getGameDatabase();
    const gameDbAny = gameDb as unknown as {
      getGame: typeof gameDb.getGame;
      completeGame: typeof gameDb.completeGame;
    };

    const originalGetGame = gameDb.getGame.bind(gameDb);
    const originalCompleteGame = gameDb.completeGame.bind(gameDb);

    const stubGameRecord: GameData = {
      game_address: gameAddress,
      creator_telegram_id: "creator",
      amount: 12_000,
      created_at: Date.now(),
      status: "active",
      winner_address: undefined,
      completed_at: undefined,
      message_id: undefined,
      chat_id: undefined,
      game_type: "coinflip",
      token_mint: "Mint",
      token_ticker: "TIMBA",
      max_players: 2,
      min_players: 2,
    };

    gameDbAny.getGame = (address: string) => {
      if (address === gameAddress) {
        return stubGameRecord as any;
      }
      return originalGetGame(address);
    };

    gameDbAny.completeGame = (address: string, winner: string, completedAt?: number) => {
      if (address === gameAddress) {
        stubGameRecord.status = "completed";
        stubGameRecord.winner_address = winner;
        stubGameRecord.completed_at = completedAt ?? Date.now();
        return;
      }
      originalCompleteGame(address, winner, completedAt);
    };

    const completionCalls: Array<
      [string, string | undefined, number | undefined, string | undefined]
    > = [];
    let releaseCompletion: (() => void) | undefined;

    botModule.__test_setProcessGameCompletionHandler(
      async (address, winner, totalPot, signature) => {
        completionCalls.push([address, winner, totalPot, signature]);
        await new Promise<void>((resolve) => {
          releaseCompletion = () => resolve();
        });
        gameDbAny.completeGame(address, winner ?? "cancelled", Date.now());
      },
    );

    botModule.__test_setCompletionHistoryFetcher(async () => ({
      winnerAddress: "RecoveredWinner",
      totalPot: 42_000,
      signature: "sig123",
    }));

    try {
      const inFlight = botModule.__test_runProcessGameCompletion(
        gameAddress,
        "RecoveredWinner",
        42_000,
        "sig123",
      );

      expect(botModule.__test_isCompletionJobActive(gameAddress)).toBe(true);

      await botModule.__test_cleanupOrphanedGame(gameAddress);

      expect(completionCalls).toEqual([[gameAddress, "RecoveredWinner", 42_000, "sig123"]]);

      if (releaseCompletion) {
        releaseCompletion();
      }
      await inFlight;
      releaseCompletion = undefined;

      expect(botModule.__test_isCompletionJobActive(gameAddress)).toBe(false);
      expect(stubGameRecord.status).toBe("completed");
      expect(stubGameRecord.winner_address).toBe("RecoveredWinner");
    } finally {
      gameDbAny.getGame = originalGetGame;
      gameDbAny.completeGame = originalCompleteGame;
      if (releaseCompletion) {
        releaseCompletion();
      }
    }
  });
});
