import { beforeEach, describe, expect, test } from "bun:test";
import {
  TradeSession,
  __test_transactionCache,
  __test_persistTradeSession,
  __test_getCachedTradeSession,
  __test_handleTradeCustomSlippageInput,
  __test_setSwapManager,
} from "../src/bot";

class StubSwapManager {
  public lastArgs: any = null;

  async getQuote(args: any) {
    this.lastArgs = args;
    return {
      provider: "pump-fun",
      estimatedRate: 1.2345,
      slippage: 3.5,
      outputAmount: "4200",
      inputAmount: args.amount,
      inputMint: args.inputMint,
      outputMint: args.outputMint,
    };
  }

  formatQuoteForDisplay() {
    return "stub quote";
  }
}

describe("trade session slippage", () => {
  beforeEach(() => {
    __test_transactionCache.clear();
    __test_setSwapManager(new StubSwapManager() as any);
  });

  test("custom slippage input updates cached session", async () => {
    const txId = "tx123";
    const session: TradeSession = {
      side: "buy",
      fromToken: "SOL",
      toToken: "TOKEN",
      amount: "1",
      rawAmount: "1000000000",
      fromTokenInfo: { token_mint: "mint_sol", decimals: 9 },
      toTokenInfo: { token_mint: "mint_token", decimals: 6 },
      quote: {
        provider: "pump-fun",
        estimatedRate: 1,
        slippage: 1,
        outputAmount: "100",
        inputAmount: "1000000000",
        inputMint: "mint_sol",
        outputMint: "mint_token",
      },
      userKeypair: {} as any,
      slippagePercent: 1,
      contractAddress: "mint_token",
      backCallback: "cmd_buy",
      cancelCallback: "buy_with_SOL",
    };

    __test_persistTradeSession(txId, session);

    const ctx = {
      chat: { id: 1 },
      from: { id: 99 },
      api: {
        editMessageText: async () => {},
      },
    } as any;

    const userState = { txId, side: "buy", messageId: 42 };

    await __test_handleTradeCustomSlippageInput(ctx, userState, "3.5");

    const updated = __test_getCachedTradeSession(txId);
    expect(updated).toBeDefined();
    expect(updated?.slippagePercent).toBeCloseTo(3.5, 5);
  });
});
