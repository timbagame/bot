import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import {
  MIN_JUPITER_SWAP_FEE_LAMPORTS,
  JUPITER_FEE_SAFETY_MARGIN_LAMPORTS,
  SwapManager,
} from "../src/utils/swap-manager";
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

describe("SwapManager.executeJupiterSwap", () => {
  let origNet: string | undefined;
  beforeEach(() => {
    origNet = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  });
  afterEach(() => {
    process.env.SOLANA_NETWORK = origNet || process.env.SOLANA_NETWORK!;
  });

  test("executes serialized Jupiter transaction when user has enough SOL", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    (connection as any).getBalance = async () =>
      MIN_JUPITER_SWAP_FEE_LAMPORTS +
      JUPITER_FEE_SAFETY_MARGIN_LAMPORTS +
      100_000;

    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet, createFeeBudgetStub());

    (sm as any).createTokenAccountsIfNeeded = async () => [];
    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
    });
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

  test("throws when user lacks SOL for Jupiter fees", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    (connection as any).getBalance = async () => 0;

    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet, createFeeBudgetStub());

    (sm as any).createTokenAccountsIfNeeded = async () => [];

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

    await expect(sm.executeJupiterSwap(req, quote)).rejects.toThrow(
      /Not enough SOL/
    );
  });
});
