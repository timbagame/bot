import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LAMPORTS_PER_SOL, MIN_SOL_FOR_TX } from "../src/utils/constants";

let botModule: typeof import("../src/bot");
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

  test("toRawAmount converts valid inputs", () => {
    const fromInteger = botModule.__test_toRawAmount("15", 2);
    const fromDecimal = botModule.__test_toRawAmount("0.5", 9);
    const fromLeadingDecimal = botModule.__test_toRawAmount(".75", 4);

    expect(fromInteger).toBe(1500);
    expect(fromDecimal).toBe(500_000_000);
    expect(fromLeadingDecimal).toBe(7500);
  });

  test("toRawAmount rejects invalid or unsafe values", () => {
    expect(() => botModule.__test_toRawAmount("abc", 2)).toThrow("Invalid amount format");
    expect(() => botModule.__test_toRawAmount("0", 2)).toThrow("greater than zero");
    expect(() => botModule.__test_toRawAmount("0.000", 3)).toThrow("greater than zero");
    expect(() => botModule.__test_toRawAmount("9007199254740993", 0)).toThrow("too large");
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

  test("calculateBuySpend handles percentage-based SOL spend", () => {
    const buffer = Math.ceil(MIN_SOL_FOR_TX * LAMPORTS_PER_SOL);
    const solBalance = buffer * 5;

    const { rawAmount, displayAmount } = botModule.__test_calculateBuySpend({
      amount: "25%",
      paymentToken: "SOL",
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

  test("calculateBuySpend handles token percentage and max paths", () => {
    const tokenBalance = { balance: 1_500_000_000, decimals: 6 };
    const solBalance = 10 * LAMPORTS_PER_SOL;

    const percentResult = botModule.__test_calculateBuySpend({
      amount: "50%",
      paymentToken: "TIMBA",
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

    const maxResult = botModule.__test_calculateBuySpend({
      amount: "max",
      paymentToken: "TIMBA",
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

  test("calculateBuySpend throws when requested amount exceeds balance", () => {
    const tokenBalance = { balance: 1_000_000, decimals: 6 };
    const solBalance = 2 * LAMPORTS_PER_SOL;

    expect(() =>
      botModule.__test_calculateBuySpend({
        amount: "2",
        paymentToken: "TIMBA",
        inputDecimals: 6,
        solBalance,
        tokenBalance,
        formatSol: (lamports: number) => botModule.wallet.formatSolBalance(lamports),
        formatToken: (value: number, decimals: number) =>
          botModule.wallet.formatTokenBalance(value, decimals),
      })
    ).toThrow("Insufficient token balance for this purchase");
  });

  test("formatBuyQuoteSummary renders pump.fun output with token decimals", () => {
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

    const summary = botModule.__test_formatBuyQuoteSummary({
      paymentToken: "SOL",
      targetToken: "TIMBA",
      displayAmount: botModule.wallet.formatSolBalance(rawAmount),
      rawAmount,
      inputDecimals: 9,
      outputDecimals: 6,
      quote,
      outputMint: quote.outputMint,
    });

    expect(summary.formattedReceiveAmount).toBe("455090.146672");
    expect(summary.rateDisplay).toBe("20959339.8734");
    expect(summary.providerLabel).toBe("pump-fun (ungraduated)");
    expect(summary.slippageText).toBe("1.0%");
    expect(summary.message).toContain("455090.146672 TIMBA");
    expect(summary.message).toContain("Rate:");
    expect(summary.message).toContain(quote.outputMint);
  });

  test("formatBuyQuoteSummary labels Jupiter routes and defaults slippage", () => {
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

    const summary = botModule.__test_formatBuyQuoteSummary({
      paymentToken: "SOL",
      targetToken: "USDC",
      displayAmount: botModule.wallet.formatSolBalance(rawAmount),
      rawAmount,
      inputDecimals: 9,
      outputDecimals: 6,
      quote,
      outputMint: quote.outputMint,
    });

    expect(summary.providerLabel).toBe("jupiter (graduated)");
    expect(summary.slippageText).toBe("1.0%");
    expect(summary.rateDisplay).toBe("0.00009");
    expect(summary.message).toContain("jupiter (graduated)");
  });
});
