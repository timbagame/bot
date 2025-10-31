import { beforeAll, describe, expect, test } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";
import { normalizePumpFunAmount } from "../src/utils/swap/pump-fun-amount";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMP_MINT = "pumpMint123456789012345678901234567890123456";

const connection = new Connection("http://localhost:8899", "confirmed");
const wallet = WalletManager.createForTest(
  "test walk nut penalty hip pave soap entry language right filter choice",
  { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
);

function createSwapManager(): SwapManager {
  const sm = new SwapManager(connection, wallet);
  (sm.pumpFunClient as any).isPumpFunToken = async (mint: string) => ({
    isPumpFun: mint === PUMP_MINT,
    isGraduated: false,
  });
  return sm;
}

describe("SwapManager pump.fun amount normalization", () => {
  beforeAll(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
    process.env.MNEMONIC =
      process.env.MNEMONIC ||
      "test walk nut penalty hip pave soap entry language right filter choice";
  });

  test("sell flow forwards raw lamports for 6-dec token amounts", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      const decimalAmount = normalizePumpFunAmount(
        normalizedAmount,
        inputDecimals
      ).decimalAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: decimalAmount,
        outputAmount: "100000000", // dummy lamports
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    const quote = await sm.getQuote({
      inputMint: PUMP_MINT,
      outputMint: SOL_MINT,
      amount: "1000000",
      inputDecimals: 6,
      outputDecimals: 9,
      userKeypair: Keypair.generate(),
      inputTicker: "PUMP",
      outputTicker: "SOL",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("1000000");
    expect(quote.inputAmount).toBe("1");
    expect(quote.provider).toBe("pump-fun");
  });

  test("sell flow keeps fractional raw pump token lamports for pump.fun normalization", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      const decimalAmount = normalizePumpFunAmount(
        normalizedAmount,
        inputDecimals
      ).decimalAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: decimalAmount,
        outputAmount: "50000000",
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    await sm.getQuote({
      inputMint: PUMP_MINT,
      outputMint: SOL_MINT,
      amount: "1500000",
      inputDecimals: 6,
      outputDecimals: 9,
      userKeypair: Keypair.generate(),
      inputTicker: "PUMP",
      outputTicker: "SOL",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("1500000");
  });

  test("sell flow keeps raw lamports with trailing digits for pump.fun normalization", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      const decimalAmount = normalizePumpFunAmount(
        normalizedAmount,
        inputDecimals
      ).decimalAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: decimalAmount,
        outputAmount: "50000000",
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    await sm.getQuote({
      inputMint: PUMP_MINT,
      outputMint: SOL_MINT,
      amount: "1234567",
      inputDecimals: 6,
      outputDecimals: 9,
      userKeypair: Keypair.generate(),
      inputTicker: "PUMP",
      outputTicker: "SOL",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("1234567");
  });

  test("sell flow keeps 6-digit pump token integer input intact", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      const decimalAmount = normalizePumpFunAmount(
        normalizedAmount,
        inputDecimals
      ).decimalAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: decimalAmount,
        outputAmount: "50000000",
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    await sm.getQuote({
      inputMint: PUMP_MINT,
      outputMint: SOL_MINT,
      amount: "100000",
      inputDecimals: 6,
      outputDecimals: 9,
      userKeypair: Keypair.generate(),
      inputTicker: "PUMP",
      outputTicker: "SOL",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("100000");
  });

  test("sell flow keeps decimal pump token input stable", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      const decimalAmount = normalizePumpFunAmount(
        normalizedAmount,
        inputDecimals
      ).decimalAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: decimalAmount,
        outputAmount: "50000000",
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    await sm.getQuote({
      inputMint: PUMP_MINT,
      outputMint: SOL_MINT,
      amount: "0.5",
      inputDecimals: 6,
      outputDecimals: 9,
      userKeypair: Keypair.generate(),
      inputTicker: "PUMP",
      outputTicker: "SOL",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("0.5");
  });

  test("sell flow keeps small integer pump token input intact", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      const decimalAmount = normalizePumpFunAmount(
        normalizedAmount,
        inputDecimals
      ).decimalAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: decimalAmount,
        outputAmount: "50000000",
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    await sm.getQuote({
      inputMint: PUMP_MINT,
      outputMint: SOL_MINT,
      amount: "1",
      inputDecimals: 6,
      outputDecimals: 9,
      userKeypair: Keypair.generate(),
      inputTicker: "PUMP",
      outputTicker: "SOL",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("1");
  });

  test("buy flow forwards probable raw SOL lamports", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      const decimalAmount = normalizePumpFunAmount(
        normalizedAmount,
        inputDecimals
      ).decimalAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: decimalAmount,
        outputAmount: "1000000",
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    await sm.getQuote({
      inputMint: SOL_MINT,
      outputMint: PUMP_MINT,
      amount: "1000000000",
      inputDecimals: 9,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "SOL",
      outputTicker: "PUMP",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("1000000000");
  });

  test("buy flow keeps sub-one SOL lamports intact for pump.fun parsing", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      _inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: normalizedAmount,
        outputAmount: "1000000",
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    await sm.getQuote({
      inputMint: SOL_MINT,
      outputMint: PUMP_MINT,
      amount: "500000000",
      inputDecimals: 9,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "SOL",
      outputTicker: "PUMP",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("500000000");
  });

  test("buy flow keeps small integer SOL input intact", async () => {
    const sm = createSwapManager();
    let capturedAmount = "";
    (sm.pumpFunClient as any).getQuote = async (
      inputMint: string,
      outputMint: string,
      normalizedAmount: string,
      _inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: normalizedAmount,
        outputAmount: "1000000",
        estimatedRate: 1,
        slippage: slippageBps / 100,
        isGraduated: false,
      };
    };

    await sm.getQuote({
      inputMint: SOL_MINT,
      outputMint: PUMP_MINT,
      amount: "1",
      inputDecimals: 9,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "SOL",
      outputTicker: "PUMP",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("1");
  });
});
