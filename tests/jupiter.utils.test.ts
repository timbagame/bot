import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getJupiterMint,
  isPriceImpactTooHigh,
  validateSlippage,
  JupiterClient,
  type JupiterQuoteResponse,
  type JupiterOrderResponse,
} from "../src/utils/jupiter";
import { createJupiterFetchStub } from "./helpers/test-stubs";
import { makeJupiterOrderResponse } from "./helpers/jupiter-factories";

describe("jupiter utils", () => {
  test("getJupiterMint maps SOL to WSOL mint", () => {
    expect(getJupiterMint("SOL")).toBe("So11111111111111111111111111111111111111112");
    const wsol = "So11111111111111111111111111111111111111112";
    expect(getJupiterMint(wsol)).toBe(wsol);
    expect(
      getJupiterMint("EPjFWd...".replace("...", "d5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")),
    ).toContain("EPjF");
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
      "1000",
    );
    expect(ok.valid).toBe(true);

    expect(jc.validateSwapParams("bad", "bad", "1000").valid).toBe(false);
    expect(
      jc.validateSwapParams(
        "So11111111111111111111111111111111111111112",
        "So11111111111111111111111111111111111111112",
        "1000",
      ).valid,
    ).toBe(false);
    expect(
      jc.validateSwapParams(
        "So11111111111111111111111111111111111111112",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "0",
      ).valid,
    ).toBe(false);
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
        {
          swapInfo: {
            ammKey: "AMM",
            label: "JupiterAMM",
            inputMint: "",
            outputMint: "",
            inAmount: "0",
            outAmount: "0",
            feeAmount: "0",
            feeMint: "",
          },
          percent: 100,
        },
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

describe("JupiterClient referral URL params", () => {
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const amount = "1000000";
  const referralAccount = "GPBNTRmo26MRoaLSvRXwhWaQZhYjwVWgEkgwRZVU6x9U";
  const payer = "6HqDqk25HSbzsk1HJ8PMzhzD5ZNY9LqZhpGwbCLyzvC6";

  let savedConsoleDebug: typeof console.debug;

  beforeEach(() => {
    savedConsoleDebug = console.debug;
    console.debug = () => {};
  });

  afterEach(() => {
    console.debug = savedConsoleDebug;
  });

  const makeSuccessResponse = (overrides?: Partial<JupiterOrderResponse>) =>
    makeJupiterOrderResponse(
      { inputMint, outputMint, amount },
      {
        mode: "ultra",
        inputMint,
        outputMint,
        inAmount: amount,
        outAmount: "100",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [
          {
            swapInfo: {
              ammKey: "AMM",
              label: "Jupiter",
              inputMint,
              outputMint,
              inAmount: amount,
              outAmount: "100",
              feeAmount: "0",
              feeMint: inputMint,
            },
            percent: 100,
          },
        ],
        transaction: "AAAA",
        requestId: "req-portal",
        referralApplied: true,
        feeBps: 100,
        ...overrides,
      },
    );

  test("falls back to payer for taker when missing", async () => {
    const capture: { url?: string } = {};
    const client = new JupiterClient(
      "https://api.jup.ag",
      createJupiterFetchStub(capture, async () => makeSuccessResponse()),
    );

    await client.getQuote({
      inputMint,
      outputMint,
      amount,
      referralAccount,
      referralFee: 85,
      payer,
    });

    expect(capture.url).toContain(`taker=${payer}`);
    expect(capture.url).toContain("referralFee=100");
  });

  test("keeps explicit taker instead of overriding with payer", async () => {
    const capture: { url?: string } = {};
    const explicitTaker = "2DxM4Qf7RZwzE9HyfYDp2mjNgS8RX5UCb7Yiz2ZGsY2Q";
    const client = new JupiterClient(
      "https://api.jup.ag",
      createJupiterFetchStub(capture, async () => makeSuccessResponse()),
    );

    await client.getQuote({
      inputMint,
      outputMint,
      amount,
      referralAccount,
      referralFee: 85,
      payer,
      taker: explicitTaker,
    });

    expect(capture.url).toContain(`taker=${explicitTaker}`);
    expect(capture.url).not.toContain(`taker=${payer}`);
  });

  test("surfaces a typed error instead of silently removing referral parameters", async () => {
    const urls: string[] = [];
    const closeAuthority = "5mo3n3ed58N8LSnMSrhMfyQyw4MKWmNBp8QtUafpJwwt";
    const client = new JupiterClient(
      "https://api.jup.ag",
      createJupiterFetchStub(
        { urls },
        async () =>
          ({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: async () => "Failed to get quotes",
          }) as unknown as Response,
      ),
    );

    await expect(
      client.getQuote({
        inputMint,
        outputMint,
        amount,
        referralAccount,
        referralFee: 85,
        payer,
        closeAuthority,
      }),
    ).rejects.toMatchObject({ name: "JupiterReferralUnavailableError" });

    expect(urls.length).toBe(1);
    expect(urls[0]).toContain("referralAccount=");
    expect(urls[0]).toContain(`payer=${payer}`);
    expect(urls[0]).toContain(`closeAuthority=${closeAuthority}`);
  });
});

describe("JupiterClient fee display", () => {
  test("shows platform fee percent when feeBps missing", () => {
    const client = new JupiterClient();
    const quote = {
      inputMint: "So11111111111111111111111111111111111111112",
      inAmount: "1000000",
      outputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      outAmount: "10000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
      totalTime: 0,
      platformFee: { amount: "1000", feeBps: 120 },
    } as JupiterQuoteResponse;

    const msg = client.formatQuoteForDisplay(quote, 9, 6, "SOL", "TIMBA");
    expect(msg).toContain("Fee:");
    expect(msg).toContain("1.20%");
  });
});

describe("JupiterClient error handling", () => {
  test("propagates gasless minimum error code 3 clearly", async () => {
    const client = new JupiterClient(
      "https://api.jup.ag",
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            errorCode: 3,
            errorMessage: "Minimum $10 for gasless",
          }),
          text: async () =>
            JSON.stringify({
              errorCode: 3,
              errorMessage: "Minimum $10 for gasless",
            }),
        }) as unknown as Response,
    );

    await expect(
      client.getQuote({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "1000000",
        taker: "Taker",
      }),
    ).rejects.toThrow("Minimum $10 for gasless");
  });

  test("does not expose raw Jupiter error JSON", async () => {
    const client = new JupiterClient(
      "https://api.jup.ag",
      async () =>
        ({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () =>
            JSON.stringify({
              requestId: "109df427-11b0-75bc-8bee-0283dbcd2d1f",
              error: "Failed to get quotes",
            }),
        }) as unknown as Response,
    );

    await expect(
      client.getQuote({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: "1000000",
        taker: "Taker",
      }),
    ).rejects.toThrow(
      "Failed to request Jupiter order: Jupiter order failed: 400 Bad Request - Failed to get quotes",
    );
  });
});
