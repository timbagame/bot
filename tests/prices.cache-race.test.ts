import { afterAll, expect, test } from "bun:test";

const ORIGINAL_TTL = process.env["PRICES_CACHE_TTL_MS"];
const ORIGINAL_ENABLED = process.env["PRICES_ENABLED"];

test("getPriceUSD retains resolved price when TTL expires during fetch", async () => {
  process.env["PRICES_CACHE_TTL_MS"] = "5";
  process.env["PRICES_ENABLED"] = "true";

  const symbol = `RACE-${Date.now()}`.toUpperCase();
  const pricesModule = await import(`../src/utils/prices?ttlRace=${Date.now()}`);

  let calls = 0;
  const fetchImpl = (async (_url: string) => {
    calls += 1;
    return new Promise<any>((resolve) => {
      setTimeout(() => {
        resolve({
          ok: true,
          json: async () => ({ data: { [symbol]: { price: 7.89 } } }),
        });
      }, 20);
    });
  }) as any;

  const first = await pricesModule.getPriceUSD(symbol, fetchImpl);
  expect(first).toBeCloseTo(7.89, 6);

  const second = await pricesModule.getPriceUSD(symbol, fetchImpl);
  expect(second).toBeCloseTo(7.89, 6);
  expect(calls).toBe(1);
});

afterAll(() => {
  if (ORIGINAL_TTL === undefined) {
    delete process.env["PRICES_CACHE_TTL_MS"];
  } else {
    process.env["PRICES_CACHE_TTL_MS"] = ORIGINAL_TTL;
  }

  if (ORIGINAL_ENABLED === undefined) {
    delete process.env["PRICES_ENABLED"];
  } else {
    process.env["PRICES_ENABLED"] = ORIGINAL_ENABLED;
  }
});
