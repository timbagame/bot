import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  getPriceUSD,
  getPricesUSD,
  resolveTokenPriceUSD,
} from "../src/utils/prices";

const originalEnv = process.env["PRICES_ENABLED"];
const originalTimeout = process.env["PRICES_TIMEOUT_MS"];

afterEach(() => {
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

    const value = await getPriceUSD("SOL", neverCalledFetch);
    expect(value).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("deduplicates inflight requests and caches successful result", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const token = `TOKEN-${Date.now()}`;
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
    const token = `Mint${Date.now()}`;
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

  test("resolveTokenPriceUSD iterates candidates and reports identifier", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const attempts: string[] = [];
    const now = Date.now();
    const tokenMint = `mint-${now}`;
    const tokenTicker = `T${now}`;
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
              [idParam as string]: {
                price: idParam === tokenTicker ? 2.34 : 0,
              },
            },
          };
        },
      } as any;
    }) as any;

    const result = await resolveTokenPriceUSD({
      tokenMint,
      tokenTicker,
      fetchImpl,
    });

    expect(result?.price).toBeCloseTo(2.34, 6);
    expect(result?.identifier).toBe(tokenTicker);
    expect(attempts).toEqual([tokenMint, tokenTicker]);
  });

  test("getPriceUSD preserves stale cache when downstream returns zero", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const token = `STALE-${Date.now()}`;
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
    const token = `RETRY-${Date.now()}`;
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

    await fc.assert(
        fc.asyncProperty(
          fc.subarray(["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"], {
            minLength: 1,
            maxLength: 5,
          }),
          fc.integer({ min: 1, max: 100 }),
          async (tokens: string[], basePriceInteger: number) => {
            const basePrice = basePriceInteger;
            const uniqueTokens = tokens.map((token: string, index: number) =>
              `${token}${basePriceInteger}${index}`
            );

          const fetchImpl = (async (url: string) => {
            const parsed = new URL(url);
            const id = parsed.searchParams.get("ids") ?? parsed.pathname.split("/").pop()!;
            return {
              ok: true,
              async json() {
                return { data: { [id]: { price: basePrice } } };
              },
            } as any;
          }) as any;

          const ids = [...uniqueTokens];
          const results = await getPricesUSD(ids, fetchImpl);
             for (const id of ids) {
               expect(results[id]).toBe(basePrice);
             }
           }
         ),
      { seed: 12345, numRuns: 25 }
    );
  });

  test("invalid PRICES_TIMEOUT_MS falls back to default timeout", async () => {
    process.env["PRICES_ENABLED"] = "true";
    const previousTimeout = process.env["PRICES_TIMEOUT_MS"];
    process.env["PRICES_TIMEOUT_MS"] = "0";

    const module = await import(
      `../src/utils/prices.ts?timeout=${Date.now()}`
    );

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
      const price = await module.getPriceUSD("SOL", fetchImpl);
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
