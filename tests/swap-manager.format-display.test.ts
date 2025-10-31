import { describe, test, expect } from "bun:test";
import { Connection } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager.formatQuoteForDisplay", () => {
  const connection = new Connection("http://localhost:8899", "confirmed");
  const wallet = WalletManager.createForTest(
    "test walk nut penalty hip pave soap entry language right filter choice",
    { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
  );
  const sm = new SwapManager(connection, wallet);

  test("formats via pump-fun client when provider is pump-fun", () => {
    (sm as any).pumpFunClient.formatQuoteForDisplay = () => "PUMP_FMT";
    const msg = sm.formatQuoteForDisplay(
      {
        provider: "pump-fun",
        inputMint: "SOL",
        outputMint: "PUMP",
        inputAmount: "1",
        inputAmountRaw: "1",
        outputAmount: "2",
        estimatedRate: 2,
        slippage: 1,
      } as any,
      9,
      6,
      "SOL",
      "PUMP"
    );
    expect(msg).toBe("PUMP_FMT");
  });

  test("formats via jupiter client when provider is jupiter", () => {
    (sm as any).jupiterClient.formatQuoteForDisplay = () => "JUP_FMT";
    const msg = sm.formatQuoteForDisplay(
      {
        provider: "jupiter",
        inputMint: "SOL",
        outputMint: "USDC",
        inputAmount: "1",
        inputAmountRaw: "1",
        outputAmount: "1",
        estimatedRate: 1,
        slippage: 1,
      } as any,
      9,
      6,
      "SOL",
      "USDC"
    );
    expect(msg).toBe("JUP_FMT");
  });

  test("returns unsupported message for unknown provider", () => {
    const msg = sm.formatQuoteForDisplay(
      {
        provider: "unknown",
        inputMint: "SOL",
        outputMint: "X",
        inputAmount: "1",
        inputAmountRaw: "1",
        outputAmount: "1",
        estimatedRate: 1,
        slippage: 1,
      } as any,
      9,
      6,
      "SOL",
      "X"
    );
    expect(msg).toContain("Unsupported provider");
  });
});
