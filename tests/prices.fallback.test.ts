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
      const price = await module.getPriceUSD("SLOW-TOKEN", slowFetch);
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
    const price = await module.getPriceUSD("CAP-TKN", fetchImpl);
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
    const price = await module.getPriceUSD("SOL-PRODUCT", fetchImpl);
    expect(price).toBe(0);
  });

  test("resolveTokenPriceUSD returns null when no candidates succeed", async () => {
    const fetchImpl = (async () => ({ ok: true, async json() { return { data: {} }; } })) as any;
    const module = await import(`../src/utils/prices.ts?null=${Date.now()}`);
    const result = await module.resolveTokenPriceUSD({
      tokenMint: "unknown",
      tokenTicker: "???",
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  test("toMintOrId prefers WSOL for SOL inputs", async () => {
    const module = await import(`../src/utils/prices.ts?solmint=${Date.now()}`);
    const fetchImpl = (async (url: string) => {
      const parsed = new URL(url);
      const id = parsed.searchParams.get("ids") ?? "";
      return {
        ok: true,
        async json() {
          return { data: { [id]: { price: id === WSOL_MINT ? 123 : 0 } } };
        },
      } as any;
    }) as any;

    const price = await module.getPriceUSD("sol", fetchImpl);
    expect(price).toBe(123);
  });
});
