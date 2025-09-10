import { JUPITER_PRICE_URL, PRICES_CACHE_TTL_MS, PRICES_TIMEOUT_MS, PRICES_ENABLED } from "./constants";

export type PriceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, { price: number; ts: number }>();
const inflight = new Map<string, Promise<number>>();

const WSOL_MINT = "So11111111111111111111111111111111111111112";

function normalizeKey(id: string): string {
  return id.trim().toUpperCase();
}

function now() {
  return Date.now();
}

async function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Caller should pass ac.signal in fetch init; for generic promises, just race
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
    ]);
  } finally {
    clearTimeout(t);
  }
}

function toMintOrId(mintOrTicker: string): { jupId: string; forDex: string } {
  const key = normalizeKey(mintOrTicker);
  if (key === "SOL") return { jupId: "SOL", forDex: WSOL_MINT };
  return { jupId: mintOrTicker, forDex: mintOrTicker };
}

async function fetchFromJupiter(id: string, fetchImpl: PriceFetch, timeoutMs: number): Promise<number | null> {
  try {
    const url = new URL(JUPITER_PRICE_URL);
    url.searchParams.set("ids", id);
    const res = await withTimeout(fetchImpl(url.toString(), { method: "GET" }), timeoutMs);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    // Jupiter returns { data: { [id]: { price: number } } }
    const entry = data?.data?.[id];
    const price = typeof entry?.price === "number" ? entry.price : Number(entry?.price);
    if (!price || !isFinite(price)) return null;
    return price;
  } catch {
    return null;
  }
}

async function fetchFromDexScreener(addr: string, fetchImpl: PriceFetch, timeoutMs: number): Promise<number | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
    const res = await withTimeout(fetchImpl(url, { method: "GET" }), timeoutMs);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const priceStr = data?.pairs?.[0]?.priceUsd;
    const price = typeof priceStr === "string" ? Number(priceStr) : Number(priceStr);
    if (!price || !isFinite(price)) return null;
    return price;
  } catch {
    return null;
  }
}

export async function getPriceUSD(
  mintOrTicker: string,
  fetchImpl: PriceFetch = (globalThis.fetch as any)
): Promise<number> {
  if (!PRICES_ENABLED) return 0;
  const key = normalizeKey(mintOrTicker);

  const c = cache.get(key);
  if (c && now() - c.ts < PRICES_CACHE_TTL_MS) return c.price;

  const inflightKey = key;
  const existing = inflight.get(inflightKey);
  if (existing) return existing;

  const p = (async () => {
    try {
      const { jupId, forDex } = toMintOrId(mintOrTicker);

      // 1) Jupiter price endpoint
      const fromJup = await fetchFromJupiter(jupId, fetchImpl, PRICES_TIMEOUT_MS);
      if (fromJup && fromJup > 0) {
        cache.set(key, { price: fromJup, ts: now() });
        return fromJup;
      }

      // 2) DexScreener fallback (requires address)
      const fromDex = await fetchFromDexScreener(forDex, fetchImpl, PRICES_TIMEOUT_MS);
      if (fromDex && fromDex > 0) {
        cache.set(key, { price: fromDex, ts: now() });
        return fromDex;
      }

      // 3) Give up
      return 0;
    } finally {
      inflight.delete(inflightKey);
    }
  })();

  inflight.set(inflightKey, p);
  return p;
}

export async function getPricesUSD(
  ids: string[],
  fetchImpl: PriceFetch = (globalThis.fetch as any)
): Promise<Record<string, number>> {
  const entries = await Promise.all(
    ids.map(async (id) => [id, await getPriceUSD(id, fetchImpl)] as const)
  );
  return Object.fromEntries(entries);
}

