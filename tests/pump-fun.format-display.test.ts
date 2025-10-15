import { test, expect } from "bun:test";

test("PumpFunClient.formatQuoteForDisplay shows amounts and rate", async () => {
  const { PumpFunClient } = await import("../src/utils/pump-fun");
  const pfc = Object.create(PumpFunClient.prototype);
  const msg = pfc.formatQuoteForDisplay(
    {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "X",
      inputAmount: "1.000000000",
      outputAmount: "2000000.0",
      estimatedRate: 2,
      slippage: 0.5,
      isGraduated: false,
    },
    9,
    6,
    "WSOL",
    "PUMP"
  );
  expect(msg).toContain("<b>Pump.fun Swap Preview</b>");
  expect(msg).toContain("<b>You pay:</b> 1 WSOL");
  expect(msg).toContain("<b>You receive:</b> 2000000 PUMP");
});

test("PumpFunClient.formatQuoteForDisplay handles raw integer outputs", async () => {
  const { PumpFunClient } = await import("../src/utils/pump-fun");
  const pfc = Object.create(PumpFunClient.prototype);
  const msg = pfc.formatQuoteForDisplay(
    {
      inputMint: "TIMBA",
      outputMint: "So11111111111111111111111111111111111111112",
      inputAmount: "211569.098447",
      outputAmount: "10116176000",
      estimatedRate: 0.00004786,
      slippage: 2,
      isGraduated: false,
    },
    6,
    9,
    "TIMBA",
    "SOL"
  );

  expect(msg).toContain("211569.098447 TIMBA");
  expect(msg).toContain("10.116176 SOL");
  expect(msg).toMatch(/<b>Rate:<\/b> 1 TIMBA = 0\.0000478\d* SOL/);
});
