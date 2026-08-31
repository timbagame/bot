import { z } from "zod";
import type { BuyDex, BuyEvent } from "./types";

const numericSchema = z.union([z.number(), z.string()]);

const pumpPortalTradeSchema = z
  .object({
    signature: z.string().min(1),
    txType: z.string(),
    mint: z.string().optional(),
    tokenMint: z.string().optional(),
    traderPublicKey: z.string().optional(),
    trader: z.string().optional(),
    solAmount: numericSchema,
    tokenAmount: numericSchema,
    pool: z.string().optional(),
  })
  .passthrough();

function parseFiniteNumber(value: number | string): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return numeric;
}

export function mapDexFromPool(pool: string | null | undefined): BuyDex {
  const normalized = pool?.trim().toLowerCase() ?? "";
  if (
    normalized === "pump" ||
    normalized === "pump-amm" ||
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

export function parsePumpPortalTrade(payload: unknown): BuyEvent | null {
  const parsed = pumpPortalTradeSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  if (parsed.data.txType.trim().toLowerCase() !== "buy") {
    return null;
  }

  const mint = (parsed.data.mint ?? parsed.data.tokenMint ?? "").trim();
  const trader = (parsed.data.traderPublicKey ?? parsed.data.trader ?? "").trim();
  const solAmount = parseFiniteNumber(parsed.data.solAmount);
  const tokenAmount = parseFiniteNumber(parsed.data.tokenAmount);

  if (!mint || !trader || solAmount == null || tokenAmount == null || tokenAmount <= 0) {
    return null;
  }

  return {
    signature: parsed.data.signature.trim(),
    mint,
    trader,
    solAmount,
    tokenAmount,
    dex: mapDexFromPool(parsed.data.pool),
  };
}
