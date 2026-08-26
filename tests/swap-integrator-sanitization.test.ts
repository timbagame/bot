import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { Keypair } from "@solana/web3.js";
import * as splToken from "@solana/spl-token";

import {
  __test_prepareIntegratorForQuote as prepareIntegratorForQuote,
  __test_buildAdminIntegratorConfig as buildAdminIntegratorConfig,
  __test_setSolWrapRentReserveLamports,
  __test_getSolWrapRentReserveLamports,
  __test_shouldSkipSolFeeBuffer as shouldSkipSolFeeBuffer,
  wallet,
} from "../src/bot";
import type { IntegratorSwapParams } from "../src/utils/integrator-fees";
import { stubWalletConnection, stubOperatorKeypair } from "./helpers/test-stubs";
import { USER_SOL_MAX_BUFFER_LAMPORTS, WSOL_MINT } from "../src/utils/constants";
import { FeeBudgetManager } from "../src/utils/fee-budget";
import * as priceService from "../src/utils/price-service";
import { SwapService } from "../src/utils/swap/service";
import type { SwapBackend } from "../src/utils/swap/service";
import { calculateRouteCosts } from "../src/utils/swap/route-cost";
import { TransactionHistory } from "../src/utils/transaction-history";

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
    executeWrapSwap: vi.fn(),
    executeUnwrapSwap: vi.fn(),
  };
  const service = new SwapService(wallet as any, stubBackend);

  test("throws clear error when swap amount exceeds balance (avoid BigInt underflow)", async () => {
    const user = Keypair.generate();
    const restoreConn = stubWalletConnection(1);

    const quote = buildQuote("So11111111111111111111111111111111111111112", 1000, 2);

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).rejects.toThrow(
      /Insufficient balance/,
    );

    restoreConn();
  });

  test("requires fee buffer even when wrap quotes omit provider details", async () => {
    const user = Keypair.generate();
    const amountLamports = 1_000_000;
    const restoreConn = stubWalletConnection(amountLamports + USER_SOL_MAX_BUFFER_LAMPORTS - 1);

    const quote = {
      inputMint: "SOL",
      outputMint: WSOL_MINT,
      inputAmountRaw: String(amountLamports),
      provider: "wrap",
    } as any;

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).rejects.toThrow(
      new RegExp(wallet.formatSolBalance(USER_SOL_MAX_BUFFER_LAMPORTS)),
    );

    restoreConn();
  });

  test("skips wrap rent reserve when WSOL ATA already exists", async () => {
    const user = Keypair.generate();
    const amountLamports = 1_000_000;
    const restoreConn = stubWalletConnection(amountLamports + USER_SOL_MAX_BUFFER_LAMPORTS);

    const accountSpy = vi.spyOn(splToken, "getAccount").mockResolvedValue({ amount: 0n } as any);

    const quote = {
      inputMint: "SOL",
      outputMint: WSOL_MINT,
      inputAmountRaw: String(amountLamports),
      provider: "wrap" as const,
    } as any;

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).resolves.toBe(0n);

    accountSpy.mockRestore();
    restoreConn();
  });

  test("adds wrap rent reserve to buffer when provider quote is missing", async () => {
    const user = Keypair.generate();
    const wrapRentLamports = 2_000_000;
    const amountLamports = 500_000;

    const feeBudgetMock = {
      getWrapFeeBufferLamports: vi.fn().mockResolvedValue(wrapRentLamports),
      getDefaultWrapFeeBufferLamports: vi.fn().mockReturnValue(500_000),
    } as unknown as FeeBudgetManager;

    const feeSpy = vi.spyOn(FeeBudgetManager, "getInstance").mockReturnValue(feeBudgetMock);

    const serviceWithMockBudget = new SwapService(wallet as any, stubBackend);
    const providerCosts = { rentFeeLamports: wrapRentLamports } as any;
    const helperCosts = calculateRouteCosts(providerCosts, {
      paddingRatio: 0.25,
      paddingExtraLamports: 200_000,
      paddingRounding: "ceil",
      baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
      requiredStrategy: "max",
    });

    const restoreConn = stubWalletConnection(amountLamports + helperCosts.requiredLamports - 1);

    const quote = {
      inputMint: "SOL",
      outputMint: WSOL_MINT,
      inputAmountRaw: String(amountLamports),
      provider: "wrap" as const,
    } as any;

    await expect(
      serviceWithMockBudget.ensureUserSolBufferForSwap(quote as any, user),
    ).rejects.toThrow(new RegExp(wallet.formatSolBalance(helperCosts.requiredLamports)));

    feeSpy.mockRestore();
    restoreConn();
  });

  test("supplements wrap provider quote without rent using fee budget reserve", async () => {
    const user = Keypair.generate();
    const wrapRentLamports = 2_200_000;
    const amountLamports = 500_000;

    const feeBudgetMock = {
      getWrapFeeBufferLamports: vi.fn().mockResolvedValue(wrapRentLamports),
      getDefaultWrapFeeBufferLamports: vi.fn().mockReturnValue(400_000),
    } as unknown as FeeBudgetManager;

    const feeSpy = vi.spyOn(FeeBudgetManager, "getInstance").mockReturnValue(feeBudgetMock);

    const serviceWithMockBudget = new SwapService(wallet as any, stubBackend);
    const providerCosts = { rentFeeLamports: wrapRentLamports } as any;
    const helperCosts = calculateRouteCosts(providerCosts, {
      paddingRatio: 0.25,
      paddingExtraLamports: 200_000,
      paddingRounding: "ceil",
      baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
      requiredStrategy: "max",
    });

    const restoreConn = stubWalletConnection(amountLamports + helperCosts.requiredLamports - 1);

    const quote = {
      inputMint: "SOL",
      outputMint: WSOL_MINT,
      inputAmountRaw: String(amountLamports),
      provider: "wrap" as const,
      providerQuote: { router: "wrap" },
    } as any;

    await expect(
      serviceWithMockBudget.ensureUserSolBufferForSwap(quote as any, user),
    ).rejects.toThrow(new RegExp(wallet.formatSolBalance(helperCosts.requiredLamports)));

    feeSpy.mockRestore();
    restoreConn();
  });

  test("allows unwrap providers when SOL balance is below WSOL input amount", async () => {
    const user = Keypair.generate();
    const amountLamports = 2_000_000;
    const restoreConn = stubWalletConnection(USER_SOL_MAX_BUFFER_LAMPORTS + 50_000);

    const quote = {
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      inputAmountRaw: String(amountLamports),
      provider: "unwrap" as const,
    } as any;

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).resolves.toBe(0n);

    restoreConn();
  });

  test("includes ATA rent when partial unwrap would recreate WSOL account", async () => {
    const user = Keypair.generate();
    const unwrapLamports = 1_000_000;
    const existingWsolLamports = 3_000_000;
    const wrapRentLamports = 2_039_280;

    const feeBudgetMock = {
      getWrapFeeBufferLamports: vi.fn().mockResolvedValue(wrapRentLamports),
      getDefaultWrapFeeBufferLamports: vi.fn().mockReturnValue(wrapRentLamports),
    } as unknown as FeeBudgetManager;

    const feeSpy = vi.spyOn(FeeBudgetManager, "getInstance").mockReturnValue(feeBudgetMock);

    const serviceWithMockBudget = new SwapService(wallet as any, stubBackend);

    const providerCosts = { rentFeeLamports: wrapRentLamports } as any;
    const helperCosts = calculateRouteCosts(providerCosts, {
      paddingRatio: 0.25,
      paddingExtraLamports: 200_000,
      paddingRounding: "ceil",
      baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
      requiredStrategy: "max",
    });

    const restoreConn = stubWalletConnection(helperCosts.requiredLamports - 1);
    const accountSpy = vi
      .spyOn(splToken, "getAccount")
      .mockResolvedValue({ amount: BigInt(existingWsolLamports) } as any);

    const quote = {
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      inputAmountRaw: String(unwrapLamports),
      provider: "unwrap" as const,
    } as any;

    await expect(
      serviceWithMockBudget.ensureUserSolBufferForSwap(quote as any, user),
    ).rejects.toThrow(new RegExp(wallet.formatSolBalance(helperCosts.requiredLamports)));

    accountSpy.mockRestore();
    restoreConn();
    feeSpy.mockRestore();
  });

  test("uses WSOL rent rebate to satisfy partial unwrap buffer when SOL is short", async () => {
    const user = Keypair.generate();
    const unwrapLamports = 1_000_000;
    const existingWsolLamports = 3_000_000;
    const wrapRentLamports = 2_039_280;

    const feeBudgetMock = {
      getWrapFeeBufferLamports: vi.fn().mockResolvedValue(wrapRentLamports),
      getDefaultWrapFeeBufferLamports: vi.fn().mockReturnValue(wrapRentLamports),
    } as unknown as FeeBudgetManager;

    const feeSpy = vi.spyOn(FeeBudgetManager, "getInstance").mockReturnValue(feeBudgetMock);

    const serviceWithMockBudget = new SwapService(wallet as any, stubBackend);

    const providerCosts = { rentFeeLamports: wrapRentLamports } as any;
    const helperCosts = calculateRouteCosts(providerCosts, {
      paddingRatio: 0.25,
      paddingExtraLamports: 200_000,
      paddingRounding: "ceil",
      baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
      requiredStrategy: "max",
    });

    const restoreConn = stubWalletConnection(helperCosts.requiredLamports - 1);
    const accountSpy = vi.spyOn(splToken, "getAccount").mockResolvedValue({
      amount: BigInt(existingWsolLamports),
      rentExemptReserve: BigInt(wrapRentLamports),
    } as any);

    const quote = {
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      inputAmountRaw: String(unwrapLamports),
      provider: "unwrap" as const,
    } as any;

    await expect(
      serviceWithMockBudget.ensureUserSolBufferForSwap(quote as any, user),
    ).resolves.toBe(0n);

    accountSpy.mockRestore();
    restoreConn();
    feeSpy.mockRestore();
  });

  test("applies rent rebate when fully unwrapping WSOL with no SOL on hand", async () => {
    const user = Keypair.generate();
    const unwrapLamports = 3_000_000;
    const wrapRentLamports = 2_039_280;

    const restoreConn = stubWalletConnection(0);
    const accountSpy = vi.spyOn(splToken, "getAccount").mockResolvedValue({
      amount: BigInt(unwrapLamports),
      rentExemptReserve: BigInt(wrapRentLamports),
    } as any);

    const quote = {
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      inputAmountRaw: String(unwrapLamports),
      provider: "unwrap" as const,
    } as any;

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).resolves.toBe(0n);

    accountSpy.mockRestore();
    restoreConn();
  });

  test("skips buffer enforcement for admin payer routes", async () => {
    const user = Keypair.generate();
    const restoreConn = stubWalletConnection(1);

    const quote = {
      ...buildQuote("So11111111111111111111111111111111111111112", 0, 1),
      integrator: { payerKind: "admin" },
      provider: "jupiter" as const,
    } as any;

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).resolves.toBe(0n);

    restoreConn();
  });

  test("enforces buffer for wrap providers even when integrator payer is admin", async () => {
    const user = Keypair.generate();
    const restoreConn = stubWalletConnection(1);

    const quote = {
      inputMint: "SOL",
      outputMint: WSOL_MINT,
      inputAmountRaw: "2",
      provider: "wrap" as const,
      integrator: { payerKind: "admin" },
    } as any;

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).rejects.toThrow(
      /Insufficient balance/,
    );

    restoreConn();
  });

  test("returns required buffer shortfall for admin unwrap providers", async () => {
    const user = Keypair.generate();
    const restoreConn = stubWalletConnection(1);

    const quote = {
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      inputAmountRaw: "1000000",
      provider: "unwrap" as const,
      integrator: { payerKind: "admin" },
    } as any;

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).resolves.toBe(
      BigInt(USER_SOL_MAX_BUFFER_LAMPORTS - 1),
    );

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

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).rejects.toThrow(
      new RegExp(wallet.formatSolBalance(USER_SOL_MAX_BUFFER_LAMPORTS)),
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
      amountLamports,
    );

    const helperCosts = calculateRouteCosts(quote.providerQuote as any, {
      paddingRatio: 0.25,
      paddingExtraLamports: 200_000,
      paddingRounding: "ceil",
      baseRequiredLamports: USER_SOL_MAX_BUFFER_LAMPORTS,
      requiredStrategy: "max",
    });

    const restoreConn = stubWalletConnection(amountLamports + helperCosts.requiredLamports - 1);

    await expect(service.ensureUserSolBufferForSwap(quote as any, user)).rejects.toThrow(
      new RegExp(wallet.formatSolBalance(helperCosts.requiredLamports)),
    );

    restoreConn();
  });
});

