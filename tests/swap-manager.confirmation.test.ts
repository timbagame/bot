import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { SwapManager } from "../src/utils/swap-manager";
import type { WalletManager } from "../src/utils/wallet";
import type { FeeBudgetProvider } from "../src/utils/fee-budget";

type SignatureStatusResponse = { value: Array<any> };

type MockConnectionDeps = {
  confirmBehavior?: "success" | "timeout";
  signatureStatuses?: Array<any>;
};

type MockConnection = {
  getLatestBlockhash: () => Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendTransaction: (tx: VersionedTransaction, options: Record<string, unknown>) => Promise<string>;
  confirmTransaction: (
    args: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment: string
  ) => Promise<{ value: { err: null } }>;
  getSignatureStatuses: (
    signatures: string[],
    config: { searchTransactionHistory: boolean }
  ) => Promise<SignatureStatusResponse>;
};

const BASE58_BLOCKHASH = "11111111111111111111111111111111";
const SIGNATURE_CONFIRMED = "2".repeat(88);
const SIGNATURE_TIMEOUT_SUCCESS = "3".repeat(88);
const SIGNATURE_TIMEOUT_FAILURE = "4".repeat(88);

const createBase64Transaction = (payer: Keypair): string => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: BASE58_BLOCKHASH,
    instructions: [],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString("base64");
};

const createMockConnection = (
  signature: string,
  deps: MockConnectionDeps = {}
): {
  connection: MockConnection;
  metrics: { readonly confirmCalls: number; readonly statusCalls: number };
} => {
  const { confirmBehavior = "success", signatureStatuses = [] } = deps;
  let confirmCalls = 0;
  let statusCalls = 0;

  const connection: MockConnection = {
    getLatestBlockhash: async () => ({
      blockhash: BASE58_BLOCKHASH,
      lastValidBlockHeight: 123456,
    }),
    sendTransaction: async (
      _tx: VersionedTransaction,
      _options: Record<string, unknown>
    ) => signature,
    confirmTransaction: async (_strategy: any, _commitment: string) => {
      confirmCalls += 1;
      if (confirmBehavior === "timeout") {
        throw new Error("Transaction was not confirmed in 30.00 seconds.");
      }
      return { value: { err: null } };
    },
    getSignatureStatuses: async (_signatures: string[], _config: any) => {
      statusCalls += 1;
      const next = signatureStatuses.shift() ?? null;
      return { value: [next] };
    },
  };

  return {
    connection,
    metrics: {
      get confirmCalls() {
        return confirmCalls;
      },
      get statusCalls() {
        return statusCalls;
      },
    },
  };
};

const walletStub = {} as WalletManager;
const feeBudgetStub = {
  getGameSafetyBufferLamports: () => 0,
  getJitSwapFeeBufferLamports: () => 0,
} as unknown as FeeBudgetProvider;

const originalEnvInterval = process.env["SWAP_CONFIRMATION_POLL_INTERVAL_MS"];
const originalEnvDuration = process.env["SWAP_CONFIRMATION_POLL_DURATION_MS"];

describe("SwapManager Jupiter confirmation", () => {
  const payer = Keypair.generate();
  const base64Tx = createBase64Transaction(payer);

  beforeEach(() => {
    process.env["SWAP_CONFIRMATION_POLL_INTERVAL_MS"] = "1";
    process.env["SWAP_CONFIRMATION_POLL_DURATION_MS"] = "10";
  });

  afterEach(() => {
    if (originalEnvInterval === undefined) {
      delete process.env["SWAP_CONFIRMATION_POLL_INTERVAL_MS"];
    } else {
      process.env["SWAP_CONFIRMATION_POLL_INTERVAL_MS"] = originalEnvInterval;
    }

    if (originalEnvDuration === undefined) {
      delete process.env["SWAP_CONFIRMATION_POLL_DURATION_MS"];
    } else {
      process.env["SWAP_CONFIRMATION_POLL_DURATION_MS"] = originalEnvDuration;
    }
  });

  test("executes Jupiter transaction when RPC confirms immediately", async () => {
    const { connection, metrics } = createMockConnection(SIGNATURE_CONFIRMED);

    const manager = new SwapManager(connection as any, walletStub, feeBudgetStub);

    const result = await (manager as any).executeJupiterTransaction(base64Tx, payer);

    expect(result).toBe(SIGNATURE_CONFIRMED);
    expect(metrics.confirmCalls).toBe(1);
    expect(metrics.statusCalls).toBe(0);
  });

  test("recovers from RPC timeout by polling signature until confirmed", async () => {
    const { connection } = createMockConnection(SIGNATURE_TIMEOUT_SUCCESS, {
      confirmBehavior: "timeout",
      signatureStatuses: [
        { confirmations: 0, confirmationStatus: "processed" },
        { confirmations: 1, confirmationStatus: "confirmed" },
      ],
    });

    const manager = new SwapManager(connection as any, walletStub, feeBudgetStub);

    const result = await (manager as any).executeJupiterTransaction(base64Tx, payer);

    expect(result).toBe(SIGNATURE_TIMEOUT_SUCCESS);
  });

  test("throws descriptive error when signature never confirms", async () => {
    const { connection } = createMockConnection(SIGNATURE_TIMEOUT_FAILURE, {
      confirmBehavior: "timeout",
      signatureStatuses: [
        { confirmations: 0, confirmationStatus: "processed" },
        { confirmations: 0, confirmationStatus: "processed" },
      ],
    });

    const manager = new SwapManager(connection as any, walletStub, feeBudgetStub);

    await expect(
      (manager as any).executeJupiterTransaction(base64Tx, payer)
    ).rejects.toThrow(
      `Failed to execute Jupiter transaction: Transaction confirmation timed out after extended polling. Check signature ${SIGNATURE_TIMEOUT_FAILURE}`
    );
  });
});
