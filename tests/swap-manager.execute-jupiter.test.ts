import { Buffer } from "buffer";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Connection, Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager.executeJupiterSwap", () => {
  let origNet: string | undefined;
  beforeEach(() => { origNet = process.env.SOLANA_NETWORK; process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com"; });
  afterEach(() => { process.env.SOLANA_NETWORK = origNet || process.env.SOLANA_NETWORK!; });

  const buildBase64Tx = (payer: Keypair): string => {
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    return Buffer.from(tx.serialize()).toString("base64");
  };

  test("executes serialized Jupiter transaction and returns signature", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);

    const user = Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    // Avoid network and account creation
    (sm as any).createTokenAccountsIfNeeded = async () => [];
    // Stub Jupiter swap endpoint response
    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: base64Tx,
      requestId: "req-123",
    });

    let capturedExecuteRequest: any = null;
    (sm as any).jupiterClient.executeOrder = async (payload: any) => {
      capturedExecuteRequest = payload;
      return { status: "Success", signature: "SIG_JUP_123" };
    };

    const req = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      userKeypair: user,
      inputDecimals: 9,
      outputDecimals: 6,
      inputTicker: "WSOL",
      outputTicker: "USDC",
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
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [],
    });

    const sig = await sm.executeJupiterSwap(req, quote);
    expect(sig).toBe("SIG_JUP_123");
    expect(capturedExecuteRequest).toBeTruthy();
    expect(capturedExecuteRequest.requestId).toBe("req-123");
    expect(typeof capturedExecuteRequest.signedTransaction).toBe("string");
  });
});
