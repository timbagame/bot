import { Buffer } from "buffer";
import { describe, test, expect } from "bun:test";
import {
  Connection,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { IntegratorSwapParams } from "../src/utils/integrator-fees";
import type { JupiterUltraOrderResponse } from "../src/utils/jupiter";
import { SwapManager } from "../src/utils/swap-manager";
import { WalletManager } from "../src/utils/wallet";

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
      (sm as any).executeJupiterTransaction("not-base64-!!", "req-1", [user])
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
      (sm as any).executeJupiterTransaction(base64Tx, "req-2", [user])
    ).rejects.toThrow("Minimum $10 for gasless");
  });
});

describe("SwapManager.executeJupiterSwap requestId handling", () => {
  test("continues when swapResponse requestId differs from quote provider", async () => {
    const connection = new Connection("http://localhost:8899", "confirmed");
    const wallet = WalletManager.createForTest(
      "test walk nut penalty hip pave soap entry language right filter choice",
      { connection, fetch: globalThis.fetch as any, timeNow: () => Date.now() }
    );
    const sm = new SwapManager(connection, wallet);
    (sm as any).createTokenAccountsIfNeeded = async () => [];
    (sm as any).executeJupiterTransaction = async () => "SIG";

    (sm as any).jupiterClient.getSwapTransaction = async () => ({
      swapTransaction: Buffer.from("fake").toString("base64"),
      requestId: "req-exec",
    });

    const quote = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputAmount: "1000",
      inputAmountRaw: "1000",
      outputAmount: "2000",
      estimatedRate: 2,
      slippage: 1,
      provider: "jupiter" as const,
      providerQuote: {
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inAmount: "1000",
        outAmount: "2000",
        otherAmountThreshold: "0",
        swapMode: "ExactIn",
        slippageBps: 100,
        priceImpactPct: "0",
        routePlan: [],
        requestId: "req-quote",
      },
      providerQuoteTimestamp: Date.now(),
    };

    await expect(
      sm.executeJupiterSwap(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount,
          userKeypair: Keypair.generate(),
          inputDecimals: 9,
          outputDecimals: 6,
          inputTicker: "SOL",
          outputTicker: "USDC",
        },
        quote
      )
    ).resolves.toBe("SIG");
  });
});

describe("SwapManager.ensureAdminCanCoverRoute", () => {
  const buildSwapManagerWithBalance = (balance: number): SwapManager => {
    const walletStub = {
      getConnection: () =>
        ({
          getBalance: async () => balance,
        } as unknown as Connection),
      formatSolBalance: (lamports: number) => `${lamports} lamports`,
    } as unknown as WalletManager;
    return new SwapManager({} as Connection, walletStub);
  };

  const buildBaseOrder = (
    overrides?: Partial<JupiterUltraOrderResponse>
  ): JupiterUltraOrderResponse => ({
    mode: "ExactIn",
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
    inAmount: "1000",
    outAmount: "2000",
    otherAmountThreshold: "0",
    swapMode: "ExactIn",
    slippageBps: 100,
    priceImpactPct: "0",
    routePlan: [],
    requestId: "route-rent",
    router: "iris",
    ...overrides,
  });

  const baseIntegrator: IntegratorSwapParams = {
    referralAccount: "dummy",
    referralFee: 100,
    payer: "payer",
    closeAuthority: "close",
    payerKind: "admin",
    adminRequiredLamports: 10_000_000,
  };

  test("allows admin to cover rent-heavy Jupiter routes when balanced", async () => {
    const swapManager = buildSwapManagerWithBalance(13_000_000);
    const integrator = { ...baseIntegrator };
    const order = buildBaseOrder({
      rentFeeLamports: 2_000_000,
      prioritizationFeeLamports: 300_000,
      signatureFeeLamports: 10_000,
    });

    await expect(
      (swapManager as any).ensureAdminCanCoverRoute(
        integrator,
        order,
        Keypair.generate().publicKey
      )
    ).resolves.toBeUndefined();
  });

  test("throws when the admin wallet balance is below the total requirement", async () => {
    const swapManager = buildSwapManagerWithBalance(5_000_000);
    const integrator = { ...baseIntegrator, adminRequiredLamports: 8_000_000 };
    const order = buildBaseOrder({
      rentFeeLamports: 0,
      prioritizationFeeLamports: 0,
      signatureFeeLamports: 0,
    });

    await expect(
      (swapManager as any).ensureAdminCanCoverRoute(
        integrator,
        order,
        Keypair.generate().publicKey
      )
    ).rejects.toThrow(/cannot cover rent\+priority/i);
  });

  test("throws when admin balance is insufficient for rent-heavy padded requirement", async () => {
    const routeLamports = 2_000_000;
    const swapManager = buildSwapManagerWithBalance(12_000_000);
    const integrator = { ...baseIntegrator };
    const order = buildBaseOrder({
      rentFeeLamports: routeLamports,
      prioritizationFeeLamports: 300_000,
      signatureFeeLamports: 10_000,
    });

    await expect(
      (swapManager as any).ensureAdminCanCoverRoute(
        integrator,
        order,
        Keypair.generate().publicKey
      )
    ).rejects.toThrow(/cannot cover rent\+priority/i);
  });
});
