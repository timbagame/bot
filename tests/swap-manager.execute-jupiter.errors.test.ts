import { Buffer } from "buffer";
import { describe, test, expect } from "bun:test";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";

const buildBase64Tx = (payer: Keypair): string => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString("base64");
};

describe("SwapManager.executeJupiterTransaction errors", () => {
  test("throws friendly error when deserialization fails before hitting execute", async () => {
    const wallet = {} as any;
    const connection = {} as any;
    const sm = new SwapManager(connection, wallet);
    const user = Keypair.generate();
    (sm as any).jupiterClient.executeOrder = async () => {
      throw new Error("execute should not be called");
    };

    await expect(
      (sm as any).executeJupiterTransaction("not-base64-!!", "req-1", user)
    ).rejects.toThrow(/Failed to execute Jupiter transaction/);
  });

  test("surfaces execute endpoint errors", async () => {
    const wallet = {} as any;
    const connection = {} as any;
    const sm = new SwapManager(connection, wallet);
    const user = Keypair.generate();
    const base64Tx = buildBase64Tx(user);

    (sm as any).jupiterClient.executeOrder = async () => ({
      status: "Failed",
      errorMessage: "Minimum $10 for gasless",
    });

    await expect(
      (sm as any).executeJupiterTransaction(base64Tx, "req-2", user)
    ).rejects.toThrow("Minimum $10 for gasless");
  });
});
