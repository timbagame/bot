import { describe, test, expect } from "bun:test";
import { __test_formatTradeConfirmationSummary as formatTradeConfirmationSummary } from "../src/bot";
import type { SwapQuote } from "../src/utils/swap/types";

const defaultQuote: SwapQuote = {
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
  inputAmount: "1000000",
  inputAmountRaw: "1000000",
  outputAmount: "10000",
  estimatedRate: 10,
  slippage: 0.01,
  provider: "jupiter",
  providerQuote: {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
    inAmount: "1000000",
    outAmount: "10000",
    otherAmountThreshold: "0",
    swapMode: "ExactIn",
    slippageBps: 100,
    priceImpactPct: "0",
    routePlan: [],
    platformFee: null,
  },
};

describe("formatTradeConfirmationSummary", () => {
  const baseInput = {
    payToken: "SOL",
    payDisplay: "1.000000 SOL",
    payRawAmount: 1_000_000_000,
    payDecimals: 9,
    receiveToken: "TIMBA",
    receiveDecimals: 6,
    quote: defaultQuote,
  };

  test("includes fee percent when integrator referral fee exists but provider fee absent", () => {
    const summary = formatTradeConfirmationSummary({
      ...baseInput,
      quote: {
        ...defaultQuote,
        integrator: { referralAccount: "dummy", referralFee: 130, payer: "a", closeAuthority: "b", payerKind: "admin" },
      },
    });
    expect(summary.message).toContain("Fee:");
    expect(summary.message).toContain("1.30%");
  });

  test("does not include fee line when no fee data provided", () => {
    const summary = formatTradeConfirmationSummary({
      ...baseInput,
      quote: { ...defaultQuote, integrator: null },
    });
    expect(summary.message).not.toContain("Fee:");
  });

  test("uses provider fee when integrator fee missing", () => {
    const summary = formatTradeConfirmationSummary({
      ...baseInput,
      quote: {
        ...defaultQuote,
        providerQuote: {
          ...defaultQuote.providerQuote!,
          feeBps: 90,
        },
        integrator: null,
      },
    });
    expect(summary.message).toContain("<b>Fee:</b> 0.90%");
  });

  test("keeps user payer fee percent identical to integrator base", () => {
    const summary = formatTradeConfirmationSummary({
      ...baseInput,
      quote: {
        ...defaultQuote,
        integrator: {
          referralAccount: "dummy",
          referralFee: 85,
          payer: "userPayer",
          closeAuthority: "userPayer",
          payerKind: "user",
        },
      },
    });
    expect(summary.message).toContain("<b>Fee:</b> 0.85%");
  });

  test("formats capped integrator fee bps correctly", () => {
    const summary = formatTradeConfirmationSummary({
      ...baseInput,
      quote: {
        ...defaultQuote,
        integrator: {
          referralAccount: "dummy",
          referralFee: 200,
          payer: "user",
          closeAuthority: "user",
          payerKind: "user",
        },
      },
    });
    expect(summary.message).toContain("2.00%");
  });
});
