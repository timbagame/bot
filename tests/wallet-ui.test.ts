import { afterEach, expect, test } from "bun:test";
import { buildWalletCaption, showCustomAmountPrompt } from "../src/utils/wallet-ui";
import { INPUT_TIMEOUT_HINT } from "../src/utils/constants";
import { getUserState, __test_clearUserState } from "../src/utils/user-state";

type EditCall = { text: string; options: any };

const createMockContext = (edits: EditCall[], overrides: Record<string, any> = {}) => {
  const baseCtx = {
    callbackQuery: { message: { message_id: 321 } },
    chat: { id: 654 },
    editMessageText: (text: string, options: any) => {
      edits.push({ text, options });
      return Promise.resolve();
    },
    reply: () => Promise.resolve(),
  };

  return { ...baseCtx, ...overrides } as any;
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
});

test("buildWalletCaption escapes HTML-sensitive ticker and address", () => {
  const caption = buildWalletCaption('ADDR<&"', [
    { ticker: 'BAD<&"', amount: '5 & rising', usdValue: '12.34' },
  ]);

  expect(caption).toContain("Solana Address · <a href=\"https://solscan.io/account/ADDR%3C%26%22\">🅴</a>");
  expect(caption).toContain("<code>ADDR&lt;&amp;&quot;</code> (Tap to copy)");
  expect(caption).toContain("BAD&lt;&amp;&quot;: 5 &amp; rising ($12.34)");
});

test("showCustomAmountPrompt formats send custom amount flow", async () => {
  const edits: EditCall[] = [];
  const ctx = createMockContext(edits);

  await showCustomAmountPrompt({
    ctx,
    userId: "send-user",
    title: "✏️ <b>CUSTOM AMOUNT - SOL</b>",
    instructions: ["Please send a message with the amount you want to send."],
    examples: ["• <code>0.5</code>", "• <code>1.25</code>"],
    cancelCallback: "send_select_SOL",
    state: { type: "send_custom_amount", token: "SOL" },
  });

  const { text, options } = expectSingleEdit(edits);
  expect(text).toContain("✏️ <b>CUSTOM AMOUNT - SOL</b>");
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
    callbackQuery: { message: { message_id: 111 } },
    chat: { id: 222 },
  });

  await showCustomAmountPrompt({
    ctx,
    userId: "sell-user",
    title: "🔴 <b>SELL TIMBA - CUSTOM AMOUNT</b>",
    instructions: [
      "Please send a message with the amount of TIMBA you want to sell.",
    ],
    examples: [
      "• <code>100</code> (sell 100 TIMBA)",
      "• <code>50%</code> (sell 50% of balance)",
      "• <code>max</code> (sell all TIMBA)",
    ],
    cancelCallback: "cmd_sell",
    state: { type: "sell_custom_amount", tokenToSell: "TIMBA" },
  });

  const { text, options } = expectSingleEdit(edits);
  expect(text).toContain("🔴 <b>SELL TIMBA - CUSTOM AMOUNT</b>");
  expect(text).toContain("amount of TIMBA you want to sell.");
  expect(text).toContain("• <code>100</code> (sell 100 TIMBA)");
  expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
    "cmd_sell"
  );

  const state = getUserState("sell-user", false);
  expect(state?.type).toBe("sell_custom_amount");
  expect(state?.tokenToSell).toBe("TIMBA");
  expect(state?.messageId).toBe(111);
  expect(state?.chatId).toBe(222);
});

test("showCustomAmountPrompt formats buy custom amount flow", async () => {
  const edits: EditCall[] = [];
  const ctx = createMockContext(edits, {
    callbackQuery: { message: { message_id: 777 } },
    chat: { id: 888 },
  });

  await showCustomAmountPrompt({
    ctx,
    userId: "buy-user",
    title: "💰 <b>BUY TIMBA - CUSTOM AMOUNT</b>",
    tokenLines: [
      "<b>Paying with:</b> USDC",
      "<b>Target token:</b> TIMBA",
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
    cancelCallback: "cmd_buy",
    state: {
      type: "buy_custom_amount",
      paymentToken: "USDC",
      targetToken: "TIMBA",
      contractAddress: "Abc123",
    },
  });

  const { text, options } = expectSingleEdit(edits);
  expect(text).toContain("💰 <b>BUY TIMBA - CUSTOM AMOUNT</b>");
  expect(text).toContain("<b>Paying with:</b> USDC");
  expect(text).toContain("Please send a message with the amount of USDC you want to spend.");
  expect(text).toContain("• <code>max</code> (spend all available USDC)");
  expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
    "cmd_buy"
  );

  const state = getUserState("buy-user", false);
  expect(state?.type).toBe("buy_custom_amount");
  expect(state?.paymentToken).toBe("USDC");
  expect(state?.targetToken).toBe("TIMBA");
  expect(state?.contractAddress).toBe("Abc123");
  expect(state?.messageId).toBe(777);
  expect(state?.chatId).toBe(888);
});
