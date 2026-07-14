import type { JupiterQuoteRequest, JupiterQuoteResponse } from "../../src/utils/jupiter";

export const makeJupiterParams = (
  overrides: Partial<JupiterQuoteRequest> = {},
): JupiterQuoteRequest => ({
  inputMint: "MintA",
  outputMint: "MintB",
  amount: "1000",
  ...overrides,
});

export const makeJupiterQuote = (
  request: JupiterQuoteRequest,
  overrides: Partial<JupiterQuoteResponse> = {},
): JupiterQuoteResponse => ({
  inputMint: request.inputMint,
  inAmount: request.amount,
  outputMint: request.outputMint,
  outAmount: "2000",
  otherAmountThreshold: "0",
  swapMode: "ExactIn",
  slippageBps: 50,
  priceImpactPct: "0",
  routePlan: [],
  totalTime: 0,
  platformFee: null,
  ...overrides,
});

export const makeJupiterOrderResponse = (
  quote: JupiterQuoteRequest,
  overrides: Partial<JupiterQuoteResponse> = {},
): Response => {
  const body = makeJupiterQuote(quote, overrides);
  return new Response(JSON.stringify(body), { status: 200, statusText: "OK" });
};
