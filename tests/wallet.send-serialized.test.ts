import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "buffer";
import {
  Connection,
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  type SendOptions,
} from "@solana/web3.js";
import bs58 from "bs58";
import { WalletManager } from "../src/utils/wallet";

describe("WalletManager.signAndSendSerializedTransaction", () => {
  const mnemonic =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  let originalDeserialize: any;
  let wm: WalletManager;

  beforeEach(() => {
    // Monkey patch deserialize to avoid needing a real transaction buffer
    // @ts-ignore
    originalDeserialize = VersionedTransaction.deserialize;
    // @ts-ignore
    VersionedTransaction.deserialize = () => ({ sign: () => {} });

    wm = WalletManager.createForTest(mnemonic, {
      connection: {
        sendTransaction: async () => "UNUSED",
      } as Partial<Connection> as any,
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
    let called = false;
    (wm as any).signAndSendVersionedTransaction = async (
      tx: VersionedTransaction,
      signer: Keypair,
      opts: SendOptions
    ) => {
      expect(tx).toBeDefined();
      expect(signer).toBe(kp);
      expect(opts.skipPreflight).toBe(true);
      expect(opts.preflightCommitment).toBe("processed");
      called = true;
      return "SERIALIZED";
    };

    const sig = await wm.signAndSendSerializedTransaction("ZmFrZQ==", kp);
    expect(sig).toBe("SERIALIZED");
    expect(called).toBe(true);
  });

  test("maps address table errors to friendly message", async () => {
    const kp = Keypair.generate();
    (wm as any).signAndSendVersionedTransaction = async () => {
      throw new Error("address table account missing");
    };

    await expect(
      wm.signAndSendSerializedTransaction("ZmFrZQ==", kp)
    ).rejects.toThrow(/Address lookup table issue/i);
  });
});

describe("WalletManager.signAndSendVersionedTransaction", () => {
  const mnemonic =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const BLOCKHASH = "11111111111111111111111111111111";
  let connection: any;
  let wm: WalletManager;

  beforeEach(() => {
    connection = {
      sendTransaction: async () => {
        return "VERSIONED";
      },
    } as Partial<Connection> as any;

    wm = WalletManager.createForTest(mnemonic, {
      connection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
  });

  test("signs the transaction before sending", async () => {
    const payer = Keypair.generate();
    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);

    const signature = await wm.signAndSendVersionedTransaction(
      tx,
      payer,
      { skipPreflight: true },
      { blockhash: BLOCKHASH, lastValidBlockHeight: 42 }
    );

    const expectedSignature = bs58.encode(tx.signatures[0]!);
    expect(signature).toBe(expectedSignature);
  });

  test("signs additional required signers when available", async () => {
    const adminAwareConnection = {
      sendTransaction: async (transaction: VersionedTransaction) => {
        const firstZero = transaction
          .signatures[0]!
          .every((byte) => byte === 0);
        const secondZero = transaction
          .signatures[1]!
          .every((byte) => byte === 0);
        expect(firstZero).toBe(false);
        expect(secondZero).toBe(false);
        return "MULTI";
      },
    } as Partial<Connection> as any;

    const multiWallet = WalletManager.createForTest(mnemonic, {
      connection: adminAwareConnection,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });

    const admin = multiWallet.getAdminKeypair();
    const user = Keypair.generate();

    const instruction = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.alloc(0),
    });

    const message = new TransactionMessage({
      payerKey: admin.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [instruction],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);

    const sig = await multiWallet.signAndSendVersionedTransaction(
      tx,
      user,
      { skipPreflight: true },
      { blockhash: BLOCKHASH, lastValidBlockHeight: 1 }
    );

    expect(sig).toBeTruthy();
  });
});

describe("WalletManager.signVersionedTransactionOnly", () => {
  const mnemonic =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const BLOCKHASH = "11111111111111111111111111111111";
  let wm: WalletManager;

  beforeEach(() => {
    wm = WalletManager.createForTest(mnemonic, {
      connection: {
        sendTransaction: async () => "X",
      } as Partial<Connection> as any,
      fetch: globalThis.fetch as any,
      timeNow: () => Date.now(),
    });
  });

  test("preserves existing payer signature when not locally available", async () => {
    const payer = Keypair.generate();
    const user = Keypair.generate();

    const instruction = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.alloc(0),
    });

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [instruction],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    const originalSignature = Uint8Array.from({ length: 64 }, (_, i) =>
      i % 2 === 0 ? 123 : 45
    );
    tx.signatures[0] = originalSignature;

    const result = await wm.signVersionedTransactionOnly(tx, user);
    expect(result.primarySignature).toBe(bs58.encode(originalSignature));
    expect(
      tx.signatures[0]!.every((byte, idx) => byte === originalSignature[idx])
    ).toBe(true);
    expect(tx.signatures[1]!.some((byte) => byte !== 0)).toBe(true);
  });

  test("allows missing payer signature for externally executed swaps", async () => {
    const payer = Keypair.generate();
    const user = Keypair.generate();

    const instruction = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: user.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.alloc(0),
    });

    const message = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [instruction],
    }).compileToV0Message();

    const tx = new VersionedTransaction(message);
    tx.signatures[0] = new Uint8Array(64); // no payer signature yet

    const result = await wm.signVersionedTransactionOnly(tx, user);
    expect(result.primarySignature).toBe("");
    expect(tx.signatures[1]!.some((byte) => byte !== 0)).toBe(true);
    expect(tx.signatures[0]!.every((byte) => byte === 0)).toBe(true);
  });
});
