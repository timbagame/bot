import { describe, expect, test } from "bun:test";
import { SwapQuoteCache } from "../src/utils/swap/quote-cache";

describe("SwapQuoteCache concurrency", () => {
  test("reuses pending Jupiter loader when called simultaneously", async () => {
    const cache = new SwapQuoteCache({ ttlMs: 10000 });
    let invocationCount = 0;

    const loader = async () => {
      invocationCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        inputMint: "A",
        outputMint: "B",
        inAmount: "123",
        outAmount: "456",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 50,
        priceImpactPct: "0",
        routePlan: [],
      };
    };

    const requests = Array.from({ length: 4 }, () =>
      cache.getJupiterQuote(
        {
          inputMint: "A",
          outputMint: "B",
          amount: "1000",
        },
        loader
      )
    );

    const responses = await Promise.all(requests);
    expect(responses.every((r) => r.outAmount === "456")).toBe(true);
    expect(invocationCount).toBe(1);
  });
});
