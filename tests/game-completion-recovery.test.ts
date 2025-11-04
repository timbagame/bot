import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameDatabase } from "../src/utils/game-database";

process.env["NODE_ENV"] = "test";
process.env["MNEMONIC"] ??=
  "test test test test test test test test test test test junk";
process.env["TELEGRAM_TOKEN"] ??= "TEST_TELEGRAM_TOKEN";
process.env["SOLANA_NETWORK"] ??= "http://localhost:8899";
process.env["BOT_DB_DIR"] ??= mkdtempSync(join(tmpdir(), "timba-bot-tests-"));

const botModulePromise = import("../src/bot");

const GAME_ADDRESS = "7kMeeUSALZ4taJDK5o1e8FGKS2ZEZND3NBgY3qEN66Bx";

const createCompletionEvent = (overrides: Partial<Record<string, unknown>> = {}) => ({
  name: "GameCompleted",
  data: {
    gameKey: {
      toBase58: () => GAME_ADDRESS,
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
    botModule.program = {
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
      coder: {} as any,
    } as any;
  });

  afterEach(() => {
    botModule.__test_resetCompletionHistoryFetcher();
    botModule.__test_resetProcessGameCompletionHandler();
    botModule.__test_resetCompletionEventParserFactory();
  });

  test("parses completion data from logs", () => {
    const fakeParser = {
      *parseLogs(_logs: string[]) {
        yield createCompletionEvent();
      },
    } as any;

    const parsed = botModule.__test_parseCompletionEventFromLogs(
      ["Program log"],
      fakeParser,
      GAME_ADDRESS
    );

    expect(parsed).toEqual({
      winnerAddress: "WinnerPubkey",
      totalPot: 24_000,
    });
  });

  test("fetches completion details from transaction history", async () => {
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
        yield createCompletionEvent();
      },
    } as any));

    try {
      const details = await botModule.__test_fetchCompletionDetailsFromHistory(
        GAME_ADDRESS
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

  test("cleanup uses reconstructed completion details", async () => {
    const completionSpy: Array<unknown[]> = [];

    botModule.__test_setCompletionHistoryFetcher(async () => ({
      winnerAddress: "RecoveredWinner",
      totalPot: 42_000,
      signature: "sig123",
    }));

    botModule.__test_setProcessGameCompletionHandler(async (...args) => {
      completionSpy.push(args);
    });

    const gameDb = GameDatabase.getInstance();
    const originalGetGame = gameDb.getGame.bind(gameDb);

    const originalCompleteGame = gameDb.completeGame.bind(gameDb);

    gameDb.getGame = (() => ({
      game_address: GAME_ADDRESS,
      status: "active",
      amount: 12_000,
      token_ticker: "TIMBA",
      token_mint: "Mint",
      chat_id: null,
      message_id: null,
      max_players: 2,
      min_players: 2,
    })) as any;

    const cancellationCalls: Array<[string, string]> = [];
    gameDb.completeGame = ((address: string, winner: string) => {
      cancellationCalls.push([address, winner]);
    }) as any;

    try {
      await botModule.__test_cleanupOrphanedGame(GAME_ADDRESS);

      expect(completionSpy).toEqual([
        [GAME_ADDRESS, "RecoveredWinner", 42_000, "sig123"],
      ]);
      expect(cancellationCalls).toEqual([]);
    } finally {
      gameDb.getGame = originalGetGame;
      gameDb.completeGame = originalCompleteGame;
    }
  });
});
