import { beforeEach, describe, expect, test } from "bun:test";
import { isPotentialPumpFunToken, validatePumpFunSwap } from "../src/utils/pump-fun";
import { parseDecimalAmount } from "../src/utils/amount";

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
    const exponent = validatePumpFunSwap("SOL", "MINT", "1e-3");
    expect(exponent.valid).toBe(false);
    expect(exponent.error).toMatch(/invalid amount/i);
  });

  test("parseDecimalAmount returns bigint lamports for pump.fun usage", () => {
    const lamports = parseDecimalAmount("0.000001", 9, { returnType: "bigint" });
    expect(lamports).toBe(1000n);

    const zeroAllowed = parseDecimalAmount("0", 9, {
      returnType: "bigint",
      allowZero: true,
    });
    expect(zeroAllowed).toBe(0n);
    expect(() => parseDecimalAmount("1e-6", 9, { returnType: "bigint" })).toThrow("Invalid amount format");
  });

  test("validatePumpFunSwap blocks non-mainnet networks", () => {
    process.env.SOLANA_NETWORK = "https://api.devnet.solana.com";
    const res = validatePumpFunSwap("SOL", "Mint111111111111111111111111111111111111111", "1");
    expect(res.valid).toBe(false);
    expect(res.error).toMatch(/only works on mainnet/i);
  });
});
