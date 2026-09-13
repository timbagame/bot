import { DepositInputError } from "./fixedfloat";

export type DepositMarket = { btcUsd: number; minSats: number; maxSats: number };
export const usdLabel = (value: string | number) =>
  `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function depositUsdLimits(market: DepositMarket) {
  return {
    min: Math.ceil((market.minSats * market.btcUsd) / 1e6) / 100,
    max: Math.floor((market.maxSats * market.btcUsd) / 1e6) / 100,
  };
}

export function usdToSats(input: string, market: DepositMarket): string {
  const normalized = input.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized) || Number(normalized) <= 0)
    throw new DepositInputError("Enter a positive USD amount, such as 20 or 20.50.");
  const usd = Number(normalized);
  const { min, max } = depositUsdLimits(market);
  if (usd < min || usd > max)
    throw new DepositInputError(`Choose an amount between ${usdLabel(min)} and ${usdLabel(max)}.`);
  const sats = Math.ceil((usd * 1e8) / market.btcUsd);
  if (!Number.isSafeInteger(sats) || sats < market.minSats || sats > market.maxSats)
    throw new DepositInputError("The deposit limits have changed. Choose another amount.");
  return String(sats);
}

export function depositUsdPresets(market: DepositMarket): number[] {
  const { min, max } = depositUsdLimits(market);
  return [10, 25, 50].filter((amount) => amount >= min && amount <= max);
}
