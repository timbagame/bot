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
        address: z.string().optional(),
        name: z.string().optional(),
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

const pairCache = createExpiringCache<PairStats[]>(PAIR_CACHE_TTL_MS);

function toFiniteNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function liquidityUsd(pair: z.infer<typeof pairSchema>): number {
  return toFiniteNumber(pair.liquidity?.usd) ?? 0;
}

function mapPairStats(pair: z.infer<typeof pairSchema>, mint?: string): PairStats {
  const normalizedMint = mint?.trim() ?? "";
  const targetIsQuote =
    normalizedMint.length > 0 && pair.quoteToken?.address?.trim() === normalizedMint;
  const token = targetIsQuote ? pair.quoteToken : pair.baseToken;
  const counterToken = targetIsQuote ? pair.baseToken : pair.quoteToken;

  return {
    // DEX Screener's price, market cap, and change fields describe the base token.
    // Keep them unknown when the watched token is the quote side instead of
    // attributing the base token's statistics to it.
    priceUsd: targetIsQuote ? null : toFiniteNumber(pair.priceUsd),
    marketCapUsd: targetIsQuote
      ? null
      : (toFiniteNumber(pair.marketCap) ?? toFiniteNumber(pair.fdv)),
    priceChangeH24: targetIsQuote ? null : toFiniteNumber(pair.priceChange?.h24),
    url: pair.url?.trim() || null,
    dexId: pair.dexId?.trim() || null,
    quoteSymbol: counterToken?.symbol?.trim() || null,
    pairAddress: pair.pairAddress?.trim() || null,
    tokenName: token?.name?.trim() || token?.symbol?.trim() || null,
  };
}

export function selectSolanaPairs(
  pairs: Array<z.infer<typeof pairSchema>> | null | undefined,
  mint?: string,
): PairStats[] {
  if (!pairs || pairs.length === 0) {
    return [];
  }

  const normalizedMint = mint?.trim() ?? "";
  const ranked = pairs.filter((pair) => {
    if ((pair.chainId ?? "").toLowerCase() !== "solana") {
      return false;
    }
    if (!normalizedMint) {
      return true;
    }
    return (
      pair.baseToken?.address?.trim() === normalizedMint ||
      pair.quoteToken?.address?.trim() === normalizedMint
    );
  });

  ranked.sort((a, b) => {
    if (normalizedMint) {
      const aIsBase = a.baseToken?.address?.trim() === normalizedMint;
      const bIsBase = b.baseToken?.address?.trim() === normalizedMint;
      if (aIsBase !== bIsBase) {
        return aIsBase ? -1 : 1;
      }
    }
    return liquidityUsd(b) - liquidityUsd(a);
  });

  return ranked.map((pair) => mapPairStats(pair, normalizedMint));
}

export function selectSolanaPair(
  pairs: Array<z.infer<typeof pairSchema>> | null | undefined,
  mint?: string,
): PairStats | null {
  return selectSolanaPairs(pairs, mint)[0] ?? null;
}

export async function fetchDexScreenerPoolStats(
  mint: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<PairStats[]> {
  const normalizedMint = mint.trim();
  if (!normalizedMint) {
    return [];
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
      pairCache.setWithTTL(normalizedMint, []);
      return [];
    }

    const payload = tokenResponseSchema.parse(await response.json());
    const stats = selectSolanaPairs(payload.pairs ?? [], normalizedMint);
    pairCache.setWithTTL(normalizedMint, stats);
    return stats;
  } catch {
    const stale = pairCache.peek(normalizedMint);
    return stale ?? [];
  }
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
  return (await fetchDexScreenerPoolStats(mint, fetchImpl))[0] ?? null;
}

export const __test_clearDexScreenerCache = (): void => {
  pairCache.clear();
};
