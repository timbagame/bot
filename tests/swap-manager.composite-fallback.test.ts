import { beforeAll, describe, expect, test } from "bun:test";
import {
  Connection,
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";
import { WSOL_MINT } from "../src/utils/token-registry";

const PUMP_MINT = "pumpFunMint1111111111111111111111111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MNEMONIC =
  "test walk nut penalty hip pave soap entry language right filter choice";

describe("SwapManager composite sequential fallback", () => {
  beforeAll(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
    process.env.MNEMONIC = process.env.MNEMONIC || MNEMONIC;
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
  });

  const connection = new Connection("http://localhost:8899", "confirmed");
  const wallet = WalletManager.createForTest(process.env.MNEMONIC!, {
    connection,
    fetch: (globalThis.fetch as any),
    timeNow: () => Date.now(),
  });

  test("rejects when sequential Jupiter fallback fails after pump leg", async () => {
    const manager = new SwapManager(connection, wallet);
    const userKeypair = wallet.getKeyPair(123n);

    (manager as any).createTokenAccountsIfNeeded = async () => [];
    (manager.pumpFunClient as any).createSwapPlan = async () => ({
      instructions: [
        new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: [],
          data: Buffer.from([1]),
        }),
      ],
      direction: "sell",
      expectedOutputAmount: 1n,
      minOutputAmount: 1n,
    });

    (manager as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: "fake-tx",
    });

    const extraSigner = Keypair.generate().publicKey;
    (manager as any).extractJupiterInstructions = async () => ({
      instructions: [
        new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: [
            { pubkey: userKeypair.publicKey, isSigner: true, isWritable: false },
            { pubkey: extraSigner, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([1]),
        }),
      ],
      addressLookupTableAccounts: [],
    });

    (manager as any).executeSequentialCompositeSwapFallback = async () => {
      throw new Error("Jupiter fallback failure");
    };

    const quote = {
      provider: "pump-fun+jupiter",
      inputMint: PUMP_MINT,
      outputMint: USDC_MINT,
      inputAmount: "100",
      inputAmountRaw: "1000000",
      outputAmount: "0",
      slippage: 5,
      composite: {
        flow: "pump-then-jupiter",
        pumpQuote: {
          inputMint: PUMP_MINT,
          outputMint: WSOL_MINT,
          inputAmount: "1",
          inputAmountRaw: "1000000",
          outputAmount: "1000",
          estimatedRate: 1,
          slippage: 5,
        },
        jupiterQuote: {
          inputMint: WSOL_MINT,
          outputMint: USDC_MINT,
          inAmount: "1000",
          outAmount: "100",
          otherAmountThreshold: "0",
          swapMode: "ExactIn",
          slippageBps: 50,
          priceImpactPct: "0",
          routePlan: [],
          platformFee: null,
        },
        intermediateAmount: "1000",
      },
    } as const;

    const request = {
      userKeypair,
      inputMint: PUMP_MINT,
      outputMint: USDC_MINT,
      slippageBps: 500,
      inputDecimals: 6,
      outputDecimals: 6,
      inputTicker: "PUMP",
      outputTicker: "USDC",
      amount: "1000000",
    } as const;

    await expect(
      manager.executeCompositePumpFunJupiterSwap(request, quote as any)
    ).rejects.toThrow("Jupiter fallback failure");
  });
});
