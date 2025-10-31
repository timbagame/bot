import { beforeAll, describe, expect, test } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";
import { normalizePumpFunAmount } from "../src/utils/swap/pump-fun-amount";

const SOL_MINT = "So11111111111111111111111111111111111111112";

describe("SwapManager Jupiter fallback", () => {
  beforeAll(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com"; // ensure mainnet paths
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
    process.env.MNEMONIC = process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice";
  });

  const connection = new Connection("http://localhost:8899", "confirmed");
  const wallet = WalletManager.createForTest(process.env.MNEMONIC!, {
    connection,
    fetch: (globalThis.fetch as any),
    timeNow: () => Date.now(),
  });

  test("throws clear error when Jupiter fails and not a pump.fun token", async () => {
    const sm = new SwapManager(connection, wallet);
    // Force Jupiter to fail
    (sm as any).jupiterClient.getQuote = async () => { throw new Error("network down"); };
    // Force pump.fun detection negative
    (sm.pumpFunClient as any).isPumpFunToken = async () => ({ isPumpFun: false, isGraduated: false });

    await expect(sm.getQuote({
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputMint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      amount: "1000000",
      inputDecimals: 6,
      outputDecimals: 5,
      userKeypair: Keypair.generate(),
      inputTicker: "USDC",
      outputTicker: "BONK",
    })).rejects.toThrow(/No quote available/);
  });

  test("falls back to pump.fun when detected and Jupiter fails", async () => {
    const sm = new SwapManager(connection, wallet);
    // Force Jupiter to fail
    (sm as any).jupiterClient.getQuote = async () => { throw new Error("network down"); };
    // Force pump.fun detection positive (non-graduated)
    (sm.pumpFunClient as any).isPumpFunToken = async () => ({ isPumpFun: true, isGraduated: false });
    // Provide a fake pump.fun quote
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      amountStr: string,
      inputDecimals: number,
      _outputDecimals: number,
      _slippageBps: number
    ) => {
      const decimalAmount = normalizePumpFunAmount(amountStr, inputDecimals).decimalAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: decimalAmount,
        outputAmount: "2000000",
        estimatedRate: 2,
        slippage: 5,
        isGraduated: false,
      };
    };

    const quote = await sm.getQuote({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "PumpMint111111111111111111111111111111111111",
      amount: "1000000",
      inputDecimals: 9,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "WSOL",
      outputTicker: "PUMP",
    });

    expect(quote.provider).toBe("pump-fun");
    expect(quote.outputAmount).toBe("2000000");
  });

  test("prefers pump.fun path for non-graduated tokens and normalizes raw amount", async () => {
    const sm = new SwapManager(connection, wallet);

    (sm.pumpFunClient as any).isPumpFunToken = async (mint: string) => ({
      isPumpFun: mint !== SOL_MINT,
      isGraduated: false,
    });

    let receivedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      _inputMint: string,
      _outputMint: string,
      amountStr: string,
      inputDecimals: number,
      _outputDecimals: number,
      _slippageBps: number
    ) => {
      receivedAmount = amountStr;
      const decimalAmount = normalizePumpFunAmount(amountStr, inputDecimals).decimalAmount;
      return {
        inputMint: SOL_MINT,
        outputMint: "PumpMint111111111111111111111111111111111111",
        inputAmount: decimalAmount,
        outputAmount: "2000000",
        estimatedRate: 2,
        slippage: 5,
        isGraduated: false,
      };
    };

    (sm as any).jupiterClient.getQuote = async () => {
      throw new Error("should not reach jupiter");
    };

    const quote = await sm.getQuote({
      inputMint: SOL_MINT,
      outputMint: "PumpMint111111111111111111111111111111111111",
      amount: "1000000000",
      inputDecimals: 9,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "WSOL",
      outputTicker: "PUMP",
    });

    expect(quote.provider).toBe("pump-fun");
    expect(receivedAmount).toBe("1000000000");
    expect(quote.inputAmount).toBe("1");
  });

  test("uses Jupiter when no pump.fun tokens detected", async () => {
    const sm = new SwapManager(connection, wallet);

    (sm.pumpFunClient as any).isPumpFunToken = async () => ({
      isPumpFun: false,
      isGraduated: false,
    });

    (sm.pumpFunClient as any).getQuote = async () => {
      throw new Error("should not reach pump.fun");
    };

    (sm as any).jupiterClient.getQuote = async () => ({
      inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000",
      outAmount: "2000000",
      otherAmountThreshold: "0",
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: "0.1",
      routePlan: [],
      totalTime: 0,
      platformFee: null,
    });

    const quote = await sm.getQuote({
      inputMint: SOL_MINT,
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      inputDecimals: 9,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "WSOL",
      outputTicker: "USDC",
    });

    expect(quote.provider).toBe("jupiter");
    expect(quote.outputAmount).toBe("2000000");
  });
});
