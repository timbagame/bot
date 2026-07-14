import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { JUPITER_MIN_SOL_BALANCE_LAMPORTS } from "../src/utils/constants";
import {
  __test_registerReferralEntry,
  __test_resetReferralEntries,
  WSOL_MINT,
} from "../src/utils/token-registry";
import {
  resolveIntegratorSwapParams,
  calculateDynamicReferralFee,
} from "../src/utils/integrator-fees";
import * as priceService from "../src/utils/price-service";

const REFERRAL_ACCOUNT = "GPBNTRmo26MRoaLSvRXwhWaQZhYjwVWgEkgwRZVU6x9U";
const ADMIN_REF_MINT1 = "AdminMintExample11111111111111111111111111";
const ADMIN_REF_MINT2 = "AdminMintExample22222222222222222222222222";
const CLAMP_REF_MINT = "ClampMintExample111111111111111111111111";
const priceLookup = (price: number, identifier: string) => ({
  price,
  identifier,
  resolvedAt: Date.now(),
});

describe("Integrator fee calculations", () => {
  beforeEach(() => {
    __test_resetReferralEntries();
  });

  afterEach(() => {
    __test_resetReferralEntries();
    vi.restoreAllMocks();
  });

  test("returns null when referral entries are missing for both mints", async () => {
    const result = await resolveIntegratorSwapParams({
      inputMint: "UnknownMint1111111111111111111111111111111",
      outputMint: "AnotherUnknownMint2222222222222222222222222",
      inputTicker: "XYZ",
      inputDecimals: 6,
      inputAmountRaw: 1_000_000,
      userPublicKey: "UserX",
      availableSolLamports: 1_000_000,
    });

    expect(result).toBeNull();
  });

  test("throws when trade is too small to cover admin payer shortfall", async () => {
    __test_registerReferralEntry({
      mint: ADMIN_REF_MINT1,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer11111111111111111111111111111",
      adminCloseAuthority: "AdminCloseAuthority2222222222222222222222222222",
      baseFeeBps: 85,
      maxExtraFeeBps: 5,
    });

    const spy = vi
      .spyOn(priceService, "getUsdPrice")
      .mockResolvedValueOnce(priceLookup(1, "SOL") as any)
      .mockResolvedValueOnce(priceLookup(100, "SOL") as any);

    await expect(
      resolveIntegratorSwapParams({
        inputMint: ADMIN_REF_MINT1,
        outputMint: WSOL_MINT,
        inputTicker: "SOL",
        inputDecimals: 9,
        inputAmountRaw: 1,
        userPublicKey: "UserTiny",
        availableSolLamports: 0,
      }),
    ).rejects.toThrow(
      "Trade is too small to cover integrator gas payer reimbursement. Add SOL or increase trade size.",
    );

    expect(spy).toHaveBeenCalled();
  });

  test("applies extra referral fee to reimburse admin gas payer shortfall", async () => {
    __test_registerReferralEntry({
      mint: WSOL_MINT,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer11111111111111111111111111111",
      adminCloseAuthority: "AdminCloseAuthority2222222222222222222222222222",
      baseFeeBps: 85,
    });

    const priceSpy = vi
      .spyOn(priceService, "getUsdPrice")
      .mockResolvedValueOnce(priceLookup(1, "USDC") as any)
      .mockResolvedValueOnce(priceLookup(25, "SOL") as any);

    const result = await resolveIntegratorSwapParams({
      inputMint: ADMIN_REF_MINT1,
      outputMint: WSOL_MINT,
      inputTicker: "USDC",
      inputDecimals: 6,
      inputAmountRaw: 1_000_000_000,
      userPublicKey: "BufferlessUser",
      availableSolLamports: 0,
    });

    expect(priceSpy).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    expect(result?.payerKind).toBe("admin");
    expect(result?.referralFee).toBe(88);
    expect(result?.payer).toBe("AdminPayer11111111111111111111111111111");
  });

  test("treats unwrap as user-funded when SOL buffer is already present", async () => {
    __test_registerReferralEntry({
      mint: ADMIN_REF_MINT1,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer11111111111111111111111111111",
      adminCloseAuthority: "AdminCloseAuthority2222222222222222222222222222",
      baseFeeBps: 85,
    });

    const result = await resolveIntegratorSwapParams({
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      inputTicker: "SOL",
      inputDecimals: 9,
      inputAmountRaw: 250_000_000,
      userPublicKey: "RecoveredUser",
      availableSolLamports: JUPITER_MIN_SOL_BALANCE_LAMPORTS,
    });

    expect(result).not.toBeNull();
    expect(result?.payerKind).toBe("user");
    expect(result?.payer).toBe("RecoveredUser");
    expect(result?.closeAuthority).toBe("RecoveredUser");
  });

  test("uses admin top-up for unwrap when user lacks upfront SOL buffer", async () => {
    __test_registerReferralEntry({
      mint: WSOL_MINT,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer11111111111111111111111111111",
      adminCloseAuthority: "AdminCloseAuthority2222222222222222222222222222",
      baseFeeBps: 85,
    });

    const priceSpy = vi
      .spyOn(priceService, "getUsdPrice")
      .mockResolvedValueOnce(priceLookup(20, "SOL") as any)
      .mockResolvedValueOnce(priceLookup(20, "SOL") as any);

    const result = await resolveIntegratorSwapParams({
      inputMint: WSOL_MINT,
      outputMint: "SOL",
      inputTicker: "SOL",
      inputDecimals: 9,
      inputAmountRaw: JUPITER_MIN_SOL_BALANCE_LAMPORTS,
      userPublicKey: "BufferlessUnwrapper",
      availableSolLamports: 0,
    });

    expect(priceSpy).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    expect(result?.payerKind).toBe("admin");
    expect(result?.payer).toBe("AdminPayer11111111111111111111111111111");
    expect(result?.closeAuthority).toBe("AdminCloseAuthority2222222222222222222222222222");
  });

  test("treats WSOL output unwraps as SOL for admin surcharge calculations", async () => {
    __test_registerReferralEntry({
      mint: WSOL_MINT,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer11111111111111111111111111111",
      adminCloseAuthority: "AdminCloseAuthority2222222222222222222222222222",
      baseFeeBps: 85,
      maxExtraFeeBps: 100,
    });

    const priceSpy = vi
      .spyOn(priceService, "getUsdPrice")
      .mockResolvedValueOnce(priceLookup(150, "SOL") as any)
      .mockResolvedValueOnce(priceLookup(150, "SOL") as any);

    const result = await resolveIntegratorSwapParams({
      inputMint: WSOL_MINT,
      outputMint: WSOL_MINT,
      inputTicker: "SOL",
      inputDecimals: 9,
      inputAmountRaw: JUPITER_MIN_SOL_BALANCE_LAMPORTS,
      userPublicKey: "ProductionUnwrapper",
      availableSolLamports: 0,
    });

    expect(priceSpy).toHaveBeenCalledTimes(2);
    expect(result?.payerKind).toBe("admin");
    expect(result?.referralFee).toBe(185);
    expect(result?.payer).toBe("AdminPayer11111111111111111111111111111");
    expect(result?.closeAuthority).toBe("AdminCloseAuthority2222222222222222222222222222");
  });

  test("uses admin top-up when provided SOL buffer is below minimum", async () => {
    __test_registerReferralEntry({
      mint: ADMIN_REF_MINT1,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer11111111111111111111111111111",
      adminCloseAuthority: "AdminCloseAuthority2222222222222222222222222222",
      baseFeeBps: 85,
    });

    const priceSpy = vi
      .spyOn(priceService, "getUsdPrice")
      .mockResolvedValueOnce(priceLookup(20, "SOL") as any)
      .mockResolvedValueOnce(priceLookup(20, "SOL") as any);

    const result = await resolveIntegratorSwapParams({
      inputMint: ADMIN_REF_MINT1,
      outputMint: WSOL_MINT,
      inputTicker: "SOL",
      inputDecimals: 9,
      inputAmountRaw: 2_000_000_000,
      userPublicKey: "UnderBufferedUser",
      availableSolLamports: 0,
      solFeeBufferLamports: 0,
    });

    expect(priceSpy).toHaveBeenCalledTimes(2);
    expect(result?.payerKind).toBe("admin");
    expect(result?.payer).toBe("AdminPayer11111111111111111111111111111");
    expect(result?.closeAuthority).toBe("AdminCloseAuthority2222222222222222222222222222");
    expect(result?.referralFee).toBeGreaterThan(85);
  });

  test("returns admin payer and close authority when user lacks buffer", async () => {
    __test_registerReferralEntry({
      mint: ADMIN_REF_MINT2,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer22222222222222222222222222",
      adminCloseAuthority: "AdminCloseAuthority33333333333333333333333333",
      baseFeeBps: 85,
    });

    vi.spyOn(priceService, "getUsdPrice")
      .mockResolvedValueOnce(priceLookup(100, "SOL") as any)
      .mockResolvedValueOnce(priceLookup(50, "SOL") as any);

    const result = await resolveIntegratorSwapParams({
      inputMint: ADMIN_REF_MINT2,
      outputMint: WSOL_MINT,
      inputTicker: "SOL",
      inputDecimals: 9,
      inputAmountRaw: 1_000_000_000,
      userPublicKey: "AdminUser",
      availableSolLamports: 0,
    });

    expect(result).not.toBeNull();
    expect(result?.payer).toBe("AdminPayer22222222222222222222222222");
    expect(result?.closeAuthority).toBe("AdminCloseAuthority33333333333333333333333333");
    expect(result?.payerKind).toBe("admin");
    expect(result?.referralFee).toBeGreaterThan(85);
  });

  test("clamps referral fee floor to 50 bps when configured lower", async () => {
    __test_registerReferralEntry({
      mint: CLAMP_REF_MINT,
      referralAccount: REFERRAL_ACCOUNT,
      baseFeeBps: 10,
    });

    const result = await resolveIntegratorSwapParams({
      inputMint: CLAMP_REF_MINT,
      outputMint: WSOL_MINT,
      inputTicker: "CLAMP",
      inputDecimals: 6,
      inputAmountRaw: 1_000_000,
      userPublicKey: "ClampUser",
      availableSolLamports: JUPITER_MIN_SOL_BALANCE_LAMPORTS,
    });

    expect(result).not.toBeNull();
    expect(result?.referralFee).toBe(50);
  });
});

