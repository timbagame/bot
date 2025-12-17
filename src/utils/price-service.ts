import { TOKEN_PRICE_CACHE_TTL_MS } from "./constants";
import { createExpiringCache } from "./expiring-cache";
import {
  resolveTokenPriceUSD,
  type PriceLookupOptions,
  type PriceLookupResult,
} from "./prices";

export type PriceLookupRequest = PriceLookupOptions;

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

const buildCacheKeys = (request: PriceLookupRequest): string[] => {
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

const isHintFresh = (hint: CachedPriceLookup): boolean => {
  const now = Date.now();
  return now - hint.resolvedAt <= TOKEN_PRICE_CACHE_TTL_MS;
};

const matchesRequest = (
  hint: CachedPriceLookup,
  request: PriceLookupRequest
): boolean => {
  const keys = buildCacheKeys(request);
  const hintKeys = new Set(
    buildCacheKeys({
      tokenMint: hint.tokenMint,
      tokenTicker: hint.tokenTicker,
    })
  );

  if (keys.length === 0) {
    return hintKeys.size > 0;
  }

  return keys.some((key) => hintKeys.has(key));
};

export function rememberPriceLookup(
  lookup: PriceLookupResult | CachedPriceLookup,
  request: PriceLookupRequest
): CachedPriceLookup {
  const entry: CachedPriceLookup = {
    ...lookup,
    tokenMint: request.tokenMint?.trim() || (lookup as CachedPriceLookup).tokenMint,
    tokenTicker: request.tokenTicker?.trim() || (lookup as CachedPriceLookup).tokenTicker,
    resolvedAt:
      (lookup as CachedPriceLookup).resolvedAt ?? Date.now(),
  };

  const keys = buildCacheKeys(request);
  for (const key of keys) {
    priceCache.setWithTTL(key, entry);
  }

  return entry;
}

export function getCachedPriceLookup(
  request: PriceLookupRequest
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

const maybeUseHint = (
  hint: CachedPriceLookup | null | undefined,
  request: PriceLookupRequest
): CachedPriceLookup | null => {
  if (!hint) return null;
  if (!matchesRequest(hint, request)) return null;
  if (!isHintFresh(hint)) return null;

  return rememberPriceLookup(hint, request);
};

export async function getUsdPrice(
  input: PriceLookupRequest & { hint?: CachedPriceLookup | null }
): Promise<CachedPriceLookup | null> {
  const request: PriceLookupRequest = {
    tokenMint: input.tokenMint,
    tokenTicker: input.tokenTicker,
    isSol: input.isSol,
    fetchImpl: input.fetchImpl,
  };

  const hintResult = maybeUseHint(input.hint, request);
  if (hintResult) {
    return hintResult;
  }

  const cached = getCachedPriceLookup(request);
  if (cached) {
    return cached;
  }

  const live = await resolveTokenPriceUSD(request);
  if (!live) {
    return null;
  }

  return rememberPriceLookup(live, request);
}

export function __test_clearPriceServiceCache(): void {
  priceCache.clear();
}
