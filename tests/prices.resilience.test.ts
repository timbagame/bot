import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { Keypair } from "#solana";
import {
  getPriceUSD,
  getPricesUSD,
  resolveTokenPriceUSD,
  __test_resetPriceCache,
} from "../src/utils/prices";
import { WSOL_MINT } from "../src/utils/token-registry";
import * as pricesModuleForReset from "../src/utils/prices";

function freshPricesModule(): typeof pricesModuleForReset {
  pricesModuleForReset.__test_resetPriceCache();
  return pricesModuleForReset;
}

const originalEnv = process.env["PRICES_ENABLED"];
const originalTimeout = process.env["PRICES_TIMEOUT_MS"];

afterEach(() => {
  __test_resetPriceCache();
  if (originalEnv === undefined) {
    delete process.env["PRICES_ENABLED"];
  } else {
    process.env["PRICES_ENABLED"] = originalEnv;
  }

  if (originalTimeout === undefined) {
    delete process.env["PRICES_TIMEOUT_MS"];
  } else {
    process.env["PRICES_TIMEOUT_MS"] = originalTimeout;
  }
});

describe("price utilities resilience", () => {
  test("getPriceUSD returns zero when prices feature disabled", async () => {
    process.env["PRICES_ENABLED"] = "false";
    let fetchCalls = 0;
    const neverCalledFetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch should not be invoked when disabled");
    }) as any;

    const value = await getPriceUSD(WSOL_MINT, neverCalledFetch);
    expect(value).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("deduplicates inflight requests and caches successful result", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const token = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls += 1;
      if (!url.includes("jup")) {
        throw new Error("unexpected url");
      }
      return {
        ok: true,
        async json() {
          return { data: { [token]: { price: 1.23 } } };
        },
      } as any;
    }) as any;

    const first = getPriceUSD(token, fetchImpl);
    const second = getPriceUSD(token, fetchImpl);
    expect(await first).toBe(1.23);
    expect(await second).toBe(1.23);
    expect(calls).toBe(1);

    const third = await getPriceUSD(token, fetchImpl);
    expect(third).toBe(1.23);
    expect(calls).toBe(1);
  });

  test("returns zero when Jupiter fails and no fallback exists", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const token = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    const fetchImpl = (async (url: string) => {
      if (url.includes("jup.ag")) {
        return {
          ok: false,
          async json() {
            return {};
          },
        } as any;
      }
      throw new Error(`unexpected url ${url}`);
    }) as any;

    const value = await getPriceUSD(token, fetchImpl);
    expect(value).toBe(0);
  });

  test("resolveTokenPriceUSD reports identifier", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const attempts: string[] = [];
    const tokenMint = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
    const fetchImpl = (async (url: string) => {
      const idParam = new URL(url).searchParams.get("ids");
      if (idParam) {
        attempts.push(idParam);
      }
      return {
        ok: true,
        async json() {
          return {
            data: {
              [idParam as string]: { price: 2.34 },
            },
          };
        },
      } as any;
    }) as any;

    const result = await resolveTokenPriceUSD({
      tokenMint,
      fetchImpl,
    });

    expect(result?.price).toBeCloseTo(2.34, 6);
    expect(result?.identifier).toBe(tokenMint);
    expect(attempts).toEqual([tokenMint]);
  });

  test("getPriceUSD preserves stale cache when downstream returns zero", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const token = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          async json() {
            return { data: { [token]: { price: 4.2 } } };
          },
        } as any;
      }
      return {
        ok: true,
        async json() {
          return { data: { [token]: { price: 0 } } };
        },
      } as any;
    }) as any;

    expect(await getPriceUSD(token, fetchImpl)).toBe(4.2);
    expect(await getPriceUSD(token, fetchImpl)).toBe(4.2);
    expect(call).toBe(1);
  });

  test("getPriceUSD retries after synchronous upstream failure", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const token = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    let jupiterCalls = 0;

    const fetchImpl = (async (url: string) => {
      if (url.includes("jup.ag")) {
        jupiterCalls += 1;
        if (jupiterCalls === 1) {
          throw new Error("network down");
        }
        return {
          ok: true,
          async json() {
            return { data: { [token]: { price: 7.77 } } };
          },
        } as any;
      }

      throw new Error(`unexpected url ${url}`);
    }) as any;

    const firstAttempt = await getPriceUSD(token, fetchImpl);
    expect(firstAttempt).toBe(0);
    expect(jupiterCalls).toBe(1);

    const secondAttempt = await getPriceUSD(token, fetchImpl);
    expect(secondAttempt).toBe(7.77);
    expect(jupiterCalls).toBe(2);
  });

  test("getPricesUSD aggregates values for mixed identifiers (property)", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const mintPool = [
      WSOL_MINT,
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
    ];

    await fc.assert(
      fc.asyncProperty(
        fc.subarray(mintPool, {
          minLength: 1,
          maxLength: 5,
        }),
        fc.integer({ min: 1, max: 100 }),
        async (tokens: string[], basePriceInteger: number) => {
          __test_resetPriceCache();
          const basePrice = basePriceInteger;

          const fetchImpl = (async (url: string) => {
            const parsed = new URL(url);
            const idsParam = parsed.searchParams.get("ids") ?? parsed.pathname.split("/").pop()!;
            const ids = idsParam ? idsParam.split(",") : [];
            return {
              ok: true,
              async json() {
                const data = ids.reduce<Record<string, { price: number }>>((acc, id) => {
                  acc[id] = { price: basePrice };
                  return acc;
                }, {});
                return { data };
              },
            } as any;
          }) as any;

          const ids = [...tokens];
          const results = await getPricesUSD(ids, fetchImpl);
          for (const id of ids) {
            const expected = id === WSOL_MINT && basePrice >= 0.5 && basePrice <= 2 ? 0 : basePrice;
            expect(results[id]).toBe(expected);
          }
        },
      ),
      { seed: 12345, numRuns: 25 },
    );
  });

  test("getPricesUSD chunks requests at Jupiter's 50-token limit", async () => {
    const mints = await Promise.all(
      Array.from({ length: 55 }, async () => (await Keypair.generate()).publicKey.toBase58()),
    );
    const requestSizes: number[] = [];
    const fetchImpl = (async (url: string) => {
      const ids = (new URL(url).searchParams.get("ids") ?? "").split(",").filter(Boolean);
      requestSizes.push(ids.length);
      return {
        ok: true,
        async json() {
          return Object.fromEntries(ids.map((id) => [id, { usdPrice: 1 }]));
        },
      } as any;
    }) as any;

    const prices = await getPricesUSD(mints, fetchImpl);

    expect(requestSizes).toEqual([50, 5]);
    expect(Object.keys(prices)).toHaveLength(55);
    expect(Object.values(prices).every((price) => price === 1)).toBe(true);
  });

  test("invalid PRICES_TIMEOUT_MS falls back to default timeout", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const previousTimeout = process.env["PRICES_TIMEOUT_MS"];
    process.env["PRICES_TIMEOUT_MS"] = "0";

    const module = freshPricesModule();

    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        ok: true,
        async json() {
          const id = new URL(url).searchParams.get("ids") ?? "SOL";
          return { data: { [id]: { price: 7.5 } } };
        },
      } as any;
    }) as any;

    try {
      const price = await module.getPriceUSD(WSOL_MINT, fetchImpl);
      expect(price).toBe(7.5);
      expect(calls).toBe(1);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env["PRICES_TIMEOUT_MS"];
      } else {
        process.env["PRICES_TIMEOUT_MS"] = previousTimeout;
      }
    }
  });
});

