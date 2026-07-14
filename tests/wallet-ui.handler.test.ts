import "./setup-env";
import { describe, test, expect } from "bun:test";
import { InlineKeyboard } from "grammy";
import { showWalletUI } from "../src/handlers/wallet";
import { buildWalletTokenLines, buildWalletActionMenu } from "../src/utils/wallet-ui";
import { __test_buildQuickAmountKeyboard } from "../src/bot";
import { WSOL_MINT } from "../src/utils/constants";

process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice";

type MakeCtxOptions = {
  editError?: Error;
  editDescription?: string;
  forceReply?: boolean;
};

function makeCtx(options: MakeCtxOptions = {}) {
  const calls: any[] = [];
  const { editError, editDescription, forceReply = false } = options;
  const ctx: any = {
    from: { id: 1 },
    message: { message_id: 7 },
    me: { id: 42 },
    chat: { id: 1, type: "private" },
    editMessageMedia: async (...args: any[]) => {
      calls.push(["edit", ...args]);
      if (editError) {
        if (editDescription) {
          (editError as any).description = editDescription;
        }
        throw editError;
      }
      if (forceReply) {
        throw new Error("force-reply");
      }
      return { ok: true };
    },
    replyWithVideo: async (...args: any[]) => {
      calls.push(["video", ...args]);
      return { ok: true };
    },
    reply: async (...args: any[]) => {
      calls.push(["reply", ...args]);
      return { ok: true };
    },
    api: {
      sendMessage: async (...args: any[]) => {
        calls.push(["send", ...args]);
        return { message_id: 200, chat: { id: args[0] } };
      },
    },
    __calls: calls,
  };
  return ctx;
}

