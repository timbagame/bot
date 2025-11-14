import { describe, test, expect, spyOn } from "bun:test";
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

  test("delegates to Jupiter formatting with computed slippage", () => {
    const stub = spyOn((sm as any).jupiterClient, "formatQuoteForDisplay").mockReturnValue("JUP_FMT");
    const quote = {
      provider: "jupiter",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputAmount: "100000000",
      inputAmountRaw: "100000000",
      outputAmount: "50000000",
      estimatedRate: 0.5,
      slippage: 0.75,
    } as any;

    const result = sm.formatQuoteForDisplay(quote, 9, 6, "SOL", "USDC");

    expect(result).toBe("JUP_FMT");
    expect(stub.mock.calls.length).toBe(1);
    const maybeArgs = stub.mock.calls[0]?.[0];
    if (!maybeArgs) {
      throw new Error("Jupiter formatter was not called");
    }
    const callArgs = maybeArgs as { slippageBps: number };
    expect(callArgs.slippageBps).toBe(75);
  });
});
