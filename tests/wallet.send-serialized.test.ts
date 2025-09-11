import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

describe("WalletManager.signAndSendSerializedTransaction", () => {
  const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  let originalDeserialize: any;
  let connection: any;
  let wm: WalletManager;

  beforeEach(() => {
    // Monkey patch deserialize to avoid needing a real transaction buffer
    // @ts-ignore
    originalDeserialize = VersionedTransaction.deserialize;
    // @ts-ignore
    VersionedTransaction.deserialize = () => ({ sign: () => {} });

    connection = {
      sendTransaction: async () => "FAKESIG",
    } as Partial<Connection> as any;

    wm = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
  });

  afterEach(() => {
    // @ts-ignore
    VersionedTransaction.deserialize = originalDeserialize;
  });

  test("returns signature on success", async () => {
    const kp = Keypair.generate();
    const sig = await wm.signAndSendSerializedTransaction("ZmFrZQ==", kp); // base64("fake")
    expect(sig).toBe("FAKESIG");
  });

  test("maps address table errors to friendly message", async () => {
    connection.sendTransaction = async () => { throw new Error("address table account missing"); };
    const kp = Keypair.generate();
    await expect(wm.signAndSendSerializedTransaction("ZmFrZQ==", kp))
      .rejects.toThrow(/Address lookup table issue/i);
  });
});

