import { describe, test, expect } from "bun:test";
import { __test_handleAddressInput } from "../src/bot";

type MockCtxOptions = {
  editError?: Error;
};

type RecordedCall = {
  type: "edit" | "reply";
  chatId?: number;
  messageId?: number;
  text: string;
  opts: any;
  message_id?: number;
};

const TELEGRAM_ID = 7_654_321;
const CHAT_ID = 9_001_100;
const ADDRESS = "HhEWJstpJE6vvrYGS3BaK5ZJbdVAXqGmQ2MBM8FyiPvy";

const makeCtx = (options: MockCtxOptions = {}) => {
  const { editError } = options;
  const calls: RecordedCall[] = [];
  let nextMessageId = 50_000;

  const ctx: any = {
    from: { id: TELEGRAM_ID },
    chat: { id: CHAT_ID },
    api: {
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
        opts: any
      ) => {
        calls.push({ type: "edit", chatId, messageId, text, opts });
        if (editError) {
          throw editError;
        }
        return { ok: true };
      },
    },
    reply: async (text: string, opts: any) => {
      const message_id = nextMessageId++;
      calls.push({ type: "reply", text, opts, message_id });
      return { message_id };
    },
    __calls: calls,
  };

  return ctx;
};

const baseState = {
  type: "send_address",
  token: "SOL",
  amount: "0.5",
  amountDisplay: "0.5 SOL",
  messageId: 44_210,
  chatId: CHAT_ID,
};

describe("handleAddressInput", () => {
  test("edits existing confirmation message when possible", async () => {
    const ctx = makeCtx();

    await __test_handleAddressInput(ctx, baseState, ADDRESS);

    const calls = ctx.__calls as RecordedCall[];
    const edits = calls.filter((call: RecordedCall) => call.type === "edit");
    const replies = calls.filter((call: RecordedCall) => call.type === "reply");

    expect(edits).toHaveLength(1);
    const firstEdit = edits[0]!;
    expect(firstEdit.chatId).toBe(CHAT_ID);
    expect(firstEdit.messageId).toBe(baseState.messageId);
    expect(firstEdit.text).toContain("SEND CONFIRMATION");
    expect(firstEdit.text).toContain(ADDRESS);
    expect(replies).toHaveLength(0);
  });

  test("falls back to replying when editMessageText fails", async () => {
    const ctx = makeCtx({
      editError: new Error("Bad Request: there is no text in the message to edit"),
    });

    await __test_handleAddressInput(ctx, baseState, ADDRESS);

    const calls = ctx.__calls as RecordedCall[];
    const edits = calls.filter((call: RecordedCall) => call.type === "edit");
    const replies = calls.filter((call: RecordedCall) => call.type === "reply");

    expect(edits).toHaveLength(1);
    expect(replies).toHaveLength(1);
    const firstReply = replies[0]!;
    expect(firstReply.text).toContain("SEND CONFIRMATION");
    expect(firstReply.text).toContain(ADDRESS);
    expect(
      firstReply.opts?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data
    ).toMatch(/^confirm_send_/);
  });

  test("replies directly when original message id is missing", async () => {
    const ctx = makeCtx();
    const stateWithoutMessage = { ...baseState, messageId: undefined };

    await __test_handleAddressInput(ctx, stateWithoutMessage, ADDRESS);

    const calls = ctx.__calls as RecordedCall[];
    const edits = calls.filter((call: RecordedCall) => call.type === "edit");
    const replies = calls.filter((call: RecordedCall) => call.type === "reply");

    expect(edits).toHaveLength(0);
    expect(replies).toHaveLength(1);
    const firstReply = replies[0]!;
    expect(firstReply.text).toContain("SEND CONFIRMATION");
    expect(firstReply.text).toContain(ADDRESS);
  });
});
