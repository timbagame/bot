import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import type { InlineKeyboardButton } from "grammy/types";
import { createGameCallbacksModule } from "../src/handlers/game-callbacks";

const originalNodeEnv = process.env.NODE_ENV;
const originalToken = process.env.TELEGRAM_TOKEN;
const originalMnemonic = process.env.MNEMONIC;
const originalSolanaNetwork = process.env.SOLANA_NETWORK;

if (originalNodeEnv === undefined) {
  process.env.NODE_ENV = "test";
}
if (originalToken === undefined) {
  process.env.TELEGRAM_TOKEN = "test-token";
}
if (originalMnemonic === undefined) {
  process.env.MNEMONIC =
    "test test test test test test test test test test test junk";
}
if (originalSolanaNetwork === undefined) {
  process.env.SOLANA_NETWORK = "http://localhost:8899";
}

describe("/active command in group chats", () => {
  let botModule: typeof import("../src/bot");
  let originalGameManager: any;

  beforeAll(async () => {
    botModule = await import("../src/bot");
    originalGameManager = botModule.gameManager;
  });

  afterEach(() => {
    botModule.__test_setGameManager(originalGameManager as any);
  });

  afterAll(() => {
    botModule.__test_setGameManager(originalGameManager as any);

    if (originalNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalToken === undefined) {
      Reflect.deleteProperty(process.env, "TELEGRAM_TOKEN");
    } else {
      process.env.TELEGRAM_TOKEN = originalToken;
    }

    if (originalMnemonic === undefined) {
      Reflect.deleteProperty(process.env, "MNEMONIC");
    } else {
      process.env.MNEMONIC = originalMnemonic;
    }

    if (originalSolanaNetwork === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalSolanaNetwork;
    }
  });

  test("renders condensed active game rows while keeping action buttons", async () => {
    const firstKeyboard: InlineKeyboardButton[][] = [
      [{ text: "🎮 Join", callback_data: "join_first" }],
      [{ text: "🔄 Refresh", callback_data: "refresh_first" }],
    ];
    const secondKeyboard: InlineKeyboardButton[][] = [
      [{ text: "🎮 Join", callback_data: "join_second" }],
      [{ text: "🔄 Refresh", callback_data: "refresh_second" }],
    ];

    const mockGames = [
      {
        messageText: "<b>Coinflip • 62.5k TIMBA ($0.5)</b>\nDetails",
        keyboard: firstKeyboard,
        gameAddress: "addr1",
        currentTickets: 1,
        maxTickets: 4,
        minTickets: 2,
      },
      {
        messageText: "<i>Coinflip • 62.5k TIMBA ($0.5)</i>\nMore",
        keyboard: secondKeyboard,
        gameAddress: "addr2",
        currentTickets: 2,
        maxTickets: 4,
        minTickets: 2,
      },
    ];

    const stubGameManager = {
      getChatActiveGames: vi.fn(async () => mockGames),
    } as any;

    botModule.__test_setGameManager(stubGameManager);

    const reply = vi.fn(async (text: string, options: any) => ({ text, ...options }));

    await botModule.__test_handleActiveCommand({
      chat: { id: -100, type: "supergroup" },
      from: { id: 1234, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100, type: "supergroup" },
        text: "/active",
      },
      reply,
    } as any);

    expect(stubGameManager.getChatActiveGames).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);

    const [text, options] = reply.mock.calls[0]!;
    expect(text).toContain("Active games (2)");
    expect(text).not.toContain("#1 First Game");
    expect(text).not.toContain("#2 Second Game");

    const inlineKeyboard = options?.reply_markup?.inline_keyboard as
      | InlineKeyboardButton[][]
      | undefined;
    expect(inlineKeyboard).toBeDefined();
    expect(inlineKeyboard?.length).toBe(4);

    const headerCallback =
      botModule.__test_ACTIVE_LIST_HEADER_CALLBACK_DATA;
    expect(inlineKeyboard?.[0]?.[0]).toMatchObject({
      text: "Coinflip (1/4) • TIMBA",
      callback_data: headerCallback,
    });
    expect(inlineKeyboard?.[2]?.[0]).toMatchObject({
      text: "Coinflip (2/4) • TIMBA",
      callback_data: headerCallback,
    });

    expect(inlineKeyboard?.[1]?.[0]).toMatchObject({
      text: "🎮 Join • 62.5k ($0.5)",
      callback_data: "join_first",
    });
    expect(inlineKeyboard?.[3]?.[0]).toMatchObject({
      text: "🎮 Join • 62.5k ($0.5)",
      callback_data: "join_second",
    });
    expect(inlineKeyboard?.[2]).not.toMatchObject({
      text: "🔄 Refresh",
    });

    const hasRefreshButton = inlineKeyboard
      ?.flat()
      ?.some(
        (button) =>
          "callback_data" in button &&
          button.callback_data?.toString().startsWith("refresh_")
      );
    expect(hasRefreshButton).toBe(false);

    expect(inlineKeyboard?.[1]?.[0]).not.toBe(firstKeyboard[0]?.[0]);
    expect(inlineKeyboard?.[3]?.[0]).not.toBe(secondKeyboard[0]?.[0]);
  });
});

describe("active game keyboard helpers", () => {
  let helpers: typeof import("../src/bot");

  beforeAll(async () => {
    helpers = await import("../src/bot");
  });

  test("extractCondensedGameLabel strips markup and truncates long names", () => {
    const longName = `<b>${"A".repeat(80)}</b>`;
    const label = helpers.__test_extractCondensedGameLabel(longName);

    expect(label.startsWith("A")).toBe(true);
    expect(label).not.toContain("<b>");
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(60);
  });

  test("active list header callbacks bypass generic game handler", () => {
    const callbacksModule = createGameCallbacksModule({
      bot: {} as any,
      wallet: {} as any,
      getGameManager: () => ({} as any),
      gameDb: {} as any,
      wrapCallbackHandler: (handler: any) => handler,
      withCreatorContext: (handler: any) => handler,
      pendingGameCreations: new Set<string>(),
      getOracleMaxPlayers: () => 0,
      getDefaultTokenMetadata: async () => ({ decimals: 6 }),
      getContractMinimumAmount: async () => ({
        formatted: 0,
        raw: 0,
        decimals: 6,
      }),
      fetchTokenPriceUSD: async () => null,
      getProgram: () => ({} as any),
      validateGameTokenData: () => ({ isValid: true }),
      gameSetupCopy: { coinflip: {} as any, giveaway: {} as any },
      getChatGameSettings: () => null,
    });

    const shouldSkip =
      callbacksModule.__test_shouldSkipGenericGameCallback("active_list:noop");

    expect(shouldSkip).toBe(true);
  });
});
