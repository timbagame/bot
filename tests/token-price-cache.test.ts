import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
  __test_clearPriceServiceCache,
  rememberPriceLookup,
  getUsdPrice,
} from "../src/utils/price-service";
import * as priceModule from "../src/utils/prices";
import { WSOL_MINT } from "../src/utils/token-registry";

describe("token price cache", () => {
  beforeEach(() => {
    __test_clearPriceServiceCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __test_clearPriceServiceCache();
  });

  test("uses cached token price instead of live lookup", async () => {
    const tokenMint = WSOL_MINT;
    rememberPriceLookup(
      { price: 5, identifier: tokenMint },
      { tokenMint }
    );

    const priceSpy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValue({ price: 0.01, identifier: tokenMint });

    const resolved = await getUsdPrice({
      tokenMint,
    });

    expect(resolved?.identifier).toBe(tokenMint);
    expect(resolved?.price).toBe(5);
    expect(priceSpy).not.toHaveBeenCalled();
  });

  test("falls back to live price after cache is cleared", async () => {
    const tokenMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    rememberPriceLookup(
      { price: 1, identifier: tokenMint },
      { tokenMint }
    );

    __test_clearPriceServiceCache();

    const priceSpy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValue({ price: 2, identifier: tokenMint });

    const refreshed = await getUsdPrice({
      tokenMint,
    });

    expect(refreshed?.price).toBe(2);
    expect(priceSpy).toHaveBeenCalledTimes(1);
  });
});
