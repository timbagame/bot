import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createGameCommandsModule } from "../src/handlers/game-commands";
import {
  GAME_CREATION_RATE_LIMIT_WINDOW_MS,
  LAMPORTS_PER_SOL,
  MAX_ACTIVE_GAMES_PER_CREATOR,
  MAX_GAMES_PER_CREATOR_WINDOW,
  MIN_SOL_FOR_TX,
  WSOL_MINT,
} from "../src/utils/constants";
import { parseDecimalAmount } from "../src/utils/amount";

const extractCallbacks = (kb: any): string[] => {
  const grid = (kb && (kb.inline_keyboard || kb.keyboard)) as any[] | undefined;
  if (Array.isArray(grid)) {
    return grid.flat().map((b: any) => b?.callback_data).filter(Boolean);
  }
  const rows = (kb as any).rows as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows.flat().map((b: any) => b?.callback_data).filter(Boolean);
  }
  try {
    const j = JSON.parse(JSON.stringify(kb));
    const arr = (j && (j.inline_keyboard || j.keyboard)) as any[] | undefined;
    if (Array.isArray(arr)) {
      return arr.flat().map((b: any) => b?.callback_data).filter(Boolean);
    }
  } catch {}
  return [];
};

const extractTexts = (kb: any): string[] => {
  const grid = (kb && (kb.inline_keyboard || kb.keyboard)) as any[] | undefined;
  if (Array.isArray(grid)) {
    return grid.flat().map((b: any) => b?.text).filter(Boolean);
  }
  const rows = (kb as any).rows as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows.flat().map((b: any) => b?.text).filter(Boolean);
  }
  try {
    const j = JSON.parse(JSON.stringify(kb));
    const arr = (j && (j.inline_keyboard || j.keyboard)) as any[] | undefined;
    if (Array.isArray(arr)) {
      return arr.flat().map((b: any) => b?.text).filter(Boolean);
    }
  } catch {}
  return [];
};

type BotModule = typeof import("../src/bot");
type CreateGameViaCommandOptions = Parameters<
  BotModule["__test_createGameViaCommand"]
>[3];
type CreateGameViaCommandDeps = NonNullable<
  Parameters<BotModule["__test_createGameViaCommand"]>[4]
>;

let botModule: BotModule;
const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  MNEMONIC: process.env.MNEMONIC,
  SOLANA_NETWORK: process.env.SOLANA_NETWORK,
};

const applyTestEnv = () => {
  process.env.NODE_ENV = "test";
  process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "test-token";
  process.env.MNEMONIC =
    process.env.MNEMONIC ||
    "test test test test test test test test test test test junk";
  process.env.SOLANA_NETWORK =
    process.env.SOLANA_NETWORK || "http://localhost:8899";
};

const revertTestEnv = () => {
  if (originalEnv.NODE_ENV === undefined) {
    Reflect.deleteProperty(process.env, "NODE_ENV");
  } else {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  }

  if (originalEnv.TELEGRAM_TOKEN === undefined) {
    Reflect.deleteProperty(process.env, "TELEGRAM_TOKEN");
  } else {
    process.env.TELEGRAM_TOKEN = originalEnv.TELEGRAM_TOKEN;
  }

  if (originalEnv.MNEMONIC === undefined) {
    Reflect.deleteProperty(process.env, "MNEMONIC");
  } else {
    process.env.MNEMONIC = originalEnv.MNEMONIC;
  }

  if (originalEnv.SOLANA_NETWORK === undefined) {
    Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
  } else {
    process.env.SOLANA_NETWORK = originalEnv.SOLANA_NETWORK;
  }
};

const ensureBotModuleLoaded = async () => {
  if (botModule) {
    return;
  }
  applyTestEnv();
  botModule = await import("../src/bot");
  (botModule.bot as any).botInfo = {
    id: 0,
    is_bot: true,
    first_name: "test-bot",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
  };
};

