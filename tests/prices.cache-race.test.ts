import { expect, test, spyOn } from "bun:test";
import { getPriceUSD, __test_resetPriceCache } from "../src/utils/prices";
import { PRICES_CACHE_TTL_MS } from "../src/utils/constants";

test("getPriceUSD retains resolved price when TTL expires during fetch", async () => {
  const originalEnabled = process.env["PRICES_ENABLED"];
  process.env["PRICES_ENABLED"] = "true";
  __test_resetPriceCache();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const symbol = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
  const response = Promise.withResolvers<Response>();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return (await response.promise).clone();
  };

  try {
    const first = getPriceUSD(symbol, fetchImpl);
    // Use the TTL of the already-created cache. Advance its clock while the
    // network request is pending and force the expired entry into stale storage.
    now += PRICES_CACHE_TTL_MS + 1;
    const concurrent = getPriceUSD(symbol, fetchImpl);
    expect(calls).toBe(1);
    response.resolve(new Response(JSON.stringify({ data: { [symbol]: { price: 7.89 } } })));
    expect(await first).toBeCloseTo(7.89, 6);
    expect(await concurrent).toBeCloseTo(7.89, 6);
    expect(await getPriceUSD(symbol, fetchImpl)).toBeCloseTo(7.89, 6);
    expect(calls).toBe(1);

    // A resolved value gets a fresh TTL, then really expires on the next interval.
    now += PRICES_CACHE_TTL_MS + 1;
    expect(await getPriceUSD(symbol, fetchImpl)).toBeCloseTo(7.89, 6);
    expect(calls).toBe(2);
  } finally {
    clock.mockRestore();
    __test_resetPriceCache();
    if (originalEnabled === undefined) delete process.env["PRICES_ENABLED"];
    else process.env["PRICES_ENABLED"] = originalEnabled;
  }
});
