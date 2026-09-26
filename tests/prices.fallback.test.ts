import { describe, expect, test } from "bun:test";
import { WSOL_MINT } from "../src/utils/token-registry";
import { PRICES_TIMEOUT_MS } from "../src/utils/constants";
import type { FetchLike } from "../src/types";
import * as pricesModuleForReset from "../src/utils/prices";

function freshPricesModule(): typeof pricesModuleForReset {
  pricesModuleForReset.__test_resetPriceCache();
  return pricesModuleForReset;
}

describe("price utilities fallbacks", () => {
  test(
    "aborts a stalled price fetch and returns zero",
    async () => {
      const module = freshPricesModule();
      let aborted = false;
      const slowFetch: FetchLike = async (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("price fetch must receive a cancellation signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("request aborted", "AbortError"));
            },
            { once: true },
          );
        });

      const price = await module.getPriceUSD(
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        slowFetch,
      );
      expect(aborted).toBe(true);
      expect(price).toBe(0);
    },
    PRICES_TIMEOUT_MS + 1_000,
  );

  test("returns zero when Jupiter fails to respond (market cap scenario)", async () => {
    const fetchImpl = (async (_url: string) => {
      return {
        ok: false,
        async json() {
          return {};
        },
      } as any;
    }) as any;

    const module = freshPricesModule();
    const price = await module.getPriceUSD(
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      fetchImpl,
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

    const module = freshPricesModule();
    const price = await module.getPriceUSD(
      "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      fetchImpl,
    );
    expect(price).toBe(0);
  });

  test("resolveTokenPriceUSD returns null when no candidates succeed", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      async json() {
        return { data: {} };
      },
    })) as any;
    const module = freshPricesModule();
    const result = await module.resolveTokenPriceUSD({
      tokenMint: "invalid",
      fetchImpl,
    });
    expect(result).toBeNull();
  });

  test("getPriceUSD ignores non-mint inputs", async () => {
    const module = freshPricesModule();
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
