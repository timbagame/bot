import { expect, test, describe } from "bun:test";
import {
  getJupiterMint,
  isPriceImpactTooHigh,
  validateSlippage,
} from "../src/utils/jupiter";
import { JupiterClient, type JupiterQuoteResponse } from "../src/utils/jupiter";

describe("jupiter utils", () => {
  test("getJupiterMint maps SOL to WSOL mint", () => {
    expect(getJupiterMint("SOL")).toBe("So11111111111111111111111111111111111111112");
    const wsol = "So11111111111111111111111111111111111111112";
    expect(getJupiterMint(wsol)).toBe(wsol);
    expect(getJupiterMint("EPjFWd...".replace("...", "d5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"))).toContain("EPjF");
  });

  test("isPriceImpactTooHigh compares numeric percent", () => {
    expect(isPriceImpactTooHigh("4.99", 5)).toBe(false);
    expect(isPriceImpactTooHigh("5.01", 5)).toBe(true);
  });

  test("validateSlippage enforces min and max bounds", () => {
    expect(validateSlippage(10).valid).toBe(true);
    expect(validateSlippage(500).valid).toBe(true);
    expect(validateSlippage(9).valid).toBe(false);
    expect(validateSlippage(501).valid).toBe(false);
  });
});

describe("JupiterClient helpers", () => {
  test("validateSwapParams checks mints, amount and sameness", () => {
    const jc = new JupiterClient();
    const ok = jc.validateSwapParams(
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "1000"
    );
    expect(ok.valid).toBe(true);

    expect(jc.validateSwapParams("bad", "bad", "1000").valid).toBe(false);
    expect(jc.validateSwapParams(
      "So11111111111111111111111111111111111111112",
      "So11111111111111111111111111111111111111112",
      "1000"
    ).valid).toBe(false);
    expect(jc.validateSwapParams(
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "0"
    ).valid).toBe(false);
  });

  test("formatQuoteForDisplay renders amounts, rate and route", () => {
    const jc = new JupiterClient();
    const quote: JupiterQuoteResponse = {
      inputMint: "So11111111111111111111111111111111111111112",
      inAmount: "1000000000", // 1 SOL with 9 decimals
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: "1000000", // 1.0 USDC with 6 decimals
      otherAmountThreshold: "990000",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0.25",
      routePlan: [
        { swapInfo: { ammKey: "AMM", label: "JupiterAMM", inputMint: "", outputMint: "", inAmount: "0", outAmount: "0", feeAmount: "0", feeMint: "" }, percent: 100 }
      ],
      totalTime: 123,
    };

    const msg = jc.formatQuoteForDisplay(quote, 9, 6, "SOL", "USDC");
    expect(msg).toContain("<b>Swap Preview</b>");
    expect(msg).toContain("<b>You pay:</b> 1.000000 SOL");
    expect(msg).toContain("<b>You receive:</b> 1.000000 USDC");
    expect(msg).toContain("<b>Route:</b> JupiterAMM");
  });
});
