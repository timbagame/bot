import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "bun:test";
import { JUPITER_MIN_SOL_BALANCE_LAMPORTS } from "../src/utils/constants";
import {
  __test_registerReferralEntry,
  __test_resetReferralEntries,
  WSOL_MINT,
} from "../src/utils/token-registry";
import { resolveIntegratorSwapParams } from "../src/utils/integrator-fees";
import * as priceModule from "../src/utils/prices";

const REFERRAL_ACCOUNT = "GPBNTRmo26MRoaLSvRXwhWaQZhYjwVWgEkgwRZVU6x9U";
const ADMIN_REF_MINT1 = "AdminMintExample11111111111111111111111111";
const ADMIN_REF_MINT2 = "AdminMintExample22222222222222222222222222";
const CLAMP_REF_MINT = "ClampMintExample111111111111111111111111";

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
      adminCloseAuthority:
        "AdminCloseAuthority2222222222222222222222222222",
      baseFeeBps: 85,
      maxExtraFeeBps: 5,
    });

    const spy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValueOnce({ price: 1, identifier: "SOL" } as any)
      .mockResolvedValueOnce({ price: 100, identifier: "SOL" } as any);

    await expect(
      resolveIntegratorSwapParams({
        inputMint: ADMIN_REF_MINT1,
        outputMint: WSOL_MINT,
        inputTicker: "SOL",
        inputDecimals: 9,
        inputAmountRaw: 1,
        userPublicKey: "UserTiny",
        availableSolLamports: 0,
      })
    ).rejects.toThrow(
      "Trade is too small to cover integrator gas payer reimbursement. Add SOL or increase trade size."
    );

    expect(spy).toHaveBeenCalled();
  });

  test("applies extra referral fee to reimburse admin gas payer shortfall", async () => {
    __test_registerReferralEntry({
      mint: ADMIN_REF_MINT1,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer11111111111111111111111111111",
      adminCloseAuthority:
        "AdminCloseAuthority2222222222222222222222222222",
      baseFeeBps: 85,
    });

    const priceSpy = vi
      .spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValueOnce({ price: 1, identifier: "USDC" } as any)
      .mockResolvedValueOnce({ price: 25, identifier: "SOL" } as any);

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
    expect(result?.referralFeeBps).toBe(88);
    expect(result?.payer).toBe("AdminPayer11111111111111111111111111111");
  });

  test("returns admin payer and close authority when user lacks buffer", async () => {
    __test_registerReferralEntry({
      mint: ADMIN_REF_MINT2,
      referralAccount: REFERRAL_ACCOUNT,
      adminPayer: "AdminPayer22222222222222222222222222",
      adminCloseAuthority:
        "AdminCloseAuthority33333333333333333333333333",
      baseFeeBps: 85,
    });

    vi.spyOn(priceModule, "resolveTokenPriceUSD")
      .mockResolvedValueOnce({ price: 100, identifier: "SOL" } as any)
      .mockResolvedValueOnce({ price: 50, identifier: "SOL" } as any);

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
    expect(result?.closeAuthority).toBe(
      "AdminCloseAuthority33333333333333333333333333"
    );
    expect(result?.payerKind).toBe("admin");
    expect(result?.referralFeeBps).toBeGreaterThan(85);
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
    expect(result?.referralFeeBps).toBe(50);
  });
});
