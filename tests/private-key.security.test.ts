import "./setup-env";
import { afterAll, beforeAll, expect, test } from "bun:test";

let bot: any;
let originalEdit: any;

const answered: Array<{ id: string; payload: any }> = [];

beforeAll(async () => {
  ({ bot } = await import("../src/bot"));

  originalEdit = bot.api.editMessageText;

  (bot as any).botInfo = {
    id: 0,
    is_bot: true,
    first_name: "test-bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };

  bot.api.editMessageText = async () => {
    throw new Error("editMessageText should not be called for private key guard");
  };

  bot.api.config.use(async (_prev: any, method: string, payload: any) => {
    if (method === "answerCallbackQuery") {
      answered.push({
        id: payload?.callback_query_id ?? "",
        payload,
      });
      return { ok: true, result: true };
    }

    return { ok: true, result: true };
  });
});

afterAll(() => {
  if (bot) {
    bot.api.editMessageText = originalEdit;
  }
});

test("private key callback rejects non-private chats", async () => {
  answered.length = 0;

  await bot.handleUpdate({
    update_id: 1,
    callback_query: {
      id: "cb-privatekey",
      from: { id: 55, is_bot: false, first_name: "Test" },
      message: {
        message_id: 101,
        chat: { id: -42, type: "group", title: "Test Group" },
      },
      data: "cmd_privatekey",
    },
  } as any);

  expect(answered).toHaveLength(1);
  const first = answered[0]!;
  const { payload } = first;
  expect(payload).toMatchObject({
    text: "❌ Private key only available in private chat",
  });
});
