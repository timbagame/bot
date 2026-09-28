import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import {
  __test_getGameManager,
  __test_handleGameInitializedProgramEvent,
  __test_resetChatDatabase,
  __test_resetGameDatabase,
  __test_resetSleepImplementation,
  __test_setChatDatabase,
  __test_setGameDatabase,
  __test_setGameManager,
  __test_setSleepImplementation,
} from "../src/bot";

describe("global public game feed", async () => {
  const gameAddress = (await Keypair.generate()).publicKey;
  const creator = (await Keypair.generate()).publicKey;
  let publishedChatIds: number[];
  let subscribers: number[];
  let gameData: Record<string, unknown> | null;
  let failingChats: Set<number>;
  let ensureCalls: number;
  let originalManager: any;
  let lastCreateArgs: unknown[] = [];
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    publishedChatIds = [];
    subscribers = [-1001, -1002];
    failingChats = new Set();
    ensureCalls = 0;
    originalManager = __test_getGameManager();
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    gameData = {
      game_address: gameAddress.toBase58(),
      creator_telegram_id: creator.toBase58(),
      amount: 25_000,
      created_at: Date.now(),
      status: "active",
      game_type: "coinflip",
      token_ticker: "TIMBA",
    };
    __test_setSleepImplementation(async () => {});
    __test_setChatDatabase({
      getGlobalPublicGameFeedChatIds: () => subscribers,
    } as any);
    __test_setGameDatabase({
      getGameMessages: () => [{ chatId: -1001, messageId: 10 }],
    } as any);
    __test_setGameManager({
      ensureGameDataFromChain: async () => {
        ensureCalls += 1;
        if (gameData === undefined) throw new Error("rpc unavailable");
        return gameData;
      },
      getPlayerUsername: async () => "ABCD…WXYZ",
      createGameMessage: async (ctx: any, ...args: unknown[]) => {
        if (failingChats.has(ctx.chat.id)) throw new Error("bot was kicked");
        publishedChatIds.push(ctx.chat.id);
        lastCreateArgs = args;
      },
    } as any);
  });

  afterEach(() => {
    __test_setGameManager(originalManager);
    errorSpy.mockRestore();
    __test_resetChatDatabase();
    __test_resetGameDatabase();
    __test_resetSleepImplementation();
  });

  test("publishes a new public game only to subscribed chats without an existing message", async () => {
    await __test_handleGameInitializedProgramEvent({
      gameKey: gameAddress,
      creator,
      isPrivate: false,
    } as any);

    expect(publishedChatIds).toEqual([-1002]);
  });

  test("does not publish private games", async () => {
    await __test_handleGameInitializedProgramEvent({
      gameKey: gameAddress,
      creator,
      isPrivate: true,
    } as any);

    expect(publishedChatIds).toEqual([]);
  });

  const publish = () =>
    __test_handleGameInitializedProgramEvent({
      gameKey: gameAddress,
      creator,
      isPrivate: false,
    } as any);

  test("uses the game's token ticker, falling back to the default token", async () => {
    await publish();
    expect(lastCreateArgs.slice(1, 6)).toEqual([
      "coinflip",
      25_000,
      "ABCD…WXYZ",
      "TIMBA",
      "Active",
    ]);

    gameData = { ...gameData, token_ticker: null };
    await publish();
    expect(typeof lastCreateArgs[4]).toBe("string");
    expect(lastCreateArgs[4]).not.toBe("");
  });

  test("skips the chat the game was created in", async () => {
    gameData = { ...gameData, chat_id: -1002 };

    await publish();

    expect(publishedChatIds).toEqual([]);
  });

  test("does not look the game up when no chat subscribes", async () => {
    subscribers = [];

    await publish();

    expect(ensureCalls).toBe(0);
  });

  test("ignores games that are missing or no longer active", async () => {
    gameData = null;
    await publish();

    gameData = { status: "Completed" };
    await publish();

    expect(ensureCalls).toBe(2);
    expect(publishedChatIds).toEqual([]);
  });

  test("a failing chat is logged without blocking the others", async () => {
    subscribers = [-1002, -1003];
    failingChats.add(-1002);

    await publish();

    expect(publishedChatIds).toEqual([-1003]);
    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      `Failed to publish public game ${gameAddress.toBase58()} to chat -1002:`,
    );
  });

  test("lookup failures are logged", async () => {
    gameData = undefined as any;

    await publish();

    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      `Error publishing public game ${gameAddress.toBase58()}:`,
    );
  });
});
