import { beforeAll, describe, expect, test } from "bun:test";
import { Connection } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager provider selection", () => {
  beforeAll(() => {
    process.env.SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
    process.env.TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "TEST_TOKEN";
    process.env.MNEMONIC = process.env.MNEMONIC || "test walk nut penalty hip pave soap entry language right filter choice";
  });

  const connection = new Connection("http://localhost:8899", "confirmed");
  const wallet = WalletManager.createForTest(process.env.MNEMONIC!, {
    connection,
    fetch: (globalThis.fetch as any),
    timeNow: () => Date.now(),
  });

  test("returns pump-fun when non-graduated token detected", async () => {
    const sm = new SwapManager(connection, wallet);
    // Force detection path
    (sm.pumpFunClient as any).isPumpFunToken = async () => ({ isPumpFun: true, isGraduated: false });

    const provider = await sm.getBestProvider("So11111111111111111111111111111111111111112", "pumpMint123456789012345678901234567890123456");
    expect(provider).toBe("pump-fun");
  });

  test("returns jupiter for non pump.fun tokens on mainnet", async () => {
    const sm = new SwapManager(connection, wallet);
    (sm.pumpFunClient as any).isPumpFunToken = async () => ({ isPumpFun: false, isGraduated: false });

    const provider = await sm.getBestProvider("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263");
    expect(provider).toBe("jupiter");
  });

  test("canSwap reports provider and success", async () => {
    const sm = new SwapManager(connection, wallet);
    (sm.pumpFunClient as any).isPumpFunToken = async () => ({ isPumpFun: true, isGraduated: false });

    const res = await sm.canSwap("So11111111111111111111111111111111111111112", "pumpMint123456789012345678901234567890123456");
    expect(res.canSwap).toBe(true);
    expect(res.provider).toBe("pump-fun");
  });
});
