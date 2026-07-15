import { beforeAll, beforeEach, afterAll, expect, test } from "bun:test";
import {
  setInputSession,
  markInputSessionProcessing,
  clearInputSessionProcessing,
  __test_listInputSessions,
  __test_clearUserState as __test_clearRawState,
} from "../src/utils/user-state";

process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice";
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

const INPUT_NAMESPACE_PREFIX = "input_session:";
let sendMessagePayloads: any[] = [];

beforeAll(async () => {
  ({ bot, wallet } = await import("../src/bot"));

  (bot as any).botInfo = {
    id: 0,
    is_bot: true,
    first_name: "test-bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  (wallet as any).getBalance = async () => 0;
  (wallet as any).getAllWalletTokenBalances = async () => [];

  const api = (bot as any).api;
  api.editMessageText = async () => ({ ok: true, result: true });
  api.deleteMessage = async () => ({ ok: true, result: true });
  api.answerCallbackQuery = async () => ({ ok: true, result: true });
  api.config.use(
    async (prev: any, method: string, payload: any, signal: AbortSignal | undefined) => {
      if (method === "sendMessage") {
        sendMessagePayloads.push(payload);
        return {
          ok: true,
          result: {
            message_id: Math.trunc(Math.random() * 10_000) + 1,
            chat: { id: payload.chat_id },
            date: Math.floor(Date.now() / 1000),
          },
        };
      }

      return prev(method, payload, signal);
    },
  );
});

const clearInputSessions = () => {
  for (const [key] of __test_listInputSessions()) {
    __test_clearRawState(`${INPUT_NAMESPACE_PREFIX}${key}`);
  }
};

beforeEach(() => {
  sendMessagePayloads = [];
  clearInputSessions();
});

test("rejects replies from non-initiators", async () => {
  const chatId = 12345;
  const promptMessageId = 54321;
  const initiatorId = "1111";

  setInputSession(`${chatId}_${promptMessageId}`, {
    type: "send_custom_amount",
    chatId,
    messageId: promptMessageId,
    initiatorId,
  });

  const now = Math.floor(Date.now() / 1000);
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 200,
      date: now,
      chat: { id: chatId, type: "private" },
      from: { id: Number(initiatorId) + 1 },
      text: "Not allowed",
      reply_to_message: {
        message_id: promptMessageId,
        chat: { id: chatId, type: "private" },
      },
    },
  } as any);

  expect(sendMessagePayloads).toHaveLength(1);
  expect(sendMessagePayloads[0]?.text ?? "").toContain("prompt is no longer active");

  const sessions = __test_listInputSessions();
  const storedSession = sessions.find(([key]) => key === `${chatId}_${promptMessageId}`)?.[1];
  expect(storedSession).toBeTruthy();
  expect(storedSession?.initiatorId).toBe(initiatorId);
});

test("ignores duplicate replies while another handler is processing", async () => {
  const chatId = 22345;
  const promptMessageId = 65432;
  const initiatorId = "2222";
  const sessionKey = `${chatId}_${promptMessageId}`;

  setInputSession(sessionKey, {
    type: "send_custom_amount",
    chatId,
    messageId: promptMessageId,
    initiatorId,
  });

  const lockerId = "other-user:123";
  const locked = markInputSessionProcessing(sessionKey, lockerId);
  expect(locked).toBe(true);

  const now = Math.floor(Date.now() / 1000);
  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 201,
      date: now,
      chat: { id: chatId, type: "private" },
      from: { id: Number(initiatorId) },
      text: "Processing",
      reply_to_message: {
        message_id: promptMessageId,
        chat: { id: chatId, type: "private" },
      },
    },
  } as any);

  expect(sendMessagePayloads).toHaveLength(0);

  const sessionEntry = __test_listInputSessions().find(([key]) => key === sessionKey)?.[1] as any;
  expect(sessionEntry).toBeTruthy();
  expect(sessionEntry.processing).toBe(true);
  expect(sessionEntry.processingBy).toBe(lockerId);

  clearInputSessionProcessing(sessionKey);
  __test_clearRawState(`${INPUT_NAMESPACE_PREFIX}${sessionKey}`);
});
