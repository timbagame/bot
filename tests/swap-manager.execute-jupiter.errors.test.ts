import { Buffer } from "buffer";
import { describe, test, expect } from "bun:test";
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

const buildBase64Tx = (payer: Keypair): string => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString("base64");
};

describe("SwapManager.executeJupiterTransaction errors", () => {
  test("throws friendly error when deserialization fails before hitting execute", async () => {
    const wallet = {} as any;
    const connection = {} as any;
    const sm = new SwapManager(connection, wallet);
    const user = Keypair.generate();
    (sm as any).jupiterClient.executeOrder = async () => {
      throw new Error("execute should not be called");
    };

    await expect(
      (sm as any).executeJupiterTransaction("not-base64-!!", "req-1", user)
    ).rejects.toThrow(/Failed to execute Jupiter transaction/);
  });

  test("surfaces execute endpoint errors", async () => {
    const wallet = {} as any;
    const connection = {} as any;
    const sm = new SwapManager(connection, wallet);
    const user = Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    (sm as any).jupiterClient.executeOrder = async () => ({
      status: "Failed",
      errorMessage: "Minimum $10 for gasless",
    });

    await expect(
      (sm as any).executeJupiterTransaction(base64Tx, "req-2", user)
    ).rejects.toThrow("Minimum $10 for gasless");
  });
});

describe("SwapManager.executeJupiterSwap requestId handling", () => {
  test("continues when swapResponse requestId differs from quote provider", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);
    (sm as any).createTokenAccountsIfNeeded = async () => [];
    (sm as any).executeJupiterTransaction = async () => "SIG";

    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
      requestId: "req-exec",
    });

    const quote = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputAmount: "1000",
      inputAmountRaw: "1000",
      outputAmount: "2000",
      estimatedRate: 2,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "1000",
        outAmount: "2000",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
        requestId: "req-quote",
      },
      providerQuoteTimestamp: Date.now(),
    };

    await expect(
      sm.executeJupiterSwap(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount,
          userKeypair: Keypair.generate(),
          inputDecimals: 9,
          outputDecimals: 6,
          inputTicker: "SOL",
          outputTicker: "USDC",
        },
        quote
      )
    ).resolves.toBe("SIG");
  });
});
