import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import type { InlineKeyboardButton } from "grammy/types";

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
  process.env.MNEMONIC = "test test test test test test test test test test test junk";
}
if (originalSolanaNetwork === undefined) {
  process.env.SOLANA_NETWORK = "http://localhost:8899";
}

describe("/public command", () => {
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

  test("renders condensed public game rows", async () => {
    // Use devnet so Solscan URLs are generated (localhost doesn't support Solscan)
    const savedNetwork = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";

    const firstKeyboard: InlineKeyboardButton[][] = [
      [{ text: "🎮 Join", callback_data: "join_first" }],
    ];
    const secondKeyboard: InlineKeyboardButton[][] = [
      [{ text: "🎮 Join", callback_data: "join_second" }],
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
      getActivePublicGamesPage: vi.fn(async (_ctx: any, options: any) => ({
        games: mockGames.slice(
          options.page * options.pageSize,
          (options.page + 1) * options.pageSize,
        ),
        totalGames: mockGames.length,
        page: options.page,
      })),
    } as any;

    botModule.__test_setGameManager(stubGameManager);

    const reply = vi.fn(async (text: string, options: any) => ({ text, ...options }));

    // We need to access the handlePublicCommand function.
    // Since it's not exported, we can trigger it via the bot instance if we could mock the context properly and pass it to the command handler.
    // However, bot.command registers it. We can try to find the handler in the bot middleware stack or just export it for testing if we modify bot.ts.
    // Alternatively, we can assume if we registered it, we can test the logic by extracting the handler or just trusting the integration test if we could run the bot.

    // BUT, for unit testing the logic inside the handler, it is best if we can access it.
    // Since I cannot easily export it without modifying bot.ts more (which I did, but didn't export),
    // I will use a trick: I will look for the command handler in the bot instance or just rely on the fact that I can't easily unit test the handler function itself without exporting it.

    // Wait, I can export `handlePublicCommand` for testing in `bot.ts` similar to `__test_handleActiveCommand` if it existed.
    // Let's check if `handleActiveCommand` was exported. The previous test used `botModule.__test_handleActiveCommand`.
    // I should probably export `handlePublicCommand` as `__test_handlePublicCommand` in `bot.ts`.

    // Let's assume I will add the export in the next step if I haven't.
    // For now, I will write the test assuming `__test_handlePublicCommand` exists.

    await botModule.__test_handlePublicCommand({
      chat: { id: 12345, type: "private" }, // Can be called from private chat
      from: { id: 1234, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345, type: "private" },
        text: "/public",
      },
      reply,
    } as any);

    expect(stubGameManager.getActivePublicGamesPage).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);

    const [text, options] = reply.mock.calls[0]!;
    expect(text).toContain("Active Public Games (2)");

    const inlineKeyboard = options?.reply_markup?.inline_keyboard as
      InlineKeyboardButton[][] | undefined;
    expect(inlineKeyboard).toBeDefined();
    expect(inlineKeyboard?.length).toBe(4); // 2 headers + 2 action rows

    // Game title buttons now link to Solscan account pages
    expect(inlineKeyboard?.[0]?.[0]).toMatchObject({
      text: "1. Coinflip (1/4) • TIMBA",
      url: expect.stringContaining("solscan.io/account/addr1"),
    });

    // Restore original network
    process.env.SOLANA_NETWORK = savedNetwork;
  });

  test("handles no active public games", async () => {
    const stubGameManager = {
      getActivePublicGamesPage: vi.fn(async () => ({ games: [], totalGames: 0, page: 0 })),
    } as any;

    botModule.__test_setGameManager(stubGameManager);

    const reply = vi.fn(async (text: string, options: any) => ({ text, ...options }));

    await botModule.__test_handlePublicCommand({
      chat: { id: 12345, type: "private" },
      from: { id: 1234, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345, type: "private" },
        text: "/public",
      },
      reply,
    } as any);

    expect(stubGameManager.getActivePublicGamesPage).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("No active public games found.", expect.anything());
  });

  const publicCtx = (text: string, reply: any) =>
    ({
      chat: { id: 12345, type: "private" },
      from: { id: 1234, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 12345, type: "private" },
        text,
      },
      reply,
    }) as any;

  const listing = (index: number) => ({
    messageText: `<b>Coinflip • ${index}k TIMBA</b>`,
    keyboard: [[{ text: "🎮 Join", callback_data: `join_${index}` }]],
    gameAddress: `addr${index}`,
    currentTickets: 1,
    maxTickets: 2,
  });

  test("parses /public filters and rejects invalid ones", () => {
    const parse = botModule.__test_parsePublicGamesFilter;
    expect(parse([])).toBeUndefined();
    expect(parse(["coinflip"])).toEqual({ gameType: "coinflip" });
    expect(parse(["GA", "$bonk"])).toEqual({ gameType: "giveaway", ticker: "BONK" });
    expect(parse(["timba", "flip"])).toEqual({ gameType: "coinflip", ticker: "TIMBA" });
    expect(parse(["coinflip", "giveaway"])).toBeNull();
    expect(parse(["AAA", "BBB"])).toBeNull();
    expect(parse(["a", "b", "c"])).toBeNull();
    expect(parse(["<b>"])).toBeNull();
    expect(parse(["X".repeat(17)])).toBeNull();
  });

  test("encodes the filter into page callbacks within the 64-byte limit", () => {
    const suffix = botModule.__test_encodePublicFilterSuffix({
      gameType: "giveaway",
      ticker: "X".repeat(16),
    });
    const data = `public_page:9999${suffix}`;
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(botModule.__test_parsePublicPageCallbackData(data)).toEqual({
      page: 9999,
      filter: { gameType: "giveaway", ticker: "X".repeat(16) },
    });
    expect(botModule.__test_encodePublicFilterSuffix(undefined)).toBe("");
    expect(botModule.__test_encodePublicFilterSuffix({})).toBe("");
    expect(botModule.__test_parsePublicPageCallbackData("public_page:2")).toEqual({
      page: 2,
      filter: undefined,
    });
    expect(botModule.__test_parsePublicPageCallbackData("public_page:1:*:TIMBA")).toEqual({
      page: 1,
      filter: { gameType: undefined, ticker: "TIMBA" },
    });
    expect(botModule.__test_parsePublicPageCallbackData("public_page:1:*:*")).toEqual({
      page: 1,
      filter: undefined,
    });
    expect(botModule.__test_parsePublicPageCallbackData("public_page:x")).toBeNull();
    expect(botModule.__test_parsePublicPageCallbackData(undefined)).toBeNull();
  });

  test("passes the filter through and keeps it in pagination buttons", async () => {
    const games = Array.from({ length: 7 }, (_, index) => listing(index + 1));
    const getActivePublicGamesPage = vi.fn(async (_ctx: any, options: any) => ({
      games: games.slice(0, options.pageSize),
      totalGames: games.length,
      page: 0,
    }));
    botModule.__test_setGameManager({ getActivePublicGamesPage } as any);
    const reply = vi.fn(async (..._args: any[]) => ({}));

    await botModule.__test_handlePublicCommand(publicCtx("/public coinflip TIMBA", reply));

    expect(getActivePublicGamesPage.mock.calls[0]![1]).toMatchObject({
      page: 0,
      filter: { gameType: "coinflip", ticker: "TIMBA" },
    });
    const [text, options] = reply.mock.calls[0]! as any[];
    expect(text).toContain("Coinflip • TIMBA");
    const buttons = options.reply_markup.inline_keyboard.flat();
    expect(
      buttons.some((button: any) => button.callback_data === "public_page:1:coinflip:TIMBA"),
    ).toBe(true);
  });

  test("explains when a filter matches nothing and when the filter is invalid", async () => {
    const getActivePublicGamesPage = vi.fn(
      async (..._args: any[]): Promise<{ games: any[]; totalGames: number; page: number }> => ({
        games: [],
        totalGames: 0,
        page: 0,
      }),
    );
    botModule.__test_setGameManager({ getActivePublicGamesPage } as any);
    const reply = vi.fn(async (..._args: any[]) => ({}));

    await botModule.__test_handlePublicCommand(publicCtx("/public giveaway", reply));
    expect(reply.mock.calls[0]![0]).toBe("No active public games match Giveaway.");

    await botModule.__test_handlePublicCommand(publicCtx("/public one two three", reply));
    expect(reply.mock.calls[1]![0]).toContain("Usage:");
    expect(getActivePublicGamesPage).toHaveBeenCalledTimes(1);
  });

  test("page callback answers before loading and edits with the requested page", async () => {
    const order: string[] = [];
    const games = Array.from({ length: 7 }, (_, index) => listing(index + 1));
    const getActivePublicGamesPage = vi.fn(async (_ctx: any, options: any) => {
      order.push("load");
      return { games: games.slice(5), totalGames: games.length, page: options.page };
    });
    botModule.__test_setGameManager({ getActivePublicGamesPage } as any);
    const answerCallbackQuery = vi.fn(async () => {
      order.push("answer");
      return true;
    });
    const editMessageText = vi.fn(async () => true);

    await botModule.__test_handlePublicPageCallback({
      chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false, first_name: "T" },
      callbackQuery: { id: "cb", data: "public_page:1:*:TIMBA" },
      answerCallbackQuery,
      editMessageText,
    } as any);

    expect(order).toEqual(["answer", "load"]);
    expect(getActivePublicGamesPage.mock.calls[0]![1]).toMatchObject({
      page: 1,
      filter: { ticker: "TIMBA" },
    });
    const [text, options] = editMessageText.mock.calls[0]! as any[];
    expect(text).toContain("<b>Active Public Games (7)</b> • TIMBA • Page 2/2");
    const buttons = options.reply_markup.inline_keyboard.flat();
    expect(buttons.some((button: any) => button.callback_data === "public_page:0:*:TIMBA")).toBe(
      true,
    );
  });

  test("page callback handles empty results, bad data and unchanged messages", async () => {
    const getActivePublicGamesPage = vi.fn(
      async (..._args: any[]): Promise<{ games: any[]; totalGames: number; page: number }> => ({
        games: [],
        totalGames: 0,
        page: 0,
      }),
    );
    botModule.__test_setGameManager({ getActivePublicGamesPage } as any);
    const answerCallbackQuery = vi.fn(async () => true);
    const editMessageText = vi.fn(async () => true);
    const baseCtx = {
      chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false, first_name: "T" },
      answerCallbackQuery,
      editMessageText,
    };

    await botModule.__test_handlePublicPageCallback({
      ...baseCtx,
      callbackQuery: { id: "cb", data: "public_page:0" },
    } as any);
    expect(editMessageText).toHaveBeenCalledWith("No active public games found.");

    await botModule.__test_handlePublicPageCallback({
      ...baseCtx,
      callbackQuery: { id: "cb", data: "public_page:0:giveaway:*" },
    } as any);
    expect(editMessageText).toHaveBeenLastCalledWith("No active public games match Giveaway.");

    await botModule.__test_handlePublicPageCallback({
      ...baseCtx,
      callbackQuery: { id: "cb", data: "public_page:bogus" },
    } as any);
    expect(answerCallbackQuery).toHaveBeenLastCalledWith("Invalid page request.");

    getActivePublicGamesPage.mockImplementation(async () => ({
      games: [listing(1)],
      totalGames: 1,
      page: 0,
    }));
    editMessageText.mockImplementation(async () => {
      throw new Error("Bad Request: message is not modified");
    });
    const callsBefore = answerCallbackQuery.mock.calls.length;
    await botModule.__test_handlePublicPageCallback({
      ...baseCtx,
      callbackQuery: { id: "cb", data: "public_page:0" },
    } as any);
    // Only the upfront page answer; the unchanged edit is not reported as an error.
    expect(answerCallbackQuery.mock.calls.length).toBe(callsBefore + 1);
  });
});
