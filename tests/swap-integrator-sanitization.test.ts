import { describe, expect, test, vi } from "bun:test";
import { Keypair } from "@solana/web3.js";

import {
  __test_prepareIntegratorForQuote as prepareIntegratorForQuote,
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
import { SwapService } from "../src/utils/swap/service";
import type { SwapBackend } from "../src/utils/swap/service";
import { calculateRouteCosts } from "../src/utils/swap/route-cost";

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
      referralFee: 100,
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
      referralFee: 100,
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
      referralFee: 100,
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

describe("SwapService.ensureUserSolBufferForSwap", () => {
  const stubBackend: SwapBackend = {
    getQuote: vi.fn(),
    executeJupiterSwap: vi.fn(),
  };
  const service = new SwapService(wallet as any, stubBackend);

  test("throws clear error when swap amount exceeds balance (avoid BigInt underflow)", async () => {
    const user = Keypair.generate();
    const restoreConn = stubWalletConnection(1);

    const quote = buildQuote("So11111111111111111111111111111111111111112", 1000, 2);

    await expect(
      service.ensureUserSolBufferForSwap(quote as any, user)
    ).rejects.toThrow(/Insufficient balance/);

    restoreConn();
  });

  test("skips buffer enforcement for admin payer routes", async () => {
    const user = Keypair.generate();
    const restoreConn = stubWalletConnection(1);

    const quote = {
      ...buildQuote("So11111111111111111111111111111111111111112", 0, 1),
      integrator: { payerKind: "admin" },
    } as any;

    await expect(
      service.ensureUserSolBufferForSwap(quote as any, user)
    ).resolves.toBeUndefined();

    restoreConn();
  });

  test("enforces USER_SOL_MAX_BUFFER when provider quote lacks rent details", async () => {
    const user = Keypair.generate();
    const restoreConn = stubWalletConnection(USER_SOL_MAX_BUFFER_LAMPORTS);

    const quote = {
      inputMint: WSOL_MINT,
      inputAmountRaw: "1",
      providerQuote: {
        router: "iris",
      },
    } as any;

    await expect(
      service.ensureUserSolBufferForSwap(quote as any, user)
    ).rejects.toThrow(
      new RegExp(wallet.formatSolBalance(USER_SOL_MAX_BUFFER_LAMPORTS))
    );

    restoreConn();
  });

  test("aligns rent-heavy enforcement with route cost helper", async () => {
    const user = Keypair.generate();
    const routeLamports = 2_400_000;
    const amountLamports = 500_000;
    const quote = buildQuote(
      "So11111111111111111111111111111111111111112",
      routeLamports,
      amountLamports
    );

    const helperCosts = calculateRouteCosts(quote.providerQuote as any, {
      paddingRatio: 0.25,
      paddingExtraLamports: 200_000,
      paddingRounding: "ceil",
      baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
      requiredStrategy: "max",
    });

    const restoreConn = stubWalletConnection(
      amountLamports + helperCosts.requiredLamports - 1
    );

    await expect(
      service.ensureUserSolBufferForSwap(quote as any, user)
    ).rejects.toThrow(
      new RegExp(wallet.formatSolBalance(helperCosts.requiredLamports))
    );

    restoreConn();
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
