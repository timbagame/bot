import { describe, test, expect } from "bun:test";
import { SwapQuoteCache } from "../src/utils/swap/quote-cache";
import { makeJupiterParams, makeJupiterQuote } from "./helpers/jupiter-factories";

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
 
  test("keeps referral and non-referral quotes separate", async () => {
    const cache = new SwapQuoteCache({ ttlMs: 5_000 });
    const baseParams = makeJupiterParams({ amount: "1500" });
    const referralParams = {
      ...baseParams,
      referralAccount: "RefAccount",
      referralFeeBps: 90,
      payer: "PayerKey",
      closeAuthority: "CloseKey",
    };

    let loaderCalls = 0;
    const loader = async () => {
      loaderCalls += 1;
      return makeJupiterQuote(baseParams);
    };

    await cache.getJupiterQuote(baseParams, loader);
    await cache.getJupiterQuote(referralParams, loader);

    expect(loaderCalls).toBe(2);
  });

  test("deduplicates concurrent referral quote requests", async () => {
    const cache = new SwapQuoteCache({ ttlMs: 5_000 });
    const params = makeJupiterParams({
      amount: "2000",
      referralAccount: "AnotherRef",
      referralFeeBps: 70,
      payer: "PayerKey2",
      closeAuthority: "CloseKey2",
    });

    let loaderCalls = 0;
    const loader = async () => {
      loaderCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return makeJupiterQuote(params);
    };

    const [first, second] = await Promise.all([
      cache.getJupiterQuote(params, loader),
      cache.getJupiterQuote(params, loader),
    ]);

    expect(loaderCalls).toBe(1);
    expect(first).toEqual(second);
  });

  test("admin and user payer races do not share same quote", async () => {
    const cache = new SwapQuoteCache({ ttlMs: 5_000 });
    const base = makeJupiterParams({ amount: "3000" });
    const adminParams = {
      ...base,
      payer: "Admin",
    };
    const userParams = {
      ...base,
      payer: "User",
    };

    let loaders = 0;
    const adminLoader = async () => {
      loaders += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return makeJupiterQuote(adminParams, { inAmount: "1" });
    };
    const userLoader = async () => {
      loaders += 1;
      return makeJupiterQuote(userParams, { inAmount: "2" });
    };

    const [adminQuote, userQuote] = await Promise.all([
      cache.getJupiterQuote(adminParams, adminLoader),
      cache.getJupiterQuote(userParams, userLoader),
    ]);

    expect(loaders).toBe(2);
    expect(adminQuote.inAmount).not.toBe(userQuote.inAmount);
  });
});
