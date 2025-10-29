import { afterEach, expect, test } from "bun:test";
import { buildWalletCaption, showCustomAmountPrompt } from "../src/utils/wallet-ui";
import { INPUT_TIMEOUT_HINT } from "../src/utils/constants";
import { getUserState, __test_clearUserState } from "../src/utils/user-state";

type EditCall = { text: string; options: any };
type ReplyCall = { text: string; options: any; message_id: number };

type CreateMockContextOptions = {
  overrides?: Record<string, any>;
  replyCalls?: ReplyCall[];
  editError?: Error;
  replyChatId?: number;
};

const createMockContext = (
  edits: EditCall[],
  options: CreateMockContextOptions = {}
) => {
  const { overrides = {}, replyCalls, editError, replyChatId } = options;
  const { callbackQuery: overrideCallbackQuery, chat: overrideChat, ...restOverrides } =
    overrides;

  let nextMessageId = 10_000;

  const ctx: any = {
    callbackQuery: overrideCallbackQuery ?? { message: { message_id: 321 } },
    chat: overrideChat ?? { id: 654 },
    editMessageText: async (text: string, options: any) => {
      edits.push({ text, options });
      if (editError) {
        throw editError;
      }
    },
    reply: async (text: string, options: any) => {
      const message_id = nextMessageId++;
      const chatId =
        replyChatId ??
        (typeof ctx.chat?.id === "number" ? ctx.chat.id : undefined);
      const message = {
        message_id,
        chat: typeof chatId === "number" ? { id: chatId } : undefined,
        text,
        options,
      };
      replyCalls?.push({ text, options, message_id });
      return message;
    },
  };

  return Object.assign(ctx, restOverrides);
};

const expectSingleEdit = (edits: EditCall[]): EditCall => {
  expect(edits.length).toBe(1);

  const firstEdit = edits[0];
  if (!firstEdit) {
    throw new Error("Expected a single edit call");
  }

  return firstEdit;
};

afterEach(() => {
  __test_clearUserState("send-user");
  __test_clearUserState("sell-user");
  __test_clearUserState("buy-user");
});

test("buildWalletCaption formats address and token lines", () => {
  const originalNetwork = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";

  try {
    const caption = buildWalletCaption("AbCdEf", [
      { ticker: "SOL", amount: "1.234567", usdValue: "123.46", unit: "SOL" },
      { ticker: "TIMBA", amount: "123", usdValue: "6,150.00" },
      { ticker: "USDC", amount: "10.00", usdValue: "10.00" },
    ]);

    expect(caption).toContain("Solana Address · <a href=\"https://solscan.io/account/AbCdEf\">🅴</a>");
    expect(caption).toContain("<code>AbCdEf</code> (Tap to copy)");
    expect(caption).toContain("SOL: 1.234567 SOL ($123.46)");
    expect(caption).toContain("TIMBA: 123 ($6,150.00)");
    expect(caption).toContain("USDC: 10.00 ($10.00)");
  } finally {
    if (originalNetwork === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalNetwork;
    }
  }
});

test("buildWalletCaption escapes HTML-sensitive ticker and address", () => {
  const originalNetwork = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";

  try {
    const caption = buildWalletCaption('ADDR<&"', [
      { ticker: 'BAD<&"', amount: '5 & rising', usdValue: '12.34' },
    ]);

    expect(caption).toContain("Solana Address · <a href=\"https://solscan.io/account/ADDR%3C%26%22\">🅴</a>");
    expect(caption).toContain("<code>ADDR&lt;&amp;&quot;</code> (Tap to copy)");
    expect(caption).toContain("BAD&lt;&amp;&quot;: 5 &amp; rising ($12.34)");
  } finally {
    if (originalNetwork === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalNetwork;
    }
  }
});

test("showCustomAmountPrompt formats send custom amount flow", async () => {
  const edits: EditCall[] = [];
  const ctx = createMockContext(edits);

  await showCustomAmountPrompt({
    ctx,
    userId: "send-user",
    title: "✏️ <b>Custom Amount - SOL</b>",
    instructions: ["Please send a message with the amount you want to send."],
    examples: ["• <code>0.5</code>", "• <code>1.25</code>"],
    cancelCallback: "send_select_SOL",
    state: { type: "send_custom_amount", token: "SOL" },
  });

  const { text, options } = expectSingleEdit(edits);
  expect(text).toContain("✏️ <b>Custom Amount - SOL</b>");
  expect(text).toContain("Please send a message with the amount you want to send.");
  expect(text).toContain("<b>Examples:</b>");
  expect(text).toContain("• <code>0.5</code>");
  expect(text).toContain(INPUT_TIMEOUT_HINT);
  expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
    "send_select_SOL"
  );

  const state = getUserState("send-user", false);
  expect(state?.type).toBe("send_custom_amount");
  expect(state?.token).toBe("SOL");
  expect(state?.messageId).toBe(321);
  expect(state?.chatId).toBe(654);
});

