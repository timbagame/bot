import { describe, test, expect } from "bun:test";
import { SwapQuoteCache } from "../src/utils/swap/quote-cache";
import type { JupiterQuoteRequest, JupiterQuoteResponse } from "../src/utils/jupiter";

const makeJupiterParams = (overrides: Partial<JupiterQuoteRequest> = {}): JupiterQuoteRequest => ({
  inputMint: "MintA",
  outputMint: "MintB",
  amount: "1000",
  slippageBps: 50,
  ...overrides,
});

const makeJupiterQuote = (
  request: JupiterQuoteRequest,
  overrides: Partial<JupiterQuoteResponse> = {}
): JupiterQuoteResponse => ({
  inputMint: request.inputMint,
  inAmount: request.amount,
  outputMint: request.outputMint,
  outAmount: "2000",
  otherAmountThreshold: "0",
  swapMode: "ExactIn",
  slippageBps: request.slippageBps ?? 0,
  priceImpactPct: "0",
  routePlan: [],
  totalTime: 0,
  platformFee: null,
  ...overrides,
});

describe("SwapQuoteCache", () => {
  test("coalesces concurrent Jupiter quote requests", async () => {
    const cache = new SwapQuoteCache({ ttlMs: 5_000 });
    const params = makeJupiterParams();

    let loaderCalls = 0;
    const loader = async () => {
      loaderCalls += 1;
      return makeJupiterQuote(params);
    };

    const [first, second] = await Promise.all([
      cache.getJupiterQuote(params, loader),
      cache.getJupiterQuote(params, loader),
    ]);

    expect(loaderCalls).toBe(1);
    expect(first).toEqual(second);
  });

  test("resets pending Jupiter quote after rejection", async () => {
    const cache = new SwapQuoteCache({ ttlMs: 5_000 });
    const params = makeJupiterParams({ amount: "2500" });

    let loaderCalls = 0;

    await expect(
      cache.getJupiterQuote(params, async () => {
        loaderCalls += 1;
        throw new Error("quote unavailable");
      })
    ).rejects.toThrow("quote unavailable");

    const resolved = await cache.getJupiterQuote(params, async () => {
      loaderCalls += 1;
      return makeJupiterQuote(params, { outAmount: "3000" });
    });

    expect(loaderCalls).toBe(2);
    expect(resolved.outAmount).toBe("3000");
  });
});
