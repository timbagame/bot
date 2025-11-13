import { describe, test, expect } from "bun:test";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  TransactionInstruction,
} from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function createLookupTableAccount(): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [Keypair.generate().publicKey],
    },
  });
}

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
          `Transaction ${signature} expired before confirmation (last valid block height 100, current 105)`
        );
      }
      expect(signature).toBe("SIG2");
    };

    const ix = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [],
      data: Buffer.alloc(0),
    });

    const finalSignature = await wallet.sendAndConfirmWithResubmits([
      ix,
    ], [Keypair.generate()], {
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
      })
    ).rejects.toThrow(/timed out/);
    expect(connection.sendCalls).toBeGreaterThanOrEqual(2);
  });

  test("resubmits when confirmation fails because of lookup-table errors", async () => {
    const connection = new ResubmitConnection();
    const wallet = WalletManager.createForTest(MNEMONIC, {
      connection: connection as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    let confirmAttempts = 0;
    (wallet as any).confirmTransaction = async () => {
      confirmAttempts += 1;
      if (confirmAttempts === 1) {
        throw new Error("Lookup table not found");
      }
    };

    const lookupAccount = createLookupTableAccount();
    const ix = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [
        { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
      ],
      data: Buffer.alloc(0),
    });

    const finalSignature = await wallet.sendAndConfirmWithResubmits(
      [ix],
      [Keypair.generate()],
      {
        operationLabel: "Lookup alt resubmit",
        maxResubmits: 1,
        addressLookupTableAccounts: [lookupAccount],
      }
    );

    expect(finalSignature).toBe("SIG2");
    expect(confirmAttempts).toBe(2);
    expect(connection.sendCalls).toBeGreaterThan(1);
  });

  test("preserves lookup table snapshots across resubmits", async () => {
    const connection = new ResubmitConnection();
    const wallet = WalletManager.createForTest(MNEMONIC, {
      connection: connection as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    const lookupAccount = createLookupTableAccount();
    const lookupList = [lookupAccount];
    const seenLengths: number[] = [];
    const originalSendTransaction = wallet.sendTransaction.bind(wallet);
    wallet.sendTransaction = async (instructions, signers, options) => {
      seenLengths.push(options?.addressLookupTableAccounts?.length ?? 0);
      return await originalSendTransaction(instructions, signers, options);
    };

    let confirmCall = 0;
    (wallet as any).confirmTransaction = async () => {
      confirmCall += 1;
      if (confirmCall === 1) {
        lookupList.push(createLookupTableAccount());
        throw new Error("timeout");
      }
    };

    const ix = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [],
      data: Buffer.alloc(0),
    });

    await wallet.sendAndConfirmWithResubmits(
      [ix],
      [Keypair.generate()],
      {
        operationLabel: "Lookup snapshot",
        maxResubmits: 1,
        addressLookupTableAccounts: lookupList,
      }
    );

    expect(seenLengths).toEqual([1, 1]);
  });

  test("fails when lookup-table errors persist beyond resubmit limit", async () => {
    const connection = new ResubmitConnection();
    const wallet = WalletManager.createForTest(MNEMONIC, {
      connection: connection as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    (wallet as any).confirmTransaction = async () => {
      throw new Error("Lookup table not found");
    };

    const lookupAccount = createLookupTableAccount();
    const ix = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [
        { pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: true },
      ],
      data: Buffer.alloc(0),
    });

    await expect(
      wallet.sendAndConfirmWithResubmits([ix], [Keypair.generate()], {
        operationLabel: "Lookup fatal",
        maxResubmits: 1,
        addressLookupTableAccounts: [lookupAccount],
      })
    ).rejects.toThrow("Lookup table not found");

    expect(connection.sendCalls).toBeGreaterThanOrEqual(1);
  });
});
