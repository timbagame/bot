import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Connection } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager.canSwap on devnet", () => {
  let orig: string | undefined;
  beforeEach(() => { orig = process.env.SOLANA_NETWORK; process.env.SOLANA_NETWORK = "https://api.devnet.solana.com"; });
  afterEach(() => { process.env.SOLANA_NETWORK = orig || process.env.SOLANA_NETWORK!; });

  test("returns jupiter provider on devnet", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest("test walk nut penalty hip pave soap entry language right filter choice", {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    const sm = new SwapManager(connection, wallet);

    const res = await sm.canSwap(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "So11111111111111111111111111111111111111112"
    );
    expect(res.canSwap).toBe(true);
    expect(res.provider).toBe("jupiter");
  });
});

