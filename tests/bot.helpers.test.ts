import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LAMPORTS_PER_SOL, MIN_SOL_FOR_TX, WSOL_MINT } from "../src/utils/constants";
import { parseDecimalAmount } from "../src/utils/amount";

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

describe("Bot helper utilities", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "test-token";
    process.env.MNEMONIC =
      process.env.MNEMONIC || "test test test test test test test test test test test junk";
    process.env.SOLANA_NETWORK = process.env.SOLANA_NETWORK || "http://localhost:8899";

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
  });

  afterAll(() => {
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

  test("resolveSpendAmount handles percentage-based SOL spend", () => {
    const buffer = Math.ceil(MIN_SOL_FOR_TX * LAMPORTS_PER_SOL);
    const solBalance = buffer * 5;

    const { rawAmount, displayAmount } = botModule.__test_resolveSpendAmount({
      amount: "25%",
      assetTicker: "SOL",
      inputDecimals: 9,
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

  test("resolveSpendAmount handles token percentage and max paths", () => {
    const tokenBalance = { balance: 1_500_000_000, decimals: 6 };
    const solBalance = 10 * LAMPORTS_PER_SOL;

    const percentResult = botModule.__test_resolveSpendAmount({
      amount: "50%",
      assetTicker: "TIMBA",
      inputDecimals: 6,
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

    const maxResult = botModule.__test_resolveSpendAmount({
      amount: "max",
      assetTicker: "TIMBA",
      inputDecimals: 6,
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

  test("resolveSpendAmount throws when requested amount exceeds balance", () => {
    const tokenBalance = { balance: 1_000_000, decimals: 6 };
    const solBalance = 2 * LAMPORTS_PER_SOL;

    expect(() =>
      botModule.__test_resolveSpendAmount({
        amount: "2",
        assetTicker: "TIMBA",
        inputDecimals: 6,
        solBalance,
        tokenBalance,
        formatSol: (lamports: number) => botModule.wallet.formatSolBalance(lamports),
        formatToken: (value: number, decimals: number) =>
          botModule.wallet.formatTokenBalance(value, decimals),
      })
    ).toThrow("Insufficient token balance");
  });

  test("formatTradeConfirmationSummary renders pump.fun output with token decimals", () => {
    const rawAmount = 21_713_000; // 0.021713 SOL
    const quote = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      inputAmount: rawAmount.toString(),
      outputAmount: "455090146672",
      estimatedRate: 0,
      slippage: 1,
      provider: "pump-fun" as const,
    };

    const summary = botModule.__test_formatTradeConfirmationSummary({
      kind: "buy",
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
      providerLabel: "pump-fun (ungraduated)",
      rateDisplay: "20959339.8734",
      slippageText: "1.0%",
      contractAddress: quote.outputMint,
    });
    expect(summary.message).toContain("Pump.fun Token");
  });

  test("formatTradeConfirmationSummary labels Jupiter routes and defaults slippage", () => {
    const rawAmount = 500_000_000; // 0.5 SOL
    const quote = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputAmount: rawAmount.toString(),
      outputAmount: "45",
      estimatedRate: 90,
      slippage: undefined as any,
      provider: "jupiter" as const,
    };

    const summary = botModule.__test_formatTradeConfirmationSummary({
      kind: "buy",
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
      providerLabel: "jupiter (graduated)",
      rateDisplay: "0.00009",
      slippageText: "1.0%",
    });
  });

  test("formatTradeConfirmationSummary handles sell paths", () => {
    const rawAmount = 250_000; // 0.25 tokens with 6 decimals
    const quote = {
      inputMint: "TokenMint",
      outputMint: "So11111111111111111111111111111111111111112",
      inputAmount: rawAmount.toString(),
      outputAmount: "137500", // assume 0.1375 SOL (5 decimals?)
      estimatedRate: 0.55,
      slippage: 1,
      provider: "jupiter" as const,
    };

    const summary = botModule.__test_formatTradeConfirmationSummary({
      kind: "sell",
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
      providerLabel: "jupiter (graduated)",
      rateDisplay: "0.00055",
      slippageText: "1.0%",
    });
  });
});

describe("createGameViaCommand helper", () => {
  const coinflipOptions: CreateGameViaCommandOptions = {
    gameType: "coinflip",
    usageMessage:
      "❌ Please provide a valid amount greater than 0.\n\nUsage: `/cf <amount>` or `/cf <amount> <maxPlayers>`",
    defaultMaxPlayers: 2,
    minPlayers: 2,
    maxPlayers: 100,
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
    tokenWasSpecified: true,
    requestedNativeSol: false,
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
    return {
      chat: { id: 42, type: "group" },
      from: { id: 1, username: "alice", first_name: "Alice" },
      reply: async (text: string) => {
        calls.push(text);
        return { ok: true };
      },
      __calls: calls,
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

    expect(ctx.__calls.length).toBe(1);
    expect(String(ctx.__calls[0])).toContain("Usage");
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

    expect(ctx.__calls.length).toBe(1);
    expect(String(ctx.__calls[0])).toContain("Coinflip players must be between 2-100");
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

    expect(ctx.__calls.length).toBe(0);
    expect(createCalls.length).toBe(1);

    const [gameType, gameData, maxPlayers, minPlayers, timeout, telegramId, chatId] =
      createCalls[0];
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
    expect(chatId).toBe(ctx.chat.id);

    expect(messageCalls.length).toBe(1);
    const messageArgs = messageCalls[0];
    expect(messageArgs[2]).toBe(coinflipOptions.gameLabel);
    expect(messageArgs[3]).toBe(baseParsedAmount.amount);
    expect(messageArgs[5]).toBe(baseParsedAmount.tokenTicker);
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

    expect(ctx.__calls.length).toBe(0);
    expect(createCalls.length).toBe(1);
    expect(messageCalls.length).toBe(1);

    const [, gameData] = createCalls[0];
    expect(gameData.tokenTicker).toBe("WSOL");

    const [, , , , , messageTokenTicker] = messageCalls[0];
    expect(messageTokenTicker).toBe("WSOL");
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
    expect(ctx.__calls.length).toBe(1);
    const response = String(ctx.__calls[0]);
    expect(response).toContain("SOL available natively");
    expect(response).toContain("wrapped SOL");
    expect(response).toContain("0.0005 SOL");
  });
});
