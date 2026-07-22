import { LAMPORTS_PER_SOL } from "./constants";

export const MAX_REFERRAL_FEE_BPS = 255;
export const MIN_JUPITER_SWAP_FEE_BPS = 100;
export const DEFAULT_REFERRAL_BASE_FEE_BPS = MIN_JUPITER_SWAP_FEE_BPS;
export const DEFAULT_MAX_EXTRA_FEE_BPS = 155; // 255 max - 100 base = 155 max extra

export interface AdminPayerSurchargeOptions {
  baseFeeBps: number;
  tradeAmountRaw: number;
  tradeDecimals: number;
  tradePriceUsd: number;
  deficitLamports: number;
  solPriceUsd: number;
  minFeeBps?: number;
  maxFeeBps?: number;
}

const clampBps = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value)));

export const clampReferralFeeBps = (
  value: number,
  min: number = 50,
  max: number = MAX_REFERRAL_FEE_BPS,
): number => clampBps(value, min, max);

export interface ReferralFeeCalculationOptions {
  baseFeeBps: number;
  tradeUsd: number;
  deficitUsd: number;
  maxExtraBps?: number;
  minFeeBps?: number;
  maxFeeBps?: number;
}

export const calculateReferralFeeBps = (options: ReferralFeeCalculationOptions): number => {
  const {
    baseFeeBps,
    tradeUsd,
    deficitUsd,
    maxExtraBps = DEFAULT_MAX_EXTRA_FEE_BPS,
    minFeeBps = 50,
    maxFeeBps = MAX_REFERRAL_FEE_BPS,
  } = options;

  if (tradeUsd <= 0 || deficitUsd <= 0) {
    throw new Error(
      "Cannot estimate referral surcharge for gas payer. Please top up SOL or try a larger trade.",
    );
  }

  const rawExtraBps = Math.ceil((deficitUsd / tradeUsd) * 10_000);
  if (rawExtraBps > maxExtraBps) {
    throw new Error(
      "Trade is too small to cover integrator gas payer reimbursement. Add SOL or increase trade size.",
    );
  }

  const referralFeeBps = clampReferralFeeBps(baseFeeBps + rawExtraBps, minFeeBps, maxFeeBps);

  if (referralFeeBps > maxFeeBps) {
    throw new Error("Referral fee exceeds allowable limit. Add SOL or increase trade size.");
  }

  return referralFeeBps;
};

export function calculateAdminPayerFeeBps(options: AdminPayerSurchargeOptions): number {
  const {
    baseFeeBps,
    tradeAmountRaw,
    tradeDecimals,
    tradePriceUsd,
    deficitLamports,
    solPriceUsd,
    minFeeBps = 50,
    maxFeeBps = MAX_REFERRAL_FEE_BPS,
  } = options;

  if (
    tradeAmountRaw <= 0 ||
    tradeDecimals < 0 ||
    tradePriceUsd <= 0 ||
    deficitLamports <= 0 ||
    solPriceUsd <= 0 ||
    baseFeeBps <= 0
  ) {
    return clampBps(baseFeeBps, minFeeBps, maxFeeBps);
  }

  const tradeUsd = (tradeAmountRaw / Math.pow(10, tradeDecimals)) * tradePriceUsd;
  const deficitUsd = (deficitLamports / LAMPORTS_PER_SOL) * solPriceUsd;

  if (tradeUsd <= 0 || deficitUsd <= 0) {
    return clampBps(baseFeeBps, minFeeBps, maxFeeBps);
  }

  const extraBps = Math.ceil((deficitUsd / tradeUsd) * 10_000);

  return clampBps(baseFeeBps + extraBps, minFeeBps, maxFeeBps);
}

export const computeRequiredAdminLamports = (
  minBalanceLamports: number,
  rentReserveLamports: number,
  extraAtaLamports: number = 0,
  priorityBufferLamports: number = 0,
): number => {
  return (
    Math.max(0, minBalanceLamports) +
    Math.max(0, rentReserveLamports) +
    Math.max(0, extraAtaLamports) +
    Math.max(0, priorityBufferLamports)
  );
};
