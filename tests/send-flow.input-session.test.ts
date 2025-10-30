import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC ||
  "test walk nut penalty hip pave soap entry language right filter choice";
process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";

let bot: any;
let wallet: any;
let __test_setWalletCache: any;
let setInputSession: any;
let getInputSession: any;
let clearAllInputSessions: any;

const USER_ID = 987_654_321;
const CHAT_ID = 7_700_100;
const PROMPT_MESSAGE_ID = 44_210;

const now = () => Math.floor(Date.now() / 1000);

const sessionKey = `${CHAT_ID}_${PROMPT_MESSAGE_ID}`;

let editCalls: Array<any>;
let replyCalls: Array<any>;
let nextMessageId = 90_000;

const seedWalletCache = () => {
  __test_setWalletCache(BigInt(USER_ID), {
    solBalance: 5_000_000_000,
    tokenBalances: [],
  });
};

const simulateUserReply = async (
  text: string,
  replyToId: number,
  overrides: Partial<{ messageId: number }> = {}
) => {
  const userMessageId = overrides.messageId ?? nextMessageId++;

  await bot.handleUpdate({
    update_id: nextMessageId + 1,
    message: {
      message_id: userMessageId,
      date: now(),
      chat: { id: CHAT_ID, type: "private" },
      from: { id: USER_ID, is_bot: false },
      text,
      reply_to_message: {
        message_id: replyToId,
        date: now(),
        chat: { id: CHAT_ID, type: "private" },
      },
    },
  } as any);
};

describe("message input sessions", () => {
  beforeAll(async () => {
    ({
      bot,
      wallet,
      __test_setWalletCache,
    } = await import("../src/bot"));

    ({
      setInputSession,
      getInputSession,
      clearAllInputSessions,
    } = await import("../src/utils/user-state"));

    (bot as any).botInfo = {
      id: 0,
      is_bot: true,
      first_name: "test-bot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    };

    (wallet as any).getTokenMetadata = async () => ({ decimals: 9 });
    (wallet as any).getBalance = async () => 5_000_000_000;
    (wallet as any).getAllApprovedTokenBalances = async () => [];

    (bot as any).api.config.use(async (_prev: any, method: string, payload: any) => {
      if (method === "editMessageText") {
        editCalls.push({
          chatId: payload.chat_id,
          messageId: payload.message_id,
          text: payload.text,
          opts: payload,
        });
        return {
          ok: true,
          result: {
            message_id: payload.message_id,
            chat: { id: payload.chat_id },
          },
        };
      }

      if (method === "sendMessage") {
        replyCalls.push({
          chatId: payload.chat_id,
          text: payload.text,
          opts: payload,
        });
        return {
          ok: true,
          result: {
            message_id: nextMessageId++,
            chat: { id: payload.chat_id ?? CHAT_ID },
            date: now(),
          },
        };
      }

      if (method === "sendVideo") {
        return {
          ok: true,
          result: {
            message_id: nextMessageId++,
            chat: { id: payload.chat_id ?? CHAT_ID },
            date: now(),
          },
        };
      }

      return { ok: true, result: true };
    });
  });

  beforeEach(() => {
    clearAllInputSessions();
    seedWalletCache();
    editCalls = [];
    replyCalls = [];
    nextMessageId = 90_000;
  });

  test("custom amount replies transition session to address input", async () => {
    setInputSession(sessionKey, {
      type: "send_custom_amount",
      token: "SOL",
      chatId: CHAT_ID,
      messageId: PROMPT_MESSAGE_ID,
    });

    await simulateUserReply("0.5", PROMPT_MESSAGE_ID);

    const session = getInputSession(sessionKey);
    expect(session).toBeTruthy();
    expect(session?.type).toBe("send_address");
    expect(session?.token).toBe("SOL");
    expect(session?.amount).toBeTruthy();
    expect(session?.amountDisplay).toBeTruthy();
    expect(editCalls.length).toBeGreaterThan(0);
    expect(replyCalls.length).toBe(0);
  });

  test("address replies clear the session after confirmation prompt", async () => {
    setInputSession(sessionKey, {
      type: "send_custom_amount",
      token: "SOL",
      chatId: CHAT_ID,
      messageId: PROMPT_MESSAGE_ID,
    });

    await simulateUserReply("1", PROMPT_MESSAGE_ID);

    const amountSession = getInputSession(sessionKey);
    expect(amountSession?.type).toBe("send_address");
    const followUpMessageId = amountSession?.messageId as number;
    const followUpChatId = amountSession?.chatId as number;
    const followUpKey = `${followUpChatId}_${followUpMessageId}`;

    await simulateUserReply(
      "HhEWJstpJE6vvrYGS3BaK5ZJbdVAXqGmQ2MBM8FyiPvy",
      followUpMessageId
    );

    const cleared = getInputSession(followUpKey);
    expect(cleared).toBeUndefined();
    expect(editCalls.length).toBeGreaterThan(0);
  });
});
