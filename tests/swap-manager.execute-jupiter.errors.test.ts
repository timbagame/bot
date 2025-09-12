import { describe, test, expect } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

describe("SwapManager.executeJupiterTransaction errors", () => {
  test("throws friendly error when deserialization fails", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);
    const user = Keypair.generate();
    await expect(
      (sm as any).executeJupiterTransaction("not-base64-!!", user)
    ).rejects.toThrow(/Failed to execute Jupiter transaction/);
  });
});

