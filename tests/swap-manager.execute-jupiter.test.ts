import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { MIN_JUPITER_SWAP_FEE_LAMPORTS, JUPITER_FEE_SAFETY_MARGIN_LAMPORTS, SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";
import type { FeeBudgetProvider } from "../src/utils/fee-budget";

const fakeFetch = async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({}),
});

globalThis.fetch = fakeFetch as unknown as typeof fetch;

const fakeBlockhashResult = {
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 1,
};

(Connection.prototype as any).getLatestBlockhash = async function () {
  return fakeBlockhashResult;
};

(Connection.prototype as any).getLatestBlockhashAndContext = async function () {
  return { value: fakeBlockhashResult, context: { slot: 1 } };
};

const stubBalanceSequence = (connection: Connection, sequence: number[]) => {
  let idx = 0;
  (connection as any).getBalance = async () => {
    const value =
      idx < sequence.length ? sequence[idx] : sequence[sequence.length - 1];
    idx = Math.min(idx + 1, sequence.length);
    return value;
  };
};
describe("SwapManager.executeJupiterSwap", () => {
  let origNet: string | undefined;
  beforeEach(() => {
    origNet = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  });
  afterEach(() => {
    process.env.SOLANA_NETWORK = origNet || process.env.SOLANA_NETWORK!;
  });

const createFeeBudgetStub = (): FeeBudgetProvider => ({
    getSingleTransactionLamports: async () => 0,
    getWrapFeeBufferLamports: async () => 0,
    getJitSwapFeeBufferLamports: async () => 0,
    getGameSafetyBufferLamports: async () => 0,
    getCachedSingleTransactionLamports: () => 0,
    getCachedWrapFeeBufferLamports: () => 0,
    getCachedGameSafetyBufferLamports: () => 0,
    getDefaultSingleTransactionLamports: () => 0,
    getDefaultWrapFeeBufferLamports: () => 0,
    getDefaultGameSafetyBufferLamports: () => 0,
  });

  test("executes serialized Jupiter transaction and returns signature", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    stubBalanceSequence(connection, [0, 200_000]);
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet, createFeeBudgetStub());

    // Avoid network and account creation
    (sm as any).createTokenAccountsIfNeeded = async () => [];
    (sm as any).sponsorSwapFees = async () => {};
    (sm as any).refundSponsoredFees = async () => {};
    // Stub Jupiter swap endpoint response
    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
    });
    // Short-circuit the internal executor to avoid deserialization
    (sm as any).executeJupiterTransaction = async () => ({
      signature: "SIG_JUP_123",
      estimatedFee: 0,
    });

    const user = Keypair.generate();
    const req = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      userKeypair: user,
      inputDecimals: 9,
      outputDecimals: 6,
      inputTicker: "WSOL",
      outputTicker: "USDC",
      slippageBps: 100,
    } as const;

    const quote = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount: req.amount,
      inputAmountRaw: req.amount,
      outputAmount: "100",
      estimatedRate: 0.0001,
      slippage: 1,
      provider: "jupiter" as const,
    };

    (sm as any).jupiterClient.getQuote = async () => ({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inAmount: req.amount,
      outAmount: quote.outputAmount,
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: req.slippageBps,
      priceImpactPct: "0",
      routePlan: [],
    });

    const sig = await sm.executeJupiterSwap(req, quote);
    expect(sig).toBe("SIG_JUP_123");
  });

  test("does not sponsor when balance already meets requirement", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet, createFeeBudgetStub());

    const requiredBalance =
      MIN_JUPITER_SWAP_FEE_LAMPORTS + JUPITER_FEE_SAFETY_MARGIN_LAMPORTS;
    (sm as any).connection.getBalance = async () => requiredBalance;

    let sponsorCalls = 0;
    (sm as any).sponsorSwapFees = async () => {
      sponsorCalls += 1;
    };

    const user = Keypair.generate();
    const result = await (sm as any).ensureJupiterSwapFeeBudget(user);
    expect(result).toBe(0);
    expect(sponsorCalls).toBe(0);
  });

  test("refunds sponsors when account creation fails", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet, createFeeBudgetStub());

    (sm as any).connection.getBalance = async () => 0;
    (sm as any).createTokenAccountsIfNeeded = async () => {
      throw new Error("account creation failed");
    };

    let sponsoredAmount = 0;
    (sm as any).sponsorSwapFees = async (_kp: any, lamports: number) => {
      sponsoredAmount = lamports;
    };

    let refundedAmount = 0;
    (sm as any).refundSponsoredFees = async (_kp: any, lamports: number) => {
      refundedAmount = lamports;
    };

    const req = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      userKeypair: Keypair.generate(),
      inputDecimals: 9,
      outputDecimals: 6,
      inputTicker: "WSOL",
      outputTicker: "USDC",
      slippageBps: 100,
    } as const;

    const quote = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount: req.amount,
      inputAmountRaw: req.amount,
      outputAmount: "100",
      estimatedRate: 0.0001,
      slippage: 1,
      provider: "jupiter" as const,
    };

    await expect(sm.executeJupiterSwap(req, quote)).rejects.toThrow(
      "account creation failed"
    );

    expect(refundedAmount).toBe(sponsoredAmount);
    expect(sponsoredAmount).toBeGreaterThan(0);
  });

  test("refunds entire sponsorship after swap", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet, createFeeBudgetStub());

    (sm as any).createTokenAccountsIfNeeded = async () => [];
    const sponsoredAmount = 100_000;
    (sm as any).ensureJupiterSwapFeeBudget = async () => sponsoredAmount;
    const user = Keypair.generate();
    const req = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      userKeypair: user,
      inputDecimals: 9,
      outputDecimals: 6,
      inputTicker: "WSOL",
      outputTicker: "USDC",
      slippageBps: 100,
    } as const;

    const quote = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount: req.amount,
      inputAmountRaw: req.amount,
      outputAmount: "100",
      estimatedRate: 0.0001,
      slippage: 1,
      provider: "jupiter" as const,
    };

    (sm as any).executeJupiterTransaction = async () => ({
      signature: "SIG_JUP_FEE",
      estimatedFee: 150_000,
    });
    (sm as any).jupiterClient.getQuote = async () => ({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inAmount: req.amount,
      outAmount: "900000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: req.slippageBps,
      priceImpactPct: "0",
      routePlan: [],
    });
    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
    });

    let refundedAmount = 0;
    (sm as any).refundSponsoredFees = async (_kp: Keypair, lamports: number) => {
      refundedAmount = lamports;
    };

    const signature = await sm.executeJupiterSwap(req, quote);
    expect(signature).toBe("SIG_JUP_FEE");
    expect(refundedAmount).toBe(sponsoredAmount);
  });

  test("retries sponsorship after balance lookup fails", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet, createFeeBudgetStub());

    let firstAttempt = true;
    (sm as any).connection.getBalance = async () => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("rpc fail");
      }
      return 0;
    };
    let sponsorCount = 0;
    (sm as any).sponsorSwapFees = async () => {
      sponsorCount++;
    };

    const user = Keypair.generate();
    await expect(
      (sm as any).ensureJupiterSwapFeeBudget(user)
    ).rejects.toThrow("rpc fail");
    await (sm as any).ensureJupiterSwapFeeBudget(user);
    expect(sponsorCount).toBe(1);
  });

  test("logs and continues when refund fails after swap", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet, createFeeBudgetStub());

    (sm as any).createTokenAccountsIfNeeded = async () => [];
    const sponsoredAmount = 100_000;
    (sm as any).ensureJupiterSwapFeeBudget = async () => sponsoredAmount;
    (sm as any).executeJupiterTransaction = async () => ({
      signature: "SIG_JUP_FEE",
      estimatedFee: 90_000,
    });
    (sm as any).jupiterClient.getQuote = async () => ({
      inputMint: "Input",
      outputMint: "Output",
      inAmount: "0",
      outAmount: "0",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
    });
    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
    });

    let refundCalls = 0;
    (sm as any).refundSponsoredFees = async (_kp: Keypair, _lamports: number) => {
      refundCalls += 1;
      throw new Error("insufficient funds to refund");
    };

    const user = Keypair.generate();
    const req = {
      inputMint: "A",
      outputMint: "B",
      amount: "0",
      userKeypair: user,
      inputDecimals: 6,
      outputDecimals: 6,
      inputTicker: "TOKEN",
      outputTicker: "SOL",
    } as const;

    const quote = {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount: req.amount,
      inputAmountRaw: req.amount,
      outputAmount: "0",
      estimatedRate: 0,
      slippage: 1,
      provider: "jupiter" as const,
    };

    const signature = await sm.executeJupiterSwap(req, quote);
    expect(signature).toBe("SIG_JUP_FEE");
    expect(refundCalls).toBe(1);
  });
});
