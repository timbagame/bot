import { describe, expect, test } from "bun:test";
import { SwapQuoteCache } from "../src/utils/swap/quote-cache";
import { makeJupiterParams, makeJupiterQuote } from "./helpers/jupiter-factories";

describe("SwapQuoteCache cached hits", () => {
  test("serves a resolved Jupiter quote from cache without calling the loader again", async () => {
    const cache = new SwapQuoteCache({ ttlMs: 60_000 });
    const params = makeJupiterParams({ amount: "777" });
    let loaderCalls = 0;
    const loader = async () => {
      loaderCalls += 1;
      return makeJupiterQuote(params, { outAmount: String(1000 + loaderCalls) });
    };

    const first = await cache.getJupiterQuote(params, loader);
    const second = await cache.getJupiterQuote(params, loader);

    expect(loaderCalls).toBe(1);
    expect(first.outAmount).toBe("1001");
    expect(second).toBe(first);
  });
});