describe("price utilities edge cases", () => {
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

  test("getPricesUSD returns zeros for every id when prices are disabled", async () => {
    process.env["PRICES_ENABLED"] = "false";
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      throw new Error("unexpected");
    }) as any;

    expect(await getPricesUSD([USDC, "not-a-mint"], fetchImpl)).toEqual({
      [USDC]: 0,
      "not-a-mint": 0,
    });
    expect(fetchCalls).toBe(0);
  });

  test("getPricesUSD falls back to single lookups when the batch request fails", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const ids = new URL(url).searchParams.get("ids")!;
      if (ids.includes(",")) return new Response("down", { status: 503 });
      return Response.json({ [ids]: { usdPrice: ids === USDC ? 1.0001 : 0.00002 } });
    }) as any;

    const prices = await getPricesUSD([USDC, BONK], fetchImpl);

    expect(prices).toEqual({ [USDC]: 1.0001, [BONK]: 0.00002 });
    expect(new URL(urls[0]!).searchParams.get("ids")).toBe(`${USDC},${BONK}`);
    expect(urls).toHaveLength(3);
  });

  test("getPricesUSD survives a malformed batch payload", async () => {
    process.env["PRICES_ENABLED"] = "true";
    let batchCalls = 0;
    const fetchImpl = (async (url: string) => {
      const ids = new URL(url).searchParams.get("ids")!;
      if (ids.includes(",")) {
        batchCalls += 1;
        return new Response("<html>not json</html>", { status: 200 });
      }
      return Response.json({ [ids]: { usdPrice: 3 } });
    }) as any;

    expect(await getPricesUSD([USDC, BONK], fetchImpl)).toEqual({ [USDC]: 3, [BONK]: 3 });
    expect(batchCalls).toBe(1);
  });

  test("a failed refresh keeps the last known price for later callers", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      let fail = false;
      let calls = 0;
      const fetchImpl = (async (url: string) => {
        calls += 1;
        if (fail) return new Response("down", { status: 500 });
        const id = new URL(url).searchParams.get("ids")!;
        return Response.json({ [id]: { usdPrice: 2.5 } });
      }) as any;

      expect(await getPriceUSD(USDC, fetchImpl)).toBe(2.5);

      now += 10 * 60_000; // past the cache TTL
      fail = true;
      await getPriceUSD(USDC, fetchImpl);
      expect(calls).toBe(2);

      // The stale value was re-cached, so the next lookup is served without a request.
      expect(await getPriceUSD(USDC, fetchImpl)).toBe(2.5);
      expect(calls).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  test("a failed first lookup caches nothing, so the next call retries", async () => {
    process.env["PRICES_ENABLED"] = "true";
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("down", { status: 500 });
    }) as any;

    expect(await getPriceUSD(USDC, fetchImpl)).toBe(0);
    expect(await getPriceUSD(USDC, fetchImpl)).toBe(0);
    expect(calls).toBe(2);
  });
});
