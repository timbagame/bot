import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import type { Context } from "grammy";
import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "bn.js";
import type { GameManager } from "../../src/utils/game";
import {
  bot,
  __test_processPlayerEventWithTarget,
  __test_resetGameDatabase,
  __test_setGameDatabase,
  __test_setGameManager,
} from "../../src/bot";
import { createGameCallbacksModule } from "../../src/handlers/game-callbacks";
import { GAME_SETUP_COPY } from "../../src/handlers/game-setup";
import type { GameCallbacksModuleDeps } from "../../src/handlers/game-callbacks";

const makeDeps = () => {
  const wrapCallbackHandler: GameCallbacksModuleDeps["wrapCallbackHandler"] =
    (handler) => async (ctx, next) => handler(ctx, next);
  const withCreatorContext =
    ((_: any, handler: any) => async (ctx: any) =>
      handler(ctx, {} as any)) as GameCallbacksModuleDeps["withCreatorContext"];

  const gameDb = {
    getGame: () => ({ token_ticker: "TOK" }),
    getCreatorInfo: () => ({ telegramId: "creator" }),
    savePlayerMapping: vi.fn(),
    getGameLastSlotWithTimestamp: vi.fn(() => ({ lastSlot: "", timestamp: null })),
    getPlayerTelegramId: vi.fn(() => "player-telegram"),
  } as unknown as GameCallbacksModuleDeps["gameDb"];

  const gameManager = {
    primeUsernameCache: vi.fn(),
    joinGame: vi.fn(async () => ({ success: true })),
    updateGameMessageFromData: vi.fn(),
    getPlayerUsername: vi.fn(async () => "@player"),
  } as unknown as GameManager;

  const wallet = {
    getKeyPair: (telegramId: bigint) => ({
      publicKey: {
        toBase58: () => `player-${telegramId.toString()}`,
      },
    }),
  } as unknown as GameCallbacksModuleDeps["wallet"];
  const fakeProgram = {
    account: {
      game: {
        fetch: async () => ({
          ticketsCount: 1,
          maxTickets: 2,
        }),
      },
    },
  } as any;

  const deps: GameCallbacksModuleDeps = {
    bot,
    wallet,
    getGameManager: () => gameManager,
    gameDb,
    wrapCallbackHandler,
    withCreatorContext,
    pendingGameCreations: new Set(),
    getOracleMaxPlayers: () => 100,
    getDefaultTokenMetadata: async () => ({ decimals: 6 }),
    getContractMinimumAmount: async () => ({ formatted: 1, raw: 1, decimals: 6 }),
    fetchTokenPriceUSD: async () => null,
    getProgram: () => fakeProgram,
    validateGameTokenData: () => ({ isValid: true }),
    gameSetupCopy: GAME_SETUP_COPY,
  };

  const module = createGameCallbacksModule(deps);
  return { module, gameDb, gameManager };
};

const makeCtx = (username?: string) => ({
  chat: { id: 1, type: "private" },
  callbackQuery: { id: "q", message: { message_id: 42 } },
  from: username
    ? { username, first_name: "", last_name: "" }
    : { first_name: "", last_name: "" },
  api: {
    answerCallbackQuery: vi.fn(),
  },
});

const makeEvent = (): any => {
  const gameKey = new PublicKey(Keypair.generate().publicKey);
  const player = new PublicKey(Keypair.generate().publicKey);
  return {
    gameKey,
    player,
    totalAmount: new BN(0),
    ticketsCount: 1,
    ticketIndex: 0,
    lastSlot: new BN(0),
    timestamp: new BN(Date.now()),
  };
};

describe("Game callback helpers", () => {
  let sendMessageSpy: any;

  beforeEach(() => {
    sendMessageSpy = vi
      .spyOn(bot.api, "sendMessage")
      .mockResolvedValue({ message_id: 1 } as any);
    __test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "@player",
      getActiveGameMessage: () => ({ chatId: 2, messageId: 6 }),
    } as any);
    __test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
    } as any);
  });

  afterEach(() => {
    sendMessageSpy.mockRestore();
    __test_setGameManager(undefined as any);
    __test_resetGameDatabase();
  });

  test("persist mapping even when display name absent", async () => {
    const { module, gameDb } = makeDeps();
    const ctx = makeCtx();
    await module.__test_handleJoinGame(
      ctx as unknown as Context,
      new PublicKey(Keypair.generate().publicKey),
      123n,
      { game_address: "game1", status: "active" }
    );

    expect(gameDb.savePlayerMapping).toHaveBeenCalledWith(
      "player-123",
      "123",
      null
    );
  });

  test("trims first/last names before persisting display name", async () => {
    const { module, gameDb } = makeDeps();
    const ctx = makeCtx();
    ctx.from = {
      first_name: "  Alpha ",
      last_name: "  Bravo  ",
    } as any;

    await module.__test_handleJoinGame(
      ctx as unknown as Context,
      new PublicKey(Keypair.generate().publicKey),
      124n,
      { game_address: "game2", status: "active" }
    );

    expect(gameDb.savePlayerMapping).toHaveBeenCalledWith(
      "player-124",
      "124",
      "Alpha Bravo"
    );
  });

  test("stale player events do not send announcements", async () => {
    const { gameDb } = makeDeps();
    (gameDb.getGameLastSlotWithTimestamp as any).mockReturnValue({
      lastSlot: "old",
      timestamp: Number(Date.now()) + 1_000,
    });
    __test_setGameDatabase(gameDb as any);
    const event = makeEvent();
    event.timestamp = new BN(0);
    const target = { chatId: 1, messageId: 5 };

    await __test_processPlayerEventWithTarget(
      event,
      "PlayerJoined",
      target
    );

    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  test("announcements escape HTML-sensitive usernames", async () => {
    __test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "<script>alert(1)</script>",
      getActiveGameMessage: () => ({ chatId: 2, messageId: 6 }),
    } as any);
    const event = makeEvent();
    const target = { chatId: 2, messageId: 6 };

    await __test_processPlayerEventWithTarget(
      event,
      "PlayerJoined",
      target
    );

    expect(sendMessageSpy).toHaveBeenCalledWith(
      2,
      expect.stringContaining("&lt;script&gt;"),
      expect.any(Object)
    );
    expect(sendMessageSpy.mock.calls[0][1]).not.toContain("<script>");
  });

  test("parallel join handling survives concurrent calls", async () => {
    const { module, gameDb, gameManager } = makeDeps();
    const ctxA = makeCtx("@alice");
    const ctxB = makeCtx("@bob");
    const gamePda = new PublicKey(Keypair.generate().publicKey);

    await Promise.all([
      module.__test_handleJoinGame(
        ctxA as unknown as Context,
        gamePda,
        10n,
        {
        game_address: "gameX",
        status: "active",
      }),
      module.__test_handleJoinGame(
        ctxB as unknown as Context,
        gamePda,
        11n,
        {
        game_address: "gameX",
        status: "active",
      }),
    ]);

    expect(gameDb.savePlayerMapping).toHaveBeenCalledTimes(2);
    expect(gameManager.joinGame).toHaveBeenCalledTimes(2);
    expect(gameManager.primeUsernameCache).toHaveBeenCalledTimes(2);
  });
});
