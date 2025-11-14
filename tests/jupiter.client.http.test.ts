import { describe, expect, test, afterEach } from "bun:test";
import { JupiterClient, type JupiterQuoteRequest, type JupiterSwapRequest } from "../src/utils/jupiter";

// Save and restore global fetch between tests
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch as any;
});

describe("JupiterClient HTTP", () => {
  test("getQuote throws with non-ok response and includes status", async () => {
    // Mock fetch to return non-ok
    globalThis.fetch = (async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "no route",
    })) as any;

    const jc = new JupiterClient("https://example.invalid", globalThis.fetch as any);

    const req: JupiterQuoteRequest = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000",
    };

    await expect(jc.getQuote(req)).rejects.toThrow(
      /Failed to request Jupiter order: Jupiter order failed: 404/
    );
  });

  test("getQuote returns parsed JSON on success", async () => {
    const fake = {
      inputMint: "A",
      outputMint: "B",
      inAmount: "10",
      outAmount: "20",
      otherAmountThreshold: "9",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0.10",
      routePlan: [],
      totalTime: 1,
    };
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => fake,
    })) as any;

    const jc = new JupiterClient("https://example.invalid", globalThis.fetch as any);

    const res = await jc.getQuote({
      inputMint: "A",
      outputMint: "B",
      amount: "10",
    });
    expect(res.inAmount).toBe("10");
    expect(res.outAmount).toBe("20");
  });

  test("getSwapTransaction throws with non-ok response and includes status", async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    })) as any;

    const jc = new JupiterClient("https://example.invalid", globalThis.fetch as any);

    const req: JupiterSwapRequest = {
      userPublicKey: "user",
      quoteResponse: {
        inputMint: "A",
        outputMint: "B",
        inAmount: "10",
        outAmount: "20",
        otherAmountThreshold: "9",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0.10",
        routePlan: [],
        totalTime: 1,
      },
    };

    await expect(jc.getSwapTransaction(req)).rejects.toThrow(
      /Failed to request Jupiter order: Jupiter order failed: 500/
    );
  });
});

