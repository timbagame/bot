import { test, expect } from "bun:test";

test("PumpFunClient.formatQuoteForDisplay shows amounts and rate", async () => {
  const { PumpFunClient } = await import("../src/utils/pump-fun");
  const pfc = Object.create(PumpFunClient.prototype);
  const msg = pfc.formatQuoteForDisplay({
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "X",
    inputAmount: "1.000000000",
    outputAmount: "2000000.0",
    estimatedRate: 2,
    slippage: 0.5,
    isGraduated: false,
  }, 9, 6, "WSOL", "PUMP");
  expect(msg).toContain("Pump.fun Swap Preview");
  expect(msg).toContain("1 WSOL");
  expect(msg).toContain("2000000 PUMP");
});
