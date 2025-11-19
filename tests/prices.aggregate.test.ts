import { test, expect } from "bun:test";
import { getPricesUSD, getPriceUSD, __test_resetPriceCache } from "../src/utils/prices";
import { WSOL_MINT } from "../src/utils/token-registry";

test("getPricesUSD aggregates ids with custom fetch (no cache hit)", async () => {
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("jup.ag/price")) {
      const id = new URL(url).searchParams.get("ids")!;
      return new Response(JSON.stringify({ data: { [id]: { price: id.endsWith("A") ? 10 : 20 } } }), { status: 200 });
    }
    return new Response("not used", { status: 404 });
  }) as any;

  // Use unique symbols unlikely to be cached from other tests
  const res = await getPricesUSD(["X_TEST_A", "Y_TEST_B"], fetchImpl);
  expect(res["X_TEST_A"]).toBe(10);
  expect(res["Y_TEST_B"]).toBe(20);
});

test("SOL aliases share a single Jupiter request and hydrate cache", async () => {
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
    const ids = ["SOL", WSOL_MINT];
    const results = await getPricesUSD(ids, fetchImpl);
    expect(results["SOL"]).toBe(price);
    expect(results[WSOL_MINT]).toBe(price);

    const solPrice = await getPriceUSD("SOL", fetchImpl);
    const wsolPrice = await getPriceUSD(WSOL_MINT, fetchImpl);
    expect(solPrice).toBe(price);
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