describe("SwapService.execute", () => {
  const user = Keypair.generate();
  const backend: SwapBackend = {
    getQuote: vi.fn(),
    executeJupiterSwap: vi.fn().mockResolvedValue("jupiter-tx"),
    executeWrapSwap: vi.fn().mockResolvedValue("wrap-tx"),
    executeUnwrapSwap: vi.fn().mockResolvedValue("unwrap-tx"),
  };
  const service = new SwapService(wallet as any, backend);
  let restoreConn: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    restoreConn = stubWalletConnection(1_000_000_000);
  });

  afterEach(() => {
    restoreConn?.();
  });

  const baseQuote = {
    inputMint: "SOL",
    outputMint: WSOL_MINT,
    inputAmount: "1000",
    inputAmountRaw: "1000",
    outputAmount: "1000",
    estimatedRate: 1,
    slippage: 0,
  };

  test("routes wrap provider to wrap executor", async () => {
    const wrapQuote = { ...baseQuote, provider: "wrap" as const };

    const txid = await service.execute(wrapQuote as any, user);

    expect(txid).toBe("wrap-tx");
    expect(backend.executeWrapSwap).toHaveBeenCalledTimes(1);
    expect(backend.executeJupiterSwap).not.toHaveBeenCalled();
  });

  test("routes unwrap provider to unwrap executor", async () => {
    const unwrapQuote = {
      ...baseQuote,
      provider: "unwrap" as const,
      inputMint: WSOL_MINT,
      outputMint: "SOL",
    };

    const txid = await service.execute(unwrapQuote as any, user);

    expect(txid).toBe("unwrap-tx");
    expect(backend.executeUnwrapSwap).toHaveBeenCalledTimes(1);
    expect(backend.executeUnwrapSwap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "unwrap" }),
      0n,
    );
    expect(backend.executeJupiterSwap).not.toHaveBeenCalled();
  });

  test("passes admin top-up for unwrap providers when SOL buffer is short", async () => {
    restoreConn?.();
    restoreConn = stubWalletConnection(0);

    const unwrapQuote = {
      ...baseQuote,
      provider: "unwrap" as const,
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      integrator: { payerKind: "admin" },
    };

    const txid = await service.execute(unwrapQuote as any, user);

    expect(txid).toBe("unwrap-tx");
    expect(backend.executeUnwrapSwap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "unwrap" }),
      BigInt(USER_SOL_MAX_BUFFER_LAMPORTS),
    );
  });

  test("does not borrow from admin when unwrap buffer is already satisfied", async () => {
    restoreConn?.();
    restoreConn = stubWalletConnection(USER_SOL_MAX_BUFFER_LAMPORTS * 10);

    const unwrapQuote = {
      ...baseQuote,
      provider: "unwrap" as const,
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      integrator: { payerKind: "admin" },
    };

    const txid = await service.execute(unwrapQuote as any, user);

    expect(txid).toBe("unwrap-tx");
    expect(backend.executeUnwrapSwap).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: "unwrap" }),
      0n,
    );
  });

  test("defaults to Jupiter executor for routed quotes", async () => {
    const jupiterQuote = { ...baseQuote, provider: "jupiter" as const };

    const txid = await service.execute(jupiterQuote as any, user);

    expect(txid).toBe("jupiter-tx");
    expect(backend.executeJupiterSwap).toHaveBeenCalledTimes(1);
  });

  test("records the final executed output instead of the initial provider quote", async () => {
    const history = TransactionHistory.getInstance();
    const recordSpy = vi.spyOn(history, "recordSwap").mockImplementation(() => {});
    const jupiterQuote = {
      ...baseQuote,
      provider: "jupiter" as const,
      outputAmount: "990",
      executionOutputAmount: "985",
      providerQuote: { outAmount: "1000" },
    };

    await service.execute(jupiterQuote as any, user);

    expect(recordSpy).toHaveBeenCalledWith(expect.objectContaining({ amount_out: "985" }));
    recordSpy.mockRestore();
  });

  test("records the isolated platform fee rate instead of Jupiter's total fee rate", async () => {
    const history = TransactionHistory.getInstance();
    const recordSpy = vi.spyOn(history, "recordSwap").mockImplementation(() => {});

    await service.execute(
      {
        ...baseQuote,
        provider: "jupiter",
        providerQuote: {
          feeBps: 100,
          platformFee: { amount: "5", feeBps: 50 },
        },
      } as any,
      user,
    );

    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fee_amount: "5", fee_bps: 50 }),
    );
    recordSpy.mockRestore();
  });

  test("records actual sponsored network cost and atomic reimbursement", async () => {
    const history = TransactionHistory.getInstance();
    const recordSpy = vi.spyOn(history, "recordSwap").mockImplementation(() => {});
    const originalGetConnection = wallet.getConnection.bind(wallet);
    (wallet as any).getConnection = () => ({
      getTransaction: async () => ({ meta: { fee: 7_000 } }),
    });

    try {
      await service.execute(
        {
          ...baseQuote,
          provider: "jupiter",
          integrator: { payerKind: "admin" },
          executionSponsorReimbursementLamports: 5_000,
        } as any,
        user,
      );

      expect(recordSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sponsor_cost_lamports: "7000",
          sponsor_reimbursement_lamports: "5000",
          sponsor_cost_estimated: false,
        }),
      );
    } finally {
      (wallet as any).getConnection = originalGetConnection;
      recordSpy.mockRestore();
    }
  });
});