describe("wallet handler showWalletUI", () => {
  test("edits existing wallet media for bot-authored callback messages", async () => {
    const ctx: any = makeCtx();
    ctx.callbackQuery = {
      message: {
        message_id: 11,
        from: { id: 42, is_bot: true },
      },
    };
    let capturedLines: any;
    const deps: any = {
      wallet: {
        getKeyPair: () => ({
          publicKey: { toBase58: () => "WALLETADDR11111111111111111111111111111111" },
        }),
        formatSolBalance: (_: number) => "0.000000",
        formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
      },
      getCachedWalletData: async () => ({
        solBalance: 0,
        tokenBalances: [{ mint: "EPjF...USDC", ticker: "USDC", balance: 1000000, decimals: 6 }],
      }),
      fetchPricesUSD: async (references: string[]) => {
        const record: Record<string, number> = {};
        for (const reference of references) {
          record[reference] = 1;
        }
        return record;
      },
      buildWalletCaption: (_: string, lines: any) => {
        capturedLines = lines;
        return "CAPTION";
      },
      createWalletKeyboard: () => ({ rows: [] }) as any,
      WINNER_VIDEO_ID: "VID",
    };
    await showWalletUI(ctx, deps);
    const calls = ctx.__calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("edit");
    expect(capturedLines).toEqual([
      { ticker: "SOL", amount: "0.000000", usdValue: "0", unit: "SOL" },
      { ticker: "USDC", amount: "1", usdValue: "1" },
    ]);
  });

  test("sends new wallet video when invoked via command context", async () => {
    const ctx: any = makeCtx();
    let capturedLines: any;
    const deps: any = {
      wallet: {
        getKeyPair: () => ({
          publicKey: { toBase58: () => "WALLETADDR11111111111111111111111111111111" },
        }),
        formatSolBalance: (_: number) => "0.000000",
        formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
      },
      getCachedWalletData: async () => ({
        solBalance: 0,
        tokenBalances: [{ mint: "EPjF...USDC", ticker: "USDC", balance: 1000000, decimals: 6 }],
      }),
      fetchPricesUSD: async (references: string[]) => {
        const record: Record<string, number> = {};
        for (const reference of references) {
          record[reference] = 1;
        }
        return record;
      },
      buildWalletCaption: (_: string, lines: any) => {
        capturedLines = lines;
        return "CAPTION";
      },
      createWalletKeyboard: () => ({ rows: [] }) as any,
      WINNER_VIDEO_ID: "VID",
    };

    await showWalletUI(ctx, deps);

    const calls = ctx.__calls;
    expect(calls.some((call: any[]) => call[0] === "edit")).toBe(false);
    expect(calls[0][0]).toBe("video");
    expect(capturedLines).toEqual([
      { ticker: "SOL", amount: "0.000000", usdValue: "0", unit: "SOL" },
      { ticker: "USDC", amount: "1", usdValue: "1" },
    ]);
  });

  test("shows error state when fetching balances fails", async () => {
    const ctx: any = makeCtx();
    ctx.callbackQuery = {
      message: {
        message_id: 12,
        from: { id: 42, is_bot: true },
      },
    };
    const deps: any = {
      wallet: {
        getKeyPair: () => ({
          publicKey: { toBase58: () => "WALLETADDR11111111111111111111111111111111" },
        }),
        formatSolBalance: (_: number) => "0.000000",
      },
      getCachedWalletData: async () => {
        throw new Error("fail");
      },
      fetchPricesUSD: async (references: string[]) => {
        const record: Record<string, number> = {};
        for (const reference of references) {
          record[reference] = 1;
        }
        return record;
      },
      buildWalletCaption: () => "CAPTION",
      createWalletKeyboard: () => ({ rows: [] }) as any,
      WINNER_VIDEO_ID: "VID",
    };
    await showWalletUI(ctx, deps);
    const calls = ctx.__calls;
    expect(calls[0][0]).toBe("edit");
    const editPayload = calls[0][1];
    expect(String(editPayload?.caption ?? "")).toContain("Error loading balances");
  });

  test("falls back to text when edit fails with recoverable media error", async () => {
    const ctx: any = makeCtx({
      editError: new Error("recoverable"),
      editDescription: "Bad Request: wrong file identifier specified",
    });
    ctx.callbackQuery = {
      message: {
        message_id: 13,
        from: { id: 42, is_bot: true },
      },
    };
    const deps: any = {
      wallet: {
        getKeyPair: () => ({
          publicKey: { toBase58: () => "WALLETADDR11111111111111111111111111111111" },
        }),
        formatSolBalance: (_: number) => "0.000000",
      },
      getCachedWalletData: async () => ({ solBalance: 0, tokenBalances: [] }),
      fetchPricesUSD: async (references: string[]) => {
        const record: Record<string, number> = {};
        for (const reference of references) {
          record[reference] = 1;
        }
        return record;
      },
      buildWalletCaption: () => "CAPTION",
      createWalletKeyboard: () => ({ rows: [] }) as any,
      WINNER_VIDEO_ID: "VID",
    };

    await showWalletUI(ctx, deps);

    const calls = ctx.__calls;
    expect(calls[0][0]).toBe("edit");
    expect(calls[1][0]).toBe("reply");
    expect(calls.some((call: any[]) => call[0] === "video")).toBe(false);
  });

  test("notifies origin chat when bot cannot initiate DM", async () => {
    const ctx: any = makeCtx();
    ctx.chat = { id: 123, type: "private" };
    ctx.__originChatId = -100;
    ctx.reply = async (...args: any[]) => {
      ctx.__calls.push(["reply", ...args]);
      const err: any = new Error("forbidden");
      err.error_code = 403;
      err.description = "Forbidden: bot can't initiate conversation with a user";
      throw err;
    };
    const deps: any = {
      wallet: {
        getKeyPair: () => ({
          publicKey: { toBase58: () => "WALLETADDR11111111111111111111111111111111" },
        }),
        formatSolBalance: (_: number) => "0.000000",
      },
      getCachedWalletData: async () => ({ solBalance: 0, tokenBalances: [] }),
      buildWalletCaption: () => "CAPTION",
      createWalletKeyboard: () => new InlineKeyboard().text("Refresh", "refresh"),
      WINNER_VIDEO_ID: null,
    };

    await showWalletUI(ctx, deps);

    expect((ctx as any).__walletDmForbidden).toBe(true);
    const sendCall = ctx.__calls.find((call: any[]) => call[0] === "send");
    expect(sendCall).toBeDefined();
    expect(sendCall?.[1]).toBe(-100);
    expect(String(sendCall?.[2])).toMatch(/Start/);
  });

  test("flags DM forbidden when video and text paths both fail in private chat", async () => {
    const ctx: any = makeCtx();
    ctx.chat = { id: 321, type: "private" };
    ctx.__originChatId = -100;
    ctx.me = { id: 42, username: "playtimbabot" };

    const recoverableVideoError: any = new Error("Bad Request: wrong file identifier specified");
    recoverableVideoError.description = "Bad Request: wrong file identifier specified";

    const forbiddenDmError: any = new Error(
      "Forbidden: bot can't initiate conversation with a user",
    );
    forbiddenDmError.error_code = 403;
    forbiddenDmError.description = "Forbidden: bot can't initiate conversation with a user";

    ctx.replyWithVideo = async (...args: any[]) => {
      ctx.__calls.push(["video", ...args]);
      throw recoverableVideoError;
    };
    ctx.reply = async (...args: any[]) => {
      ctx.__calls.push(["reply", ...args]);
      throw forbiddenDmError;
    };

    const deps: any = {
      wallet: {
        getKeyPair: () => ({
          publicKey: { toBase58: () => "WALLETADDR1111111111111111111111111111111" },
        }),
        formatSolBalance: (_: number | bigint) => "0.000000",
      },
      getCachedWalletData: async () => ({ solBalance: 0n, tokenBalances: [] }),
      fetchPricesUSD: async () => ({}),
      buildWalletCaption: () => "CAPTION",
      createWalletKeyboard: () => ({ rows: [] }) as any,
      WINNER_VIDEO_ID: "VID",
    };

    await showWalletUI(ctx, deps);

    expect((ctx as any).__walletDmForbidden).toBe(true);
    const replyAttempts = ctx.__calls.filter((call: any[]) => call[0] === "reply");
    expect(replyAttempts).toHaveLength(1);
    const notifyCall = ctx.__calls.find((call: any[]) => call[0] === "send");
    expect(notifyCall).toBeDefined();
    expect(notifyCall?.[1]).toBe(-100);
    expect(String(notifyCall?.[2])).toContain("Start");
  });
});

