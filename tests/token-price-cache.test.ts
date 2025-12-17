import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  __test_clearPriceServiceCache,
  rememberPriceLookup,
  getUsdPrice,
} from "../src/utils/price-service";
import * as priceModule from "../src/utils/prices";

describe("token price cache", () => {
  beforeEach(() => {
    __test_clearPriceServiceCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __test_clearPriceServiceCache();
  });

  test("uses cached token price instead of SOL fallback", async () => {
    const tokenMint = "WBTC_MINT";
    rememberPriceLookup(
      { price: 5, identifier: "WBTC" },
      { tokenMint, tokenTicker: "WBTC" }
    );

    const priceSpy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValue({ price: 0.01, identifier: "SOL" });

    const resolved = await getUsdPrice({
      tokenMint,
      tokenTicker: "WBTC",
    });

    expect(resolved?.identifier).toBe("WBTC");
    expect(resolved?.price).toBe(5);
    expect(priceSpy).not.toHaveBeenCalled();
  });

  test("falls back to live price after cache is cleared", async () => {
    rememberPriceLookup(
      { price: 1, identifier: "AAA" },
      { tokenMint: "AAA", tokenTicker: "AAA" }
    );

    __test_clearPriceServiceCache();

    const priceSpy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValue({ price: 2, identifier: "AAA" });

    const refreshed = await getUsdPrice({
      tokenMint: "AAA",
      tokenTicker: "AAA",
    });

    expect(refreshed?.price).toBe(2);
    expect(priceSpy).toHaveBeenCalledTimes(1);
  });
});
