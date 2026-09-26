import { beforeAll, beforeEach, afterEach, expect, test } from "bun:test";
import { upsertGameSetupSession, clearAllGameSetupSessions } from "../src/utils/user-state";
import { encodeGameConfirmPayload } from "../src/utils/callback-data";

process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice";
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

  const okJson = async () => ({ ok: true, result: true }) as any;
  const fetchMock = Object.assign(async () => ({ ok: true, status: 200, json: okJson }) as any, {
    preconnect: async (_url: string | URL, _options?: Parameters<typeof fetch.preconnect>[1]) => {},
  });
  globalThis.fetch = fetchMock as typeof fetch;

  if (!interceptorInstalled) {
    (bot.api.config.use as any)(
      async (
        prev: (method: string, payload: any, signal?: unknown) => any,
        method: string,
        payload: any,
        signal?: unknown,
      ) => {
        const handler = apiHandlers[method];
        if (handler) {
          return handler(payload);
        }
        return prev(method, payload, signal);
      },
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

test("confirm_game skips fallback edit when confirmation message is missing", async () => {
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

  const confirmPayload =
    encodeGameConfirmPayload({
      gameType: "coinflip",
      amount: "1.5",
      players: 2,
      timeoutSeconds: 3600,
      minPlayers: 2,
      isPrivate: true,
      creatorId: String(userId),
    }) ?? "";

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
      data: confirmPayload,
    },
  } as any);

  expect(editCalls.length).toBe(1);
  expect(editCalls[0].text).toBe("⏳ Creating game…");
  expect(deleteCalls.length).toBe(1);
  expect(sendCalls.length).toBe(0);
}, 15000);

test.each([false, true])(
  "confirm_game replies directly when confirmation message is missing and creation fails (confirmed=%s)",
  async (confirmed) => {
    const opaque = "database credential xyz exploded";
    const userId = confirmed ? 7201 : 7200;
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
      createGame: async () => ({
        success: false,
        error: opaque,
        ...(confirmed ? { gameAddress: "GAME<123>", confirmedSignature: "CONFIRMED_SIG" } : {}),
      }),
      createGameMessage: async () => {},
      updateGameMessageFromData: async () => {},
    } as any);

    const confirmPayload =
      encodeGameConfirmPayload({
        gameType: "coinflip",
        amount: "2",
        players: 2,
        timeoutSeconds: 3600,
        minPlayers: 2,
        isPrivate: true,
        creatorId: String(userId),
      }) ?? "";

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
        data: confirmPayload,
      },
    } as any);

    if (confirmed) {
      expect(editCalls.length).toBe(1);
      expect(deleteCalls.length).toBe(0);
      expect(sendCalls.length).toBe(0);
    } else {
      expect(editCalls.length).toBe(1);
      expect(deleteCalls.length).toBe(0);
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0].text).toBe("❌ Failed to create game. Please try again.");
    }
    expect(JSON.stringify(sendCalls)).not.toContain(opaque);
  },
  15000,
);

test("confirm_game clears pending state and surfaces limit errors", async () => {
  const userId = 7300;
  const chatId = 8400;
  const messageId = 93;

  upsertGameSetupSession(`${chatId}_${messageId}`, {
    waitingFor: "setup",
    gameType: "coinflip",
    userBalance: 20,
    messageId,
    chatId,
    amount: "3",
    creatorId: String(userId),
    tokenMint: "Mint111111111111111111111111111111111111111",
    tokenTicker: "SOL",
    tokenDecimals: 9,
  });

  const replyMarkupCalls: any[] = [];
  const editCalls: any[] = [];
  const sendCalls: any[] = [];

  apiHandlers["editMessageReplyMarkup"] = async (payload: any) => {
    replyMarkupCalls.push(payload);
    return { ok: true, result: true };
  };

  apiHandlers["editMessageText"] = async (payload: any) => {
    editCalls.push(payload);
    return { ok: true, result: true };
  };

  apiHandlers["sendMessage"] = async (payload: any) => {
    sendCalls.push(payload);
    return { ok: true, result: { message_id: 2000, ...payload } };
  };

  const limitMessage =
    "Game creation rate limit reached. You have created 3 games in the last 60 seconds (maximum 3). Please wait before creating a new game.";

  botModule.__test_setGameManager({
    createGame: async () => ({ success: false, error: limitMessage }),
    createGameMessage: async () => {
      throw new Error("should not send game message when creation fails");
    },
    updateGameMessageFromData: async () => {},
  } as any);

  expect(botModule.__test_getPendingGameCreations().size).toBe(0);

  const confirmPayload =
    encodeGameConfirmPayload({
      gameType: "coinflip",
      amount: "3",
      players: 2,
      timeoutSeconds: 3600,
      minPlayers: 2,
      isPrivate: true,
      creatorId: String(userId),
    }) ?? "";

  await bot.handleUpdate({
    update_id: 3,
    callback_query: {
      id: "cb-3",
      from: { id: userId } as any,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "private" },
      } as any,
      data: confirmPayload,
    },
  } as any);

  expect(replyMarkupCalls.length).toBe(1);
  expect(editCalls.length).toBe(2);
  expect(sendCalls.length).toBe(0);

  const errorEdit = editCalls[editCalls.length - 1];
  expect(errorEdit[2] || errorEdit.text || "").toBe(
    "❌ Too many games are being created. Please try again shortly.",
  );
  expect(JSON.stringify(errorEdit)).not.toContain(limitMessage);
  expect(botModule.__test_getPendingGameCreations().size).toBe(0);
}, 15000);

