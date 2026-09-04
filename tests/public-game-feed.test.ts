import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Keypair } from "#solana";
import {
  __test_handleGameInitializedProgramEvent,
  __test_resetChatDatabase,
  __test_resetGameDatabase,
  __test_resetSleepImplementation,
  __test_setChatDatabase,
  __test_setGameDatabase,
  __test_setGameManager,
  __test_setSleepImplementation,
} from "../src/bot";

describe("global public game feed", () => {
  const gameAddress = Keypair.generate().publicKey;
  const creator = Keypair.generate().publicKey;
  let publishedChatIds: number[];

  beforeEach(() => {
    publishedChatIds = [];
    __test_setSleepImplementation(async () => {});
    __test_setChatDatabase({
      getGlobalPublicGameFeedChatIds: () => [-1001, -1002],
    } as any);
    __test_setGameDatabase({
      getGameMessages: () => [{ chatId: -1001, messageId: 10 }],
    } as any);
    __test_setGameManager({
      ensureGameDataFromChain: async () => ({
        game_address: gameAddress.toBase58(),
        creator_telegram_id: creator.toBase58(),
        amount: 25_000,
        created_at: Date.now(),
        status: "active",
        game_type: "coinflip",
        token_ticker: "TIMBA",
      }),
      getPlayerUsername: async () => "ABCD…WXYZ",
      createGameMessage: async (ctx: any) => {
        publishedChatIds.push(ctx.chat.id);
      },
    } as any);
  });

  afterEach(() => {
    __test_setGameManager(undefined as any);
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
});
