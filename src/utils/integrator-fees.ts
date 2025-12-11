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

/**
 * Context for calculating dynamic referral fees based on SOL shortfall.
 * Used by both JIT swaps and regular swaps when admin covers gas costs.
 */
export interface DynamicFeeContext {
  /** The token being swapped (input side) */
  inputMint: string;
  /** Ticker symbol for the input token */
  inputTicker: string;
  /** Decimal places for the input token */
  inputDecimals: number;
  /** Raw amount of input tokens (before decimal conversion) */
  inputAmountRaw: number;
  /** SOL shortfall in lamports that admin needs to cover */
  shortfallLamports: number;
  /** Base fee in bps (default: 85) */
  baseFeeBps?: number;
  /** Maximum extra fee in bps (default: 170) */
  maxExtraBps?: number;
  /** Whether to throw on price resolution failure (default: false) */
  throwOnPriceFailure?: boolean;
}

/**
 * Calculates the dynamic referral fee based on SOL shortfall vs trade value.
 *
 * Formula: referralFee = baseFee + min(extraBps, maxExtraBps)
 * where extraBps = ceil((deficitUsd / tradeUsd) * 10,000)
 *
 * @returns The calculated referral fee in bps, clamped to 50-255 range
 */
export async function calculateDynamicReferralFee(
  context: DynamicFeeContext
): Promise<number> {
  const {
    inputMint,
    inputTicker,
    inputDecimals,
    inputAmountRaw,
    shortfallLamports,
    baseFeeBps = DEFAULT_REFERRAL_BASE_FEE_BPS,
    maxExtraBps = DEFAULT_MAX_EXTRA_FEE_BPS,
    throwOnPriceFailure = false,
  } = context;

  // Default to base fee
  const clampedBaseFee = clampReferralFeeBps(baseFeeBps, 50, MAX_REFERRAL_FEE_BPS);

  if (shortfallLamports <= 0) {
    return clampedBaseFee;
  }

  try {
    const tradeUsd = await estimateTradeUsdValue(
      inputAmountRaw,
      inputDecimals,
      inputMint,
      inputTicker,
      isSolMint(inputMint)
    );
    const deficitUsd = await estimateSolUsdValue(shortfallLamports);

    if (tradeUsd <= 0 || deficitUsd <= 0) {
      if (throwOnPriceFailure) {
        throw new Error(
          "Cannot estimate referral surcharge for gas payer. Please top up SOL or try a larger trade."
        );
      }
      return clampedBaseFee;
    }

    const rawExtraBps = Math.ceil((deficitUsd / tradeUsd) * 10_000);
    const actualExtraBps = Math.min(rawExtraBps, maxExtraBps);
    const referralFeeBps = clampReferralFeeBps(
      clampedBaseFee + actualExtraBps,
      50,
      MAX_REFERRAL_FEE_BPS
    );

    console.log(
      `💰 Dynamic fee: base=${clampedBaseFee}bps + extra=${actualExtraBps}bps = ${referralFeeBps}bps ` +
      `(trade=$${tradeUsd.toFixed(2)}, deficit=$${deficitUsd.toFixed(4)})`
    );

    return referralFeeBps;
  } catch (error) {
    if (throwOnPriceFailure) {
      throw error;
    }
    console.warn("⚠️ Failed to calculate dynamic fee, using base fee:", error);
    return clampedBaseFee;
  }
}

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

  const maxExtraBps = referralConfig.maxExtraFeeBps ?? DEFAULT_MAX_EXTRA_FEE_BPS;

  // Use unified fee calculation
  const referralFeeBps = isUnwrappingSol
    ? await calculateDynamicReferralFee({
        inputMint,
        inputTicker,
        inputDecimals,
        inputAmountRaw,
        shortfallLamports,
        baseFeeBps,
        maxExtraBps,
        throwOnPriceFailure: false,
      })
    : await (async () => {
        // For non-unwrap flows, use calculateReferralFeeBps which throws on small trades
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

        return calculateReferralFeeBps({
          baseFeeBps,
          tradeUsd,
          deficitUsd,
          maxExtraBps,
        });
      })();

  return {
    referralAccount: referralConfig.referralAccount,
    referralFee: referralFeeBps,
    payer: referralConfig.adminPayer!,
    closeAuthority: referralConfig.adminCloseAuthority!,
    payerKind: "admin",
  };
};
