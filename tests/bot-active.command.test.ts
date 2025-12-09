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
      text: "1. Coinflip (1/4) • TIMBA",
      callback_data: headerCallback,
    });
    expect(inlineKeyboard?.[2]?.[0]).toMatchObject({
      text: "2. Coinflip (2/4) • TIMBA",
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

describe("/active command pagination", () => {
  let botModule: typeof import("../src/bot");
  let originalGameManager: any;

  beforeAll(async () => {
    botModule = await import("../src/bot");
    originalGameManager = botModule.gameManager;
  });

  afterEach(() => {
    botModule.__test_setGameManager(originalGameManager as any);
  });

  const createMockGame = (index: number): any => ({
    messageText: `<b>Coinflip • ${index}k TIMBA ($${index})</b>\nDetails`,
    keyboard: [[{ text: "🎮 Join", callback_data: `join_${index}` }]],
    gameAddress: `addr${index}`,
    currentTickets: 1,
    maxTickets: 4,
    minTickets: 2,
  });

  test("paginates active games with max 5 per page", async () => {
    const mockGames = Array.from({ length: 8 }, (_, i) => createMockGame(i + 1));

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

    expect(reply).toHaveBeenCalledTimes(1);

    const [text, options] = reply.mock.calls[0]!;
    expect(text).toContain("Active games (8)");
    expect(text).toContain("Page 1/2");

    const inlineKeyboard = options?.reply_markup?.inline_keyboard as InlineKeyboardButton[][] | undefined;
    expect(inlineKeyboard).toBeDefined();

    // Check for pagination nav row (last row)
    const lastRow = inlineKeyboard?.[inlineKeyboard.length - 1];
    expect(lastRow).toBeDefined();

    // Should have page indicator and Next button (no Prev on first page)
    const hasNextButton = lastRow?.some(btn => btn.text === "Next →");
    const hasPrevButton = lastRow?.some(btn => btn.text === "← Prev");
    const hasPageIndicator = lastRow?.some(btn => btn.text === "1/2");

    expect(hasNextButton).toBe(true);
    expect(hasPrevButton).toBe(false);
    expect(hasPageIndicator).toBe(true);
  });

  test("shows all games without pagination when under limit", async () => {
    const mockGames = Array.from({ length: 3 }, (_, i) => createMockGame(i + 1));

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

    const [text, options] = reply.mock.calls[0]!;
    expect(text).toContain("Active games (3)");
    expect(text).not.toContain("Page");

    const inlineKeyboard = options?.reply_markup?.inline_keyboard as InlineKeyboardButton[][] | undefined;

    // No pagination buttons - check that last row is a game button, not navigation
    const lastRow = inlineKeyboard?.[inlineKeyboard.length - 1];
    const hasNavButtons = lastRow?.some(btn => btn.text === "Next →" || btn.text === "← Prev");
    expect(hasNavButtons).toBeFalsy();
  });

  test("buildActiveGamesKeyboard adds navigation buttons correctly", () => {
    const games = Array.from({ length: 3 }, (_, i) => createMockGame(i + 1));

    // Test first page of multi-page list
    const keyboard = botModule.__test_buildActiveGamesKeyboard(games, {
      page: 0,
      totalGames: 12,
      callbackPrefix: "active_page:",
    });

    const lastRow = keyboard[keyboard.length - 1]!;
    expect(lastRow.some(btn => btn.text === "1/3")).toBe(true);
    expect(lastRow.some(btn => btn.text === "Next →")).toBe(true);
    expect(lastRow.some(btn => btn.text === "← Prev")).toBe(false);
  });

  test("buildActiveGamesKeyboard shows both nav buttons on middle page", () => {
    const games = Array.from({ length: 3 }, (_, i) => createMockGame(i + 1));

    const keyboard = botModule.__test_buildActiveGamesKeyboard(games, {
      page: 1,
      totalGames: 12,
      callbackPrefix: "active_page:",
    });

    const lastRow = keyboard[keyboard.length - 1]!;
    expect(lastRow.some(btn => btn.text === "2/3")).toBe(true);
    expect(lastRow.some(btn => btn.text === "Next →")).toBe(true);
    expect(lastRow.some(btn => btn.text === "← Prev")).toBe(true);
  });

  test("buildActiveGamesKeyboard hides next button on last page", () => {
    const games = Array.from({ length: 2 }, (_, i) => createMockGame(i + 1));

    const keyboard = botModule.__test_buildActiveGamesKeyboard(games, {
      page: 2,
      totalGames: 12,
      callbackPrefix: "active_page:",
    });

    const lastRow = keyboard[keyboard.length - 1]!;
    expect(lastRow.some(btn => btn.text === "3/3")).toBe(true);
    expect(lastRow.some(btn => btn.text === "Next →")).toBe(false);
    expect(lastRow.some(btn => btn.text === "← Prev")).toBe(true);
  });

  test("pagination callbacks use correct prefix format", () => {
    const activePrefix = botModule.__test_ACTIVE_PAGE_CALLBACK_PREFIX;
    const publicPrefix = botModule.__test_PUBLIC_PAGE_CALLBACK_PREFIX;

    expect(activePrefix).toBe("active_page:");
    expect(publicPrefix).toBe("public_page:");
    expect(botModule.__test_ACTIVE_GAMES_PER_PAGE).toBe(5);
  });
});

describe("/public command pagination", () => {
  let botModule: typeof import("../src/bot");
  let originalGameManager: any;

  beforeAll(async () => {
    botModule = await import("../src/bot");
    originalGameManager = botModule.gameManager;
  });

  afterEach(() => {
    botModule.__test_setGameManager(originalGameManager as any);
  });

  const createMockGame = (index: number): any => ({
    messageText: `<b>Coinflip • ${index}k TIMBA ($${index})</b>\nDetails`,
    keyboard: [[{ text: "🎮 Join", callback_data: `join_${index}` }]],
    gameAddress: `addr${index}`,
    currentTickets: 1,
    maxTickets: 4,
    minTickets: 2,
  });

  test("paginates public games with max 5 per page", async () => {
    const mockGames = Array.from({ length: 7 }, (_, i) => createMockGame(i + 1));

    const stubGameManager = {
      getAllActivePublicGames: vi.fn(async () => mockGames),
    } as any;

    botModule.__test_setGameManager(stubGameManager);

    const reply = vi.fn(async (text: string, options: any) => ({ text, ...options }));

    await botModule.__test_handlePublicCommand({
      chat: { id: 123, type: "private" },
      from: { id: 1234, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        text: "/public",
      },
      reply,
    } as any);

    expect(reply).toHaveBeenCalledTimes(1);

    const [text, options] = reply.mock.calls[0]!;
    expect(text).toContain("Active Public Games (7)");
    expect(text).toContain("Page 1/2");

    const inlineKeyboard = options?.reply_markup?.inline_keyboard as InlineKeyboardButton[][] | undefined;
    const lastRow = inlineKeyboard?.[inlineKeyboard.length - 1];

    expect(lastRow?.some(btn => btn.text === "Next →")).toBe(true);
    expect(lastRow?.some(btn =>
      "callback_data" in btn && btn.callback_data === "public_page:1"
    )).toBe(true);
  });

  test("shows no pagination for single page of public games", async () => {
    const mockGames = Array.from({ length: 4 }, (_, i) => createMockGame(i + 1));

    const stubGameManager = {
      getAllActivePublicGames: vi.fn(async () => mockGames),
    } as any;

    botModule.__test_setGameManager(stubGameManager);

    const reply = vi.fn(async (text: string, options: any) => ({ text, ...options }));

    await botModule.__test_handlePublicCommand({
      chat: { id: 123, type: "private" },
      from: { id: 1234, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 123, type: "private" },
        text: "/public",
      },
      reply,
    } as any);

    const [text, options] = reply.mock.calls[0]!;
    expect(text).toContain("Active Public Games (4)");
    expect(text).not.toContain("Page");

    const inlineKeyboard = options?.reply_markup?.inline_keyboard as InlineKeyboardButton[][] | undefined;
    const lastRow = inlineKeyboard?.[inlineKeyboard.length - 1];

    const hasNavButtons = lastRow?.some(btn => btn.text === "Next →" || btn.text === "← Prev");
    expect(hasNavButtons).toBeFalsy();
  });
});
