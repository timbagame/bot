import { beforeAll, beforeEach, afterEach, expect, test } from "bun:test";
import { upsertGameSetupSession, clearAllGameSetupSessions } from "../src/utils/user-state";

process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC ||
  "test walk nut penalty hip pave soap entry language right filter choice";
process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";
process.env.NODE_ENV = "test";

let botModule: typeof import("../src/bot");
let bot: any;
type ApiHandler = (payload: any) => any | Promise<any>;
const apiHandlers: Record<string, ApiHandler | undefined> = {};
let interceptorInstalled = false;

beforeAll(async () => {
  botModule = await import("../src/bot");
  bot = botModule.bot;

  (bot as any).botInfo = {
    id: 0,
    is_bot: true,
    first_name: "test-bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  const okJson = async () => ({ ok: true, result: true } as any);
  const fetchMock = Object.assign(
    async () => ({ ok: true, status: 200, json: okJson } as any),
    {
      preconnect: async (
        _url: string | URL,
        _options?: Parameters<typeof fetch.preconnect>[1]
      ) => {},
    }
  );
  globalThis.fetch = fetchMock as typeof fetch;

  if (!interceptorInstalled) {
    (bot.api.config.use as any)(
      async (
        prev: (method: string, payload: any, signal?: unknown) => any,
        method: string,
        payload: any,
        signal?: unknown
      ) => {
        const handler = apiHandlers[method];
        if (handler) {
          return handler(payload);
        }
        return prev(method, payload, signal);
      }
    );
    interceptorInstalled = true;
  }
});

beforeEach(() => {
  clearAllGameSetupSessions();

  botModule.__test_setGameManager({
    createGame: async () => ({ success: true, gameAddress: "GAME123" }),
    createGameMessage: async () => {},
    updateGameMessageFromData: async () => {},
  } as any);

  for (const key of Object.keys(apiHandlers)) {
    delete apiHandlers[key];
  }
  apiHandlers["answerCallbackQuery"] = async () => ({
    ok: true,
    result: true,
  });
  apiHandlers["editMessageReplyMarkup"] = async () => ({
    ok: true,
    result: true,
  });
  apiHandlers["editMessageCaption"] = async () => ({ ok: true, result: true });
});

afterEach(() => {
  for (const key of Object.keys(apiHandlers)) {
    delete apiHandlers[key];
  }
});

test(
  "confirm_game skips fallback edit when confirmation message is missing",
  async () => {
    const userId = 7100;
    const chatId = 8200;
    const messageId = 91;

    upsertGameSetupSession(`${chatId}_${messageId}`, {
      waitingFor: "setup",
      gameType: "coinflip",
      userBalance: 100,
      messageId,
      chatId,
      amount: "1.5",
      creatorId: String(userId),
      tokenMint: "So11111111111111111111111111111111111111112",
      tokenTicker: "SOL",
      tokenDecimals: 9,
    });

    const editCalls: any[] = [];
    const deleteCalls: any[] = [];
    const sendCalls: any[] = [];

    apiHandlers["editMessageText"] = async (payload: any) => {
      editCalls.push(payload);
      return { ok: true, result: true };
    };

    apiHandlers["deleteMessage"] = async (payload: any) => {
      deleteCalls.push(payload);
      return {
        ok: false,
        error_code: 400,
        description: "Bad Request: message to delete not found",
      };
    };

    apiHandlers["sendMessage"] = async (payload: any) => {
      sendCalls.push(payload);
      return { ok: true, result: { message_id: 999, ...payload } };
    };

    botModule.__test_setGameManager({
      createGame: async () => ({ success: true, gameAddress: "GAME123" }),
      createGameMessage: async () => {},
      updateGameMessageFromData: async () => {},
    } as any);

    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: userId } as any,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
        } as any,
        data: `confirm_game_coinflip_1.5_2_${userId}`,
      },
    } as any);

    expect(editCalls.length).toBe(1);
    expect(deleteCalls.length).toBe(1);
    expect(sendCalls.length).toBe(0);
  },
  15000
);

test(
  "confirm_game replies directly when confirmation message is missing and creation fails",
  async () => {
    const userId = 7200;
    const chatId = 8300;
    const messageId = 92;

    upsertGameSetupSession(`${chatId}_${messageId}`, {
      waitingFor: "setup",
      gameType: "coinflip",
      userBalance: 50,
      messageId,
      chatId,
      amount: "2",
      creatorId: String(userId),
      tokenMint: "So11111111111111111111111111111111111111112",
      tokenTicker: "SOL",
      tokenDecimals: 9,
    });

    const editCalls: any[] = [];
    const deleteCalls: any[] = [];
    const sendCalls: any[] = [];

    const editError = new Error("Bad Request: message to edit not found");
    (editError as any).description = "Bad Request: message to edit not found";

    apiHandlers["editMessageText"] = async (payload: any) => {
      editCalls.push(payload);
      throw editError;
    };

    apiHandlers["deleteMessage"] = async (payload: any) => {
      deleteCalls.push(payload);
      return { ok: true, result: true };
    };

    apiHandlers["sendMessage"] = async (payload: any) => {
      sendCalls.push(payload);
      return { ok: true, result: { message_id: 1000, ...payload } };
    };

    botModule.__test_setGameManager({
      createGame: async () => ({ success: false, error: "No liquidity" }),
      createGameMessage: async () => {},
      updateGameMessageFromData: async () => {},
    } as any);

    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb-2",
        from: { id: userId } as any,
        message: {
          message_id: messageId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: "private" },
        } as any,
        data: `confirm_game_coinflip_2_2_${userId}`,
      },
    } as any);

    expect(editCalls.length).toBe(1);
    expect(deleteCalls.length).toBe(0);
    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0].text).toBe("❌ No liquidity");
  },
  15000
);
