import { afterEach, expect, test } from "bun:test";
import { InlineKeyboard, type Context } from "grammy";
import {
  buildWalletCaption,
  buildWalletTokenLines,
  buildWalletActionMenuForUser,
  showCustomAmountPrompt,
  persistInputPromptFromContext,
} from "../src/utils/wallet-ui";
import { INPUT_TIMEOUT_HINT, LAMPORTS_PER_SOL, WSOL_MINT } from "../src/utils/constants";
import { getInputSession, clearAllInputSessions } from "../src/utils/user-state";

type EditCall = { text: string; options: any };
type ReplyCall = { text: string; options: any; message_id: number };

type CreateMockContextOptions = {
  overrides?: Record<string, any>;
  replyCalls?: ReplyCall[];
  editError?: Error;
  replyChatId?: number;
};

const createMockContext = (edits: EditCall[], options: CreateMockContextOptions = {}) => {
  const { overrides = {}, replyCalls, editError, replyChatId } = options;
  const { callbackQuery: overrideCallbackQuery, chat: overrideChat, ...restOverrides } = overrides;

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
      const chatId = replyChatId ?? (typeof ctx.chat?.id === "number" ? ctx.chat.id : undefined);
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
  clearAllInputSessions();
});

test("buildWalletCaption formats address and token lines", () => {
  const originalNetwork = process.env.SOLANA_NETWORK;
  process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";

  try {
    const caption = buildWalletCaption("AbCdEf", [
      { ticker: "SOL", amount: "1.234567", usdValue: "123.46", unit: "SOL" },
      { ticker: "TIMBA", amount: "123", usdValue: "6,150" },
      { ticker: "USDC", amount: "10.00", usdValue: "10" },
    ]);

    expect(caption).toContain('Solana Address · <a href="https://solscan.io/account/AbCdEf">🅴</a>');
    expect(caption).toContain("<code>AbCdEf</code> (Tap to copy)");
    expect(caption).toContain("SOL: 1.234567 SOL ($123.46)");
    expect(caption).toContain("TIMBA: 123 ($6,150)");
    expect(caption).toContain("USDC: 10.00 ($10)");
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
      { ticker: 'BAD<&"', amount: "5 & rising", usdValue: "12.34" },
    ]);

    expect(caption).toContain(
      'Solana Address · <a href="https://solscan.io/account/ADDR%3C%26%22">🅴</a>',
    );
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

test("buildWalletTokenLines batches price lookups and reuses cached values", async () => {
  const calls: string[] = [];
  const lines = await buildWalletTokenLines({
    solBalanceLamports: 2 * LAMPORTS_PER_SOL,
    tokenBalances: [
      { mint: "mint-1", ticker: "TOKEN", balance: 2_000_000, decimals: 6 },
      { mint: "mint-1", ticker: "TOKEN-B", balance: 3_000_000, decimals: 6 },
      {
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        ticker: "USDC",
        balance: 10_000_000,
        decimals: 6,
      },
    ],
    formatSolBalance: (lamports) => `${lamports / LAMPORTS_PER_SOL} SOL`,
    formatTokenBalance: (balance, decimals) => (balance / Math.pow(10, decimals)).toFixed(2),
    fetchPricesUSD: async (references) => {
      const record: Record<string, number> = {};
      for (const reference of references) {
        calls.push(reference);
        switch (reference) {
          case WSOL_MINT:
            record[reference] = 25;
            break;
          case "mint-1":
            record[reference] = 0.5;
            break;
          case "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v":
            record[reference] = 1;
            break;
          default:
            record[reference] = 0;
        }
      }
      return record;
    },
  });

  expect(calls).toEqual([WSOL_MINT, "mint-1", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]);
  expect(lines).toHaveLength(4);
  expect(lines[0]).toEqual({
    ticker: "SOL",
    amount: "2 SOL",
    usdValue: "50",
    unit: "SOL",
  });
  const tokenLine = lines[1]!;
  const tokenLineB = lines[2]!;
  const stablecoinLine = lines[3]!;
  expect(tokenLine.usdValue).toBe("1");
  expect(tokenLineB.usdValue).toBe("1.5");
  expect(stablecoinLine.usdValue).toBe("10");
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
  expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("send_select_SOL");

  const session = getInputSession("654_321");
  expect(session?.type).toBe("send_custom_amount");
  expect(session?.["token"]).toBe("SOL");
  expect(session?.messageId).toBe(321);
  expect(session?.chatId).toBe(654);
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
    instructions: ["Please send a message with the amount of TIMBA you want to send."],
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
  expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("cmd_withdraw");

  const session = getInputSession("222_111");
  expect(session?.type).toBe("send_custom_amount");
  expect(session?.["token"]).toBe("TIMBA");
  expect(session?.messageId).toBe(111);
  expect(session?.chatId).toBe(222);
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
    tokenLines: ["<b>From:</b> USDC", "<b>To:</b> TIMBA"],
    instructions: ["Please send a message with the amount of USDC you want to spend."],
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
  expect(options.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("cmd_swap");

  const session = getInputSession("888_777");
  expect(session?.type).toBe("swap_custom_amount");
  expect(session?.["fromToken"]).toBe("USDC");
  expect(session?.["toToken"]).toBe("TIMBA");
  expect(session?.messageId).toBe(777);
  expect(session?.chatId).toBe(888);
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
    "send_select_SOL",
  );

  const replyMessageId = reply?.message_id;
  expect(replyMessageId).toBeDefined();

  const sessionKey = replyMessageId ? `9001_${replyMessageId}` : undefined;
  const session = sessionKey ? getInputSession(sessionKey) : undefined;

  expect(session?.type).toBe("send_custom_amount");
  expect(session?.messageId).toBe(replyMessageId);
  expect(session?.chatId).toBe(9_001);
});

test("persistInputPromptFromContext overwrites session with latest prompt", async () => {
  const edits: EditCall[] = [];
  const ctx = createMockContext(edits, {
    overrides: {
      from: { id: 999 },
    },
  });

  const keyboard = new InlineKeyboard().text("Cancel", "cancel");

  await persistInputPromptFromContext({
    ctx,
    text: "First prompt",
    keyboard,
    session: { type: "first_prompt", payload: 1 },
    logLabel: "first",
  });

  await persistInputPromptFromContext({
    ctx,
    text: "Second prompt",
    keyboard,
    session: { type: "second_prompt", payload: 2 },
    logLabel: "second",
  });

  const sessionKey = "654_321";
  const session = getInputSession(sessionKey);

  expect(session?.type).toBe("second_prompt");
  expect(session?.["payload"]).toBe(2);
});

test("persistInputPromptFromContext stores initiatorId by default", async () => {
  const edits: EditCall[] = [];
  const ctx = createMockContext(edits, {
    overrides: {
      from: { id: 111 },
    },
  });

  const keyboard = new InlineKeyboard().text("Cancel", "cancel");

  await persistInputPromptFromContext({
    ctx,
    text: "Prompt",
    keyboard,
    session: { type: "send_custom_amount" },
    logLabel: "initiator-default",
  });

  const sessionKey = "654_321";
  const session = getInputSession(sessionKey);
  expect(session?.initiatorId).toBe("111");
});

test("buildWalletActionMenuForUser assembles menu using shared dependencies", async () => {
  const keyboard = new InlineKeyboard();
  const balancesCalls: bigint[] = [];
  const deps = {
    requireTelegramId: (_ctx: any, label: string) => {
      expect(label).toBe("wallet action menu");
      return 77n;
    },
    getWalletAddress: async (telegramId: bigint) => {
      expect(telegramId).toBe(77n);
      return "WALLET111111111111111111111111111111111111";
    },
    getWalletBalances: async (telegramId: bigint) => {
      balancesCalls.push(telegramId);
      return {
        solBalance: 2_500_000_000,
        tokenBalances: [{ mint: "mint-aaa", ticker: "AAA", balance: 500_000_000, decimals: 9 }],
      };
    },
    formatSolBalance: (lamports: number) => `${lamports / 1_000_000_000} SOL`,
    formatTokenBalance: (balance: number, decimals: number) =>
      (balance / Math.pow(10, decimals)).toString(),
  } as const;

  const { menu, walletAddress, solBalance, tokenBalances } = await buildWalletActionMenuForUser(
    deps,
    {
      ctx: {} as Context,
      title: "💸 <b>Withdraw</b>",
      bodyLines: ["<b>Balances:</b>", "AAA tokens available"],
      quickActions: { type: "prebuilt", keyboard },
    },
  );

  expect(walletAddress).toBe("WALLET111111111111111111111111111111111111");
  expect(solBalance).toBe(2_500_000_000);
  expect(tokenBalances).toHaveLength(1);
  expect(menu.text).toContain("AAA tokens available");
  expect(balancesCalls).toEqual([77n]);

  const rows = menu.keyboard.inline_keyboard ?? [];
  const lastRow = rows[rows.length - 1];
  const lastButton = lastRow?.[0];
  expect(lastButton?.text).toBe("← Back to Wallet");
  expect(lastButton && "callback_data" in lastButton ? lastButton.callback_data : undefined).toBe(
    "main_wallet",
  );
});

test("buildWalletActionMenuForUser applies prepareBalances overrides", async () => {
  const deps = {
    requireTelegramId: () => 88n,
    getWalletAddress: () => "ADDR22222222222222222222222222222222222",
    getWalletBalances: async () => ({
      solBalance: 3_000_000_000,
      tokenBalances: [
        { mint: "mint-aaa", ticker: "AAA", balance: 1_000_000, decimals: 6 },
        { mint: "mint-bbb", ticker: "BBB", balance: 2_000_000, decimals: 6 },
      ],
    }),
    formatSolBalance: (lamports: number) => `${lamports / 1_000_000_000} SOL`,
    formatTokenBalance: (balance: number, decimals: number) =>
      (balance / Math.pow(10, decimals)).toFixed(3),
  } as const;

  let prepareCalledWith: { solBalance: number; tokenBalances: any[] } | undefined;

  const { menu } = await buildWalletActionMenuForUser(deps, {
    ctx: {} as Context,
    title: "🎯 <b>Select Token</b>",
    bodyLines: ["Choose a token"],
    quickActions: {
      type: "token-select",
      actionPrefix: "send_select_",
      includeSol: true,
    },
    prepareBalances: (balances) => {
      prepareCalledWith = balances;
      return {
        solBalanceLamports: balances.solBalance,
        tokenBalances: balances.tokenBalances.slice(0, 1),
      };
    },
  });

  expect(prepareCalledWith?.tokenBalances).toHaveLength(2);
  const rows = menu.keyboard.inline_keyboard ?? [];
  const flattened = rows.flat();
  const buttonLabels = flattened.map((btn) => btn?.text);
  expect(buttonLabels.filter((label) => label?.includes("AAA"))).toHaveLength(1);
  expect(buttonLabels.some((label) => label?.includes("BBB"))).toBe(false);
});
