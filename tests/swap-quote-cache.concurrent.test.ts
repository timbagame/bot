import { test, expect } from "bun:test";
import { SwapQuoteCache } from "../src/utils/swap/quote-cache";

test("SwapQuoteCache deduplicates concurrent loaders", async () => {
  const cache = new SwapQuoteCache({ ttlMs: 100 });
  let loadCount = 0;

  const loader = async () => {
    loadCount++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
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
  };

  const params = {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    amount: "1000",
  };

  const [first, second] = await Promise.all([
    cache.getJupiterQuote(params, loader),
    cache.getJupiterQuote(params, loader),
  ]);

  expect(loadCount).toBe(1);
  expect(first).toEqual(second);
});
