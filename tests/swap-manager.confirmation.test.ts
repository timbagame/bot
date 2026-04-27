import { describe, expect, test } from "bun:test";
import { Buffer } from "buffer";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import type { FeeBudgetProvider } from "../src/utils/fee-budget";

const SIGNATURE_OK = "2".repeat(88);

const createBase64Transaction = (payer: Keypair): string => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString("base64");
};

const feeBudgetStub = {
  getSingleTransactionLamports: async () => 0,
  getWrapFeeBufferLamports: async () => 0,
  getJitSwapFeeBufferLamports: async () => 0,
  getGameSafetyBufferLamports: async () => 0,
  getCachedSingleTransactionLamports: () => 0,
  getCachedWrapFeeBufferLamports: () => 0,
  getCachedGameSafetyBufferLamports: () => 0,
  getDefaultSingleTransactionLamports: () => 0,
  getDefaultWrapFeeBufferLamports: () => 0,
  getDefaultGameSafetyBufferLamports: () => 0,
} as unknown as FeeBudgetProvider;

describe("SwapManager Jupiter execution", () => {
  test("signs transaction and forwards payload to execute endpoint", async () => {
    const walletStub = {} as any;
    const connectionStub = {} as any;
    const manager = new SwapManager(
      connectionStub as any,
      walletStub,
      feeBudgetStub
    );
    const payer = Keypair.generate();
    const base64Tx = createBase64Transaction(payer);

    let captured: { requestId: string; signedTransaction: string } | null =
      null;
    (manager as any).jupiterClient.executeOrder = async (payload: any) => {
      captured = payload;
      return { status: "Success", signature: SIGNATURE_OK };
    };

    const result = await (manager as any).executeJupiterTransaction(
      base64Tx,
      "req-success",
      [payer]
    );

    expect(result).toBe(SIGNATURE_OK);
    expect(captured).not.toBeNull();
    expect(captured!.requestId).toBe("req-success");
    expect(captured!.signedTransaction).not.toEqual(base64Tx);
  });

  test("filters out signers not present in transaction account keys", async () => {
    const walletStub = {} as any;
    const connectionStub = {} as any;
    const manager = new SwapManager(
      connectionStub as any,
      walletStub,
      feeBudgetStub
    );
    const payer = Keypair.generate();
    const extraSigner = Keypair.generate();
    const base64Tx = createBase64Transaction(payer);

    let captured: { requestId: string; signedTransaction: string } | null =
      null;
    (manager as any).jupiterClient.executeOrder = async (payload: any) => {
      captured = payload;
      return { status: "Success", signature: SIGNATURE_OK };
    };

    const result = await (manager as any).executeJupiterTransaction(
      base64Tx,
      "req-filtered-signers",
      [payer, extraSigner]
    );

    expect(result).toBe(SIGNATURE_OK);
    expect(captured).not.toBeNull();
    expect(captured!.requestId).toBe("req-filtered-signers");

    const signedTx = VersionedTransaction.deserialize(
      Buffer.from(captured!.signedTransaction, "base64")
    );

    expect(signedTx.message.staticAccountKeys.map((key) => key.toBase58())).toEqual([
      payer.publicKey.toBase58(),
    ]);
    expect(signedTx.signatures).toHaveLength(1);
    expect(signedTx.signatures[0]).not.toEqual(new Uint8Array(64));
  });

  test("throws when execute endpoint omits signature", async () => {
    const walletStub = {} as any;
    const connectionStub = {} as any;
    const manager = new SwapManager(
      connectionStub as any,
      walletStub,
      feeBudgetStub
    );
    const payer = Keypair.generate();
    const base64Tx = createBase64Transaction(payer);

    (manager as any).jupiterClient.executeOrder = async () => ({
      status: "Success",
    });

    await expect(
      (manager as any).executeJupiterTransaction(base64Tx, "req-missing", [
        payer,
      ])
    ).rejects.toThrow(/did not return a signature/);
  });
});
