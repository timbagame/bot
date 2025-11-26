import { JUPITER_MIN_SOL_BALANCE_LAMPORTS, LAMPORTS_PER_SOL, WSOL_MINT } from "./constants";
import { getReferralConfigForMint, type ReferralTokenConfigEntry } from "./token-registry";
import { resolveTokenPriceUSD } from "./prices";
import {
  clampReferralFeeBps,
  calculateReferralFeeBps,
  DEFAULT_REFERRAL_BASE_FEE_BPS,
  DEFAULT_MAX_EXTRA_FEE_BPS,
  MAX_REFERRAL_FEE_BPS,
} from "./admin-payer-surcharge";

export type IntegratorPayerKind = "user" | "admin";

export interface IntegratorSwapParams {
  referralAccount: string;
  referralFee: number;
  payer: string;
  closeAuthority: string;
  payerKind: IntegratorPayerKind;
  adminBalanceLamports?: number;
  adminRequiredLamports?: number;
  adminRouteLamports?: number;
}

export interface IntegratorFeeContext {
  inputMint: string;
  outputMint: string;
  inputTicker: string;
  inputDecimals: number;
  inputAmountRaw: number;
  userPublicKey: string;
  availableSolLamports: number;
  solFeeBufferLamports?: number;
}

const getReferralTargetForPair = (
  inputMint: string,
  outputMint: string
): ReferralTokenConfigEntry | undefined => {
  return (
    getReferralConfigForMint(inputMint) || getReferralConfigForMint(outputMint)
  );
};

const isSolMint = (mint: string): boolean =>
  mint === WSOL_MINT || mint === "SOL";

const toDecimalAmount = (raw: number, decimals: number): number => {
  if (!Number.isFinite(raw)) return 0;
  return raw / Math.pow(10, decimals);
};

const estimateTradeUsdValue = async (
  amountRaw: number,
  decimals: number,
  mint: string,
  ticker: string,
  isSol: boolean
): Promise<number> => {
  const amountDecimal = toDecimalAmount(amountRaw, decimals);
  if (amountDecimal <= 0) return 0;

  const lookup = await resolveTokenPriceUSD({
    tokenMint: mint,
    tokenTicker: ticker,
    isSol,
  });

  if (!lookup || lookup.price <= 0) {
    return 0;
  }

  return amountDecimal * lookup.price;
};

const estimateSolUsdValue = async (lamports: number): Promise<number> => {
  if (lamports <= 0) return 0;
  const lookup = await resolveTokenPriceUSD({ isSol: true });
  if (!lookup || lookup.price <= 0) return 0;
  return (lamports / LAMPORTS_PER_SOL) * lookup.price;
};

export const resolveIntegratorSwapParams = async (
  context: IntegratorFeeContext
): Promise<IntegratorSwapParams | null> => {
  const {
    inputMint,
    outputMint,
    inputTicker,
    inputDecimals,
    inputAmountRaw,
    userPublicKey,
    availableSolLamports,
    solFeeBufferLamports,
  } = context;

  const isUnwrappingSol = inputMint === WSOL_MINT && isSolMint(outputMint);
  const availableForFeesLamports = availableSolLamports;

  const referralConfig = getReferralTargetForPair(inputMint, outputMint);
  if (!referralConfig) {
    return null;
  }

  const requiresAdminPayer =
    Boolean(referralConfig.adminPayer) &&
    Boolean(referralConfig.adminCloseAuthority);

  const effectiveSolFeeBufferLamports = requiresAdminPayer
    ? Math.max(solFeeBufferLamports ?? 0, JUPITER_MIN_SOL_BALANCE_LAMPORTS)
    : solFeeBufferLamports ?? 0;

  const baseFeeBps = clampReferralFeeBps(
    referralConfig.baseFeeBps ?? DEFAULT_REFERRAL_BASE_FEE_BPS,
    50,
    MAX_REFERRAL_FEE_BPS
  );

  if (
    availableForFeesLamports >= effectiveSolFeeBufferLamports ||
    !requiresAdminPayer
  ) {
    return {
      referralAccount: referralConfig.referralAccount,
      referralFee: baseFeeBps,
      payer: userPublicKey,
      closeAuthority: userPublicKey,
      payerKind: "user",
    };
  }

  const shortfallLamports = Math.max(
    0,
    effectiveSolFeeBufferLamports - availableForFeesLamports
  );
  if (shortfallLamports <= 0) {
    return {
      referralAccount: referralConfig.referralAccount,
      referralFee: baseFeeBps,
      payer: userPublicKey,
      closeAuthority: userPublicKey,
      payerKind: "user",
    };
  }

  const tradeUsd = await estimateTradeUsdValue(
    inputAmountRaw,
    inputDecimals,
    inputMint,
    inputTicker,
    isSolMint(inputMint)
  );
  const deficitUsd = await estimateSolUsdValue(shortfallLamports);

  if (tradeUsd <= 0 || deficitUsd <= 0) {
    throw new Error(
      "Cannot estimate referral surcharge for gas payer. Please top up SOL or try a larger trade."
    );
  }

  const maxExtraBps = referralConfig.maxExtraFeeBps ?? DEFAULT_MAX_EXTRA_FEE_BPS;
  const rawExtraBps = Math.ceil((deficitUsd / tradeUsd) * 10_000);
  const referralFeeBps = isUnwrappingSol
    ? clampReferralFeeBps(
        baseFeeBps + Math.min(rawExtraBps, maxExtraBps),
        50,
        MAX_REFERRAL_FEE_BPS
      )
    : calculateReferralFeeBps({
        baseFeeBps,
        tradeUsd,
        deficitUsd,
        maxExtraBps,
      });

  // For unwrap flows, admin-linked metadata still indicates the user remains the
  // transaction payer while the admin only fronts temporary lamports.
  return {
    referralAccount: referralConfig.referralAccount,
    referralFee: referralFeeBps,
    payer: referralConfig.adminPayer!,
    closeAuthority: referralConfig.adminCloseAuthority!,
    payerKind: "admin",
  };
};
