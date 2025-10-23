import { beforeAll, describe, expect, test } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

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

  test("sell flow normalizes raw 6-dec token amount to whole token", async () => {
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

    expect(capturedAmount).toBe("1");
    expect(quote.inputAmount).toBe("1");
    expect(quote.provider).toBe("pump-fun");
  });

  test("sell flow normalizes raw fractional pump token amounts when magnitude exceeds decimals", async () => {
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

    expect(capturedAmount).toBe("1.5");
  });

  test("sell flow normalizes raw pump token lamports without trailing zeros when magnitude exceeds decimals", async () => {
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

    expect(capturedAmount).toBe("1.234567");
  });

  test("sell flow keeps 6-digit pump token integer input intact", async () => {
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
      _inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: normalizedAmount,
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
      _inputDecimals: number,
      _outputDecimals: number,
      slippageBps: number
    ) => {
      capturedAmount = normalizedAmount;
      return {
        inputMint,
        outputMint,
        inputAmount: normalizedAmount,
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

  test("buy flow normalizes raw SOL lamports", async () => {
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
      amount: "1000000000",
      inputDecimals: 9,
      outputDecimals: 6,
      userKeypair: Keypair.generate(),
      inputTicker: "SOL",
      outputTicker: "PUMP",
      slippageBps: 100,
    });

    expect(capturedAmount).toBe("1");
  });

  test("buy flow normalizes sub-one SOL raw lamports", async () => {
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

    expect(capturedAmount).toBe("0.5");
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