const confirmCardMessage = (messageId: number, chatId: number) => ({
  message_id: messageId,
  date: Math.floor(Date.now() / 1000),
  chat: { id: chatId, type: "private" },
  text: "🎮 Coinflip\nAmount: 4 SOL",
  entities: [{ type: "bold", offset: 3, length: 8 }],
  reply_markup: {
    inline_keyboard: [[{ text: "✅ Create Game", callback_data: "cg|placeholder" }]],
  },
});

test.each([
  ["fails", async () => ({ success: false, error: "simulation failed" })],
  [
    "is interrupted",
    async () => {
      throw new Error("socket hang up");
    },
  ],
])(
  "confirm_game restores the confirm card when creation %s",
  async (label, createGame) => {
    const interrupted = label === "is interrupted";
    const userId = interrupted ? 7501 : 7500;
    const chatId = 8500;
    const messageId = interrupted ? 95 : 94;

    upsertGameSetupSession(`${chatId}_${messageId}`, {
      waitingFor: "setup",
      gameType: "coinflip",
      userBalance: 20,
      messageId,
      chatId,
      amount: "4",
      creatorId: String(userId),
      tokenMint: "So11111111111111111111111111111111111111112",
      tokenTicker: "SOL",
      tokenDecimals: 9,
    });

    const editCalls: any[] = [];
    const sendCalls: any[] = [];
    apiHandlers["editMessageText"] = async (payload: any) => {
      editCalls.push(payload);
      return { ok: true, result: true };
    };
    apiHandlers["sendMessage"] = async (payload: any) => {
      sendCalls.push(payload);
      return { ok: true, result: { message_id: 3000, ...payload } };
    };

    botModule.__test_setGameManager({
      createGame,
      createGameMessage: async () => {},
      updateGameMessageFromData: async () => {},
    } as any);

    const confirmPayload =
      encodeGameConfirmPayload({
        gameType: "coinflip",
        amount: "4",
        players: 2,
        timeoutSeconds: 3600,
        minPlayers: 2,
        isPrivate: true,
        creatorId: String(userId),
      }) ?? "";

    const message = confirmCardMessage(messageId, chatId);
    await bot.handleUpdate({
      update_id: interrupted ? 5 : 4,
      callback_query: {
        id: `cb-restore-${messageId}`,
        from: { id: userId } as any,
        message: message as any,
        data: confirmPayload,
      },
    } as any);

    expect(editCalls.length).toBe(2);
    expect(editCalls[0].text).toBe("⏳ Creating game…");
    const notice = interrupted
      ? "❌ Game creation was interrupted. Please try again."
      : "❌ Failed to create game. Please try again.";
    const restored = editCalls[1];
    expect(restored.text).toBe(`${notice}\n\n${message.text}`);
    expect(restored.entities).toEqual([
      { type: "bold", offset: 0, length: notice.length },
      { type: "bold", offset: notice.length + 2 + 3, length: 8 },
    ]);
    expect(restored.reply_markup).toEqual(message.reply_markup);
    expect(sendCalls.length).toBe(0);
    expect(botModule.__test_getPendingGameCreations().size).toBe(0);
  },
  15000,
);

test("confirm_game falls back to a reply when the confirm card cannot be restored", async () => {
  const userId = 7600;
  const chatId = 8600;
  const messageId = 96;

  upsertGameSetupSession(`${chatId}_${messageId}`, {
    waitingFor: "setup",
    gameType: "coinflip",
    userBalance: 20,
    messageId,
    chatId,
    amount: "5",
    creatorId: String(userId),
    tokenMint: "So11111111111111111111111111111111111111112",
    tokenTicker: "SOL",
    tokenDecimals: 9,
  });

  const editCalls: any[] = [];
  const sendCalls: any[] = [];
  apiHandlers["editMessageText"] = async (payload: any) => {
    editCalls.push(payload);
    if (editCalls.length > 1) {
      throw Object.assign(new Error("Bad Request: chat not found"), {
        description: "Bad Request: chat not found",
      });
    }
    return { ok: true, result: true };
  };
  apiHandlers["sendMessage"] = async (payload: any) => {
    sendCalls.push(payload);
    return { ok: true, result: { message_id: 3100, ...payload } };
  };

  botModule.__test_setGameManager({
    createGame: async () => {
      throw new Error("socket hang up");
    },
    createGameMessage: async () => {},
    updateGameMessageFromData: async () => {},
  } as any);

  const confirmPayload =
    encodeGameConfirmPayload({
      gameType: "coinflip",
      amount: "5",
      players: 2,
      timeoutSeconds: 3600,
      minPlayers: 2,
      isPrivate: true,
      creatorId: String(userId),
    }) ?? "";

  await bot.handleUpdate({
    update_id: 6,
    callback_query: {
      id: "cb-restore-fallback",
      from: { id: userId } as any,
      message: confirmCardMessage(messageId, chatId) as any,
      data: confirmPayload,
    },
  } as any);

  expect(editCalls.length).toBe(2);
  expect(sendCalls.length).toBe(1);
  expect(sendCalls[0].text).toBe("❌ Failed to create game. Please try again.");
}, 15000);
