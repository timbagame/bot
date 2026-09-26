import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice";
process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost";
process.env.NODE_ENV = "test";

const botModule = await import("../src/bot");
const bot: any = botModule.bot;

const TELEGRAM_ID = 424242n;
const apiCalls: Array<[string, any]> = [];

beforeAll(() => {
  bot.botInfo = {
    id: 0,
    is_bot: true,
    first_name: "test-bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
  bot.api.config.use(async (prev: any, method: string, payload: any, signal: unknown) => {
    if (method === "answerCallbackQuery" || method.startsWith("editMessage")) {
      apiCalls.push([method, payload]);
      return { ok: true, result: true } as any;
    }
    return prev(method, payload, signal);
  });
});

beforeEach(() => {
  apiCalls.length = 0;
  botModule.__test_resetPrepareTokenTradeQuote();
  botModule.__test_swapQuoteRetryStore.clear();
});

afterEach(() => {
  botModule.__test_resetPrepareTokenTradeQuote();
});

const timeout = () =>
  new Error("Failed to request Jupiter order: The operation timed out.", {
    cause: Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
  });

const runCustomAmountQuote = async (amount: string) => {
  const edits: any[] = [];
  const ctx: any = {
    from: { id: Number(TELEGRAM_ID) },
    chat: { id: 12345 },
    api: {
      editMessageText: async (...args: any[]) => {
        edits.push(args);
      },
    },
  };
  await botModule.__test_handleSwapCustomAmountInput(
    ctx,
    {
      type: "swap_custom_amount",
      fromToken: "SOL",
      toToken: "USDC",
      messageId: 111,
      chatId: 12345,
    },
    amount,
  );
  return edits;
};

const pressRetry = async (data: string, fromId: number, updateId: number) => {
  await bot.handleUpdate({
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: { id: fromId, is_bot: false, first_name: "T" },
      chat_instance: "ci",
      message: {
        message_id: 111,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: "private" },
        text: "old",
      },
      data,
    },
  });
};

describe("swap quote provider retry", () => {
  test("a provider timeout shows the slow-provider card with a one-tap Retry", async () => {
    const seen: Array<{ amountInput: string; telegramId: bigint }> = [];
    botModule.__test_setPrepareTokenTradeQuote(async (params) => {
      seen.push({ amountInput: params.amountInput, telegramId: params.telegramId });
      await params.onError(timeout());
      return null as any;
    });

    const edits = await runCustomAmountQuote("0.5");
    const [, , text, options] = edits.at(-1);
    expect(text).toContain("Provider is slow right now");
    expect(text).toContain("0.5 SOL → USDC");
    const [[retry], [back]] = options.reply_markup.inline_keyboard;
    expect(retry.text).toBe("🔄 Retry");
    expect(retry.callback_data.startsWith("swap_retry_")).toBe(true);
    expect(back.callback_data).toBe("swap_to_SOL_USDC");

    // Retry re-runs the same quote for the same user.
    botModule.__test_setPrepareTokenTradeQuote(async (params) => {
      seen.push({ amountInput: params.amountInput, telegramId: params.telegramId });
      return null as any;
    });
    await pressRetry(retry.callback_data, Number(TELEGRAM_ID), 9001);
    expect(seen).toEqual([
      { amountInput: "0.5", telegramId: TELEGRAM_ID },
      { amountInput: "0.5", telegramId: TELEGRAM_ID },
    ]);
    expect(apiCalls.filter(([method]) => method === "answerCallbackQuery")).toHaveLength(1);
  });

  test("other quote errors keep the existing error card", async () => {
    botModule.__test_setPrepareTokenTradeQuote(async (params) => {
      await params.onError(new Error("Jupiter order error (code 1): No routes found"));
      return null as any;
    });
    const edits = await runCustomAmountQuote("1");
    const [, , text, options] = edits.at(-1);
    expect(text).not.toContain("Provider is slow");
    expect(options.reply_markup.inline_keyboard[0][0].text).toBe("← Try Again");
  });

  test("thrown provider errors also offer Retry", async () => {
    botModule.__test_setPrepareTokenTradeQuote(async () => {
      throw timeout();
    });
    const edits = await runCustomAmountQuote("2");
    expect(edits.at(-1)[2]).toContain("Provider is slow right now");
  });

  test("retry buttons are private to their user and expire", async () => {
    let calls = 0;
    botModule.__test_setPrepareTokenTradeQuote(async () => {
      calls += 1;
      return null as any;
    });
    const data = botModule.__test_swapQuoteRetryStore.save({
      userId: TELEGRAM_ID.toString(),
      fromTokenIdentifier: "SOL",
      toToken: "USDC",
      amount: "1",
    });

    await pressRetry(data, 1, 9002);
    await pressRetry("swap_retry_unknown", Number(TELEGRAM_ID), 9003);

    expect(calls).toBe(0);
    const answers = apiCalls
      .filter(([method]) => method === "answerCallbackQuery")
      .map(([, payload]) => payload.text);
    expect(answers).toEqual([
      "❌ This quote belongs to someone else",
      "⌛ This quote expired. Pick the amount again.",
    ]);
  });
});