describe("Bot helper utilities", () => {
  beforeAll(async () => {
    await ensureBotModuleLoaded();
  });

  afterAll(() => {
    revertTestEnv();
  });

  const expectTradeSummaryBasics = (
    summary: ReturnType<
      typeof botModule.__test_formatTradeConfirmationSummary
    >,
    {
      payDisplay,
      payToken,
      receiveDisplay,
      receiveToken,
      providerLabel,
      rateDisplay,
      slippageText,
      contractAddress,
    }: {
      payDisplay: string;
      payToken: string;
      receiveDisplay: string;
      receiveToken: string;
      providerLabel: string;
      rateDisplay: string;
      slippageText: string;
      contractAddress?: string;
    }
  ) => {
    expect(summary.receiveDisplay).toBe(receiveDisplay);
    expect(summary.rateDisplay).toBe(rateDisplay);
    expect(summary.providerLabel).toBe(providerLabel);
    expect(summary.slippageText).toBe(slippageText);

    expect(summary.message).toContain(
      `<b>You Pay:</b> ${payDisplay} ${payToken}`
    );
    expect(summary.message).toContain(
      `<b>You Receive:</b> ~${receiveDisplay} ${receiveToken}`
    );
    expect(summary.message).toContain(providerLabel);
    if (contractAddress) {
      expect(summary.message).toContain(contractAddress);
    }
  };

  test("parseDecimalAmount returns raw lamports for valid bot inputs", () => {
    const fromInteger = parseDecimalAmount("15", 2);
    const fromDecimal = parseDecimalAmount("0.5", 9);
    const fromLeadingDecimal = parseDecimalAmount(".75", 4);

    expect(fromInteger).toBe(1500);
    expect(fromDecimal).toBe(500_000_000);
    expect(fromLeadingDecimal).toBe(7500);
  });

  test("parseDecimalAmount rejects invalid or unsafe values", () => {
    expect(() => parseDecimalAmount("abc", 2)).toThrow("Invalid amount format");
    expect(() => parseDecimalAmount("0", 2)).toThrow("greater than zero");
    expect(() => parseDecimalAmount("0.000", 3)).toThrow("greater than zero");
    expect(() => parseDecimalAmount("9007199254740993", 0)).toThrow("too large");
    expect(() => parseDecimalAmount("1e3", 9)).toThrow("Invalid amount format");
  });

  test("clampLamportsForFees subtracts buffered lamports without going negative", () => {
    const buffer = Math.ceil(MIN_SOL_FOR_TX * LAMPORTS_PER_SOL);
    const aboveBuffer = botModule.__test_clampLamportsForFees(buffer * 2);
    const exactlyBuffer = botModule.__test_clampLamportsForFees(buffer);
    const belowBuffer = botModule.__test_clampLamportsForFees(buffer - 1);

    expect(aboveBuffer).toBe(buffer);
    expect(exactlyBuffer).toBe(0);
    expect(belowBuffer).toBe(0);
  });

  test("isPrivateChat detects chat type", () => {
    const privateCtx = { chat: { type: "private" } } as any;
    const groupCtx = { chat: { type: "group" } } as any;

    expect(botModule.__test_isPrivateChat(privateCtx)).toBe(true);
    expect(botModule.__test_isPrivateChat(groupCtx)).toBe(false);
  });

  test("createApiContext builds minimal context with provided api", () => {
    const customApi = { call: () => Promise.resolve() } as any;
    const ctxWithCustom = botModule.__test_createApiContext(123, customApi);
    expect(ctxWithCustom.api).toBe(customApi);
    expect(ctxWithCustom.chat?.id).toBe(123);

    const ctxWithDefault = botModule.__test_createApiContext(456);
    expect(ctxWithDefault.chat?.id).toBe(456);
    expect(ctxWithDefault.api).toBe(botModule.bot.api);
  });

  test("validateGameTokenData enforces required fields", () => {
    expect(botModule.__test_validateGameTokenData(null)).toEqual({
      isValid: false,
      error: "Game not found",
    });
    expect(
      botModule.__test_validateGameTokenData({ token_mint: "mint" })
    ).toEqual({
      isValid: false,
      error: "Game missing token information",
    });
    expect(
      botModule.__test_validateGameTokenData({ token_mint: "mint", token_ticker: "AAA" })
    ).toEqual({ isValid: true });
  });

  test("chat initialization helpers work correctly", async () => {
    // Test that chat initialization helpers are accessible and work
    botModule.__test_resetInitiatedChats();
    expect(botModule.__test_getInitiatedChats().size).toBe(0);

    // showBotInfoScreen was removed as part of cleanup
    // This test now focuses on the remaining helper functions
    expect(botModule.__test_resetInitiatedChats).toBeDefined();
    expect(botModule.__test_getInitiatedChats).toBeDefined();
  });

  test("presentSpendAmount handles percentage-based SOL spend", () => {
    const buffer = Math.ceil(MIN_SOL_FOR_TX * LAMPORTS_PER_SOL);
    const solBalance = buffer * 5;

    const { rawAmount, displayAmount } = botModule.__test_presentSpendAmount({
      amount: "25%",
      assetTicker: "SOL",
      decimals: 9,
      solBalance,
      tokenBalance: undefined,
      formatSol: (lamports: number) => botModule.wallet.formatSolBalance(lamports),
      formatToken: (value: number, decimals: number) =>
        botModule.wallet.formatTokenBalance(value, decimals),
    });

    const expectedSpendable = Math.max(0, solBalance - buffer);
    const expectedRaw = Math.floor(expectedSpendable * 0.25);

    expect(rawAmount).toBe(expectedRaw);
    expect(displayAmount).toBe(botModule.wallet.formatSolBalance(expectedRaw));
  });

  test("presentSpendAmount handles token percentage and max paths", () => {
    const tokenBalance = { balance: 1_500_000_000, decimals: 6 };
    const solBalance = 10 * LAMPORTS_PER_SOL;

    const percentResult = botModule.__test_presentSpendAmount({
      amount: "50%",
      assetTicker: "TIMBA",
      decimals: 6,
      solBalance,
      tokenBalance,
      formatSol: (lamports: number) => botModule.wallet.formatSolBalance(lamports),
      formatToken: (value: number, decimals: number) =>
        botModule.wallet.formatTokenBalance(value, decimals),
    });

    expect(percentResult.rawAmount).toBe(750_000_000);
    expect(percentResult.displayAmount).toBe(
      botModule.wallet.formatTokenBalance(750_000_000, 6)
    );

    const maxResult = botModule.__test_presentSpendAmount({
      amount: "max",
      assetTicker: "TIMBA",
      decimals: 6,
      solBalance,
      tokenBalance,
      formatSol: (lamports: number) => botModule.wallet.formatSolBalance(lamports),
      formatToken: (value: number, decimals: number) =>
        botModule.wallet.formatTokenBalance(value, decimals),
    });

    expect(maxResult.rawAmount).toBe(1_500_000_000);
    expect(maxResult.displayAmount).toBe(
      botModule.wallet.formatTokenBalance(1_500_000_000, 6)
    );
  });

  test("presentSpendAmount throws when requested amount exceeds balance", () => {
    const tokenBalance = { balance: 1_000_000, decimals: 6 };
    const solBalance = 2 * LAMPORTS_PER_SOL;

    expect(() =>
      botModule.__test_presentSpendAmount({
        amount: "2",
        assetTicker: "TIMBA",
        decimals: 6,
        solBalance,
        tokenBalance,
        formatSol: (lamports: number) => botModule.wallet.formatSolBalance(lamports),
        formatToken: (value: number, decimals: number) =>
          botModule.wallet.formatTokenBalance(value, decimals),
      })
    ).toThrow("Insufficient token balance");
  });

  test("formatTradeConfirmationSummary renders output with token decimals", () => {
    const rawAmount = 21_713_000; // 0.021713 SOL
    const quote = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputAmount: rawAmount.toString(),
      inputAmountRaw: rawAmount.toString(),
      outputAmount: "455090146672",
      estimatedRate: 0,
      slippage: 1,
      provider: "jupiter" as const,
    };

    const summary = botModule.__test_formatTradeConfirmationSummary({
      payToken: "SOL",
      payDisplay: botModule.wallet.formatSolBalance(rawAmount),
      payRawAmount: rawAmount,
      payDecimals: 9,
      receiveToken: "TIMBA",
      receiveDecimals: 6,
      quote,
      contractAddress: quote.outputMint,
    });

    expectTradeSummaryBasics(summary, {
      payDisplay: botModule.wallet.formatSolBalance(rawAmount),
      payToken: "SOL",
      receiveDisplay: "455090.146672",
      receiveToken: "TIMBA",
      providerLabel: "Jupiter",
      rateDisplay: "20959339.8734",
      slippageText: "1.0%",
      contractAddress: quote.outputMint,
    });
  });

  test("formatTradeConfirmationSummary labels Jupiter routes and defaults slippage", () => {
    const rawAmount = 500_000_000; // 0.5 SOL
    const quote = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputAmount: rawAmount.toString(),
      inputAmountRaw: rawAmount.toString(),
      outputAmount: "45",
      estimatedRate: 90,
      slippage: undefined as any,
      provider: "jupiter" as const,
    };

    const summary = botModule.__test_formatTradeConfirmationSummary({
      payToken: "SOL",
      payDisplay: botModule.wallet.formatSolBalance(rawAmount),
      payRawAmount: rawAmount,
      payDecimals: 9,
      receiveToken: "USDC",
      receiveDecimals: 6,
      quote,
    });

    expectTradeSummaryBasics(summary, {
      payDisplay: botModule.wallet.formatSolBalance(rawAmount),
      payToken: "SOL",
      receiveDisplay: "0.000045",
      receiveToken: "USDC",
      providerLabel: "Jupiter",
      rateDisplay: "0.00009",
      slippageText: "1.0%",
    });
  });

  test("formatTradeConfirmationSummary handles swap to SOL", () => {
    const rawAmount = 250_000; // 0.25 tokens with 6 decimals
    const quote = {
      inputMint: "TokenMint",
      outputMint: "So11111111111111111111111111111111111111112",
      inputAmount: rawAmount.toString(),
      inputAmountRaw: rawAmount.toString(),
      outputAmount: "137500", // assume 0.1375 SOL (5 decimals?)
      estimatedRate: 0.55,
      slippage: 1,
      provider: "jupiter" as const,
    };

    const summary = botModule.__test_formatTradeConfirmationSummary({
      payToken: "FOO",
      payDisplay: botModule.wallet.formatTokenBalance(rawAmount, 6),
      payRawAmount: rawAmount,
      payDecimals: 6,
      receiveToken: "SOL",
      receiveDecimals: 9,
      quote,
    });

    expectTradeSummaryBasics(summary, {
      payDisplay: botModule.wallet.formatTokenBalance(rawAmount, 6),
      payToken: "FOO",
      receiveDisplay: botModule.wallet.formatSolBalance(Number(quote.outputAmount)),
      receiveToken: "SOL",
      providerLabel: "Jupiter",
      rateDisplay: "0.00055",
      slippageText: "1.0%",
    });
  });

  test("formatTradeConfirmationSummary escapes dynamic fields for HTML output", () => {
    const rawAmount = 100_000;
    const quote = {
      inputMint: "InMint",
      outputMint: "OutMint",
      inputAmount: rawAmount.toString(),
      inputAmountRaw: rawAmount.toString(),
      outputAmount: "250000",
      estimatedRate: 0,
      slippage: 1,
      provider: "jupiter" as const,
    };

    const summary = botModule.__test_formatTradeConfirmationSummary({
      payToken: "<SOL>",
      payDisplay: "<0.1>",
      payRawAmount: rawAmount,
      payDecimals: 9,
      receiveToken: "TIMBA & Co",
      receiveDecimals: 6,
      quote,
      contractAddress: "Mint<unsafe>",
    });

    expect(summary.message).not.toContain("<SOL>");
    expect(summary.message).not.toContain("TIMBA & Co");
    expect(summary.message).toContain("&lt;SOL&gt;");
    expect(summary.message).toContain("TIMBA &amp; Co");
    expect(summary.message).toContain("Mint&lt;unsafe&gt;");
  });

  test("parseOracleNumeric returns null for values above Number.MAX_SAFE_INTEGER", () => {
  const hugeResult = botModule.__test_parseOracleNumeric(2n ** 60n);
    expect(hugeResult).toBeNull();
  });

  test("validateAndProcessTransaction requires native SOL for withdraw-all flow", async () => {
    const original = {
      getKeyPair: botModule.wallet.getKeyPair,
      getTokenBalance: botModule.wallet.getTokenBalance,
      getBalance: botModule.wallet.getBalance,
      getTokenMetadata: botModule.wallet.getTokenMetadata,
      formatSolBalance: botModule.wallet.formatSolBalance,
      formatTokenBalance: botModule.wallet.formatTokenBalance,
    };

    const solBalance = 1_000_000_000;
    const wsolBalance = 2_000_000_000;
    const totalLamports = solBalance + wsolBalance;

    try {
      botModule.wallet.getKeyPair = (() => ({
        publicKey: { toBase58: () => "test-player" },
      })) as any;
      botModule.wallet.getTokenBalance = (async (
        _telegramId: bigint,
        mint: string
      ) => (mint === WSOL_MINT ? wsolBalance : 0)) as any;
      botModule.wallet.getBalance = (async () => solBalance) as any;
      botModule.wallet.getTokenMetadata = (async () => ({ decimals: 9 })) as any;
      botModule.wallet.formatSolBalance = ((lamports: number) =>
        `${lamports / 1_000_000_000} SOL`) as any;
      botModule.wallet.formatTokenBalance = ((amount: number) =>
        `${amount / 1_000_000_000}`) as any;

      const replies: string[] = [];
      const edits: string[] = [];
      const ctx: any = {
        chat: { id: 42 },
        message: { message_id: 7 },
        reply: async (text: string) => {
          replies.push(text);
          return { message_id: 999 };
        },
        api: {
          editMessageText: async (_chatId: number, _msgId: number, text: string) => {
            edits.push(text);
          },
        },
      };

      let transactionCalls = 0;
      await botModule.__test_validateAndProcessTransaction(
        ctx,
        123n,
        totalLamports,
        true,
        "SOL withdrawal",
        async () => {
          transactionCalls += 1;
          return "sig-123";
        }
      );

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Not enough SOL");
      expect(replies[0]).not.toContain("unwrap WSOL");
      expect(transactionCalls).toBe(0);
      expect(edits).toHaveLength(0);
    } finally {
      botModule.wallet.getKeyPair = original.getKeyPair;
      botModule.wallet.getTokenBalance = original.getTokenBalance;
      botModule.wallet.getBalance = original.getBalance;
      botModule.wallet.getTokenMetadata = original.getTokenMetadata;
      botModule.wallet.formatSolBalance = original.formatSolBalance;
      botModule.wallet.formatTokenBalance = original.formatTokenBalance;
    }
  });

  test("buildSwapConfirmationKeyboard includes confirm and cancel actions", () => {
    const keyboard = botModule.__test_buildSwapConfirmationKeyboard({
      txId: "tx_test",
      cancelCallback: "swap_to_SOL_TIMBA",
    });

    const callbacks = extractCallbacks(keyboard);
    expect(callbacks).toContain("confirm_swap_tx_test");
    expect(callbacks).toContain("swap_to_SOL_TIMBA");
    expect(callbacks.filter((cb) => cb?.startsWith("swap_slippage_")).length).toBe(0);

    const texts = extractTexts(keyboard);
    expect(texts).toContain("✅ Confirm Swap");
    expect(texts).toContain("❌ Cancel");
  });

  test("swap amount keyboard routes back to swap_from handler", () => {
    const keyboard = botModule.__test_createSwapAmountKeyboard({
      fromToken: "SOL",
      toTokenIdentifier: "TIMBA",
      canTrade: true,
    });

    const callbacks = extractCallbacks(keyboard);
    expect(callbacks).toContain("swap_amount_SOL_TIMBA_25%");
    expect(callbacks).toContain("swap_amount_SOL_TIMBA_50%");
    expect(callbacks).toContain("swap_amount_SOL_TIMBA_75%");
    expect(callbacks).toContain("swap_amount_SOL_TIMBA_MAX");
    expect(callbacks).toContain("swap_amount_SOL_TIMBA_CUSTOM");
    expect(callbacks).toContain("swap_from_SOL");

    const texts = extractTexts(keyboard);
    expect(texts).toContain("← Back");
  });

  test("swap amount keyboard shows insufficient state when balance is zero", () => {
    const keyboard = botModule.__test_createSwapAmountKeyboard({
      fromToken: "TIMBA",
      toTokenIdentifier: "SOL",
      canTrade: false,
    });

    const callbacks = extractCallbacks(keyboard);
    expect(callbacks).toContain("swap_from_TIMBA");
    expect(callbacks).not.toContain("swap_amount_TIMBA_SOL_25%");

    const texts = extractTexts(keyboard);
    expect(texts).toContain("❌ Insufficient balance");
    expect(texts).toContain("← Back");
  });
});

