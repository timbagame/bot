import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { PublicKey, Keypair } from "@solana/web3.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GameData } from "../src/types";

process.env["NODE_ENV"] = "test";
process.env["MNEMONIC"] ??=
  "test test test test test test test test test test test junk";
process.env["TELEGRAM_TOKEN"] ??= "TEST_TELEGRAM_TOKEN";
process.env["SOLANA_NETWORK"] ??= "http://localhost:8899";
process.env["BOT_DB_DIR"] ??= mkdtempSync(join(tmpdir(), "timba-bot-tests-"));

const botModulePromise = import("../src/bot");

const createTestGameAddress = () => Keypair.generate().publicKey.toBase58();

const createCompletionEvent = (
  gameAddress: string,
  overrides: Partial<Record<string, unknown>> = {}
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

  test("parses completion data from logs", () => {
    const gameAddress = createTestGameAddress();
    const fakeParser = {
      *parseLogs(_logs: string[]) {
        yield createCompletionEvent(gameAddress);
      },
    } as any;

    const parsed = botModule.__test_parseCompletionEventFromLogs(
      ["Program log"],
      fakeParser,
      gameAddress
    );

    expect(parsed).toEqual({
      winnerAddress: "WinnerPubkey",
      totalPot: 24_000,
    });
  });

  test("fetches completion details from transaction history", async () => {
    const gameAddress = createTestGameAddress();
    const connectionStub = {
      getSignaturesForAddress: async () => [
        {
          signature: "completion-signature",
        },
      ],
      getTransaction: async () => ({
        meta: {
          logMessages: ["Program log"],
        },
      }),
    };

    const originalGetConnection = botModule.wallet.getConnection.bind(
      botModule.wallet
    );

    botModule.wallet.getConnection = () => connectionStub as any;

    botModule.__test_setCompletionEventParserFactory(() => ({
      *parseLogs(_logs: string[]) {
        yield createCompletionEvent(gameAddress);
      },
    } as any));

    try {
      const details = await botModule.__test_fetchCompletionDetailsFromHistory(
        gameAddress
      );

      expect(details).toEqual({
        winnerAddress: "WinnerPubkey",
        totalPot: 24_000,
        signature: "completion-signature",
      });
    } finally {
      botModule.wallet.getConnection = originalGetConnection;
    }
  });

  test("fetch completion history continues after empty batches", async () => {
    const gameAddress = createTestGameAddress();
    const signatures = Array.from({ length: 6 }, (_, index) => ({
      signature: `completion-${index}`,
    }));

    const transactionResponses: Array<{ meta: { logMessages: string[] } } | null> =
      [
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

    const originalGetConnection = botModule.wallet.getConnection.bind(
      botModule.wallet
    );

    botModule.wallet.getConnection = () => connectionStub as any;

    botModule.__test_setCompletionEventParserFactory(() => ({
      *parseLogs(logs: string[] = []) {
        if (logs.some((message) => message.includes("completion-4"))) {
          yield createCompletionEvent(gameAddress);
        }
      },
    } as any));

    try {
      const details = await botModule.__test_fetchCompletionDetailsFromHistory(
        gameAddress
      );

      expect(details).toEqual({
        winnerAddress: "WinnerPubkey",
        totalPot: 24_000,
        signature: "completion-4",
      });
    } finally {
      botModule.wallet.getConnection = originalGetConnection;
    }
  });

  test("cleanup uses reconstructed completion details", async () => {
    const gameAddress = createTestGameAddress();
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

    gameDbAny.completeGame = (
      address: string,
      winner: string,
      completedAt?: number
    ) => {
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
      }
    );

    try {
      await botModule.__test_cleanupOrphanedGame(gameAddress);
    } finally {
      gameDbAny.getGame = originalGetGame;
      gameDbAny.completeGame = originalCompleteGame;
    }

    expect(historyCalls).toEqual([gameAddress]);
    expect(completionCalls).toEqual([
      [gameAddress, "RecoveredWinner", 42_000, "sig123"],
    ]);

    expect(stubGameRecord.status).toBe("completed");
    expect(stubGameRecord.winner_address).toBe("RecoveredWinner");
  });

  test("cleanup skips when completion is already running", async () => {
    const gameAddress = createTestGameAddress();
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

    gameDbAny.completeGame = (
      address: string,
      winner: string,
      completedAt?: number
    ) => {
      if (address === gameAddress) {
        stubGameRecord.status = "completed";
        stubGameRecord.winner_address = winner;
        stubGameRecord.completed_at = completedAt ?? Date.now();
        return;
      }
      originalCompleteGame(address, winner, completedAt);
    };

    const completionCalls: Array<[
      string,
      string | undefined,
      number | undefined,
      string | undefined
    ]> = [];
    let releaseCompletion: (() => void) | undefined;

    botModule.__test_setProcessGameCompletionHandler(
      async (address, winner, totalPot, signature) => {
        completionCalls.push([address, winner, totalPot, signature]);
        await new Promise<void>((resolve) => {
          releaseCompletion = () => resolve();
        });
        gameDbAny.completeGame(address, winner ?? "cancelled", Date.now());
      }
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
        "sig123"
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
