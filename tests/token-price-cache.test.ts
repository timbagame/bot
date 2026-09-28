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
    rememberPriceLookup({ price: 5, identifier: tokenMint }, { tokenMint });

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
    rememberPriceLookup({ price: 1, identifier: tokenMint }, { tokenMint });

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

  describe("price hints", () => {
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const hint = (overrides: Record<string, unknown> = {}) =>
      ({
        price: 1.25,
        identifier: USDC,
        tokenMint: USDC,
        resolvedAt: Date.now(),
        ...overrides,
      }) as any;

    test("a fresh matching hint is used and remembered", async () => {
      const live = vi.spyOn(priceModule, "resolveTokenPriceUSD");

      const first = await getUsdPrice({ tokenMint: ` ${USDC} `, hint: hint() });
      const second = await getUsdPrice({ tokenMint: USDC });

      expect(first).toMatchObject({ price: 1.25, tokenMint: USDC });
      expect(second?.price).toBe(1.25);
      expect(live).not.toHaveBeenCalled();
    });

    test("a hint for another mint is ignored", async () => {
      const live = vi
        .spyOn(priceModule, "resolveTokenPriceUSD")
        .mockResolvedValue({ price: 0.99, identifier: USDC });

      const resolved = await getUsdPrice({ tokenMint: USDC, hint: hint({ tokenMint: WSOL_MINT }) });

      expect(resolved?.price).toBe(0.99);
      expect(live).toHaveBeenCalledTimes(1);
    });

    test("a stale hint is ignored", async () => {
      const live = vi
        .spyOn(priceModule, "resolveTokenPriceUSD")
        .mockResolvedValue({ price: 0.97, identifier: USDC });

      const resolved = await getUsdPrice({ tokenMint: USDC, hint: hint({ resolvedAt: 0 }) });

      expect(resolved?.price).toBe(0.97);
      expect(live).toHaveBeenCalledTimes(1);
    });

    test("a hint with a mint answers a request without one", async () => {
      const live = vi.spyOn(priceModule, "resolveTokenPriceUSD");

      expect((await getUsdPrice({ hint: hint() }))?.price).toBe(1.25);
      expect(live).not.toHaveBeenCalled();
    });

    test("a hint without a mint cannot answer a request without one", async () => {
      vi.spyOn(priceModule, "resolveTokenPriceUSD").mockResolvedValue(null);

      expect(await getUsdPrice({ hint: hint({ tokenMint: undefined }) })).toBeNull();
    });

    test("returns null and caches nothing when the live lookup fails", async () => {
      const live = vi.spyOn(priceModule, "resolveTokenPriceUSD").mockResolvedValue(null);

      expect(await getUsdPrice({ tokenMint: USDC })).toBeNull();
      expect(await getUsdPrice({ tokenMint: USDC })).toBeNull();
      expect(live).toHaveBeenCalledTimes(2);
    });
  });
});