test("buildWalletTokenLines formats balances and skips empty tokens", async () => {
  const lines = await buildWalletTokenLines({
    solBalanceLamports: 2_000_000_000,
    tokenBalances: [
      { mint: WSOL_MINT, ticker: "SOL", balance: 1, decimals: 9 },
      { mint: "mint-aaa", ticker: "AAA", balance: 1_500_000, decimals: 6 },
      { mint: "mint-bbb", ticker: "BBB", balance: 0, decimals: 6 },
    ],
    formatSolBalance: (lamports) => (lamports / 1_000_000_000).toFixed(6),
    formatTokenBalance: (amount, decimals) => (amount / Math.pow(10, decimals)).toFixed(3),
    fetchPricesUSD: async (references: string[]) => {
      const record: Record<string, number> = {};
      for (const reference of references) {
        if (reference === WSOL_MINT) {
          record[reference] = 20;
        } else {
          record[reference] = 5;
        }
      }
      return record;
    },
  });

  expect(lines).toEqual([
    { ticker: "SOL", amount: "2.000000", usdValue: "40", unit: "SOL" },
    { ticker: "AAA", amount: "1.500", usdValue: "7.5" },
  ]);
});

describe("buildWalletActionMenu", () => {
  const formatters = {
    formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(3),
    formatTokenBalance: (balance: number, decimals: number) =>
      (balance / Math.pow(10, decimals)).toFixed(3),
  };

  test("creates withdraw token selection menu", () => {
    const menu = buildWalletActionMenu({
      title: "💸 <b>Withdraw</b>",
      walletAddress: "ADDR1111111111111111111111111111111",
      bodyLines: [
        "<b>From:</b> <code>{{WALLET_ADDRESS}}</code>",
        "",
        "<b>Select token to withdraw:</b>",
      ],
      balances: {
        solBalanceLamports: 1_500_000_000,
        tokenBalances: [
          { mint: "mint-aaa", ticker: "AAA", balance: 900_000, decimals: 6 },
          { mint: "mint-bbb", ticker: "BBB", balance: 0, decimals: 6 },
        ],
      },
      formatters,
      quickActions: {
        type: "token-select",
        actionPrefix: "send_select_",
        includeSol: true,
        limit: 5,
      },
      backButton: { label: "← Back to Wallet", callback: "main_wallet" },
    });

    expect(menu.text).toBe(
      [
        "💸 <b>Withdraw</b>",
        "",
        "<b>From:</b> <code>ADDR1111111111111111111111111111111</code>",
        "",
        "<b>Select token to withdraw:</b>",
      ].join("\n"),
    );
    expect(menu.keyboard.inline_keyboard).toEqual([
      [{ text: "SOL (1.500)", callback_data: "send_select_SOL" }],
      [{ text: "AAA (0.900)", callback_data: "send_select_AAA" }],
      [{ text: "BBB (0.000)", callback_data: "send_select_BBB" }],
      [{ text: "← Back to Wallet", callback_data: "main_wallet" }],
    ]);
  });

  test("returns empty swap state when no balances available", () => {
    const menu = buildWalletActionMenu({
      title: "💱 <b>Swap Tokens</b>",
      walletAddress: "swap-user",
      bodyLines: [
        "<b>From Wallet:</b> <code>{{WALLET_ADDRESS}}</code>",
        "",
        "<b>Select token to swap FROM:</b>",
      ],
      balances: {
        solBalanceLamports: 0,
        tokenBalances: [
          { mint: "mint-ccc", ticker: "CCC", balance: 0, decimals: 6, rawBalance: "0" },
        ],
      },
      formatters,
      quickActions: {
        type: "token-select",
        actionPrefix: "swap_from_",
        includeSol: { includeIf: (lamports) => lamports > 0 },
        filter: (token) => Number.parseFloat(String(token.rawBalance ?? "0")) > 0,
        emptyLabel: "❌ No tokens available to swap",
      },
      backButton: { label: "← Back to Wallet", callback: "main_wallet" },
    });

    expect(menu.text).toContain("<b>Select token to swap FROM:</b>");
    expect(menu.keyboard.inline_keyboard).toEqual([
      [{ text: "❌ No tokens available to swap", callback_data: "noop" }],
      [{ text: "← Back to Wallet", callback_data: "main_wallet" }],
    ]);
  });

  test("uses provided keyboard for prebuilt quick actions", () => {
    const prebuilt = new InlineKeyboard().text("Option", "cb").row();

    const menu = buildWalletActionMenu({
      title: "📤 <b>Send AAA</b>",
      walletAddress: "send-user",
      bodyLines: ["<b>From:</b> <code>{{WALLET_ADDRESS}}</code>", "<b>Balance:</b> 1 AAA"],
      balances: { solBalanceLamports: 0, tokenBalances: [] },
      formatters,
      quickActions: { type: "prebuilt", keyboard: prebuilt },
    });

    expect(menu.keyboard).toBe(prebuilt);
    expect(menu.text).toContain("<b>Balance:</b> 1 AAA");
  });

  test("wrap menu shows quick actions when balance sufficient", () => {
    const baseConfig = {
      title: "🔧 <b>Wrap SOL</b>",
      bodyLines: [
        "<b>Native SOL:</b> 0.500",
        "<b>WSOL:</b> 0.125",
        "",
        "<b>Quick Wrap Amounts:</b>",
      ],
      formatters,
      quickActions: {
        type: "wrap" as const,
        callbackPrefix: "wrap_amount_",
        amounts: [
          { label: "25%", value: "25%" },
          { label: "50%", value: "50%" },
          { label: "75%", value: "75%" },
          { label: "MAX", value: "MAX" },
        ],
        customAction: { label: "✏️ Custom Amount", callback: "wrap_custom" },
        insufficientLabel: "❌ Insufficient SOL balance",
        minimumLamports: 10_000,
      },
      backButton: { label: "← Back to Settings", callback: "wallet_settings" },
    };

    const withBalance = buildWalletActionMenu({
      ...baseConfig,
      walletAddress: "wrap-user",
      balances: { solBalanceLamports: 50_000, tokenBalances: [] },
    });

    expect(withBalance.keyboard.inline_keyboard).toEqual([
      [
        { text: "25%", callback_data: "wrap_amount_25%" },
        { text: "50%", callback_data: "wrap_amount_50%" },
      ],
      [
        { text: "75%", callback_data: "wrap_amount_75%" },
        { text: "MAX", callback_data: "wrap_amount_MAX" },
      ],
      [{ text: "✏️ Custom Amount", callback_data: "wrap_custom" }],
      [{ text: "← Back to Settings", callback_data: "wallet_settings" }],
    ]);

    const insufficient = buildWalletActionMenu({
      ...baseConfig,
      walletAddress: "wrap-user",
      balances: { solBalanceLamports: 1_000, tokenBalances: [] },
    });

    expect(insufficient.keyboard.inline_keyboard).toEqual([
      [{ text: "❌ Insufficient SOL balance", callback_data: "noop" }],
      [{ text: "← Back to Settings", callback_data: "wallet_settings" }],
    ]);
  });

  test("wrap menu treats exact minimum lamports as insufficient", () => {
    const baseConfig = {
      title: "🔧 <b>Wrap SOL</b>",
      bodyLines: [
        "<b>Native SOL:</b> 0.010",
        "<b>WSOL:</b> 0.000",
        "",
        "<b>Quick Wrap Amounts:</b>",
      ],
      formatters,
      quickActions: {
        type: "wrap" as const,
        callbackPrefix: "wrap_amount_",
        amounts: [
          { label: "25%", value: "25%" },
          { label: "50%", value: "50%" },
          { label: "75%", value: "75%" },
          { label: "MAX", value: "MAX" },
        ],
        customAction: { label: "✏️ Custom Amount", callback: "wrap_custom" },
        insufficientLabel: "❌ Insufficient SOL balance",
        minimumLamports: 10_000,
      },
      backButton: { label: "← Back to Settings", callback: "wallet_settings" },
    };

    const equalThreshold = buildWalletActionMenu({
      ...baseConfig,
      walletAddress: "wrap-user",
      balances: { solBalanceLamports: 10_000, tokenBalances: [] },
    });

    expect(equalThreshold.keyboard.inline_keyboard).toEqual([
      [{ text: "❌ Insufficient SOL balance", callback_data: "noop" }],
      [{ text: "← Back to Settings", callback_data: "wallet_settings" }],
    ]);
  });
});

