import { describe, test, expect, vi } from "bun:test";
import type { Context } from "grammy";
import { PublicKey, Keypair } from "@solana/web3.js";
import type { GameManager } from "../../src/utils/game";
import { bot } from "../../src/bot";
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
    getGame: () => ({ token_ticker: "TOK", amount: 100 }),
    getCreatorInfo: () => ({ telegramId: "creator" }),
    savePlayerMapping: vi.fn(),
    getGameLastSlotWithTimestamp: vi.fn(() => ({ lastSlot: "", timestamp: null })),
    getPlayerTelegramId: vi.fn(() => "player-telegram"),
  } as unknown as GameCallbacksModuleDeps["gameDb"];

  const gameManager = {
    primeUsernameCache: vi.fn(),
    joinGame: vi.fn(async () => ({ success: true })),
    updateGameMessageFromData: vi.fn(),
    createGameMessage: vi.fn(),
    getActiveGameMessages: vi.fn(() => new Map()),
    getGameCreatorUsername: vi.fn(async () => "@creator"),
    getUsernameFromTelegramId: vi.fn(async () => "@player"),
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
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  },
});

describe("Game Join Message Recreation", () => {
  test("recreates game message if missing in current chat", async () => {
    const { module, gameManager } = makeDeps();
    const ctx = makeCtx("@joiner");
    ctx.chat = { id: 999, type: "supergroup" } as any;

    const gameAddress = "game-addr-1";
    const gamePda = new PublicKey(Keypair.generate().publicKey);

    // Mock getActiveGameMessages to return empty map (no message in chat 999)
    (gameManager.getActiveGameMessages as any).mockReturnValue(new Map());

    await module.__test_handleJoinGame(
      ctx as unknown as Context,
      gamePda,
      123n,
      {
        game_address: gameAddress,
        status: "active",
        chat_id: 111, // Created in chat 111
        amount: 100,
        game_type: "coinflip",
        token_ticker: "TOK",
      }
    );

    // Should have called createGameMessage with the callback message ID for reply
    expect(gameManager.createGameMessage).toHaveBeenCalledWith(
        ctx,
        gameAddress,
        "Coinflip",
        100,
        "@creator",
        "TOK",
        "Active",
        42 // The callback message ID from ctx.callbackQuery.message.message_id
    );
  });

  test("does NOT recreate game message if already exists in current chat", async () => {
    const { module, gameManager } = makeDeps();
    const ctx = makeCtx("@joiner");
    ctx.chat = { id: 999, type: "supergroup" } as any;

    const gameAddress = "game-addr-2";
    const gamePda = new PublicKey(Keypair.generate().publicKey);

    // Mock getActiveGameMessages to return map containing chat 999
    const activeMap = new Map();
    activeMap.set(999, { messageId: 50, chatId: 999 });
    (gameManager.getActiveGameMessages as any).mockReturnValue(activeMap);

    await module.__test_handleJoinGame(
      ctx as unknown as Context,
      gamePda,
      123n,
      {
        game_address: gameAddress,
        status: "active",
        chat_id: 111,
        amount: 100,
        game_type: "coinflip",
        token_ticker: "TOK",
      }
    );

    // Should NOT have called createGameMessage
    expect(gameManager.createGameMessage).not.toHaveBeenCalled();
  });
});
