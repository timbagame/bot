import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { WSOL_MINT } from "../src/utils/token-registry";

const botModule = await import("../src/bot");

const TELEGRAM_ID = 987654321n;

describe("swap custom amount telegram id propagation", () => {
  beforeEach(() => {
    botModule.__test_resetPrepareTokenTradeQuote();
    botModule.__test_clearTransactionCache();
    botModule.__test_clearWalletCache(TELEGRAM_ID);
  });

  afterEach(() => {
    botModule.__test_resetPrepareTokenTradeQuote();
    botModule.__test_clearTransactionCache();
    botModule.__test_clearWalletCache(TELEGRAM_ID);
  });

  test("handleSwapCustomAmountInput forwards the caller telegram id", async () => {
    const capturedIds: bigint[] = [];

    botModule.__test_setPrepareTokenTradeQuote(async (params) => {
      capturedIds.push(params.telegramId);
      return null as any;
    });

    botModule.__test_setWalletCache(TELEGRAM_ID, {
      solBalance: 5_000_000_000,
      tokenBalances: [],
    });

    const ctx: any = {
      from: { id: Number(TELEGRAM_ID) },
      chat: { id: 12345 },
      api: {
        editMessageText: async () => {
          /* noop for test */
        },
      },
    };

    const userState = {
      type: "swap_custom_amount" as const,
      fromToken: "SOL",
      toToken: "TIMBA",
      messageId: 111,
      chatId: ctx.chat.id,
    };

    await botModule.__test_handleSwapCustomAmountInput(ctx, userState, "1");

    expect(capturedIds).toEqual([TELEGRAM_ID]);
  });

  test("handleSwapCustomAmountInput uses session overrides for cached tokens", async () => {
    const tokenMint = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";
    const cacheKey = "xe1onx0clpo";
    const capturedOutputs: any[] = [];
    let capturedAmountInput: string | undefined;

    botModule.__test_setTransactionCacheEntry(cacheKey, {
      targetToken: "MAGAIBA",
      targetTokenAddress: tokenMint,
      paymentToken: "SOL",
      tokenMetadata: {
        symbol: "MAGAIBA",
        decimals: 8,
        verified: true,
      },
    });

    botModule.__test_setPrepareTokenTradeQuote(async (params) => {
      capturedAmountInput = params.amountInput;
      const snapshot = await botModule.__test_getCachedWalletData(TELEGRAM_ID);
      const context = { telegramId: TELEGRAM_ID, ...snapshot } as any;
      capturedOutputs.push(await params.outputFactory(context));
      return null as any;
    });

    botModule.__test_setWalletCache(TELEGRAM_ID, {
      solBalance: 5_000_000_000,
      tokenBalances: [],
    });

    const ctx: any = {
      from: { id: Number(TELEGRAM_ID) },
      chat: { id: 12345 },
      api: {
        editMessageText: async () => {
          /* noop */
        },
      },
    };

    const userState = {
      type: "swap_custom_amount" as const,
      fromToken: "SOL",
      toToken: cacheKey,
      toTokenDisplay: "MAGAIBA",
      toMintOverride: tokenMint,
      toDecimalsOverride: 8,
      messageId: 222,
      chatId: ctx.chat.id,
    };

    await botModule.__test_handleSwapCustomAmountInput(ctx, userState, "0.42");

    expect(capturedAmountInput).toBe("0.42");
    expect(capturedOutputs).toHaveLength(1);
    expect(capturedOutputs[0]).toMatchObject({
      ticker: "MAGAIBA",
      mint: tokenMint,
      decimals: 8,
    });
  });

  test("handleSwapCustomAmountInput rehydrates cached token metadata when overrides are missing", async () => {
    const tokenMint = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";
    const cacheKey = "sd8a1fhc6n";
    let capturedOutput: any;

    botModule.__test_setTransactionCacheEntry(cacheKey, {
      targetToken: "MAGAIBA",
      targetTokenAddress: tokenMint,
      paymentToken: "SOL",
      tokenMetadata: {
        symbol: "MAGAIBA",
        decimals: 8,
        verified: true,
      },
    });

    botModule.__test_setPrepareTokenTradeQuote(async (params) => {
      const snapshot = await botModule.__test_getCachedWalletData(TELEGRAM_ID);
      const context = { telegramId: TELEGRAM_ID, ...snapshot } as any;
      capturedOutput = await params.outputFactory(context);
      return null as any;
    });

    botModule.__test_setWalletCache(TELEGRAM_ID, {
      solBalance: 7_500_000_000,
      tokenBalances: [],
    });

    const ctx: any = {
      from: { id: Number(TELEGRAM_ID) },
      chat: { id: 67890 },
      api: {
        editMessageText: async () => {
          /* noop */
        },
      },
    };

    const userState = {
      type: "swap_custom_amount" as const,
      fromToken: "SOL",
      toToken: cacheKey,
      messageId: 333,
      chatId: ctx.chat.id,
    };

    await botModule.__test_handleSwapCustomAmountInput(ctx, userState, "1.5");

    expect(capturedOutput).toMatchObject({
      ticker: "MAGAIBA",
      mint: tokenMint,
      decimals: 8,
    });
  });

  test("handleSwapCustomAmountInput preserves WSOL selection balances", async () => {
    const capturedInputs: any[] = [];

    const originalTokenManager = botModule.__test_getTokenManager();
    botModule.__test_setTokenManager({
      resolveMintForTicker: async (ticker: string) =>
        ticker.trim().toUpperCase() === "WSOL"
          ? WSOL_MINT
          : "So11111111111111111111111111111111111111112",
    } as any);

    try {
      botModule.__test_setPrepareTokenTradeQuote(async (params) => {
        const snapshot = await botModule.__test_getCachedWalletData(TELEGRAM_ID);
        const context = { telegramId: TELEGRAM_ID, ...snapshot } as any;
        capturedInputs.push(await params.inputFactory(context));
        return null as any;
      });

      botModule.__test_setWalletCache(TELEGRAM_ID, {
        solBalance: 0,
        wsolBalance: 4_200_000_000,
        tokenBalances: [
          {
            mint: WSOL_MINT,
            ticker: "WSOL",
            balance: 4_200_000_000,
            decimals: 9,
          },
        ],
      });

      const ctx: any = {
        from: { id: Number(TELEGRAM_ID) },
        chat: { id: 24680 },
        api: {
          editMessageText: async () => {
            /* noop */
          },
          editMessageCaption: async () => {
            /* noop */
          },
        },
      };

      const userState = {
        type: "swap_custom_amount" as const,
        fromToken: "WSOL",
        fromTokenRaw: "WSOL",
        toToken: "SOL",
        toTokenRaw: "SOL",
        messageId: 555,
        chatId: ctx.chat.id,
      };

      await botModule.__test_handleSwapCustomAmountInput(ctx, userState, "1");

      expect(capturedInputs).toHaveLength(1);
      expect(capturedInputs[0]).toMatchObject({
        ticker: "WSOL",
        tokenBalance: { balance: 4_200_000_000, decimals: 9 },
        applySolFeeBuffer: false,
        metadata: { selectedTicker: "WSOL" },
      });
    } finally {
      botModule.__test_setTokenManager(originalTokenManager);
    }
  });
});
