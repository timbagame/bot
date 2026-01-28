import { describe, expect, test } from "bun:test";
import { WSOL_MINT } from "../src/utils/token-registry";

const originalTimeout = process.env["PRICES_TIMEOUT_MS"];

describe("price utilities fallbacks", () => {
  test("withTimeout rejects long fetches and returns zero", async () => {
    process.env["PRICES_TIMEOUT_MS"] = "1";
    const module = await import(`../src/utils/prices.ts?timeout=${Date.now()}`);
    try {
      const slowFetch = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          ok: true,
          async json() {
            return { data: {} };
          },
        } as any;
      }) as any;
      const price = await module.getPriceUSD(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        slowFetch
      );
      expect(price).toBe(0);
    } finally {
      if (originalTimeout === undefined) {
        delete process.env["PRICES_TIMEOUT_MS"];
      } else {
        process.env["PRICES_TIMEOUT_MS"] = originalTimeout;
      }
    }
  });

  test("returns zero when Jupiter fails to respond (market cap scenario)", async () => {
    const fetchImpl = (async (_url: string) => {
      return { ok: false, async json() { return {}; } } as any;
    }) as any;

    const module = await import(`../src/utils/prices.ts?cap=${Date.now()}`);
    const price = await module.getPriceUSD(
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      fetchImpl
    );
    expect(price).toBe(0);
  });

  test("returns zero when Jupiter returns formatted fallback data but no successful price", async () => {
    const fetchImpl = (async (_url: string) => {
      return {
        ok: true,
        async json() {
          return { priceInSol: "0.5", solPrice: "120" };
        },
      } as any;
    }) as any;

    const module = await import(`../src/utils/prices.ts?sol=${Date.now()}`);
    const price = await module.getPriceUSD(
      "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      fetchImpl
    );
    expect(price).toBe(0);
  });

  test("resolveTokenPriceUSD returns null when no candidates succeed", async () => {
    const fetchImpl = (async () => ({ ok: true, async json() { return { data: {} }; } })) as any;
    const module = await import(`../src/utils/prices.ts?null=${Date.now()}`);
    const result = await module.resolveTokenPriceUSD({
      tokenMint: "invalid",
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  test("getPriceUSD ignores non-mint inputs", async () => {
    const module = await import(`../src/utils/prices.ts?solmint=${Date.now()}`);
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() {
          return { data: { [WSOL_MINT]: { price: 123 } } };
        },
      } as any;
    }) as any;

    const price = await module.getPriceUSD("sol", fetchImpl);
    expect(price).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});
