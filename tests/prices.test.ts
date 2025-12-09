import { describe, test, expect } from "bun:test";
import { getPriceUSD } from "../src/utils/prices";

const jupOkFetch = (price: number) => async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("api.jup.ag")) {
    const id = new URL(url).searchParams.get("ids")!;
    return new Response(
      JSON.stringify({ [id]: { id, usdPrice: price } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
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
  test("gets SOL price from Jupiter", async () => {
    const price = await getPriceUSD("SOL", jupOkFetch(123.45) as any);
    expect(price).toBe(123.45);
  });

  test("returns zero when Jupiter fails", async () => {
    const price = await getPriceUSD("So11111111111111111111111111111111111111112", jupFailFetch as any);
    expect(price).toBe(0);
  });

  test("caches results within TTL", async () => {
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = typeof input === "string" ? input : input.toString();
      const id = new URL(url).searchParams.get("ids")!;
      return new Response(
        JSON.stringify({ [id]: { id, usdPrice: 1.23 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as any;

    const a = await getPriceUSD("SOL_CACHE", fetchImpl);
    const b = await getPriceUSD("SOL_CACHE", fetchImpl);
    expect(a).toBe(1.23);
    expect(b).toBe(1.23);
    expect(calls).toBe(1);
  });

  test("handles non-positive TTL env override without throwing", async () => {
    const previousTtl = process.env["PRICES_CACHE_TTL_MS"];
    process.env["PRICES_CACHE_TTL_MS"] = "0";

    try {
      const module = await import(
        `../src/utils/prices?ttl=${Date.now()}`
      );
      const price = await module.getPriceUSD("SOL", jupOkFetch(9.99) as any);
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
