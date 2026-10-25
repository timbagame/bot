import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  JupiterClient,
  fetchJupiterTokenMetadata,
  type JupiterQuoteRequest,
} from "../src/utils/jupiter";

type FetchCall = { url: string; init?: RequestInit };

const orderBody = (overrides: Record<string, unknown> = {}) => ({
  inputMint: "MintA",
  outputMint: "MintB",
  inAmount: "10",
  outAmount: "20",
  otherAmountThreshold: "9",
  swapMode: "ExactIn",
  slippageBps: 100,
  routePlan: [],
  totalTime: 1,
  ...overrides,
});

const instruction = (programId: string) => ({ programId, accounts: [], data: "AA==" });

const buildBody = (overrides: Record<string, unknown> = {}) => ({
  inputMint: "MintA",
  outputMint: "MintB",
  inAmount: "10",
  outAmount: "20",
  otherAmountThreshold: "9",
  swapMode: "ExactIn",
  slippageBps: 50,
  routePlan: [],
  computeBudgetInstructions: [instruction("ComputeBudget")],
  setupInstructions: [],
  swapInstruction: instruction("SwapProgram"),
  cleanupInstruction: null,
  otherInstructions: [],
  tipInstruction: null,
  addressesByLookupTableAddress: null,
  blockhashWithMetadata: { blockhash: [1, 2, 3], lastValidBlockHeight: 99 },
  ...overrides,
});

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const failResponse = (status: number, statusText: string, text: string) => ({
  ok: false,
  status,
  statusText,
  text: async () => text,
  json: async () => JSON.parse(text),
});

