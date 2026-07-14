import { describe, test, expect } from "bun:test";
import { Connection, Keypair, TransactionInstruction } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

class ResubmitConnection implements Partial<Connection> {
  public sendCalls = 0;

  async getLatestBlockhash() {
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100 + this.sendCalls,
    } as any;
  }

  async sendTransaction() {
    this.sendCalls += 1;
    return this.sendCalls === 1 ? "SIG1" : `SIG${this.sendCalls}`;
  }
}

describe("WalletManager sendAndConfirmWithResubmits", () => {
  test("re-signs and confirms on blockhash expiry", async () => {
    const connection = new ResubmitConnection();
    const wallet = WalletManager.createForTest(MNEMONIC, {
      connection: connection as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    const observedSignatures: string[] = [];
    let confirmCalls = 0;

    (wallet as any).confirmTransaction = async (signature: string) => {
      confirmCalls += 1;
      observedSignatures.push(signature);
      if (confirmCalls === 1) {
        throw new Error(
          `Transaction ${signature} expired before confirmation (last valid block height 100, current 105)`,
        );
      }
      expect(signature).toBe("SIG2");
    };

    const ix = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [],
      data: Buffer.alloc(0),
    });

    const finalSignature = await wallet.sendAndConfirmWithResubmits([ix], [Keypair.generate()], {
      operationLabel: "Test transaction",
    });

    expect(finalSignature).toBe("SIG2");
    expect(confirmCalls).toBe(2);
    expect(connection.sendCalls).toBe(2);
    expect(observedSignatures).toEqual(["SIG1", "SIG2"]);
  });

  test("surfaces error after exhausting resubmits", async () => {
    const connection = new ResubmitConnection();
    const wallet = WalletManager.createForTest(MNEMONIC, {
      connection: connection as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    (wallet as any).confirmTransaction = async (signature: string) => {
      throw new Error(`Transaction ${signature} timed out`);
    };

    const ix = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [],
      data: Buffer.alloc(0),
    });

    await expect(
      wallet.sendAndConfirmWithResubmits([ix], [Keypair.generate()], {
        operationLabel: "Failing transaction",
        maxResubmits: 1,
      }),
    ).rejects.toThrow(/timed out/);
    expect(connection.sendCalls).toBeGreaterThanOrEqual(2);
  });
});
