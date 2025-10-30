import { describe, test, expect, beforeEach } from "bun:test";
import {
  __test_handleCustomAmountInput,
  __test_getUserState,
  __test_clearUserState,
  __test_setWalletCache,
  wallet,
} from "../src/bot";

type MockCtxOptions = {
  editError?: Error;
};

const TELEGRAM_NUMERIC_ID = 9_876_543;
const TELEGRAM_ID = BigInt(TELEGRAM_NUMERIC_ID);
const DEFAULT_CHAT_ID = 777_001;
const USER_WALLET_ADDRESS = wallet
  .getKeyPair(TELEGRAM_ID)
  .publicKey.toBase58();

const baseWalletCache = {
  solBalance: 5_000_000_000, // 5 SOL
  tokenBalances: [] as Array<{
    mint: string;
    ticker: string;
    balance: number;
    decimals: number;
    rawBalance: string;
  }>,
  approvedTokens: [] as any[],
};

const userKey = String(TELEGRAM_NUMERIC_ID);

const createMockCtx = (options: MockCtxOptions = {}) => {
  const { editError } = options;
  const calls: Array<Record<string, unknown>> = [];
  let nextMessageId = 10_000;

  const ctx: any = {
    chat: { id: DEFAULT_CHAT_ID },
    from: { id: TELEGRAM_NUMERIC_ID },
    message: { message_id: 6000 },
    api: {
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
        opts: Record<string, unknown>
      ) => {
        calls.push({ type: "edit", chatId, messageId, text, opts });
        if (editError) {
          throw editError;
        }
        return { ok: true };
      },
    },
    reply: async (text: string, opts: Record<string, unknown>) => {
      const message_id = nextMessageId++;
      calls.push({ type: "reply", text, opts, message_id });
      return { message_id };
    },
    __calls: calls,
  };

  return ctx;
};

beforeEach(() => {
  __test_clearUserState(userKey);
  __test_setWalletCache(TELEGRAM_ID, {
    ...baseWalletCache,
  });
});

describe("handleCustomAmountInput", () => {
  test("edits existing send prompt when message id is present", async () => {
    const ctx = createMockCtx();
    const userState = {
      type: "send_custom_amount",
      token: "SOL",
      messageId: 4321,
      chatId: DEFAULT_CHAT_ID,
    };

    await __test_handleCustomAmountInput(ctx, userState, "0.0001");

    const edits = ctx.__calls.filter((call: any) => call.type === "edit");
    const replies = ctx.__calls.filter((call: any) => call.type === "reply");

    expect(edits).toHaveLength(1);
    expect(edits[0].chatId).toBe(DEFAULT_CHAT_ID);
    expect(edits[0].messageId).toBe(4321);
    expect(String(edits[0].text)).toContain("Send");
    expect(String(edits[0].text)).toContain(USER_WALLET_ADDRESS);
    expect(replies).toHaveLength(0);

    const state = __test_getUserState(userKey);
    expect(state).toBeUndefined(); // Now using inputSessions instead of user-state
  });

  test("falls back to reply when editing existing message fails", async () => {
    const ctx = createMockCtx({
      editError: new Error("Bad Request: there is no text in the message to edit"),
    });
    const userState = {
      type: "send_custom_amount",
      token: "SOL",
      messageId: 4500,
      chatId: DEFAULT_CHAT_ID,
    };

    await __test_handleCustomAmountInput(ctx, userState, "0.0002");

    const edits = ctx.__calls.filter((call: any) => call.type === "edit");
    const replies = ctx.__calls.filter((call: any) => call.type === "reply");

    expect(edits).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(String(replies[0].text)).toContain("Send");
    expect(String(replies[0].text)).toContain(USER_WALLET_ADDRESS);

    const state = __test_getUserState(userKey);
    expect(state).toBeUndefined(); // Now using inputSessions instead of user-state
  });

  test("sends new prompt when prior message id is missing", async () => {
    const ctx = createMockCtx();
    const userState = {
      type: "send_custom_amount",
      token: "SOL",
      chatId: DEFAULT_CHAT_ID,
    };

    await __test_handleCustomAmountInput(ctx, userState, "0.0003");

    const edits = ctx.__calls.filter((call: any) => call.type === "edit");
    const replies = ctx.__calls.filter((call: any) => call.type === "reply");

    expect(edits).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(String(replies[0].text)).toContain(USER_WALLET_ADDRESS);

    const state = __test_getUserState(userKey);
    expect(state).toBeUndefined(); // Now using inputSessions instead of user-state
  });
});
