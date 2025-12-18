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
  process.env.MNEMONIC =
    "test test test test test test test test test test test junk";
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
      getAllActivePublicGames: vi.fn(async () => mockGames),
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

    expect(stubGameManager.getAllActivePublicGames).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledTimes(1);

    const [text, options] = reply.mock.calls[0]!;
    expect(text).toContain("Active Public Games (2)");

    const inlineKeyboard = options?.reply_markup?.inline_keyboard as
      | InlineKeyboardButton[][]
      | undefined;
    expect(inlineKeyboard).toBeDefined();
    expect(inlineKeyboard?.length).toBe(4); // 2 headers + 2 action rows

    // Game title buttons now link to Solscan account pages
    expect(inlineKeyboard?.[0]?.[0]).toMatchObject({
      text: "1. Coinflip (1/4) • TIMBA",
      url: expect.stringContaining("solscan.io/account/addr1"),
    });
  });

  test("handles no active public games", async () => {
    const stubGameManager = {
      getAllActivePublicGames: vi.fn(async () => []),
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

    expect(stubGameManager.getAllActivePublicGames).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("No active public games found.", expect.anything());
  });
});
