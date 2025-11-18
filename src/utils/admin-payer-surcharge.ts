import { LAMPORTS_PER_SOL } from "./constants";

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

export function calculateAdminPayerFeeBps(
  options: AdminPayerSurchargeOptions
): number {
  const {
    baseFeeBps,
    tradeAmountRaw,
    tradeDecimals,
    tradePriceUsd,
    deficitLamports,
    solPriceUsd,
    minFeeBps = 50,
    maxFeeBps = 255,
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

  const tradeUsd =
    (tradeAmountRaw / Math.pow(10, tradeDecimals)) * tradePriceUsd;
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
  priorityBufferLamports: number = 0
): number => {
  return (
    Math.max(0, minBalanceLamports) +
    Math.max(0, rentReserveLamports) +
    Math.max(0, extraAtaLamports) +
    Math.max(0, priorityBufferLamports)
  );
};
