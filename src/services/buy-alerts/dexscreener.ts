import { z } from "zod";
import { createExpiringCache } from "../../utils/expiring-cache";
import type { FetchLike } from "../../types";
import type { PairStats } from "./types";

const DEXSCREENER_TOKEN_URL = "https://api.dexscreener.com/latest/dex/tokens";
const PAIR_CACHE_TTL_MS = 30_000;
const PAIR_FETCH_TIMEOUT_MS = 5_000;

const pairSchema = z
  .object({
    chainId: z.string().optional(),
    dexId: z.string().optional(),
    url: z.string().optional(),
    priceUsd: z.union([z.number(), z.string()]).optional(),
    marketCap: z.union([z.number(), z.string()]).optional(),
    fdv: z.union([z.number(), z.string()]).optional(),
    liquidity: z
      .object({
        usd: z.union([z.number(), z.string()]).optional(),
      })
      .passthrough()
      .optional(),
    priceChange: z
      .object({
        h24: z.union([z.number(), z.string()]).optional(),
      })
      .passthrough()
      .optional(),
    pairAddress: z.string().optional(),
    quoteToken: z
      .object({
        symbol: z.string().optional(),
      })
      .passthrough()
      .optional(),
    baseToken: z
      .object({
        name: z.string().optional(),
        symbol: z.string().optional(),
        address: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const tokenResponseSchema = z
  .object({
    pairs: z.array(pairSchema).nullable().optional(),
  })
  .passthrough();

const pairCache = createExpiringCache<PairStats | null>(PAIR_CACHE_TTL_MS);

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function liquidityUsd(pair: z.infer<typeof pairSchema>): number {
  return toFiniteNumber(pair.liquidity?.usd) ?? 0;
}

export function selectSolanaPair(
  pairs: Array<z.infer<typeof pairSchema>> | null | undefined,
): PairStats | null {
  if (!pairs || pairs.length === 0) {
    return null;
  }

  const solanaPairs = pairs.filter((pair) => (pair.chainId ?? "").toLowerCase() === "solana");
  const ranked = (solanaPairs.length > 0 ? solanaPairs : pairs).slice();
  ranked.sort((a, b) => liquidityUsd(b) - liquidityUsd(a));
  const best = ranked[0];
  if (!best) {
    return null;
  }

  return {
    priceUsd: toFiniteNumber(best.priceUsd),
    marketCapUsd: toFiniteNumber(best.marketCap) ?? toFiniteNumber(best.fdv),
    priceChangeH24: toFiniteNumber(best.priceChange?.h24),
    url: best.url?.trim() || null,
    dexId: best.dexId?.trim() || null,
    quoteSymbol: best.quoteToken?.symbol?.trim() || null,
    pairAddress: best.pairAddress?.trim() || null,
    tokenName: best.baseToken?.name?.trim() || best.baseToken?.symbol?.trim() || null,
  };
}

async function withTimeout<T>(factory: (signal: AbortSignal) => Promise<T>, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await factory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchDexScreenerPairStats(
  mint: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<PairStats | null> {
  const normalizedMint = mint.trim();
  if (!normalizedMint) {
    return null;
  }

  const cached = pairCache.get(normalizedMint);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await withTimeout(
      (signal) =>
        fetchImpl(`${DEXSCREENER_TOKEN_URL}/${encodeURIComponent(normalizedMint)}`, {
          method: "GET",
          signal,
        }),
      PAIR_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      pairCache.setWithTTL(normalizedMint, null);
      return null;
    }

    const payload = tokenResponseSchema.parse(await response.json());
    const stats = selectSolanaPair(payload.pairs ?? []);
    pairCache.setWithTTL(normalizedMint, stats);
    return stats;
  } catch {
    const stale = pairCache.peek(normalizedMint);
    return stale === undefined ? null : stale;
  }
}

export const __test_clearDexScreenerCache = (): void => {
  pairCache.clear();
};
