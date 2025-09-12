import { expect, test, beforeAll } from "bun:test";

// Set required env vars before importing the bot
process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC ||
  "test walk nut penalty hip pave soap entry language right filter choice";
process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";

let bot: any;
let __testSessions: any;
let wallet: any;

// Stub Telegram API calls to avoid network
beforeAll(async () => {
  ({ bot, __testSessions, wallet } = await import("../src/bot"));

  // Replace global fetch used by grammy API with a dummy success
  // for methods invoked in these handlers
  const okJson = async () => ({ ok: true, result: true } as any);
  // @ts-ignore
  globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return {
      ok: true,
      status: 200,
      json: okJson,
    } as any;
  };

  // So back_to_amounts handler doesn't hit real RPC
  (wallet as any).getTokenBalance = async () => 0;
  (wallet as any).getTokenMetadata = async () => ({ decimals: 6 });

  // Provide fake botInfo to avoid calling getMe()
  (bot as any).botInfo = {
    id: 0,
    is_bot: true,
    first_name: "test-bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  // Stub API methods used in these handlers to avoid Telegram errors/timeouts
  try {
    (bot as any).api.answerCallbackQuery = async () => ({ ok: true, result: true });
    (bot as any).api.editMessageText = async () => ({ ok: true, result: true });
  } catch {}
});

test("cancel_game_setup clears session so next text is not intercepted", async () => {
  const uid = 4242;
  // Seed a pending typed-input session
  __testSessions.set(uid, {
    waitingFor: "amount_input",
    gameType: "coinflip",
    userBalance: 100,
    messageId: 1,
    chatId: uid,
    creatorId: String(uid),
  });

  // Fire cancel callback as the creator
  try {
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: uid } as any,
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: uid, type: "private" } } as any,
        data: `cancel_game_setup_${uid}`,
      } as any,
    } as any);
  } catch {}

  expect(__testSessions.has(uid)).toBe(false);
}, 15000);

test("back_to_amounts clears session so next text is not intercepted", async () => {
  const uid = 5252;
  __testSessions.set(uid, {
    waitingFor: "players_input",
    gameType: "coinflip",
    userBalance: 100,
    messageId: 2,
    chatId: uid,
    creatorId: String(uid),
  });

  // Fire back_to_amounts as the creator
  try {
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb-2",
        from: { id: uid } as any,
        message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: uid, type: "private" } } as any,
        data: `back_to_amounts_coinflip_${uid}`,
      } as any,
    } as any);
  } catch {}

  expect(__testSessions.has(uid)).toBe(false);
}, 15000);

test("cancel by non-creator does not clear another user's session", async () => {
  const creator = 6000;
  const other = 6001;
  __testSessions.set(creator, {
    waitingFor: "amount_input",
    gameType: "coinflip",
    userBalance: 50,
    messageId: 3,
    chatId: creator,
    creatorId: String(creator),
  });

  try {
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb-3",
        from: { id: other } as any,
        message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: creator, type: "private" } } as any,
        data: `cancel_game_setup_${creator}`,
      } as any,
    } as any);
  } catch {}

  // Session stays for the creator; non-creator action ignored
  expect(__testSessions.has(creator)).toBe(true);
}, 15000);

test("back_to_amounts by non-creator does not clear session", async () => {
  const creator = 6100;
  const other = 6101;
  __testSessions.set(creator, {
    waitingFor: "players_input",
    gameType: "coinflip",
    userBalance: 50,
    messageId: 4,
    chatId: creator,
    creatorId: String(creator),
  });

  try {
    await bot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "cb-4",
        from: { id: other } as any,
        message: { message_id: 4, date: Math.floor(Date.now() / 1000), chat: { id: creator, type: "private" } } as any,
        data: `back_to_amounts_coinflip_${creator}`,
      } as any,
    } as any);
  } catch {}

  expect(__testSessions.has(creator)).toBe(true);
}, 15000);

test("back_to_amounts with no existing session does not create one", async () => {
  const uid = 6200;
  __testSessions.delete(uid);

  try {
    await bot.handleUpdate({
      update_id: 5,
      callback_query: {
        id: "cb-5",
        from: { id: uid } as any,
        message: { message_id: 5, date: Math.floor(Date.now() / 1000), chat: { id: uid, type: "private" } } as any,
        data: `back_to_amounts_coinflip_${uid}`,
      } as any,
    } as any);
  } catch {}

  expect(__testSessions.has(uid)).toBe(false);
}, 15000);

test("cancel clears players_input sessions as well", async () => {
  const uid = 6300;
  __testSessions.set(uid, {
    waitingFor: "players_input",
    gameType: "coinflip",
    userBalance: 0,
    messageId: 6,
    chatId: uid,
    creatorId: String(uid),
  });

  try {
    await bot.handleUpdate({
      update_id: 6,
      callback_query: {
        id: "cb-6",
        from: { id: uid } as any,
        message: { message_id: 6, date: Math.floor(Date.now() / 1000), chat: { id: uid, type: "private" } } as any,
        data: `cancel_game_setup_${uid}`,
      } as any,
    } as any);
  } catch {}

  expect(__testSessions.has(uid)).toBe(false);
}, 15000);
