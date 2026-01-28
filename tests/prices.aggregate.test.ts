import { test, expect } from "bun:test";
import { getPricesUSD, getPriceUSD, __test_resetPriceCache } from "../src/utils/prices";
import { WSOL_MINT } from "../src/utils/token-registry";

test("getPricesUSD aggregates ids with custom fetch (no cache hit)", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("jup.ag/price")) {
      const id = new URL(url).searchParams.get("ids")!;
      return new Response(
        JSON.stringify({ data: { [id]: { price: id === WSOL_MINT ? 10 : 20 } } }),
        { status: 200 }
      );
    }
    return new Response("not used", { status: 404 });
  }) as any;

  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const res = await getPricesUSD([WSOL_MINT, usdcMint], fetchImpl);
  expect(res[WSOL_MINT]).toBe(10);
  expect(res[usdcMint]).toBe(20);
});

test("duplicate mint requests share a single Jupiter request and hydrate cache", async () => {
  const previous = process.env["PRICES_ENABLED"];
  process.env["PRICES_ENABLED"] = "true";
  __test_resetPriceCache();
  const calls: string[] = [];
  const price = 24.5;

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.includes("jup.ag/price")) {
      throw new Error(`unexpected url ${url}`);
    }
    calls.push(url);
    const ids = new URL(url).searchParams.get("ids");
    expect(ids).toBe(WSOL_MINT);
    return new Response(
      JSON.stringify({ data: { [WSOL_MINT]: { price } } }),
      { status: 200 }
    );
  }) as any;

  try {
    const ids = [WSOL_MINT, WSOL_MINT];
    const results = await getPricesUSD(ids, fetchImpl);
    expect(results[WSOL_MINT]).toBe(price);

    const wsolPrice = await getPriceUSD(WSOL_MINT, fetchImpl);
    expect(wsolPrice).toBe(price);
    expect(calls).toHaveLength(1);
  } finally {
    __test_resetPriceCache();
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "PRICES_ENABLED");
    } else {
      process.env["PRICES_ENABLED"] = previous;
    }
  }
});
