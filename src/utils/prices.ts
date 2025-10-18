import {
  JUPITER_PRICE_URL,
  PRICES_CACHE_TTL_MS,
  PRICES_TIMEOUT_MS,
} from "./constants";
import { WSOL_MINT } from "./token-registry";

export type PriceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const cache = new Map<string, { price: number; ts: number }>();
const inflight = new Map<string, Promise<number>>();

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
  if (key === "SOL") return { jupId: WSOL_MINT, forDex: WSOL_MINT };
  return { jupId: mintOrTicker, forDex: mintOrTicker };
}

function pickValidPrice(
  candidates: Array<number | string | null | undefined>
): number | null {
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
  fetchImpl: PriceFetch,
  timeoutMs: number
): Promise<number | null> {
  try {
    const url = new URL(JUPITER_PRICE_URL);
    url.searchParams.set("ids", id);
    const res = await withTimeout(fetchImpl(url.toString(), { method: "GET" }), timeoutMs);
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const entry = data?.data?.[id] ?? data?.[id];
    if (!entry) return null;
    return pickValidPrice([entry?.price, entry?.usdPrice, entry?.usd_price]);
  } catch {
    return null;
  }
}

async function fetchFromPumpFun(
  addr: string,
  fetchImpl: PriceFetch,
  timeoutMs: number
): Promise<number | null> {
  try {
    const url = `https://frontend-api.pump.fun/coins/${addr}`;
    const res = await withTimeout(
      fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "timba-bot/1.0 (+https://timba.ai)",
        },
      }),
      timeoutMs
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return pickValidPrice([
      data?.usdPrice,
      data?.usd_price,
      data?.usdValue,
      data?.priceUsd,
      data?.price_usd,
      data?.usd_market_cap
        ? Number(data?.usd_market_cap) /
          Number(data?.supply ?? data?.supplyInTokens ?? 0)
        : undefined,
      data?.priceInSol && data?.solPrice
        ? Number(data?.priceInSol) * Number(data?.solPrice)
        : undefined,
    ]);
  } catch {
    return null;
  }
}

export async function getPriceUSD(
  mintOrTicker: string,
  fetchImpl: PriceFetch = (globalThis.fetch as any)
): Promise<number> {
  if (!isPricesEnabled()) return 0;
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

      // 2) Pump.fun fallback (requires address)
      const fromPump = await fetchFromPumpFun(forDex, fetchImpl, PRICES_TIMEOUT_MS);
      if (fromPump && fromPump > 0) {
        cache.set(key, { price: fromPump, ts: now() });
        return fromPump;
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

