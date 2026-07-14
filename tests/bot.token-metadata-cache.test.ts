import { describe, test, expect, beforeEach } from "bun:test";
import {
  wallet,
  __test_getCachedTokenMetadata,
  __test_clearTokenMetadataCache,
  __test_setTokenMetadataCacheTtlMs,
  __test_resetTokenMetadataCacheTtlMs,
  __test_setTokenMetadataCacheMaxEntries,
  __test_resetTokenMetadataCacheMaxEntries,
} from "../src/bot";

describe("token metadata cache", () => {
  beforeEach(() => {
    __test_clearTokenMetadataCache();
    __test_resetTokenMetadataCacheTtlMs();
    __test_resetTokenMetadataCacheMaxEntries();
  });

  test("refreshes after TTL expires", async () => {
    const mint = "TestMint11111111111111111111111111111111";
    const originalGetTokenMetadata = wallet.getTokenMetadata;
    let callCount = 0;

    wallet.getTokenMetadata = async () => {
      callCount++;
      return {
        decimals: callCount === 1 ? 6 : 9,
        symbol: "TOK",
      } as any;
    };

    __test_setTokenMetadataCacheTtlMs(10);

    const first = await __test_getCachedTokenMetadata(mint);
    expect(first.decimals).toBe(6);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await __test_getCachedTokenMetadata(mint);
    expect(second.decimals).toBe(9);
    expect(callCount).toBe(2);

    wallet.getTokenMetadata = originalGetTokenMetadata;
  });

  test("coalesces concurrent fetches for the same mint", async () => {
    const mint = "ConcurrentMint111111111111111111111111111111";
    const originalGetTokenMetadata = wallet.getTokenMetadata;
    let callCount = 0;

    wallet.getTokenMetadata = async () => {
      callCount += 1;
      return { decimals: 8 } as any;
    };

    __test_setTokenMetadataCacheTtlMs(50);

    const [first, second, third] = await Promise.all([
      __test_getCachedTokenMetadata(mint),
      __test_getCachedTokenMetadata(mint),
      __test_getCachedTokenMetadata(mint),
    ]);

    expect(first.decimals).toBe(8);
    expect(second.decimals).toBe(8);
    expect(third.decimals).toBe(8);
    expect(callCount).toBe(1);

    wallet.getTokenMetadata = originalGetTokenMetadata;
  });

  test("evicts least-recently-used entries when cache exceeds size", async () => {
    const originalGetTokenMetadata = wallet.getTokenMetadata;
    let callCount = 0;

    wallet.getTokenMetadata = async () => {
      callCount += 1;
      return { decimals: 9 } as any;
    };

    __test_setTokenMetadataCacheMaxEntries(2);
    __test_setTokenMetadataCacheTtlMs(1_000);

    const mintA = "MintA1111111111111111111111111111111111";
    const mintB = "MintB2222222222222222222222222222222222";
    const mintC = "MintC3333333333333333333333333333333333";

    await __test_getCachedTokenMetadata(mintA);
    await __test_getCachedTokenMetadata(mintB);
    expect(callCount).toBe(2);

    // Access mintA again to make mintB the oldest entry
    await __test_getCachedTokenMetadata(mintA);

    await __test_getCachedTokenMetadata(mintC);
    expect(callCount).toBe(3);

    // mintB should have been evicted; fetching again should trigger another call
    await __test_getCachedTokenMetadata(mintB);
    expect(callCount).toBe(4);

    wallet.getTokenMetadata = originalGetTokenMetadata;
  });

  test("wraps metadata errors with context", async () => {
    const mint = "ErrorMint99999999999999999999999999999999";
    const originalGetTokenMetadata = wallet.getTokenMetadata;

    wallet.getTokenMetadata = async () => {
      throw new Error("network down");
    };

    await expect(__test_getCachedTokenMetadata(mint)).rejects.toThrow(
      `Token metadata unavailable for ${mint}: Error: network down`,
    );

    wallet.getTokenMetadata = originalGetTokenMetadata;
  });
});