describe("calculateDynamicReferralFee", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns base fee when shortfallLamports is zero", async () => {
    const result = await calculateDynamicReferralFee({
      inputMint: "SomeMint111111111111111111111111111111111",
      inputTicker: "TKN",
      inputDecimals: 6,
      inputAmountRaw: 1_000_000,
      shortfallLamports: 0,
      baseFeeBps: 85,
    });

    expect(result).toBe(85);
  });

  test("returns base fee when shortfallLamports is negative", async () => {
    const result = await calculateDynamicReferralFee({
      inputMint: "SomeMint111111111111111111111111111111111",
      inputTicker: "TKN",
      inputDecimals: 6,
      inputAmountRaw: 1_000_000,
      shortfallLamports: -100,
      baseFeeBps: 85,
    });

    expect(result).toBe(85);
  });

  test("calculates dynamic fee based on deficit/trade ratio", async () => {
    vi.spyOn(priceService, "getUsdPrice").mockImplementation(async (opts: any) => {
      const resolvedAt = Date.now();
      if (opts?.tokenMint === WSOL_MINT) {
        return { price: 200, source: "mock", identifier: WSOL_MINT, resolvedAt };
      }
      return { price: 1, source: "mock", identifier: "TKN", resolvedAt };
    });

    // Trade: 10 tokens @ $1 = $10, Shortfall: 0.01 SOL @ $200 = $2
    const result = await calculateDynamicReferralFee({
      inputMint: "SomeMint111111111111111111111111111111111",
      inputTicker: "TKN",
      inputDecimals: 6,
      inputAmountRaw: 10_000_000,
      shortfallLamports: 10_000_000,
      baseFeeBps: 85,
      maxExtraBps: 170,
    });

    expect(result).toBe(255); // 85 + 170 (capped)
  });

  test("scales fee proportionally for small shortfalls", async () => {
    vi.spyOn(priceService, "getUsdPrice").mockImplementation(async (opts: any) => {
      const resolvedAt = Date.now();
      if (opts?.tokenMint === WSOL_MINT) {
        return { price: 200, source: "mock", identifier: WSOL_MINT, resolvedAt };
      }
      return { price: 1, source: "mock", identifier: "TKN", resolvedAt };
    });

    // Trade: 100 tokens @ $1 = $100, Shortfall: 0.001 SOL @ $200 = $0.20
    const result = await calculateDynamicReferralFee({
      inputMint: "SomeMint111111111111111111111111111111111",
      inputTicker: "TKN",
      inputDecimals: 6,
      inputAmountRaw: 100_000_000,
      shortfallLamports: 1_000_000,
      baseFeeBps: 85,
      maxExtraBps: 170,
    });

    expect(result).toBe(105); // 85 + 20
  });

  test("clamps fee to MAX_REFERRAL_FEE_BPS of 255", async () => {
    vi.spyOn(priceService, "getUsdPrice").mockImplementation(async (opts: any) => {
      const resolvedAt = Date.now();
      if (opts?.tokenMint === WSOL_MINT) {
        return { price: 200, source: "mock", identifier: WSOL_MINT, resolvedAt };
      }
      return { price: 1, source: "mock", identifier: "TKN", resolvedAt };
    });

    const result = await calculateDynamicReferralFee({
      inputMint: "SomeMint111111111111111111111111111111111",
      inputTicker: "TKN",
      inputDecimals: 6,
      inputAmountRaw: 1_000_000,
      shortfallLamports: 100_000_000,
      baseFeeBps: 85,
      maxExtraBps: 500,
    });

    expect(result).toBe(255);
  });

  test("returns base fee when prices unavailable", async () => {
    vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(null);

    const result = await calculateDynamicReferralFee({
      inputMint: "SomeMint111111111111111111111111111111111",
      inputTicker: "TKN",
      inputDecimals: 6,
      inputAmountRaw: 10_000_000,
      shortfallLamports: 5_000_000,
      baseFeeBps: 85,
      throwOnPriceFailure: false,
    });

    expect(result).toBe(85);
  });

  test("throws when throwOnPriceFailure is true", async () => {
    vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(null);

    await expect(
      calculateDynamicReferralFee({
        inputMint: "SomeMint111111111111111111111111111111111",
        inputTicker: "TKN",
        inputDecimals: 6,
        inputAmountRaw: 10_000_000,
        shortfallLamports: 5_000_000,
        baseFeeBps: 85,
        throwOnPriceFailure: true,
      }),
    ).rejects.toThrow("Cannot estimate referral surcharge for gas payer.");
  });

  test("uses default baseFeeBps of 85 when not specified", async () => {
    const result = await calculateDynamicReferralFee({
      inputMint: "SomeMint111111111111111111111111111111111",
      inputTicker: "TKN",
      inputDecimals: 6,
      inputAmountRaw: 1_000_000,
      shortfallLamports: 0,
    });

    expect(result).toBe(85);
  });

  test("returns base fee when price resolution throws", async () => {
    vi.spyOn(priceService, "getUsdPrice").mockRejectedValue(new Error("Network error"));

    const result = await calculateDynamicReferralFee({
      inputMint: "SomeMint111111111111111111111111111111111",
      inputTicker: "TKN",
      inputDecimals: 6,
      inputAmountRaw: 10_000_000,
      shortfallLamports: 5_000_000,
      baseFeeBps: 100,
      throwOnPriceFailure: false,
    });

    expect(result).toBe(100);
  });
});
