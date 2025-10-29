import { expect, test, beforeAll, afterAll } from "bun:test";

// Ensure required env vars are set before importing the bot module
process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC ||
  "test walk nut penalty hip pave soap entry language right filter choice";
process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";
const previousPricesEnabled = process.env["PRICES_ENABLED"];
process.env["PRICES_ENABLED"] = "false";

afterAll(() => {
  if (previousPricesEnabled === undefined) {
    process.env["PRICES_ENABLED"] = "true";
    return;
  }

  process.env["PRICES_ENABLED"] = previousPricesEnabled;
});

let bot: any;
let wallet: any;
let __test_setUserState: any;
let __test_getUserState: any;
let __test_clearUserState: any;

beforeAll(async () => {
  ({
    bot,
    wallet,
    __test_setUserState,
    __test_getUserState,
    __test_clearUserState,
  } = await import("../src/bot"));

  // Provide botInfo to avoid getMe()
  (bot as any).botInfo = {
    id: 0,
    is_bot: true,
    first_name: "test-bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  // Stub wallet RPCs used indirectly
  (wallet as any).getBalance = async () => 0;
  (wallet as any).getAllApprovedTokenBalances = async () => [];

  // Stub Telegram API methods that may be called
  (bot as any).api.editMessageText = async () => ({ ok: true, result: true });
  (bot as any).api.deleteMessage = async () => ({ ok: true, result: true });
  (bot as any).api.sendMessage = async () => ({ message_id: 999, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) } as any);
  (bot as any).api.sendVideo = async () => ({ message_id: 998, chat: { id: 1 }, date: Math.floor(Date.now() / 1000) } as any);
  (bot as any).api.answerCallbackQuery = async () => ({ ok: true, result: true });
});

test("typed-input ignores messages from a different chat (swap_to_token)", async () => {
  const userId = 1111;
  __test_setUserState(String(userId), {
    type: "swap_to_token",
    fromToken: "SOL",
    messageId: 10,
    chatId: 1,
  });

  let editCalls = 0;
  let deleteCalls = 0;
  (bot as any).api.editMessageText = async () => { editCalls++; return { ok: true } as any; };
  (bot as any).api.deleteMessage = async () => { deleteCalls++; return { ok: true } as any; };

  await bot.handleUpdate({
    update_id: 100,
    message: {
      message_id: 50,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 2, type: "supergroup" },
      from: { id: userId },
      text: "casdasasdasg",
    },
  } as any);

  // State remains, nothing processed
  expect(__test_getUserState(String(userId))).toBeTruthy();
  expect(editCalls).toBe(0);
  expect(deleteCalls).toBe(0);

  __test_clearUserState(String(userId));
});

// Note: a full same-chat flow test is brittle due to global bot middlewares.
// The guard test above provides sufficient coverage for swap state guards.