describe("createGameViaCommand helper", () => {
  beforeAll(async () => {
    await ensureBotModuleLoaded();
  });

  afterAll(() => {
    revertTestEnv();
  });
  const coinflipOptions: CreateGameViaCommandOptions = {
    gameType: "coinflip",
    usageMessage:
      "❌ Please provide a valid amount greater than 0.\n\nUsage: `/cf <amount>` or `/cf <amount> <maxPlayers>`",
    defaultMaxPlayers: 2,
    minPlayers: 2,
    getMaxPlayers: () => 100,
    timeoutSeconds: 60 * 60,
    gameLabel: "Coinflip",
    inferErrorLabel: "Coinflip",
    logPrefix: "🎮",
    errorMessage: "❌ Error creating coinflip game. Please try again.",
  };

    const baseParsedAmount = {
      amount: 1_000_000,
      tokenMint: "mint",
      tokenTicker: "TOK",
      isSol: false,
      formattedAmount: "1 TOK",
      decimals: 6,
      tokenWasSpecified: true,
      requestedNativeSol: false,
    };

  const formatWindowForTests = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) {
      return "recent window";
    }

    if (ms < 1_000) {
      const rounded = Math.ceil(ms);
      return `${rounded}ms`;
    }

    const seconds = Math.ceil(ms / 1_000);
    if (seconds < 60) {
      return `${seconds} second${seconds === 1 ? "" : "s"}`;
    }

    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) {
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }

    const hours = Math.ceil(minutes / 60);
    if (hours < 24) {
      return `${hours} hour${hours === 1 ? "" : "s"}`;
    }

    const days = Math.ceil(hours / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  };

  const makeDeps = (
    overrides: Partial<CreateGameViaCommandDeps> & {
      wallet?: Partial<CreateGameViaCommandDeps["wallet"]>;
      gameManager?: Partial<CreateGameViaCommandDeps["gameManager"]>;
    } = {}
  ): CreateGameViaCommandDeps => {
    const base: CreateGameViaCommandDeps = {
      parseAmount: async () => ({ success: true, data: baseParsedAmount }),
      inferMaxPlayers: () => ({ ok: true, value: 3, source: "default" }),
      wallet: {
        getTokenBalance: async () => 2_000_000,
        getTokenMetadata: async () => ({ decimals: 6 }),
        formatTokenBalance: (amount, decimals) =>
          (amount / Math.pow(10, decimals)).toString(),
        getBalance: async () => 0,
        formatSolBalance: () => "0",
      },
      getContractMinimumAmount: async () => ({
        raw: 500_000,
        formatted: 0.5,
        decimals: 6,
      }),
      gameManager: {
        createGame: async () => ({
          success: true,
          gameAddress: "ADDR",
          autoJoinResult: { success: true },
        }),
        createGameMessage: async () => 0,
      },
    };

    return {
      ...base,
      ...overrides,
      wallet: { ...base.wallet, ...overrides.wallet },
      gameManager: { ...base.gameManager, ...overrides.gameManager },
    };
  };

  const makeCtx = () => {
    const calls: any[] = [];
    const deletedMessages: { chatId: number; messageId: number }[] = [];
    let nextMessageId = 1;

    return {
      chat: { id: 42, type: "group" },
      from: { id: 1, username: "alice", first_name: "Alice" },
      reply: async (text: string) => {
        calls.push(text);
        return { ok: true, chat: { id: 42 }, message_id: nextMessageId++ };
      },
      api: {
        deleteMessage: async (chatId: number, messageId: number) => {
          deletedMessages.push({ chatId, messageId });
          return true;
        },
      },
      __calls: calls,
      __deleted: deletedMessages,
    };
  };

  test("returns usage guidance when amount parsing fails", async () => {
    const ctx: any = makeCtx();
    const deps = makeDeps({
      parseAmount: async () => ({ success: false, error: "invalid_amount" }),
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "oops"],
      1n,
      coinflipOptions,
      deps
    );

    expect(ctx.__calls.length).toBe(2);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    expect(String(ctx.__calls[1])).toContain("Usage");
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("surfaces player count validation failures", async () => {
    const ctx: any = makeCtx();
    const deps = makeDeps({
      inferMaxPlayers: () => ({ ok: false, error: "players must be between 2-100" }),
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "5"],
      1n,
      coinflipOptions,
      deps
    );

    expect(ctx.__calls.length).toBe(2);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    expect(String(ctx.__calls[1])).toContain("Coinflip players must be between 2-100");
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("creates a game and message when inputs are valid", async () => {
    const ctx: any = makeCtx();
    const createCalls: any[] = [];
    const messageCalls: any[] = [];

    const deps = makeDeps({
      gameManager: {
        createGame: async (...args) => {
          createCalls.push(args);
          return { success: true, gameAddress: "ADDR", autoJoinResult: { success: true } };
        },
        createGameMessage: async (...args) => {
          messageCalls.push(args);
          return 99;
        },
      },
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "5"],
      1n,
      coinflipOptions,
      deps
    );

    expect(ctx.__calls.length).toBe(1);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    expect(createCalls.length).toBe(1);

      const [
        gameType,
        gameData,
        maxPlayers,
        minPlayers,
        timeout,
        telegramId,
        optionsArg,
        chatId,
        requestTimestamp,
      ] = createCalls[0];
    expect(gameType).toBe("coinflip");
    expect(gameData).toEqual({
      amount: baseParsedAmount.amount,
      tokenMint: baseParsedAmount.tokenMint,
      tokenTicker: baseParsedAmount.tokenTicker,
      isSol: baseParsedAmount.isSol,
      requestedNativeSol: baseParsedAmount.requestedNativeSol,
    });
      expect(maxPlayers).toBe(3);
      expect(minPlayers).toBe(coinflipOptions.minPlayers);
      expect(timeout).toBe(coinflipOptions.timeoutSeconds);
      expect(telegramId).toBe(1n);
      expect(optionsArg).toEqual({ isPrivate: true });
      expect(chatId).toBe(ctx.chat.id);
      expect(requestTimestamp).toBeUndefined();

    expect(messageCalls.length).toBe(1);
    const messageArgs = messageCalls[0];
    expect(messageArgs[2]).toBe(coinflipOptions.gameLabel);
    expect(messageArgs[3]).toBe(baseParsedAmount.amount);
    expect(messageArgs[5]).toBe(baseParsedAmount.tokenTicker);
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("handles USD token hints while inferring max players", async () => {
    const ctx: any = makeCtx();
    const inferCalls: any[] = [];
    const createCalls: any[] = [];

    const deps = makeDeps({
      parseAmount: async () => ({
        success: true,
        data: { ...baseParsedAmount, tokenWasSpecified: true, formattedAmount: "24 TOK" },
      }),
      inferMaxPlayers: (args, amountIndex, tokenSpecified, defaultMax, minPlayers, maxPlayers) => {
        inferCalls.push({ args, amountIndex, tokenSpecified, defaultMax, minPlayers, maxPlayers });
        return { ok: true, value: 4, source: "arg" };
      },
      gameManager: {
        createGame: async (...args) => {
          createCalls.push(args);
          return { success: true, gameAddress: "ADDR", autoJoinResult: { success: true } };
        },
        createGameMessage: async () => 0,
      },
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "12", "USD", "4"],
      1n,
      coinflipOptions,
      deps
    );

    expect(inferCalls.length).toBe(1);
    expect(inferCalls[0].args).toEqual(["/cf", "12", "USD", "4"]);
    expect(inferCalls[0].tokenSpecified).toBe(true);
    expect(inferCalls[0].amountIndex).toBe(1);
    expect(inferCalls[0].defaultMax).toBe(coinflipOptions.defaultMaxPlayers);
    expect(createCalls.length).toBe(1);
  });

  test("relays active game limit failures from GameManager", async () => {
    const ctx: any = makeCtx();
    const limitMessage = `Active game limit reached. You currently have ${MAX_ACTIVE_GAMES_PER_CREATOR} active games (maximum ${MAX_ACTIVE_GAMES_PER_CREATOR}). Finish or cancel an existing game before creating a new one.`;
    const deps = makeDeps({
      gameManager: {
        createGame: async () => ({ success: false, error: limitMessage }),
        createGameMessage: async () => {
          throw new Error("should not send message when creation fails");
        },
      },
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "5"],
      1n,
      coinflipOptions,
      deps
    );

    expect(ctx.__calls.length).toBe(2);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    const response = String(ctx.__calls[1]);
    expect(response).toContain("Active game limit reached");
    expect(response).toContain("limit reached");
    expect(response).toContain(String(MAX_ACTIVE_GAMES_PER_CREATOR));
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("relays creation rate limit failures from GameManager", async () => {
    const ctx: any = makeCtx();
    const recentCount = MAX_GAMES_PER_CREATOR_WINDOW;
    const windowLabel = formatWindowForTests(GAME_CREATION_RATE_LIMIT_WINDOW_MS);
    const rateLimitMessage = `Game creation rate limit reached. You have created ${recentCount} games in the last ${windowLabel} (maximum ${MAX_GAMES_PER_CREATOR_WINDOW}). Please wait before creating a new game.`;
    const deps = makeDeps({
      gameManager: {
        createGame: async () => ({ success: false, error: rateLimitMessage }),
        createGameMessage: async () => {
          throw new Error("should not send message when creation fails");
        },
      },
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "5"],
      1n,
      coinflipOptions,
      deps
    );

    expect(ctx.__calls.length).toBe(2);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    const response = String(ctx.__calls[1]);
    expect(response).toContain("Game creation rate limit reached");
    expect(response.toLowerCase()).toContain("rate limit");
    expect(response).toContain(String(MAX_GAMES_PER_CREATOR_WINDOW));
    expect(response).toContain("Please wait");
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("allows SOL games when native balance covers deficit", async () => {
    const ctx: any = makeCtx();
    const createCalls: any[] = [];
    const messageCalls: any[] = [];

    const solAmount = 600_000;
    const deps = makeDeps({
      parseAmount: async () => ({
        success: true,
        data: {
          ...baseParsedAmount,
          amount: solAmount,
          tokenMint: WSOL_MINT,
          tokenTicker: "SOL",
          formattedAmount: "0.0006 SOL",
          decimals: 9,
          requestedNativeSol: true,
        },
      }),
      wallet: {
        getTokenBalance: async () => 0,
        getTokenMetadata: async () => ({ decimals: 9 }),
        formatTokenBalance: (amount, decimals) =>
          (amount / Math.pow(10, decimals)).toString(),
        getBalance: async () => 1_500_000,
        formatSolBalance: (lamports) => (lamports / LAMPORTS_PER_SOL).toString(),
      },
      gameManager: {
        createGame: async (...args) => {
          createCalls.push(args);
          return { success: true, gameAddress: "ADDR", autoJoinResult: { success: true } };
        },
        createGameMessage: async (...args) => {
          messageCalls.push(args);
          return 0;
        },
      },
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "0.0006", "SOL"],
      1n,
      coinflipOptions,
      deps
    );

    expect(ctx.__calls.length).toBe(1);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    expect(createCalls.length).toBe(1);
    expect(messageCalls.length).toBe(1);

    const [, gameData] = createCalls[0];
    expect(gameData.tokenTicker).toBe("WSOL");

    const [, , , , , messageTokenTicker] = messageCalls[0];
    expect(messageTokenTicker).toBe("WSOL");
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("allows WSOL games when user specifies token explicitly", async () => {
    const ctx: any = makeCtx();
    const createCalls: any[] = [];
    const messageCalls: any[] = [];
    let balanceChecks = 0;

    const solAmount = 600_000;
    const deps = makeDeps({
      parseAmount: async () => ({
        success: true,
        data: {
          ...baseParsedAmount,
          amount: solAmount,
          tokenMint: WSOL_MINT,
          tokenTicker: "WSOL",
          formattedAmount: "0.0006 WSOL",
          decimals: 9,
          requestedNativeSol: false,
          tokenWasSpecified: true,
        },
      }),
      wallet: {
        getTokenBalance: async () => 0,
        getTokenMetadata: async () => ({ decimals: 9 }),
        formatTokenBalance: (amount, decimals) =>
          (amount / Math.pow(10, decimals)).toString(),
        getBalance: async () => {
          balanceChecks += 1;
          return 1_500_000;
        },
        formatSolBalance: (lamports) => (lamports / LAMPORTS_PER_SOL).toString(),
      },
      gameManager: {
        createGame: async (...args) => {
          createCalls.push(args);
          return { success: true, gameAddress: "ADDR", autoJoinResult: { success: true } };
        },
        createGameMessage: async (...args) => {
          messageCalls.push(args);
          return 0;
        },
      },
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "0.0006", "WSOL"],
      1n,
      coinflipOptions,
      deps
    );

    expect(ctx.__calls.length).toBe(1);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    expect(createCalls.length).toBe(1);
    expect(messageCalls.length).toBe(1);
    expect(balanceChecks).toBeGreaterThan(0);

    const [, gameData] = createCalls[0];
    expect(gameData.tokenTicker).toBe("WSOL");
    const [, , , , , messageTokenTicker] = messageCalls[0];
    expect(messageTokenTicker).toBe("WSOL");
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("reports combined SOL balance when insufficient for native SOL games", async () => {
    const ctx: any = makeCtx();
    const createCalls: any[] = [];
    const solAmount = 500_000;

    const deps = makeDeps({
      parseAmount: async () => ({
        success: true,
        data: {
          ...baseParsedAmount,
          amount: solAmount,
          tokenMint: WSOL_MINT,
          tokenTicker: "SOL",
          formattedAmount: "0.0005 SOL",
          decimals: 9,
          requestedNativeSol: true,
        },
      }),
      wallet: {
        getTokenBalance: async () => 100_000,
        getTokenMetadata: async () => ({ decimals: 9 }),
        formatTokenBalance: (amount, decimals) =>
          (amount / Math.pow(10, decimals)).toFixed(6),
        getBalance: async () => 200_000,
        formatSolBalance: (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(6),
      },
      gameManager: {
        createGame: async (...args) => {
          createCalls.push(args);
          return { success: true, gameAddress: "ADDR", autoJoinResult: { success: true } };
        },
        createGameMessage: async () => 0,
      },
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "0.0005", "SOL"],
      1n,
      coinflipOptions,
      deps
    );

    expect(createCalls.length).toBe(0);
    expect(ctx.__calls.length).toBe(2);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    const response = String(ctx.__calls[1]);
    expect(response).toContain("Not enough SOL or wrapped SOL");
    expect(response).not.toContain("You have");
    expect(response).not.toContain("but the game needs");
    expect(response).toContain("Add more SOL or wrapped SOL and try again.");
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("reports combined SOL balance when WSOL specified but insufficient", async () => {
    const ctx: any = makeCtx();
    const solAmount = 600_000;

    const deps = makeDeps({
      parseAmount: async () => ({
        success: true,
        data: {
          ...baseParsedAmount,
          amount: solAmount,
          tokenMint: WSOL_MINT,
          tokenTicker: "WSOL",
          formattedAmount: "0.0006 WSOL",
          decimals: 9,
          requestedNativeSol: false,
          tokenWasSpecified: true,
        },
      }),
      wallet: {
        getTokenBalance: async () => 150_000,
        getTokenMetadata: async () => ({ decimals: 9 }),
        formatTokenBalance: (amount, decimals) =>
          (amount / Math.pow(10, decimals)).toFixed(6),
        getBalance: async () => 200_000,
        formatSolBalance: (lamports) => (lamports / LAMPORTS_PER_SOL).toFixed(6),
      },
    });

    await botModule.__test_createGameViaCommand(
      ctx,
      ["/cf", "0.0004", "WSOL"],
      1n,
      coinflipOptions,
      deps
    );

    expect(ctx.__calls.length).toBe(2);
    expect(ctx.__calls[0]).toBe("⏳ Creating game...");
    const response = String(ctx.__calls[1]);
    expect(response).toContain("Not enough SOL or wrapped SOL");
    expect(response).toContain("Add more SOL or wrapped SOL and try again.");
    expect(response).not.toContain("You have");
    expect(ctx.__deleted?.length).toBe(1);
  });

  test("creates a private game when chat setting is private", async () => {
    const ctx: any = makeCtx();
    const createCalls: any[] = [];

    const moduleDeps = {
      getChatGameSettings: () => ({ coinflip_default_privacy: "private" }),
      getOracleMaxPlayers: () => 100,
      parseAmount: () => {},
      inferMaxPlayers: () => {},
      wallet: {},
      getContractMinimumAmount: () => {},
      gameManager: {},
      isGroupChat: () => true,
      startInteractiveGameSetup: () => {},
      resolveCommandTokenOverride: () => {},
      getRequiredTelegramIdForContext: () => {},
      gameSetupCopy: { coinflip: {}, giveaway: {} },
    } as any;

    const module = createGameCommandsModule(moduleDeps);

    const deps = makeDeps({
      gameManager: {
        createGame: async (...args) => {
          createCalls.push(args);
          return {
            success: true,
            gameAddress: "ADDR",
            autoJoinResult: { success: true },
          };
        },
        createGameMessage: async () => 99,
      },
    });

    await module.createGameViaCommand(
      ctx,
      ["/cf", "5"],
      1n,
      module.COINFLIP_COMMAND_OPTIONS,
      deps
    );

    expect(createCalls.length).toBe(1);
    const optionsArg = createCalls[0][6];
    expect(optionsArg).toEqual({ isPrivate: true });
  });

  test("creates a public game when chat setting is public", async () => {
    const ctx: any = makeCtx();
    const createCalls: any[] = [];

    const moduleDeps = {
      getChatGameSettings: () => ({ coinflip_default_privacy: "public" }),
      getOracleMaxPlayers: () => 100,
      parseAmount: () => {},
      inferMaxPlayers: () => {},
      wallet: {},
      getContractMinimumAmount: () => {},
      gameManager: {},
      isGroupChat: () => true,
      startInteractiveGameSetup: () => {},
      resolveCommandTokenOverride: () => {},
      getRequiredTelegramIdForContext: () => {},
      gameSetupCopy: { coinflip: {}, giveaway: {} },
    } as any;

    const module = createGameCommandsModule(moduleDeps);

    const deps = makeDeps({
      gameManager: {
        createGame: async (...args) => {
          createCalls.push(args);
          return {
            success: true,
            gameAddress: "ADDR",
            autoJoinResult: { success: true },
          };
        },
        createGameMessage: async () => 99,
      },
    });

    await module.createGameViaCommand(
      ctx,
      ["/cf", "5"],
      1n,
      module.COINFLIP_COMMAND_OPTIONS,
      deps
    );

    expect(createCalls.length).toBe(1);
    const optionsArg = createCalls[0][6];
    expect(optionsArg).toEqual({ isPrivate: false });
  });
});
