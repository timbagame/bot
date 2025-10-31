import { describe, test, expect } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager jupiter guard", () => {
  test("createSwapTransaction throws for jupiter provider", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest("test walk nut penalty hip pave soap entry language right filter choice", {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const sm = new SwapManager(connection, wallet);
    // Avoid network access inside setup routine
    (sm as any).createTokenAccountsIfNeeded = async () => [];
    const user = Keypair.generate();

    await expect(sm.createSwapTransaction({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000",
      userKeypair: user,
      inputDecimals: 9,
      outputDecimals: 6,
      inputTicker: "WSOL",
      outputTicker: "USDC",
    }, {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputAmount: "1000000",
      inputAmountRaw: "1000000",
      outputAmount: "100",
      estimatedRate: 0.0001,
      slippage: 1,
      provider: "jupiter",
    } as any)).rejects.toThrow(/Jupiter swaps should use executeJupiterSwap/);
  });

  test("canSwap returns reason when pump.fun validation fails", async () => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest("test walk nut penalty hip pave soap entry language right filter choice", {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const sm = new SwapManager(connection, wallet);
    (sm as any).getBestProvider = async () => "pump-fun";
    const res = await sm.canSwap("USDC", "BONK");
    expect(res.canSwap).toBe(false);
    expect(res.reason?.toLowerCase()).toContain("involve sol");
  });
});
