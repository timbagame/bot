import { describe, test, expect, afterEach } from "bun:test";
import { getPriceUSD, __test_resetPriceCache } from "../src/utils/prices";
import { WSOL_MINT } from "../src/utils/token-registry";
import * as pricesModuleForReset from "../src/utils/prices";

function freshPricesModule(): typeof pricesModuleForReset {
  pricesModuleForReset.__test_resetPriceCache();
  return pricesModuleForReset;
}

afterEach(() => {
  __test_resetPriceCache();
});

const jupOkFetch = (price: number) => async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("api.jup.ag")) {
    const id = new URL(url).searchParams.get("ids")!;
    return new Response(JSON.stringify({ [id]: { id, usdPrice: price } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("not used", { status: 404 });
};

const jupFailFetch = async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("api.jup.ag")) {
    return new Response("oops", { status: 500 });
  }
  return new Response("not used", { status: 404 });
};
describe("prices util", () => {
  test("rejects a WSOL usdPrice of 1 as native SOL/SOL", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const id = new URL(url).searchParams.get("ids")!;
      return new Response(JSON.stringify({ [id]: { id, price: 1, usdPrice: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const price = await getPriceUSD(WSOL_MINT, fetchImpl);
    expect(price).toBe(0);
  });

  test("prefers usdPrice when Jupiter also returns a native WSOL price of 1", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const id = new URL(url).searchParams.get("ids")!;
      return new Response(JSON.stringify({ [id]: { id, price: 1, usdPrice: 147.22 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const price = await getPriceUSD(WSOL_MINT, fetchImpl);
    expect(price).toBe(147.22);
  });

  test("gets SOL price from Jupiter", async () => {
    const price = await getPriceUSD(WSOL_MINT, jupOkFetch(123.45) as any);
    expect(price).toBe(123.45);
  });

  test("returns zero when Jupiter fails", async () => {
    const price = await getPriceUSD(WSOL_MINT, jupFailFetch as any);
    expect(price).toBe(0);
  });

  test("caches results within TTL", async () => {
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      const id = new URL(url).searchParams.get("ids")!;
      return new Response(JSON.stringify({ [id]: { id, usdPrice: 1.23 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;

    const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const a = await getPriceUSD(tokenMint, fetchImpl);
    const b = await getPriceUSD(tokenMint, fetchImpl);
    expect(a).toBe(1.23);
    expect(b).toBe(1.23);
    expect(calls).toBe(1);
  });

  test("handles non-positive TTL env override without throwing", async () => {
    const previousTtl = process.env["PRICES_CACHE_TTL_MS"];
    process.env["PRICES_CACHE_TTL_MS"] = "0";

    try {
      const module = freshPricesModule();
      const price = await module.getPriceUSD(WSOL_MINT, jupOkFetch(9.99) as any);
      expect(price).toBe(9.99);
    } finally {
      if (previousTtl === undefined) {
        Reflect.deleteProperty(process.env, "PRICES_CACHE_TTL_MS");
      } else {
        process.env["PRICES_CACHE_TTL_MS"] = previousTtl;
      }
    }
  });
});
