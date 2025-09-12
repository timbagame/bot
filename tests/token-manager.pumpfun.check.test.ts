import { describe, test, expect } from "bun:test";
import { TokenManager } from "../src/utils/token-manager";
import { PumpFunClient } from "../src/utils/pump-fun";

function makeWallet() {
  return {
    getConnection: () => ({}) as any,
    getTokenMetadata: async (_m: string) => ({ decimals: 6 }),
  } as any;
}

describe("TokenManager.checkPumpFunToken", () => {
  test("returns false when not potential pump.fun token", async () => {
    const tm = new TokenManager(makeWallet());
    const res = await tm.checkPumpFunToken("not-a-mint");
    expect(res.isPumpFun).toBe(false);
    expect(res.isGraduated).toBe(false);
  });

  test("returns false on SDK error even when potential", async () => {
    // Patch method on prototype so newly constructed client uses it
    const orig = PumpFunClient.prototype.isPumpFunToken;
    PumpFunClient.prototype.isPumpFunToken = (async () => { throw new Error("boom"); }) as any;
    try {
      const tm = new TokenManager(makeWallet());
      // Valid base58 32-byte pubkey length string (44 chars)
      const res = await tm.checkPumpFunToken("11111111111111111111111111111111R7V3pV");
      expect(res.isPumpFun).toBe(false);
      expect(res.isGraduated).toBe(false);
    } finally {
      PumpFunClient.prototype.isPumpFunToken = orig;
    }
  });
});

