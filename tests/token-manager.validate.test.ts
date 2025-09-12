import { describe, test, expect } from "bun:test";
import { TokenManager } from "../src/utils/token-manager";

function makeWallet(valid: boolean) {
  return {
    getTokenMetadata: async (_m: string) => {
      if (!valid) throw new Error("bad");
      return { decimals: 6 };
    },
  } as any;
}

describe("TokenManager.validateTokenMint", () => {
  test("returns false for invalid mint", async () => {
    const tm = new TokenManager(makeWallet(false));
    const ok = await tm.validateTokenMint("not-a-mint");
    expect(ok).toBe(false);
  });

  test("returns true for valid mint and metadata present", async () => {
    const tm = new TokenManager(makeWallet(true));
    const ok = await tm.validateTokenMint("BPFLoader1111111111111111111111111111111111");
    expect(ok).toBe(true);
  });
});

