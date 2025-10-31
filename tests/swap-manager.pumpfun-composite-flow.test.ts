import { beforeAll, describe, expect, test } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";
import { normalizePumpFunAmount } from "../src/utils/swap/pump-fun-amount";
import type { JupiterQuoteResponse } from "../src/utils/jupiter";
import type { PumpFunQuote } from "../src/utils/pump-fun";
import { WSOL_MINT } from "../src/utils/token-registry";

describe("SwapManager pump.fun composite quotes", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const wallet = WalletManager.createForTest(
    "test walk nut penalty hip pave soap entry language right filter choice",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );

  const pumpMint = "pumpFunMint1111111111111111111111111111111111";
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  beforeAll(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
    process.env.MNEMONIC =
      process.env.MNEMONIC ||
      "test walk nut penalty hip pave soap entry language right filter choice";
  });

  const createManager = () => {
    const manager = new SwapManager(connection, wallet);
    (manager.pumpFunClient as any).isPumpFunToken = async (mint: string) => ({
      isPumpFun: mint === pumpMint,
      isGraduated: false,
    });
    return manager;
  };

  const stubPumpQuote = (
    overrides: Partial<PumpFunQuote> = {}
  ): PumpFunQuote => ({
    inputMint: pumpMint,
    outputMint: WSOL_MINT,
    inputAmount: "1",
    outputAmount: "1000",
    estimatedRate: 1000,
    slippage: 5,
    isGraduated: false,
    ...overrides,
  });

  const stubJupiterQuote = (
    overrides: Partial<JupiterQuoteResponse> = {}
  ): JupiterQuoteResponse => ({
    inputMint: WSOL_MINT,
    inAmount: "1000",
    outputMint: usdcMint,
    outAmount: "250000", // 0.25 USDC assuming 6 decimals
    otherAmountThreshold: "0",
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: "0.1",
    routePlan: [],
    platformFee: null,
    ...overrides,
  });

  test("builds pump → SOL → Jupiter composite quote", async () => {
    const manager = createManager();
    (manager.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      amount: string,
      _inputDecimals: number,
      _outputDecimals: number,
      _slippageBps: number
    ) => {
      expect(inputMint).toBe(pumpMint);
      expect(outputMint).toBe(WSOL_MINT);
      expect(amount).toBe("1");
      return stubPumpQuote({ inputAmount: amount });
    };
    (manager as any).jupiterClient.getQuote = async () =>
      stubJupiterQuote({ inAmount: "1000" });

    const quote = await manager.getQuote({
      inputMint: pumpMint,
      outputMint: usdcMint,
      amount: "1",
      inputDecimals: 6,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "PUMP",
      outputTicker: "USDC",
      slippageBps: 50,
    });

    expect(quote.provider).toBe("pump-fun+jupiter");
    expect(quote.composite).toBeDefined();
    expect(quote.composite?.flow).toBe("pump-then-jupiter");
    expect(quote.composite?.pumpQuote.inputMint).toBe(pumpMint);
    expect(quote.composite?.jupiterQuote.inputMint).toBe(WSOL_MINT);
  });

  test("builds Jupiter → SOL → pump composite quote", async () => {
    const manager = createManager();
    (manager.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      amount: string,
      _inputDecimals: number,
      _outputDecimals: number,
      _slippageBps: number
    ) => {
      expect(inputMint).toBe(WSOL_MINT);
      expect(outputMint).toBe(pumpMint);
      expect(amount).toBe("0.001");
      return stubPumpQuote({
        inputMint,
        outputMint,
        inputAmount: amount,
        outputAmount: "5000000", // 5 pump tokens with 6 decimals
      });
    };
    (manager as any).jupiterClient.getQuote = async (request: {
      inputMint: string;
      outputMint: string;
      amount: string;
    }) => {
      expect(request.inputMint).toBe(usdcMint);
      expect(request.outputMint).toBe(WSOL_MINT);
      return stubJupiterQuote({
        inputMint: request.inputMint,
        outputMint: request.outputMint,
        inAmount: request.amount,
        outAmount: "1000000", // 0.001 SOL
      });
    };

    const quote = await manager.getQuote({
      inputMint: usdcMint,
      outputMint: pumpMint,
      amount: "1",
      inputDecimals: 6,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "USDC",
      outputTicker: "PUMP",
      slippageBps: 50,
    });

    expect(quote.provider).toBe("pump-fun+jupiter");
    expect(quote.composite?.flow).toBe("jupiter-then-pump");
    expect(quote.composite?.pumpQuote.outputMint).toBe(pumpMint);
    expect(quote.composite?.jupiterQuote.outputMint).toBe(WSOL_MINT);
  });

  test("pump → SOL composite forwards raw lamports to pump.fun", async () => {
    const manager = createManager();
    const rawAmount = "1000000"; // 1 token with 6 decimals
    (manager.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      amount: string,
      inputDecimals: number,
      _outputDecimals: number,
      _slippageBps: number
    ) => {
      expect(inputMint).toBe(pumpMint);
      expect(outputMint).toBe(WSOL_MINT);
      expect(amount).toBe(rawAmount);
      const decimalAmount = normalizePumpFunAmount(amount, inputDecimals).decimalAmount;
      return stubPumpQuote({ inputAmount: decimalAmount, outputAmount: "1000" });
    };

    (manager as any).jupiterClient.getQuote = async () =>
      stubJupiterQuote({ inAmount: "1000" });

    const quote = await manager.getQuote({
      inputMint: pumpMint,
      outputMint: usdcMint,
      amount: rawAmount,
      inputDecimals: 6,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "PUMP",
      outputTicker: "USDC",
      slippageBps: 50,
    });

    expect(quote.provider).toBe("pump-fun+jupiter");
    expect(quote.inputAmount).toBe("1");
    expect(quote.composite?.pumpQuote.inputAmount).toBe("1");
  });
});