const makeClient = (respond: (call: FetchCall) => unknown) => {
  const calls: FetchCall[] = [];
  const fetchStub = async (url: string, init?: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { calls, client: new JupiterClient("https://jupiter.test", fetchStub as any, "test-key") };
};

const quoteRequest: JupiterQuoteRequest = { inputMint: "MintA", outputMint: "MintB", amount: "10" };

describe("JupiterClient coverage-d", () => {
  let errorSpy: ReturnType<typeof spyOn>;
  const originalApiKey = process.env.JUPITER_API_KEY;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    if (originalApiKey === undefined) {
      delete process.env.JUPITER_API_KEY;
    } else {
      process.env.JUPITER_API_KEY = originalApiKey;
    }
  });

  describe("normalizeQuote price impact", () => {
    test("derives priceImpactPct from the numeric priceImpact when the string is absent", async () => {
      const { client } = makeClient(() => okResponse(orderBody({ priceImpact: 0.75 })));
      const quote = await client.getQuote(quoteRequest);
      expect(quote.priceImpactPct).toBe("0.75");
      expect(quote.priceImpact).toBe(0.75);
    });

    test("defaults priceImpactPct to zero when the order carries no impact data", async () => {
      const { client } = makeClient(() => okResponse(orderBody()));
      const quote = await client.getQuote(quoteRequest);
      expect(quote.priceImpactPct).toBe("0");
    });
  });

  describe("getSwapTransaction", () => {
    const swapRequest = {
      userPublicKey: "UserKey",
      quoteResponse: {
        inputMint: "MintA",
        outputMint: "MintB",
        inAmount: "10",
        outAmount: "20",
        otherAmountThreshold: "9",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
        totalTime: 1,
      },
    };

    test("explains when the order switched to gasless mode without a transaction", async () => {
      const { client } = makeClient(() => okResponse(orderBody({ gasless: true })));
      await expect(client.getSwapTransaction(swapRequest)).rejects.toThrow(
        "Jupiter order switched to gasless mode and did not provide a transaction",
      );
    });

    test("explains when the order has no transaction at all", async () => {
      const { client } = makeClient(() => okResponse(orderBody({ transaction: null })));
      await expect(client.getSwapTransaction(swapRequest)).rejects.toThrow(
        "Jupiter order did not return a swap transaction",
      );
    });

    test("rejects an order that has a transaction but no requestId", async () => {
      const { client } = makeClient(() => okResponse(orderBody({ transaction: "AAAA" })));
      await expect(client.getSwapTransaction(swapRequest)).rejects.toThrow(
        "Jupiter order did not include a requestId",
      );
    });
  });

  describe("getBuildInstructions", () => {
    test("sends every optional parameter and returns the parsed build response", async () => {
      const body = buildBody();
      const { client, calls } = makeClient(() => okResponse(body));

      const result = await client.getBuildInstructions({
        ...quoteRequest,
        taker: "TakerKey",
        payer: "PayerKey",
        swapMode: "ExactOut",
        slippageBps: 75,
        maxAccounts: 32,
        platformFeeBps: 1,
        feeAccount: "FeeAccountKey",
      });

      expect(result.swapInstruction.programId).toBe("SwapProgram");
      expect(result.blockhashWithMetadata.lastValidBlockHeight).toBe(99);
      expect(calls).toHaveLength(1);
      const url = new URL(calls[0]!.url);
      expect(url.pathname).toBe("/swap/v2/build");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        inputMint: "MintA",
        outputMint: "MintB",
        amount: "10",
        taker: "TakerKey",
        payer: "PayerKey",
        swapMode: "ExactOut",
        slippageBps: "75",
        maxAccounts: "32",
        feeAccount: "FeeAccountKey",
      });
      expect(Number(url.searchParams.get("platformFeeBps"))).toBeGreaterThanOrEqual(1);
      expect((calls[0]!.init?.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    });

    test("wraps HTTP failures with the extracted Jupiter message", async () => {
      const { client } = makeClient(() =>
        failResponse(429, "Too Many Requests", JSON.stringify({ error: "slow down" })),
      );
      await expect(client.getBuildInstructions(quoteRequest)).rejects.toThrow(
        /Failed to request Jupiter build: Jupiter build failed: 429 Too Many Requests/,
      );
    });
  });

  describe("executeOrder", () => {
    const executeRequest = { requestId: "req-1", signedTransaction: "signed" };

    test("reports HTTP failures using the status line when no message is provided", async () => {
      const { client } = makeClient(() => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => ({}),
      }));
      await expect(client.executeOrder(executeRequest)).rejects.toThrow(
        "Failed to execute Jupiter order: Jupiter execute failed: 503 Service Unavailable",
      );
      expect(errorSpy).toHaveBeenCalledWith("Jupiter execute response", expect.any(String));
    });

    test("prefers the Jupiter error message on HTTP failures", async () => {
      const { client } = makeClient(() => ({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ errorMessage: "transaction expired" }),
      }));
      await expect(client.executeOrder(executeRequest)).rejects.toThrow(
        "Jupiter execute failed: transaction expired",
      );
    });

    test("surfaces error payloads returned with an OK status", async () => {
      const { client } = makeClient(() => okResponse({ error: "simulation failed" }));
      await expect(client.executeOrder(executeRequest)).rejects.toThrow(
        "Failed to execute Jupiter order: simulation failed",
      );
    });

    test("rejects non-success statuses", async () => {
      const { client } = makeClient(() => okResponse({ status: "Failed", signature: "sig" }));
      await expect(client.executeOrder(executeRequest)).rejects.toThrow(
        "Jupiter execute returned status Failed",
      );
    });

    test("rejects responses without any signature", async () => {
      const { client } = makeClient(() => okResponse({ status: "Success" }));
      await expect(client.executeOrder(executeRequest)).rejects.toThrow(
        "Jupiter execute response is missing a signature",
      );
    });

    test("accepts txid as the signature", async () => {
      const { client, calls } = makeClient(() => okResponse({ status: "Success", txid: "tx-1" }));
      const result = await client.executeOrder(executeRequest);
      expect(result.txid).toBe("tx-1");
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
        requestId: "req-1",
        signedTransaction: "signed",
      });
    });
  });
});

describe("fetchJupiterTokenMetadata coverage-d", () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("returns null without calling fetch for a blank query", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return okResponse([]);
    };
    expect(await fetchJupiterTokenMetadata("", fetchImpl as any)).toBeNull();
    expect(await fetchJupiterTokenMetadata("   ", fetchImpl as any)).toBeNull();
    expect(calls).toBe(0);
  });

  test("logs and returns null when the lookup throws", async () => {
    const failure = new Error("network down");
    const fetchImpl = async () => {
      throw failure;
    };
    expect(await fetchJupiterTokenMetadata("SOL", fetchImpl as any)).toBeNull();
    expect(errorSpy).toHaveBeenCalledWith("Failed to fetch Jupiter token metadata:", failure);
  });
});
