import { LAMPORTS_PER_SOL, WSOL_MINT } from "./constants";
import {
  DEFAULT_MAX_EXTRA_FEE_BPS,
  DEFAULT_REFERRAL_BASE_FEE_BPS,
  MAX_REFERRAL_FEE_BPS,
  getReferralConfigForMint,
} from "./referral-config";
import type { ReferralTokenConfigEntry } from "./referral-config";
import { resolveTokenPriceUSD } from "./prices";

export type IntegratorPayerKind = "user" | "admin";

export interface IntegratorSwapParams {
  referralAccount: string;
  referralFeeBps: number;
  payer: string;
  closeAuthority: string;
  payerKind: IntegratorPayerKind;
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

const clampBps = (value: number): number =>
  Math.max(50, Math.min(MAX_REFERRAL_FEE_BPS, Math.round(value)));

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
    solFeeBufferLamports = 0,
  } = context;

  const referralConfig = getReferralTargetForPair(inputMint, outputMint);
  if (!referralConfig) {
    return null;
  }

  const baseFeeBps = clampBps(
    referralConfig.baseFeeBps ?? DEFAULT_REFERRAL_BASE_FEE_BPS
  );

  if (
    availableSolLamports >= solFeeBufferLamports ||
    !referralConfig.adminPayer ||
    !referralConfig.adminCloseAuthority
  ) {
    return {
      referralAccount: referralConfig.referralAccount,
      referralFeeBps: baseFeeBps,
      payer: userPublicKey,
      closeAuthority: userPublicKey,
      payerKind: "user",
    };
  }

  const shortfallLamports = Math.max(
    0,
    solFeeBufferLamports - availableSolLamports
  );
  if (shortfallLamports <= 0) {
    return {
      referralAccount: referralConfig.referralAccount,
      referralFeeBps: baseFeeBps,
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

  const rawExtraBps = Math.ceil((deficitUsd / tradeUsd) * 10_000);
  const maxExtraBps =
    referralConfig.maxExtraFeeBps ?? DEFAULT_MAX_EXTRA_FEE_BPS;
  if (rawExtraBps > maxExtraBps) {
    throw new Error(
      "Trade is too small to cover integrator gas payer reimbursement. Add SOL or increase trade size."
    );
  }

  const referralFeeBps = clampBps(baseFeeBps + rawExtraBps);
  if (referralFeeBps > MAX_REFERRAL_FEE_BPS) {
    throw new Error(
      "Referral fee exceeds allowable limit. Add SOL or increase trade size."
    );
  }

  return {
    referralAccount: referralConfig.referralAccount,
    referralFeeBps,
    payer: referralConfig.adminPayer!,
    closeAuthority: referralConfig.adminCloseAuthority!,
    payerKind: "admin",
  };
};
