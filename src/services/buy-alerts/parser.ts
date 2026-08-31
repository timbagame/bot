import type { BuyDex } from "./types";

export function mapDexFromPool(pool: string | null | undefined): BuyDex {
  const normalized = pool?.trim().toLowerCase() ?? "";
  if (
    normalized === "pump" ||
    normalized === "pump-amm" ||
    normalized === "pump-fun" ||
    normalized === "pumpfun" ||
    normalized === "pumpswap"
  ) {
    return "pump";
  }
  if (normalized.startsWith("raydium")) {
    return "raydium";
  }
  return "unknown";
}
