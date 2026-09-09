import { afterEach, expect, test } from "bun:test";
import { Bot, type Context } from "grammy";
import { formatTokenAmount } from "@timbagame/protocol/amounts";
import { EvmBotStore } from "./store";
import { registerEvmSetup, type Setup } from "./setup";

const stores: EvmBotStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});

function fixture() {
  const store = new EvmBotStore(":memory:", "setup-test");
  stores.push(store);
  const submitted: Setup[] = [];
  let mode: "ok" | "fail" | "lost-response" = "ok";
  let visible: any;
  const answers: string[] = [];
  let sends = 0;
  let updateId = 1;
  const chat = { id: 1, type: "private" as const, first_name: "Test" };
  const from = { id: 1, is_bot: false, first_name: "Test" };
  function createBot() {
    const bot = new Bot<Context>("123:test", {
      botInfo: {
        id: 123,
        is_bot: true,
        first_name: "Test",
        username: "TestBot",
        can_join_groups: true,
        can_read_all_group_messages: true,
        supports_inline_queries: false,
      } as any,
    });
    bot.api.config.use(async (_previous, method, payload) => {
      if (method === "editMessageText") {
        if (mode === "fail") throw new Error("Telegram unavailable");
        if (JSON.stringify(visible) === JSON.stringify(payload))
          return {
            ok: false,
            error_code: 400,
            description: "Bad Request: message is not modified",
          };
        visible = payload;
        if (mode === "lost-response") throw new Error("Response lost");
      }
      if (method === "answerCallbackQuery") answers.push((payload as any).text ?? "");
      if (method === "sendMessage") sends++;
      return {
        ok: true,
        result: method === "sendMessage" ? { message_id: 100, date: 1, chat } : true,
      } as any;
    });
    const open = registerEvmSetup(bot, store, "Anvil", async (_ctx, setup) => {
      submitted.push(structuredClone(setup));
    });
    bot.command("cf", (ctx) =>
      open(
        ctx,
        {
          address: `0x${"11".repeat(20)}`,
          symbol: "TEST",
          decimals: 18,
          minimumAmount: "1",
        },
        "coinflip",
        { maxPlayers: 2, minPlayers: 2, timeout: 3600, isPrivate: false },
      ),
    );
    return bot;
  }
  let bot = createBot();
  return {
    store,
    submitted,
    answers,
    fail: (value: typeof mode) => {
      mode = value;
    },
    restart: () => {
      bot = createBot();
    },
    visible: () => visible,
    sends: () => sends,
    button: (predicate: (text: string) => boolean) => {
      const button = visible.reply_markup.inline_keyboard
        .flat()
        .find((b: any) => predicate(b.text));
      expect(button).toBeDefined();
      return button.callback_data as string;
    },
    open: () =>
      bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat,
          from,
          text: "/cf",
          entities: [{ type: "bot_command", offset: 0, length: 3 }],
        },
      }),
    click: (data: string) =>
      bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: String(updateId),
          chat_instance: "test",
          from,
          data,
          message: { message_id: 100, date: 1, chat, text: "menu" },
        },
      }),
    reply: (text: string) =>
      bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: 1,
          chat,
          from,
          text,
          reply_to_message: {
            message_id: 100,
            date: 1,
            chat,
            text: "prompt",
            reply_to_message: undefined,
          },
        },
      }),
  };
}

test("failed edits preserve visible buttons across restart and retire them after delivery", async () => {
  const f = fixture();
  await f.open();
  const amount = f.button(() => true);
  f.fail("fail");
  await f.click(amount);
  await f.click(amount);
  expect(f.answers).not.toContain("This setup is unavailable.");
  f.restart();
  f.fail("ok");
  await f.click(amount);
  const players = f.button((text) => text.includes("2"));
  expect(players).not.toBe(amount);
  await f.click(amount);
  expect(f.answers.at(-1)).toBe("This setup is unavailable.");
  await f.click(players);
  expect(f.visible().text).toContain("0.000000000000000001");
  expect(f.submitted).toHaveLength(0);
});

test("lost edit responses recover through either visible generation without duplicate transitions", async () => {
  for (const useOld of [true, false]) {
    const f = fixture();
    await f.open();
    const amount = f.button(() => true);
    f.fail("lost-response");
    await f.click(amount);
    const players = f.button((text) => text.includes("2"));
    f.restart();
    f.fail("ok");
    if (useOld) {
      // Telegram reports not modified when the exact saved edit is retried.
      await f.click(amount);
      expect(f.answers.at(-1)).toBe("");
      expect(f.button((text) => text.includes("2"))).toBe(players);
    }
    await f.click(players);
    await f.click(f.button((text) => text.includes("Create")));
    expect(f.submitted).toHaveLength(1);
    expect(f.submitted[0]?.amount).toBe("0.000000000000000001");
  }
});

test("initial failed menu delivery retries the saved message on update replay", async () => {
  const f = fixture();
  f.fail("fail");
  await expect(f.open()).rejects.toThrow();
  f.restart();
  f.fail("ok");
  await f.open();
  expect(f.sends()).toBe(1);
  expect(f.button(() => true)).toMatch(/^evs:1:1:/);
});

test("large valid uint256 stakes retain exact amounts and usable short confirmation callbacks", async () => {
  const f = fixture();
  await f.open();
  await f.click(f.button((text) => text.includes("Custom")));
  const amount = formatTokenAmount(((1n << 256n) - 1n) / 2n, 18);
  await f.reply(amount);
  await f.click(f.button((text) => text.includes("2")));
  expect(f.visible().text).toContain(amount);
  for (const button of f.visible().reply_markup.inline_keyboard.flat()) {
    expect(button.text).not.toContain("Unable to render");
    if (button.callback_data)
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  }
  await f.click(f.button((text) => text.includes("Create")));
  expect(f.submitted).toHaveLength(1);
  expect(f.submitted[0]?.amount).toBe(amount);
});

test("retrying a failed timeout edit applies its delta only once", async () => {
  const f = fixture();
  await f.open();
  await f.click(f.button(() => true));
  await f.click(f.button((text) => text.includes("2")));
  const increase = f.button((text) => text === "+100%");
  f.fail("fail");
  await f.click(increase);
  f.fail("ok");
  await f.click(increase);
  await f.click(f.button((text) => text.includes("Create")));
  expect(f.submitted[0]?.timeoutSeconds).toBe(7200);
});
