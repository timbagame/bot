import { describe, test, expect } from "bun:test";
import { Connection, Keypair } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class ConnConfirmOk implements Partial<Connection> {
  calls = 0;
  async getSignatureStatus(_sig: string) {
    this.calls += 1;
    return { value: { confirmationStatus: "confirmed" } } as any;
  }
}

class ConnConfirmErr implements Partial<Connection> {
  async getSignatureStatus(_sig: string) {
    return { value: { err: { Custom: 1 }, confirmationStatus: "processed" } } as any;
  }
}

class ConnSendMock implements Partial<Connection> {
  async getLatestBlockhash() { return { blockhash: "BH", lastValidBlockHeight: 1 } as any; }
  async sendTransaction() { return "SIG123456"; }
}

describe("WalletManager confirmTransaction and sendTransaction", () => {
  test("confirmTransaction resolves when status is confirmed", async () => {
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: new ConnConfirmOk() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    await wm.confirmTransaction("FAKESIG");
  });

  test("confirmTransaction throws when status has err", async () => {
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: new ConnConfirmErr() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    await expect(wm.confirmTransaction("FAKESIG"))
      .rejects.toThrow(/Transaction failed/);
  });

  test("sendTransaction throws without signers", async () => {
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: new ConnSendMock() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    await expect(wm.sendTransaction([], [] as any)).rejects.toThrow(/No signers provided/);
  });

  test("transferSol delegates to sendTransaction and returns signature", async () => {
    const wm = WalletManager.createForTest(MNEMONIC, {
      connection: new ConnSendMock() as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
    // Stub sendTransaction directly to avoid building a real tx
    (wm as any).sendTransaction = async () => "ABCDEF12";
    const sig = await wm.transferSol(1n, Keypair.generate().publicKey, 0.5);
    expect(sig).toBe("ABCDEF12");
  });
});