describe("buildAdminIntegratorConfig", () => {
  test("fails fast when wrap rent reserve cache is empty", async () => {
    __test_setSolWrapRentReserveLamports(0);
    const feeBudget = FeeBudgetManager.getInstance(wallet.getConnection());
    const wrapSpy = vi.spyOn(feeBudget, "getWrapFeeBufferLamports").mockResolvedValue(0);
    const defaultSpy = vi.spyOn(feeBudget, "getDefaultWrapFeeBufferLamports").mockReturnValue(0);
    const restoreConn = stubWalletConnection(1_000_000_000);
    const restoreAdmin = stubOperatorKeypair();

    const configPromise = buildAdminIntegratorConfig({
      referralConfig: {
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
    const restoreAdmin = stubOperatorKeypair();
    const feeBudget = FeeBudgetManager.getInstance(wallet.getConnection());
    const wrapSpy = vi.spyOn(feeBudget, "getWrapFeeBufferLamports").mockResolvedValue(0);
    const defaultSpy = vi
      .spyOn(feeBudget, "getDefaultWrapFeeBufferLamports")
      .mockReturnValue(500_000);
    const priceSpy = vi
      .spyOn(priceService, "getUsdPrice")
      .mockResolvedValue({ price: 1, identifier: "SOL", resolvedAt: Date.now() } as any);

    const config = await buildAdminIntegratorConfig({
      referralConfig: {
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
    expect(shouldSkipSolFeeBuffer(solAsset, "SOL", "max", referral)).toBe(true);
  });
});
