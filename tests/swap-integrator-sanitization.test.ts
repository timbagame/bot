import { describe, expect, test, vi } from "bun:test";
import { Keypair } from "@solana/web3.js";

import {
  __test_prepareIntegratorForQuote as prepareIntegratorForQuote,
  __test_ensureUserSolBufferForSwap as ensureUserSolBufferForSwap,
  __test_buildAdminIntegratorConfig as buildAdminIntegratorConfig,
  __test_setSolWrapRentReserveLamports,
  __test_getSolWrapRentReserveLamports,
  wallet,
} from "../src/bot";
import type { IntegratorSwapParams } from "../src/utils/integrator-fees";
import { __test_shouldSkipSolFeeBuffer as shouldSkipSolFeeBuffer } from "../src/bot";
import { stubWalletConnection, stubAdminKeypair } from "./helpers/test-stubs";
import { USER_SOL_MAX_BUFFER_LAMPORTS, WSOL_MINT } from "../src/utils/constants";
import { FeeBudgetManager } from "../src/utils/fee-budget";
import * as priceModule from "../src/utils/prices";

// Minimal mock quote to exercise buffer checks
const buildQuote = (inputMint: string, routeLamports: number, amountRaw: number) => ({
  inputMint,
  inputAmountRaw: amountRaw,
  providerQuote: {
    rentFeeLamports: routeLamports,
    prioritizationFeeLamports: 0,
    signatureFeeLamports: 0,
    router: "iris",
  },
});


describe("prepareIntegratorForQuote", () => {
  test("strips admin fields and rewrites payer for non-SOL outputs", () => {
    const integrator: IntegratorSwapParams = {
      payerKind: "admin",
      payer: "ADMIN",
      closeAuthority: "ADMIN",
      referralAccount: "REF",
      referralFeeBps: 100,
      adminBalanceLamports: 123,
      adminRequiredLamports: 456,
      adminRouteLamports: 789,
    };

    const result = prepareIntegratorForQuote(integrator, "USDC", "USER");

    expect(result?.payerKind).toBe("user");
    expect(result?.payer).toBe("USER");
    expect(result?.closeAuthority).toBe("USER");
    expect(result?.adminBalanceLamports).toBeUndefined();
    expect(result?.adminRequiredLamports).toBeUndefined();
    expect(result?.adminRouteLamports).toBeUndefined();
  });

  test("cleans admin metadata when cached integrator reused for AI16Z", () => {
    const integrator: IntegratorSwapParams = {
      payerKind: "admin",
      payer: "ADMIN",
      closeAuthority: "ADMIN",
      referralAccount: "REF",
      referralFeeBps: 100,
      adminBalanceLamports: 123,
      adminRequiredLamports: 456,
      adminRouteLamports: 789,
    };

    const result = prepareIntegratorForQuote(integrator, "AI16Z", "USER");

    expect(result?.payerKind).toBe("user");
    expect(result?.payer).toBe("USER");
    expect(result?.closeAuthority).toBe("USER");
    expect(result?.adminBalanceLamports).toBeUndefined();
    expect(result?.adminRequiredLamports).toBeUndefined();
    expect(result?.adminRouteLamports).toBeUndefined();
  });

  test("retains admin payer when swap outputs SOL", () => {
    const integrator: IntegratorSwapParams = {
      payerKind: "admin",
      payer: "ADMIN",
      closeAuthority: "ADMIN",
      referralAccount: "REF",
      referralFeeBps: 100,
      adminBalanceLamports: 123,
      adminRequiredLamports: 456,
      adminRouteLamports: 789,
    };

    const result = prepareIntegratorForQuote(integrator, "SOL", "USER");

    expect(result?.payerKind).toBe("admin");
    expect(result?.payer).toBe("ADMIN");
    expect(result?.closeAuthority).toBe("ADMIN");
    expect(result?.adminBalanceLamports).toBe(123);
    expect(result?.adminRequiredLamports).toBe(456);
    expect(result?.adminRouteLamports).toBe(789);
  });
});

