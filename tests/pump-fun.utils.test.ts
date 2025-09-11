import { beforeEach, describe, expect, test } from "bun:test";
import { isPotentialPumpFunToken, validatePumpFunSwap } from "../src/utils/pump-fun";

describe("pump-fun utils", () => {

  beforeEach(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com"; // ensure mainnet for validation
  });

  test("isPotentialPumpFunToken accepts known mint and rejects invalid", () => {
    expect(isPotentialPumpFunToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
    expect(isPotentialPumpFunToken("not-a-mint")).toBe(false);
  });

  test("validatePumpFunSwap enforces SOL involvement and positive amount", () => {
    // valid: SOL to token
    expect(validatePumpFunSwap("SOL", "SomeMint1111111111111111111111111111111111111", "1").valid).toBe(true);
    // invalid: no SOL
    const noSol = validatePumpFunSwap("A", "B", "1");
    expect(noSol.valid).toBe(false);
    expect(noSol.error).toMatch(/involve SOL/i);
    // invalid: non-positive
    const badAmt = validatePumpFunSwap("SOL", "MINT", "0");
    expect(badAmt.valid).toBe(false);
  });

  test("validatePumpFunSwap blocks non-mainnet networks", () => {
    process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";
    const res = validatePumpFunSwap("SOL", "Mint111111111111111111111111111111111111111", "1");
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/only works on mainnet/i);
  });
});
