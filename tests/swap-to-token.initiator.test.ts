import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { clearAllInputSessions, getInputSession, setInputSession } from "../src/utils/user-state";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  MNEMONIC: process.env.MNEMONIC,
  SOLANA_NETWORK: process.env.SOLANA_NETWORK,
  PRICES_ENABLED: process.env["PRICES_ENABLED"],
};

let botModule: Awaited<typeof import("../src/bot")>;

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "test-token";
  process.env.MNEMONIC =
    process.env.MNEMONIC || "test test test test test test test test test test test junk";
  process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost:8899";
  process.env["PRICES_ENABLED"] = "false";

  botModule = await import("../src/bot");
});

afterAll(() => {
  if (originalEnv.NODE_ENV === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  }

  if (originalEnv.TELEGRAM_TOKEN === undefined) {
    Reflect.deleteProperty(process.env, "TELEGRAM_TOKEN");
  } else {
    process.env.TELEGRAM_TOKEN = originalEnv.TELEGRAM_TOKEN;
  }

  if (originalEnv.MNEMONIC === undefined) {
    Reflect.deleteProperty(process.env, "MNEMONIC");
  } else {
    process.env.MNEMONIC = originalEnv.MNEMONIC;
  }

  if (originalEnv.SOLANA_NETWORK === undefined) {
    Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
  } else {
    process.env.SOLANA_NETWORK = originalEnv.SOLANA_NETWORK;
  }

  if (originalEnv.PRICES_ENABLED === undefined) {
    Reflect.deleteProperty(process.env, "PRICES_ENABLED");
  } else {
    process.env["PRICES_ENABLED"] = originalEnv.PRICES_ENABLED;
  }
});

beforeEach(() => {
  clearAllInputSessions();
});

test("swap_to_token reprompt keeps initiatorId ownership", async () => {
  const originalTokenManager = botModule.__test_getTokenManager();
  const createdTokenManagerStub = originalTokenManager
    ? undefined
    : {
        resolveSwapToken: async () => {
          throw new Error("Token not found");
        },
      };

  if (createdTokenManagerStub) {
    botModule.__test_setTokenManager(createdTokenManagerStub as any);
  }

  const tokenManager = botModule.__test_getTokenManager();
  expect(tokenManager).toBeTruthy();
  const originalResolveSwapToken = tokenManager.resolveSwapToken;

  const chatId = 123;
  const promptMessageId = 456;
  const initiatorNumericId = 7777;
  const initiatorId = String(initiatorNumericId);

  setInputSession(`${chatId}_${promptMessageId}`, {
    type: "swap_to_token",
    fromToken: "SOL",
    chatId,
    messageId: promptMessageId,
    initiatorId,
  });

  tokenManager.resolveSwapToken = async () => {
    throw new Error("Token not found");
  };

  const replies: Array<{ text: string; options: any }> = [];
  const ctx: any = {
    chat: { id: chatId, type: "private" },
    from: { id: initiatorNumericId },
    message: {
      message_id: 999,
      text: "BADTOKEN",
      reply_to_message: {
        message_id: promptMessageId,
        chat: { id: chatId, type: "private" },
      },
    },
    reply: async (text: string, options: any) => {
      replies.push({ text, options });
      return { message_id: 1000, chat: { id: chatId } } as any;
    },
    api: {
      sendMessage: async () => ({ message_id: 1001, chat: { id: chatId } }) as any,
      editMessageText: async () => ({}),
    },
  };

  try {
    await botModule.__test_handleSwapToTokenInput(
      ctx,
      {
        type: "swap_to_token",
        fromToken: "SOL",
        chatId,
        messageId: promptMessageId,
        initiatorId,
      },
      "BADTOKEN",
    );

    const stored = getInputSession(`${chatId}_${promptMessageId}`);
    expect(stored?.initiatorId).toBe(initiatorId);
  } finally {
    tokenManager.resolveSwapToken = originalResolveSwapToken;
    if (originalTokenManager) {
      botModule.__test_setTokenManager(originalTokenManager as any);
    } else if (createdTokenManagerStub) {
      botModule.__test_setTokenManager(undefined as any);
    }
  }
});
