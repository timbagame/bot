import { describe, expect, test } from "bun:test";
import { Buffer } from "buffer";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import type { WalletManager } from "../src/utils/wallet";
import type { FeeBudgetProvider } from "../src/utils/fee-budget";

type MockConnection = {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
};

const BASE58_BLOCKHASH = "11111111111111111111111111111111";
const UPDATED_BASE58_BLOCKHASH = "BPFLoaderUpgradeab1e11111111111111111111111";
const SIGNATURE_OK = "2".repeat(88);
const SIGNATURE_ERR = "3".repeat(88);

const createBase64Transaction = (payer: Keypair): string => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BASE58_BLOCKHASH,
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

describe("SwapManager Jupiter confirmation", () => {
  const payer = Keypair.generate();
  const base64Tx = createBase64Transaction(payer);

  test("invokes wallet helpers to sign, send, and confirm", async () => {
    let capturedTx: string | null = null;
    let confirmed: string | null = null;

    const walletStub = {
      signAndSendSerializedTransaction: async (tx: string, signer: Keypair) => {
        capturedTx = tx;
        expect(signer).toBe(payer);
        return SIGNATURE_OK;
      },
      confirmTransaction: async (signature: string) => {
        confirmed = signature;
      },
    } as unknown as WalletManager;

    const connection: MockConnection = {
      getLatestBlockhash: async () => ({
        blockhash: UPDATED_BASE58_BLOCKHASH,
        lastValidBlockHeight: 999,
      }),
    };

    const manager = new SwapManager(connection as any, walletStub, feeBudgetStub);
    const result = await (manager as any).executeJupiterTransaction(base64Tx, payer);

    expect(result).toBe(SIGNATURE_OK);
    expect(confirmed).not.toBeNull();
    expect(confirmed!).toBe(SIGNATURE_OK);
    expect(capturedTx).not.toBeNull();
    expect(capturedTx).not.toEqual(base64Tx);
  });

  test("surfaces errors from confirmTransaction", async () => {
    const walletStub = {
      signAndSendSerializedTransaction: async () => SIGNATURE_ERR,
      confirmTransaction: async () => {
        throw new Error("RPC timeout");
      },
    } as unknown as WalletManager;

    const connection: MockConnection = {
      getLatestBlockhash: async () => ({
        blockhash: BASE58_BLOCKHASH,
        lastValidBlockHeight: 42,
      }),
    };

    const manager = new SwapManager(connection as any, walletStub, feeBudgetStub);
    await expect((manager as any).executeJupiterTransaction(base64Tx, payer)).rejects.toThrow(
      "RPC timeout"
    );
  });
});
