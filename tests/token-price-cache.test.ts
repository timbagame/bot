import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  __test_clearTokenPriceCache,
  rememberPriceLookup,
  resolvePriceWithCache,
} from "../src/utils/token-price-cache";
import * as priceModule from "../src/utils/prices";

describe("token price cache", () => {
  beforeEach(() => {
    __test_clearTokenPriceCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __test_clearTokenPriceCache();
  });

  test("refreshes after cache expiry", async () => {
    rememberPriceLookup(
      { price: 1, identifier: "AAA" },
      { tokenMint: "AAA", tokenTicker: "AAA" }
    );

    const priceSpy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValue({ price: 2, identifier: "AAA" });

    __test_clearTokenPriceCache();

    const refreshed = await resolvePriceWithCache({
      tokenMint: "AAA",
      tokenTicker: "AAA",
    });

    expect(refreshed?.price).toBe(2);
    expect(priceSpy).toHaveBeenCalledTimes(1);
  });

  test("uses cached token price instead of SOL fallback", async () => {
    const tokenMint = "WBTC_MINT";
    rememberPriceLookup(
      { price: 5, identifier: "WBTC" },
      { tokenMint, tokenTicker: "WBTC", chatId: 99 }
    );

    const priceSpy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValue({ price: 0.01, identifier: "SOL" });

    const resolved = await resolvePriceWithCache({
      tokenMint,
      tokenTicker: "WBTC",
      chatId: 99,
    });

    expect(resolved?.identifier).toBe("WBTC");
    expect(resolved?.price).toBe(5);
    expect(priceSpy).not.toHaveBeenCalled();
  });
});