test("send quick amount keyboard preserves percentage and custom callbacks", () => {
  const keyboard = __test_buildQuickAmountKeyboard({
    baseCallback: (value: string) => `send_amount_SOL_${value.toUpperCase()}`,
    customLabel: "✏️ Custom Amount",
    backCallback: "cmd_withdraw",
  });

  const rows = keyboard.inline_keyboard.filter((row) => row.length > 0);
  expect(rows).toHaveLength(4);

  const [rowPercent1, rowPercent2, rowCustom, rowBack] = rows;
  expect(rowPercent1).toBeDefined();
  expect(rowPercent2).toBeDefined();
  expect(rowCustom).toBeDefined();
  expect(rowBack).toBeDefined();

  const [btn25, btn50] = rowPercent1!;
  const [btn75, btnMax] = rowPercent2!;
  const [customBtn] = rowCustom!;
  const [backBtn] = rowBack!;

  expect(btn25).toMatchObject({
    text: "25%",
    callback_data: "send_amount_SOL_25%",
  });
  expect(btn50).toMatchObject({
    text: "50%",
    callback_data: "send_amount_SOL_50%",
  });
  expect(btn75).toMatchObject({
    text: "75%",
    callback_data: "send_amount_SOL_75%",
  });
  expect(btnMax).toMatchObject({
    text: "MAX",
    callback_data: "send_amount_SOL_MAX",
  });
  expect(customBtn).toMatchObject({
    text: "✏️ Custom Amount",
    callback_data: "send_amount_SOL_CUSTOM",
  });
  expect(backBtn).toMatchObject({
    text: "← Back",
    callback_data: "cmd_withdraw",
  });
});
