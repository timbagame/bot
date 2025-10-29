import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const botModule = await import("../src/bot");

const TELEGRAM_ID = 987654321n;

describe("swap custom amount telegram id propagation", () => {
  beforeEach(() => {
    botModule.__test_resetPrepareTokenTradeQuote();
  });

  afterEach(() => {
    botModule.__test_resetPrepareTokenTradeQuote();
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
});
