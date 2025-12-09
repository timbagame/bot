import { describe, test, expect, afterEach } from "bun:test";
import { JupiterClient } from "../src/utils/jupiter";

describe("JupiterClient API Key", () => {
  const originalEnv = process.env.JUPITER_API_KEY;

  afterEach(() => {
    if (originalEnv) {
      process.env.JUPITER_API_KEY = originalEnv;
    } else {
      delete process.env.JUPITER_API_KEY;
    }
  });

  test("sends x-api-key header when apiKey is provided in constructor", async () => {
    const capture: { headers?: Record<string, string> } = {};
    const fetchStub = async (_url: string, init?: RequestInit) => {
      capture.headers = init?.headers as Record<string, string>;
      return {
        ok: true,
        json: async () => ({
          inputMint: "MintA",
          outputMint: "MintB",
          inAmount: "100",
          outAmount: "100",
          otherAmountThreshold: "100",
          swapMode: "ExactIn",
          slippageBps: 0,
          priceImpactPct: "0",
          routePlan: [],
        }),
      } as Response;
    };

    const client = new JupiterClient("https://api.jup.ag", fetchStub as any, "my-test-key");
    await client.getQuote({
      inputMint: "MintA",
      outputMint: "MintB",
      amount: "100",
    });

    expect(capture.headers).toBeDefined();
    expect(capture.headers!["x-api-key"]).toBe("my-test-key");
  });

  test("sends x-api-key header when JUPITER_API_KEY env var is set", async () => {
    process.env.JUPITER_API_KEY = "env-test-key";

    const capture: { headers?: Record<string, string> } = {};
    const fetchStub = async (_url: string, init?: RequestInit) => {
      capture.headers = init?.headers as Record<string, string>;
      return {
        ok: true,
        json: async () => ({
          inputMint: "MintA",
          outputMint: "MintB",
          inAmount: "100",
          outAmount: "100",
          otherAmountThreshold: "100",
          swapMode: "ExactIn",
          slippageBps: 0,
          priceImpactPct: "0",
          routePlan: [],
        }),
      } as Response;
    };

    const client = new JupiterClient("https://api.jup.ag", fetchStub as any);
    await client.getQuote({
      inputMint: "MintA",
      outputMint: "MintB",
      amount: "100",
    });

    expect(capture.headers).toBeDefined();
    expect(capture.headers!["x-api-key"]).toBe("env-test-key");
  });

  test("does not send x-api-key header when no key is present", async () => {
    delete process.env.JUPITER_API_KEY;

    const capture: { headers?: Record<string, string> } = {};
    const fetchStub = async (_url: string, init?: RequestInit) => {
      capture.headers = init?.headers as Record<string, string>;
      return {
        ok: true,
        json: async () => ({
          inputMint: "MintA",
          outputMint: "MintB",
          inAmount: "100",
          outAmount: "100",
          otherAmountThreshold: "100",
          swapMode: "ExactIn",
          slippageBps: 0,
          priceImpactPct: "0",
          routePlan: [],
        }),
      } as Response;
    };

    const client = new JupiterClient("https://api.jup.ag", fetchStub as any);
    await client.getQuote({
      inputMint: "MintA",
      outputMint: "MintB",
      amount: "100",
    });

    expect(capture.headers).toBeDefined();
    expect(capture.headers!["x-api-key"]).toBeUndefined();
  });
});
