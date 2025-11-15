import { describe, test, expect } from "bun:test";
import {
  wallet,
  __test_getCachedTokenMetadata,
  __test_clearTokenMetadataCache,
  __test_setTokenMetadataCacheTtlMs,
  __test_resetTokenMetadataCacheTtlMs,
} from "../src/bot";

describe("token metadata cache", () => {
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

    __test_clearTokenMetadataCache();
    __test_setTokenMetadataCacheTtlMs(10);

    const first = await __test_getCachedTokenMetadata(mint);
    expect(first.decimals).toBe(6);

    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await __test_getCachedTokenMetadata(mint);
    expect(second.decimals).toBe(9);
    expect(callCount).toBe(2);

    wallet.getTokenMetadata = originalGetTokenMetadata;
    __test_resetTokenMetadataCacheTtlMs();
  });
});
