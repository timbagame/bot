import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager.executeJupiterSwap", () => {
  let origNet: string | undefined;
  beforeEach(() => {
    origNet = process.env.SOLANA_NETWORK;
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
  });
  afterEach(() => {
    process.env.SOLANA_NETWORK = origNet || process.env.SOLANA_NETWORK!;
  });

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

  test("executeJupiterTransaction replaces compute budget with capped values", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);

    const user = Keypair.generate();
    const limitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 900_000,
    });
    const priceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 4_000_000,
    });
    const payloadIx = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        {
          pubkey: user.publicKey,
          isSigner: true,
          isWritable: true,
        },
      ],
      data: Buffer.alloc(0),
    });

    (sm as any).extractJupiterInstructions = async () => ({
      instructions: [limitIx, priceIx, payloadIx],
      addressLookupTableAccounts: [],
    });

    const sent: TransactionInstruction[][] = [];
    const originalSend = wallet.sendAndConfirmWithResubmits;
    (wallet as any).sendAndConfirmWithResubmits = async (
      instructions: TransactionInstruction[]
    ) => {
      sent.push(instructions);
      return "SIG_CLAMP";
    };

    const signature = await (sm as any).executeJupiterTransaction(
      Buffer.from("dummy").toString("base64"),
      user
    );
    expect(signature).toBe("SIG_CLAMP");
    expect(sent).toHaveLength(1);
    const instructions = sent[0];
    if (!instructions) {
      throw new Error("Missing instruction payload");
    }
    expect(instructions.length).toBeGreaterThanOrEqual(3);
    const derivedLimitIx = instructions[0]!;
    expect(
      derivedLimitIx.programId.equals(ComputeBudgetProgram.programId)
    ).toBe(true);
    const limit = Buffer.from(derivedLimitIx.data).readUInt32LE(1);
    expect(limit).toBe(600_000);
    const derivedPriceIx = instructions[1]!;
    expect(
      derivedPriceIx.programId.equals(ComputeBudgetProgram.programId)
    ).toBe(true);
    expect(Buffer.from(derivedPriceIx.data)[0]).toBe(3);
    expect(Buffer.from(derivedPriceIx.data).readBigUInt64LE(1)).toBe(1n);
    expect(instructions[2]).toBe(payloadIx);

    (wallet as any).sendAndConfirmWithResubmits = originalSend;
  });

  test("executeJupiterTransaction rejects when extra signers are present", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);

    const user = Keypair.generate();
    const extraSigner = Keypair.generate();
    const payloadIx = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        {
          pubkey: extraSigner.publicKey,
          isSigner: true,
          isWritable: false,
        },
        {
          pubkey: user.publicKey,
          isSigner: true,
          isWritable: true,
        },
      ],
      data: Buffer.alloc(0),
    });

    (sm as any).extractJupiterInstructions = async () => ({
      instructions: [payloadIx],
      addressLookupTableAccounts: [],
    });

    await expect(
      (sm as any).executeJupiterTransaction(
        Buffer.from("dummy").toString("base64"),
        user
      )
    ).rejects.toThrow(/needs an extra signer/i);
  });
});
