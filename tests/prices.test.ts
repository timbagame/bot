import { describe, test, expect } from "bun:test";
import { getPriceUSD } from "../src/utils/prices";

const jupOkFetch = (price: number) => async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("lite-api.jup.ag")) {
    const id = new URL(url).searchParams.get("ids")!;
    return new Response(
      JSON.stringify({ [id]: { id, usdPrice: price } }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response("not used", { status: 404 });
};

const jupFailPumpOkFetch = (pumpPrice: number) => async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : input.toString();
  if (url.includes("lite-api.jup.ag")) {
    return new Response("oops", { status: 500 });
  }
  if (url.includes("frontend-api.pump.fun")) {
    return new Response(
      JSON.stringify({ priceUsd: String(pumpPrice) }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response("not used", { status: 404 });
};

describe("prices util", () => {
  test("gets SOL price from Jupiter", async () => {
    const price = await getPriceUSD("SOL", jupOkFetch(123.45) as any);
    expect(price).toBe(123.45);
  });

  test("falls back to pump.fun when Jupiter fails", async () => {
    const price = await getPriceUSD("So11111111111111111111111111111111111111112", jupFailPumpOkFetch(5.67) as any);
    expect(price).toBe(5.67);
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
});
