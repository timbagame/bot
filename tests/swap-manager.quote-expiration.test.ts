import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Connection, Keypair } from "#solana";
import {
  SwapManager,
  __test_setJupiterQuoteExpirationMs,
  __test_resetJupiterQuoteExpirationMs,
} from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

const quoteResponse = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  inAmount: "1000",
  outAmount: "2000",
  otherAmountThreshold: "0",
  swapMode: "ExactIn",
  slippageBps: 100,
  priceImpactPct: "0",
  routePlan: [],
};

describe("SwapManager quote expiration", () => {
  beforeEach(() => {
    __test_setJupiterQuoteExpirationMs(1);
  });

  afterEach(() => {
    __test_resetJupiterQuoteExpirationMs();
  });

  test("stale provider quote requires fresh user confirmation", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() },
    );
    const sm = new SwapManager(connection, wallet);
    (sm as any).createTokenAccountsIfNeeded = async () => [];

    let quoteFetchCount = 0;
    (sm as any).getJupiterQuote = async () => {
      quoteFetchCount++;
      return {
        ...quoteResponse,
        router: "test",
        priceImpactPct: "0",
      };
    };

    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
      requestId: "req-123",
    });
    (sm as any).executeJupiterTransaction = async () => "SIG";

    const quote = {
      inputMint: quoteResponse.inputMint,
      outputMint: quoteResponse.outputMint,
      inputAmount: quoteResponse.inAmount,
      inputAmountRaw: quoteResponse.inAmount,
      outputAmount: quoteResponse.outAmount,
      estimatedRate: 2,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: quoteResponse,
      providerQuoteTimestamp: Date.now() - 1000,
    };

    await expect(
      sm.executeJupiterSwap(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount,
          userKeypair: await Keypair.generate(),
          inputDecimals: 9,
          outputDecimals: 6,
          inputTicker: "SOL",
          outputTicker: "USDC",
        },
        quote,
      ),
    ).rejects.toThrow(/quote expired.*new quote/i);

    expect(quoteFetchCount).toBe(0);
  });
});