test("showCustomAmountPrompt formats sell custom amount flow", async () => {
  const edits: EditCall[] = [];
  const ctx = createMockContext(edits, {
    overrides: {
      callbackQuery: { message: { message_id: 111 } },
      chat: { id: 222 },
    },
  });

  await showCustomAmountPrompt({
    ctx,
    userId: "sender",
    title: "📤 <b>Send TIMBA - Custom Amount</b>",
    instructions: [
      "Please send a message with the amount of TIMBA you want to send.",
    ],
    examples: [
      "• <code>100</code> (send 100 TIMBA)",
      "• <code>50%</code> (send 50% of balance)",
      "• <code>max</code> (send all TIMBA)",
    ],
    cancelCallback: "cmd_withdraw",
    state: { type: "send_custom_amount", token: "TIMBA" },
  });

  const { text, options } = expectSingleEdit(edits);
  expect(text).toContain("📤 <b>Send TIMBA - Custom Amount</b>");
  expect(text).toContain("amount of TIMBA you want to send.");
  expect(text).toContain("• <code>100</code> (send 100 TIMBA)");
  expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
    "cmd_withdraw"
  );

  const state = getUserState("sender", false);
  expect(state?.type).toBe("send_custom_amount");
  expect(state?.token).toBe("TIMBA");
  expect(state?.messageId).toBe(111);
  expect(state?.chatId).toBe(222);
});

test("showCustomAmountPrompt formats buy custom amount flow", async () => {
  const edits: EditCall[] = [];
  const ctx = createMockContext(edits, {
    overrides: {
      callbackQuery: { message: { message_id: 777 } },
      chat: { id: 888 },
    },
  });

  await showCustomAmountPrompt({
    ctx,
    userId: "buy-user",
    title: "💱 <b>Swap TIMBA - Custom Amount</b>",
    tokenLines: [
      "<b>From:</b> USDC",
      "<b>To:</b> TIMBA",
    ],
    instructions: [
      "Please send a message with the amount of USDC you want to spend.",
    ],
    examples: [
      "• <code>0.1</code> (spend 0.1 USDC)",
      "• <code>5</code> (spend 5 USDC)",
      "• <code>50%</code> (spend 50% of balance)",
      "• <code>max</code> (spend all available USDC)",
    ],
    cancelCallback: "cmd_swap",
    state: {
      type: "swap_custom_amount",
      fromToken: "USDC",
      toToken: "TIMBA",
    },
  });

  const { text, options } = expectSingleEdit(edits);
  expect(text).toContain("💱 <b>Swap TIMBA - Custom Amount</b>");
  expect(text).toContain("<b>From:</b> USDC");
  expect(text).toContain("Please send a message with the amount of USDC you want to spend.");
  expect(text).toContain("• <code>max</code> (spend all available USDC)");
  expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
    "cmd_swap"
  );

  const state = getUserState("buy-user", false);
  expect(state?.type).toBe("swap_custom_amount");
  expect(state?.fromToken).toBe("USDC");
  expect(state?.toToken).toBe("TIMBA");
  expect(state?.messageId).toBe(777);
  expect(state?.chatId).toBe(888);
});

test("showCustomAmountPrompt stores fallback reply identifiers when edit fails", async () => {
  const edits: EditCall[] = [];
  const replies: ReplyCall[] = [];
  const ctx = createMockContext(edits, {
    editError: new Error("Bad Request: there is no text in the message to edit"),
    replyCalls: replies,
    replyChatId: 9_001,
    overrides: {
      callbackQuery: { message: { message_id: 654321 } },
      chat: { id: 8_765 },
    },
  });

  await showCustomAmountPrompt({
    ctx,
    userId: "send-user",
    title: "✏️ <b>Custom Amount - SOL</b>",
    instructions: ["Please send a message with the amount you want to send."],
    cancelCallback: "send_select_SOL",
    state: { type: "send_custom_amount", token: "SOL" },
  });

  expect(edits.length).toBe(1);
  expect(replies.length).toBe(1);

  const reply = replies[0];
  expect(reply).toBeDefined();
  expect(reply?.text).toContain("✏️ <b>Custom Amount - SOL</b>");
  expect(reply?.options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
    "send_select_SOL"
  );

  const state = getUserState("send-user", false);
  expect(state?.type).toBe("send_custom_amount");
  expect(reply).toBeDefined();
  expect(state?.messageId).toBe(reply?.message_id);
  expect(state?.chatId).toBe(9_001);
});
