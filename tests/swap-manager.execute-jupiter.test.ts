import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager.executeJupiterSwap", () => {
  let origNet: string | undefined;
  beforeEach(() => { origNet = process.env.SOLANA_NETWORK; process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com"; });
  afterEach(() => { process.env.SOLANA_NETWORK = origNet || process.env.SOLANA_NETWORK!; });

  test("executes serialized Jupiter transaction and returns signature", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);

    // Avoid network and account creation
    (sm as any).createTokenAccountsIfNeeded = async () => [];
    // Stub Jupiter swap endpoint response
    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
      lastValidBlockHeight: 0,
      prioritizationFeeLamports: 0,
      computeUnitLimit: 0,
      prioritizationFeeInstructions: [],
      addressLookupTableAddresses: [],
    });
    // Short-circuit the internal executor to avoid deserialization
    (sm as any).executeJupiterTransaction = async () => "SIG_JUP_123";

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
      outputAmount: "100",
      estimatedRate: 0.0001,
      slippage: 1,
      provider: "jupiter" as const,
    };

    (sm as any).jupiterClient.getQuote = async () => ({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount: req.amount,
      outputAmount: quote.outputAmount,
      slippage: quote.slippage,
      estimatedRate: quote.estimatedRate,
      otherAmountThreshold: "0",
    });

    const sig = await sm.executeJupiterSwap(req, quote);
    expect(sig).toBe("SIG_JUP_123");
  });
});
