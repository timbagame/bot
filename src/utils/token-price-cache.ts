import { TOKEN_PRICE_CACHE_TTL_MS } from "./constants";
import { createExpiringCache } from "./expiring-cache";
import {
  resolveTokenPriceUSD,
  type PriceLookupOptions,
  type PriceLookupResult,
} from "./prices";

type PriceCacheLookupRequest = PriceLookupOptions;

export type CachedPriceLookup = PriceLookupResult & {
  tokenMint?: string;
  tokenTicker?: string;
  resolvedAt: number;
};

const priceCache = createExpiringCache<CachedPriceLookup>(
  TOKEN_PRICE_CACHE_TTL_MS
);

const normalize = (value?: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
};

const buildCacheKeys = (request: PriceCacheLookupRequest): string[] => {
  const keys = new Set<string>();
  const normalizedMint = normalize(request.tokenMint);
  const normalizedTicker = normalize(request.tokenTicker);

  if (normalizedMint) {
    keys.add(normalizedMint);
  }

  if (normalizedTicker) {
    keys.add(normalizedTicker);
  }

  return Array.from(keys.values());
};

export function rememberPriceLookup(
  lookup: PriceLookupResult,
  request: PriceCacheLookupRequest
): CachedPriceLookup {
  const entry: CachedPriceLookup = {
    ...lookup,
    tokenMint: request.tokenMint?.trim() || undefined,
    tokenTicker: request.tokenTicker?.trim() || undefined,
    resolvedAt: Date.now(),
  };

  const keys = buildCacheKeys(request);
  for (const key of keys) {
    priceCache.setWithTTL(key, entry);
  }

  return entry;
}

export function getCachedPriceLookup(
  request: PriceCacheLookupRequest
): CachedPriceLookup | null {
  const keys = buildCacheKeys(request);
  for (const key of keys) {
    const cached = priceCache.get(key);
    if (cached) {
      return cached;
    }
  }
  return null;
}

export async function resolvePriceWithCache(
  request: PriceCacheLookupRequest
): Promise<CachedPriceLookup | null> {
  const cached = getCachedPriceLookup(request);
  if (cached) {
    return cached;
  }

  const { tokenMint, tokenTicker, isSol, fetchImpl } = request;
  const live = await resolveTokenPriceUSD({
    tokenMint,
    tokenTicker,
    isSol,
    fetchImpl,
  });
  if (!live) {
    return null;
  }

  return rememberPriceLookup(live, request);
}

export function __test_clearTokenPriceCache(): void {
  priceCache.clear();
}
