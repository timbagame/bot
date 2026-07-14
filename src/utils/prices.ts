import { JUPITER_PRICE_URL, PRICES_CACHE_TTL_MS, PRICES_TIMEOUT_MS } from "./constants";
import { PublicKey } from "@solana/web3.js";
import { createExpiringCache, type ExpiringCache } from "./expiring-cache";
import type { FetchLike } from "../types";

type PriceCacheEntry = {
  value?: number;
  inflight?: Promise<number>;
};

const priceCache: ExpiringCache<PriceCacheEntry> = createExpiringCache(PRICES_CACHE_TTL_MS);

const PRICES_ENV_KEY = "PRICES_ENABLED";

function isPricesEnabled(): boolean {
  if (typeof process !== "undefined" && process?.env) {
    const override = process.env[PRICES_ENV_KEY];
    if (override !== undefined) {
      return override.toLowerCase() !== "false";
    }
  }

  return true;
}

function normalizeKey(id: string): string {
  return id.trim();
}

function isValidMintAddress(value: string): boolean {
  if (!value) return false;
  try {
    return new PublicKey(value).toBase58() === value;
  } catch {
    return false;
  }
}

async function withTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    return await factory(ac.signal);
  } catch (error) {
    if ((error as any)?.name === "AbortError" || (error as any)?.code === "ABORT_ERR") {
      throw new Error("timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pickValidPrice(candidates: Array<number | string | null | undefined>): number | null {
  for (const candidate of candidates) {
    const price = typeof candidate === "number" ? candidate : Number(candidate);
    if (price && Number.isFinite(price) && price > 0) {
      return price;
    }
  }
  return null;
}

async function fetchFromJupiter(
  id: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<number | null> {
  try {
    const url = new URL(JUPITER_PRICE_URL);
    url.searchParams.set("ids", id);
    const apiKey = process.env.JUPITER_API_KEY;

    const res = await withTimeout(
      (signal) =>
        fetchImpl(url.toString(), {
          method: "GET",
          headers: apiKey ? { "x-api-key": apiKey } : undefined,
          signal,
        }),
      timeoutMs,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const entry = data?.data?.[id] ?? data?.[id];
    if (!entry) return null;
    return pickValidPrice([entry?.price, entry?.usdPrice, entry?.usd_price]);
  } catch {
    return null;
  }
}

async function fetchBatchFromJupiter(
  ids: string[],
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<Record<string, number | null>> {
  const uniqueIds = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) {
    return {};
  }

  try {
    const url = new URL(JUPITER_PRICE_URL);
    url.searchParams.set("ids", uniqueIds.join(","));
    const apiKey = process.env.JUPITER_API_KEY;

    const res = await withTimeout(
      (signal) =>
        fetchImpl(url.toString(), {
          method: "GET",
          headers: apiKey ? { "x-api-key": apiKey } : undefined,
          signal,
        }),
      timeoutMs,
    );
    if (!res.ok) {
      return {};
    }

    const data = (await res.json()) as any;
    const container = data?.data ?? data ?? {};
    return uniqueIds.reduce<Record<string, number | null>>((acc, requestId) => {
      const entry = container?.[requestId];
      acc[requestId] = entry
        ? pickValidPrice([entry?.price, entry?.usdPrice, entry?.usd_price])
        : null;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

export async function getPriceUSD(
  mintAddress: string,
  fetchImpl: FetchLike = globalThis.fetch as any,
): Promise<number> {
  if (!isPricesEnabled()) return 0;
  const key = normalizeKey(mintAddress);
  if (!key || !isValidMintAddress(key)) return 0;

  const liveEntry = priceCache.get(key);
  if (liveEntry?.value !== undefined) {
    return liveEntry.value;
  }

  const cachedOrPending = priceCache.peek(key);
  if (cachedOrPending?.inflight) {
    return cachedOrPending.inflight;
  }

  const staleValue = cachedOrPending?.value;

  const inflightRef: { current?: Promise<number> } = {};

  const pendingPromise = (async () => {
    let resolvedPrice = 0;
    try {
      // 1) Jupiter price endpoint
      const fromJup = await fetchFromJupiter(key, fetchImpl, PRICES_TIMEOUT_MS);
      if (fromJup && fromJup > 0) {
        resolvedPrice = fromJup;
        priceCache.setWithTTL(key, { value: fromJup });
        return fromJup;
      }

      // 2) Give up
      return 0;
    } finally {
      const latest = priceCache.peek(key);
      if (latest?.inflight === inflightRef.current) {
        if (resolvedPrice > 0) {
          priceCache.setWithTTL(key, { value: resolvedPrice });
        } else if (latest?.value !== undefined) {
          priceCache.setWithTTL(key, { value: latest.value });
        } else {
          priceCache.delete(key);
        }
      }
    }
  })();

  inflightRef.current = pendingPromise;

  priceCache.setWithTTL(key, { value: staleValue, inflight: pendingPromise });
  return pendingPromise;
}

export async function getPricesUSD(
  ids: string[],
  fetchImpl: FetchLike = globalThis.fetch as any,
): Promise<Record<string, number>> {
  if (!isPricesEnabled()) {
    return Object.fromEntries(ids.map((id) => [id, 0]));
  }

  const batchTargets = new Map<string, { requestId: string; normalizedKeys: Set<string> }>();

  for (const id of ids) {
    const normalizedKey = normalizeKey(id);
    if (!normalizedKey || !isValidMintAddress(normalizedKey)) {
      continue;
    }

    const target = batchTargets.get(normalizedKey);
    if (target) {
      target.normalizedKeys.add(normalizedKey);
    } else {
      batchTargets.set(normalizedKey, {
        requestId: normalizedKey,
        normalizedKeys: new Set([normalizedKey]),
      });
    }
  }

  if (batchTargets.size > 0) {
    const requests = Array.from(batchTargets.values());
    const fetched = await fetchBatchFromJupiter(
      requests.map((item) => item.requestId),
      fetchImpl,
      PRICES_TIMEOUT_MS,
    );

    for (const target of requests) {
      const price = fetched[target.requestId];
      if (!price || !Number.isFinite(price) || price <= 0) {
        continue;
      }
      for (const normalizedKey of target.normalizedKeys) {
        priceCache.setWithTTL(normalizedKey, { value: price });
      }
    }
  }

  const entries = await Promise.all(
    ids.map(async (id) => [id, await getPriceUSD(id, fetchImpl)] as const),
  );
  return Object.fromEntries(entries);
}

export type PriceLookupOptions = {
  tokenMint?: string;
  fetchImpl?: FetchLike;
};

export type PriceLookupResult = {
  price: number;
  identifier: string;
};

export async function resolveTokenPriceUSD({
  tokenMint,
  fetchImpl,
}: PriceLookupOptions): Promise<PriceLookupResult | null> {
  const candidate = tokenMint?.trim();
  if (!candidate) return null;
  const price = await getPriceUSD(candidate, fetchImpl);
  if (price && Number.isFinite(price) && price > 0) {
    return { price, identifier: candidate };
  }

  return null;
}

export function __test_resetPriceCache(): void {
  priceCache.clear();
}
