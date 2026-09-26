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
  const client = new JupiterClient(
    "https://api.jup.ag",
    async () =>
      new Response("rate-limited", {
        status: 429,
        statusText: "Too Many Requests",
      }),
  );

  try {
    await client.getQuote({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
    });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/429 Too Many Requests/);
  }
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

  const client = new JupiterClient(
    "https://api.jup.ag",
    async () =>
      new Response(JSON.stringify(orderPayload), {
        status: 200,
        statusText: "OK",
      }),
  );

  try {
    await client.getSwapTransaction({
      userPublicKey: "test",
      quoteResponse: baseQuote,
    });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Minimum $10 for gasless");
  }
});

test("JupiterClient honors referralApplied returned by Jupiter", async () => {
  const client = new JupiterClient(
    "https://api.jup.ag",
    async () =>
      new Response(
        JSON.stringify({
          inputMint: "MintA",
          outputMint: "MintB",
          inAmount: "1000",
          outAmount: "2000",
          otherAmountThreshold: "0",
          swapMode: "ExactIn",
          slippageBps: 50,
          priceImpactPct: "0",
          routePlan,
          router: "pump",
          requestId: "req-123",
          quoteId: "quote-123",
          totalTime: 1,
          platformFee: null,
          referralApplied: false,
        }),
        { status: 200, statusText: "OK" },
      ),
  );

  const quote = await client.getQuote({
    inputMint: "MintA",
    outputMint: "MintB",
    amount: "1000",
    referralAccount: "REF-ACC",
  });

  expect(quote.referralApplied).toBe(false);
});

test("JupiterClient does not invent payerApplied from request parameters", async () => {
  const client = new JupiterClient(
    "https://api.jup.ag",
    async () =>
      new Response(
        JSON.stringify({
          inputMint: "MintA",
          outputMint: "MintB",
          inAmount: "1000",
          outAmount: "2000",
          otherAmountThreshold: "0",
          swapMode: "ExactIn",
          slippageBps: 50,
          priceImpactPct: "0",
          routePlan,
          payerApplied: false,
        }),
        { status: 200, statusText: "OK" },
      ),
  );

  const quote = await client.getQuote({
    inputMint: "MintA",
    outputMint: "MintB",
    amount: "1000",
    payer: "RequestedPayer",
  });

  expect(quote.payerApplied).toBe(false);
});

test("Jupiter executeOrder surfaces stringify failures without crashing", async () => {
  // BigInt makes JSON.stringify throw immediately. (A cyclic object also throws,
  // but Bun's indented stringify takes seconds to detect the cycle.)
  const unserializable = { signature: "derp", slot: 1n };
  const client = new JupiterClient(
    "https://api.jup.ag",
    async () =>
      ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => unserializable,
      }) as any,
  );

  try {
    await client.executeOrder({
      requestId: "req",
      signedTransaction: "tx",
    });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Failed to execute Jupiter order:/);
  }
});

test("Jupiter build surfaces 200 error payloads", async () => {
  const client = new JupiterClient(
    "https://api.jup.ag",
    async () =>
      new Response(
        JSON.stringify({
          error: "Failed to get quotes",
          errorCode: 1,
        }),
        { status: 200, statusText: "OK" },
      ),
  );

  try {
    await client.getBuildInstructions({
      inputMint: "MintA",
      outputMint: "MintB",
      amount: "1000",
      taker: "Taker",
    });
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Failed to get quotes");
  }
});
