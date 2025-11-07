import { describe, test, expect } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";

describe("SwapManager.executeJupiterTransaction errors", () => {
  test("throws friendly error when deserialization fails before wallet usage", async () => {
    const wallet = {
      signAndSendSerializedTransaction: async () => {
        throw new Error("sign should not be called");
      },
      confirmTransaction: async () => {
        throw new Error("confirm should not be called");
      },
    } as any;
    const connection = {} as any;
    const sm = new SwapManager(connection, wallet);
    const user = Keypair.generate();
    await expect(
      (sm as any).executeJupiterTransaction("not-base64-!!", user)
    ).rejects.toThrow(/Failed to execute Jupiter transaction/);
  });
});
