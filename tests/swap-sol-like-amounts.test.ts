import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InlineKeyboard } from "grammy";

import { WSOL_MINT } from "../src/utils/token-registry";
const botModule = await import("../src/bot");

const TELEGRAM_ID = 12345n;

const ctx: any = {
  from: { id: Number(TELEGRAM_ID) },
  chat: { id: 999 },
  api: {
    editMessageText: async () => {
      /* noop */
    },
    editMessageCaption: async () => {
      /* noop */
    },
    editMessageReplyMarkup: async () => {
      /* noop */
    },
  },
};

describe("SOL-like swap amount resolution", () => {
  let originalSwapService: any;

  beforeEach(() => {
    botModule.__test_resetPrepareTokenTradeQuote();
    botModule.__test_resetPresentSpendAmount();
    botModule.__test_clearTransactionCache();
    botModule.__test_clearWalletCache(TELEGRAM_ID);

    originalSwapService = botModule.__test_getSwapService?.();
    botModule.__test_setSwapService({
      prepareSwap: async () => ({ outputAmount: "0", slippage: 0 } as any),
      execute: async () => "sig",
    } as any);
  });

  afterEach(() => {
    botModule.__test_resetPrepareTokenTradeQuote();
    botModule.__test_resetPresentSpendAmount();
    botModule.__test_clearTransactionCache();
    botModule.__test_clearWalletCache(TELEGRAM_ID);

    if (originalSwapService) {
      botModule.__test_setSwapService(originalSwapService);
    }
  });

  test("uses native SOL only for SOL swap spend and fee checks", async () => {
    const presentCalls: any[] = [];

    botModule.__test_setPresentSpendAmount((params: any) => {
      presentCalls.push(params);
      throw new Error("present-stop");
    });

    botModule.__test_setWalletCache(TELEGRAM_ID, {
      solBalance: 200_000_000,
      nativeSolBalance: 200_000_000,
      wsolBalance: 1_000_000_000,
      tokenBalances: [],
    });

    await expect(
      botModule.__test_prepareTokenTradeQuote({
        ctx,
        telegramId: TELEGRAM_ID,
        amountInput: "max",
      inputFactory: () => ({
        ticker: "SOL",
        mint: "So11111111111111111111111111111111111111112",
        decimals: 9,
        applySolFeeBuffer: true,
        metadata: { selectedTicker: "SOL" },
      }),
      outputFactory: () => ({
        ticker: "USDC",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
      }),
      spinnerText: () => "spinner",
      cacheQuote: () => {
        /* noop */
      },
        buildConfirmationKeyboard: () => new InlineKeyboard(),
        onError: () => {
          throw new Error("unexpected error");
        },
      } as any)
    ).rejects.toThrow("present-stop");

    expect(presentCalls).not.toHaveLength(0);
    for (const call of presentCalls) {
      expect(call.assetTicker).toBe("SOL");
      expect(call.solBalance).toBe(200_000_000);
      expect(call.solFeePayerBalance).toBe(200_000_000);
    }

  });

  test("routes WSOL inputs through WSOL balances when ticker is normalized", async () => {
    const presentCalls: any[] = [];

    botModule.__test_setPresentSpendAmount((params: any) => {
      presentCalls.push(params);
      throw new Error("present-stop");
    });

    botModule.__test_setWalletCache(TELEGRAM_ID, {
      solBalance: 0,
      nativeSolBalance: 0,
      wsolBalance: 1_200_000_000,
      tokenBalances: [
        {
          ticker: "WSOL",
          balance: 1_200_000_000,
          decimals: 9,
          mint: WSOL_MINT,
        },
      ],
    });

    await expect(
      botModule.__test_prepareTokenTradeQuote({
        ctx,
        telegramId: TELEGRAM_ID,
        amountInput: "max",
      inputFactory: () => ({
        ticker: "SOL",
        mint: WSOL_MINT,
        decimals: 9,
        tokenBalance: { balance: 1_200_000_000, decimals: 9 },
        applySolFeeBuffer: true,
        metadata: { selectedTicker: "WSOL" },
      }),
      outputFactory: () => ({
        ticker: "SOL",
        mint: "So11111111111111111111111111111111111111112",
        decimals: 9,
      }),
      spinnerText: () => "spinner",
      cacheQuote: () => {
        /* noop */
      },
        buildConfirmationKeyboard: () => new InlineKeyboard(),
        onError: () => {
          throw new Error("unexpected error");
        },
      } as any)
    ).rejects.toThrow("present-stop");

    expect(presentCalls).not.toHaveLength(0);
    for (const call of presentCalls) {
      expect(call.assetTicker).toBe("WSOL");
      expect(call.tokenBalance?.balance).toBe(1_200_000_000);
      expect(call.solBalance).toBe(0);
      expect(call.solFeePayerBalance).toBe(0);
    }

  });
});
