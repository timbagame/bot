import { test, expect } from "bun:test";
import { getPricesUSD } from "../src/utils/prices";

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