describe("ensureUserSolBufferForSwap", () => {
  test("throws clear error when swap amount exceeds balance (avoid BigInt underflow)", async () => {
    const user = Keypair.generate();
    // Mock balance to 1 lamport
    const originalGetConnection = wallet.getConnection;
    (wallet as any).getConnection = () => ({ getBalance: async () => 1 });

    const quote = buildQuote("So11111111111111111111111111111111111111112", 1000, 2);

    await expect(
      ensureUserSolBufferForSwap({ quote: quote as any, userKeypair: user })
    ).rejects.toThrow(/Insufficient balance/);

    (wallet as any).getConnection = originalGetConnection;
  });

  test("enforces USER_SOL_MAX_BUFFER when provider quote lacks rent details", async () => {
    const user = Keypair.generate();
    const originalGetConnection = wallet.getConnection;
    (wallet as any).getConnection = () => ({
      getBalance: async () => USER_SOL_MAX_BUFFER_LAMPORTS,
    });

    const quote = {
      inputMint: WSOL_MINT,
      inputAmountRaw: "1",
      providerQuote: {
        router: "iris",
      },
    } as any;

    await expect(
      ensureUserSolBufferForSwap({ quote, userKeypair: user })
    ).rejects.toThrow(
      new RegExp(wallet.formatSolBalance(USER_SOL_MAX_BUFFER_LAMPORTS))
    );

    (wallet as any).getConnection = originalGetConnection;
  });
});

describe("buildAdminIntegratorConfig", () => {
  test("fails fast when wrap rent reserve cache is empty", async () => {
    __test_setSolWrapRentReserveLamports(0);
    const feeBudget = FeeBudgetManager.getInstance(wallet.getConnection());
    const wrapSpy = vi
      .spyOn(feeBudget, "getWrapFeeBufferLamports")
      .mockResolvedValue(0);
    const defaultSpy = vi
      .spyOn(feeBudget, "getDefaultWrapFeeBufferLamports")
      .mockReturnValue(0);
    const restoreConn = stubWalletConnection(1_000_000_000);
    const restoreAdmin = stubAdminKeypair();

    const configPromise = buildAdminIntegratorConfig({
      referralConfig: {
        mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
        referralAccount: "REF",
      },
      baseFeeBps: 85,
      tradeAmountRaw: 1_000_000,
      tradeMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      tradeTicker: "TIMBA",
      tradeDecimals: 6,
      solFeeBufferLamports: undefined,
    });

    await expect(configPromise).rejects.toThrow(/wrap rent reserve unavailable/i);

    wrapSpy.mockRestore();
    defaultSpy.mockRestore();
    restoreConn();
    restoreAdmin();
  });

  test("builds admin config when wrap buffer refresh fails but fallback exists", async () => {
    __test_setSolWrapRentReserveLamports(0);
    const restoreConn = stubWalletConnection(1_000_000_000);
    const restoreAdmin = stubAdminKeypair();
    const feeBudget = FeeBudgetManager.getInstance(wallet.getConnection());
    const wrapSpy = vi
      .spyOn(feeBudget, "getWrapFeeBufferLamports")
      .mockResolvedValue(0);
    const defaultSpy = vi
      .spyOn(feeBudget, "getDefaultWrapFeeBufferLamports")
      .mockReturnValue(500_000);
    const priceSpy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValue({ price: 1, identifier: "SOL" } as any);

    const config = await buildAdminIntegratorConfig({
      referralConfig: {
        mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
        referralAccount: "REF",
      },
      baseFeeBps: 85,
      tradeAmountRaw: 1_000_000,
      tradeMint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
      tradeTicker: "TIMBA",
      tradeDecimals: 6,
      solFeeBufferLamports: undefined,
    });

    expect(config).toBeDefined();
    expect(__test_getSolWrapRentReserveLamports()).toBeGreaterThan(0);

    wrapSpy.mockRestore();
    defaultSpy.mockRestore();
    priceSpy.mockRestore();
    restoreConn();
    restoreAdmin();
  });
});

describe("shouldSkipSolFeeBuffer", () => {
  test("skips buffer when admin referral payer present and amount is max", () => {
    const solAsset = { ticker: "SOL" } as any;
    const referral = { adminPayer: "ADMIN", adminCloseAuthority: "ADMIN" };
    expect(shouldSkipSolFeeBuffer(solAsset, "SOL", "max", referral)).toBe(
      true
    );
  });
});
