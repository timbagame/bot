import { test, expect } from "bun:test";
import { JupiterClient } from "../../src/utils/jupiter";

const routePlan = [
  {
    swapInfo: {
      ammKey: "",
      label: "",
      inputMint: "",
      outputMint: "",
      inAmount: "",
      outAmount: "",
      feeAmount: "0",
      feeMint: "",
    },
    percent: 100,
  },
];

test("JupiterClient surfaces HTTP errors without error payload", async () => {
  const client = new JupiterClient("https://lite-api.jup.ag", async () =>
    new Response("rate-limited", {
      status: 429,
      statusText: "Too Many Requests",
    })
  );

  await expect(
    client.getQuote({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
    })
  ).rejects.toThrow(/429 Too Many Requests/);
});

test("JupiterClient surfaces gasless order error message", async () => {
  const baseQuote = {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inAmount: "1000",
    outAmount: "2000",
    otherAmountThreshold: "0",
    swapMode: "ExactIn",
    slippageBps: 100,
    priceImpactPct: "0",
    routePlan,
    router: "pump",
    requestId: "quote-req",
  } as const;

  const orderPayload = {
    ...baseQuote,
    transaction: "",
    gasless: true,
    errorMessage: "Minimum $10 for gasless",
  };

  const client = new JupiterClient("https://lite-api.jup.ag", async () =>
    new Response(JSON.stringify(orderPayload), {
      status: 200,
      statusText: "OK",
    })
  );

  await expect(
    client.getSwapTransaction({
      userPublicKey: "test",
      quoteResponse: baseQuote,
    })
  ).rejects.toThrow("Minimum $10 for gasless");
});
