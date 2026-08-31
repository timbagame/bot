import { z } from "zod";
import { WSOL_MINT } from "../../utils/constants";
import { fetchDexScreenerPoolStats } from "./dexscreener";
import { mapDexFromPool } from "./parser";
import type { BuyEvent, BuyFeed, PairStats } from "./types";

const GECKO_POOL_TRADES_URL = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const TRADE_FETCH_TIMEOUT_MS = 5_000;
// Keep the keyless GeckoTerminal feed below its approximate 10 requests/minute limit.
const GECKO_MIN_REQUEST_INTERVAL_MS = 7_000;
export const POOL_TRADE_POLL_MS = 8_000;
export const MAX_SEEN_SIGNATURES_PER_MINT = 400;

export function rememberSignature(
  known: Set<string>,
  signature: string,
  max = MAX_SEEN_SIGNATURES_PER_MINT,
): boolean {
  if (known.has(signature)) {
    return false;
  }
  known.add(signature);
  while (known.size > max) {
    const oldest = known.values().next().value;
    if (oldest == null) {
      break;
    }
    known.delete(oldest);
  }
  return true;
}

const numericSchema = z.union([z.number(), z.string()]);

const geckoTradeSchema = z
  .object({
    attributes: z
      .object({
        tx_hash: z.string().min(1),
        tx_from_address: z.string().optional(),
        from_token_amount: numericSchema.optional(),
        to_token_amount: numericSchema.optional(),
        kind: z.string().optional(),
        from_token_address: z.string().optional(),
        to_token_address: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const geckoTradesResponseSchema = z
  .object({
    data: z.array(geckoTradeSchema),
  })
  .passthrough();

function parseFiniteNumber(value: number | string | undefined): number | null {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return numeric;
}

function isSolMint(mint: string | undefined): boolean {
  const normalized = mint?.trim() ?? "";
  return normalized === WSOL_MINT;
}

export function parseGeckoPoolTrade(
  mint: string,
  payload: unknown,
  dexId?: string | null,
  inputSymbol?: string | null,
): BuyEvent | null {
  const parsed = geckoTradeSchema.safeParse(payload);
  if (!parsed.success) {
    return null;
  }

  const attrs = parsed.data.attributes;
  const toMint = (attrs.to_token_address ?? "").trim();
  const fromMint = (attrs.from_token_address ?? "").trim();
  if (toMint !== mint) {
    return null;
  }

  const trader = (attrs.tx_from_address ?? "").trim();
  const tokenAmount = parseFiniteNumber(attrs.to_token_amount);
  const fromAmount = parseFiniteNumber(attrs.from_token_amount);
  if (!trader || tokenAmount == null || tokenAmount <= 0) {
    return null;
  }

  const solAmount = isSolMint(fromMint) && fromAmount != null && fromAmount > 0 ? fromAmount : null;

  return {
    signature: attrs.tx_hash.trim(),
    mint,
    trader,
    solAmount,
    inputAmount: fromAmount,
    inputSymbol: inputSymbol?.trim() || (isSolMint(fromMint) ? "SOL" : null),
    tokenAmount,
    dex: mapDexFromPool(dexId),
    dexId: dexId?.trim() || null,
    quoteSymbol: inputSymbol?.trim() || (isSolMint(fromMint) ? "SOL" : null),
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

export type PoolTradePollerOptions = {
  fetchPairStats?: (mint: string) => Promise<PairStats | null>;
  fetchPoolStats?: (mint: string) => Promise<PairStats[]>;
  fetchTrades?: (pairAddress: string) => Promise<unknown>;
  intervalMs?: number;
  minRequestIntervalMs?: number;
};

async function fetchGeckoTrades(pairAddress: string): Promise<unknown> {
  const response = await withTimeout(
    (signal) =>
      fetch(`${GECKO_POOL_TRADES_URL}/${encodeURIComponent(pairAddress)}/trades`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      }),
    TRADE_FETCH_TIMEOUT_MS,
  );
  if (!response.ok) {
    throw new Error(`GeckoTerminal trades request failed with status ${response.status}`);
  }
  return response.json();
}

export type PoolTradePoller = BuyFeed & {
  pollNow: () => Promise<void>;
};

export function createPoolTradePoller(options: PoolTradePollerOptions = {}): PoolTradePoller {
  const fetchPoolStats =
    options.fetchPoolStats ??
    (options.fetchPairStats
      ? async (mint: string) => {
          const pair = await options.fetchPairStats!(mint);
          return pair ? [pair] : [];
        }
      : fetchDexScreenerPoolStats);
  const fetchTrades = options.fetchTrades ?? fetchGeckoTrades;
  const intervalMs = options.intervalMs ?? POOL_TRADE_POLL_MS;
  const minRequestIntervalMs = Math.max(
    0,
    options.minRequestIntervalMs ?? GECKO_MIN_REQUEST_INTERVAL_MS,
  );

  let mints: string[] = [];
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const handlers = new Set<(event: BuyEvent) => void>();
  const seen = new Map<string, Map<string, Set<string>>>();
  const primed = new Map<string, Set<string>>();
  const discoveredPools = new Map<string, Set<string>>();
  const baselinePools = new Map<string, Set<string>>();
  const lastPolledPool = new Map<string, string>();
  let nextTradeFetchAt = 0;
  let consecutiveTradeFailures = 0;

  const emit = (event: BuyEvent) => {
    for (const handler of handlers) {
      handler(event);
    }
  };

  const waitForTradeSlot = async () => {
    if (minRequestIntervalMs <= 0) return;
    const current = Date.now();
    const scheduled = Math.max(current, nextTradeFetchAt);
    nextTradeFetchAt = scheduled + minRequestIntervalMs;
    if (scheduled > current) {
      await new Promise<void>((resolve) => setTimeout(resolve, scheduled - current));
    }
  };

  const deferAfterTradeFailure = () => {
    consecutiveTradeFailures += 1;
    if (minRequestIntervalMs <= 0) return;
    const multiplier = 2 ** Math.min(consecutiveTradeFailures - 1, 4);
    nextTradeFetchAt = Math.max(nextTradeFetchAt, Date.now() + minRequestIntervalMs * multiplier);
  };

  const pollPool = async (
    mint: string,
    pair: PairStats,
    suppressFirstPass: boolean,
  ): Promise<boolean> => {
    const pairAddress = pair?.pairAddress?.trim();
    if (!pairAddress) {
      return false;
    }

    let payload: unknown;
    try {
      await waitForTradeSlot();
      if (!mints.includes(mint)) {
        return false;
      }
      payload = await fetchTrades(pairAddress);
    } catch {
      deferAfterTradeFailure();
      return false;
    }

    const parsed = geckoTradesResponseSchema.safeParse(payload);
    if (!parsed.success) {
      deferAfterTradeFailure();
      return false;
    }
    consecutiveTradeFailures = 0;
    const trades = parsed.data.data;
    const mintSeen = seen.get(mint) ?? new Map<string, Set<string>>();
    const known = mintSeen.get(pairAddress) ?? new Set<string>();
    const mintPrimed = primed.get(mint) ?? new Set<string>();
    const isFirstPass = !mintPrimed.has(pairAddress);

    for (const trade of trades) {
      const event = parseGeckoPoolTrade(mint, trade, pair.dexId, pair.quoteSymbol);
      if (!event) continue;
      if (!rememberSignature(known, event.signature)) continue;
      if (!isFirstPass || !suppressFirstPass) {
        emit(event);
      }
    }

    mintSeen.set(pairAddress, known);
    seen.set(mint, mintSeen);
    mintPrimed.add(pairAddress);
    primed.set(mint, mintPrimed);
    return true;
  };

  const pollMint = async (mint: string) => {
    let pools: PairStats[];
    try {
      pools = await fetchPoolStats(mint);
    } catch {
      return;
    }
    const uniquePools = new Map<string, PairStats>();
    for (const pool of pools) {
      const pairAddress = pool.pairAddress?.trim();
      if (pairAddress && !uniquePools.has(pairAddress)) {
        uniquePools.set(pairAddress, pool);
      }
    }
    const poolsToPoll = Array.from(uniquePools.values());
    if (poolsToPoll.length === 0) {
      return;
    }

    let knownPools = discoveredPools.get(mint);
    if (!knownPools) {
      knownPools = new Set(uniquePools.keys());
      discoveredPools.set(mint, knownPools);
      baselinePools.set(mint, new Set(knownPools));
    } else {
      for (const pairAddress of uniquePools.keys()) {
        knownPools.add(pairAddress);
      }
    }

    const previousPair = lastPolledPool.get(mint);
    const previousIndex = previousPair
      ? poolsToPoll.findIndex((pool) => pool.pairAddress?.trim() === previousPair)
      : -1;
    const nextIndex = previousIndex >= 0 ? (previousIndex + 1) % poolsToPoll.length : 0;
    const pool = poolsToPoll[nextIndex];
    const pairAddress = pool?.pairAddress?.trim();
    if (!pool || !pairAddress) {
      return;
    }

    lastPolledPool.set(mint, pairAddress);
    const suppressFirstPass = baselinePools.get(mint)?.has(pairAddress) ?? false;
    const succeeded = await pollPool(mint, pool, suppressFirstPass);
    if (succeeded) {
      baselinePools.get(mint)?.delete(pairAddress);
    }
  };

  let pollChain = Promise.resolve();
  let queuedPolls = 0;

  const pollNow = async () => {
    queuedPolls += 1;
    const run = async () => {
      if (mints.length === 0) return;
      const mint = mints[cursor % mints.length];
      cursor += 1;
      if (!mint) return;
      await pollMint(mint);
    };
    const next = pollChain.then(run, run);
    pollChain = next.then(
      () => undefined,
      () => undefined,
    );
    try {
      await next;
    } finally {
      queuedPolls -= 1;
    }
  };

  const startTimer = () => {
    if (timer || mints.length === 0) return;
    timer = setInterval(() => {
      if (queuedPolls === 0) {
        void pollNow();
      }
    }, intervalMs);
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
    if (queuedPolls === 0) {
      void pollNow();
    }
  };

  const stopTimer = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  return {
    setMints: (nextMints) => {
      const normalized = nextMints.map((mint) => mint.trim()).filter((mint) => mint.length > 0);
      const nextSet = new Set(normalized);
      for (const mint of mints) {
        if (!nextSet.has(mint)) {
          seen.delete(mint);
          primed.delete(mint);
          discoveredPools.delete(mint);
          baselinePools.delete(mint);
          lastPolledPool.delete(mint);
        }
      }
      mints = Array.from(nextSet);
      if (cursor >= mints.length) {
        cursor = 0;
      }
      if (mints.length === 0) {
        stopTimer();
        return;
      }
      startTimer();
    },
    onTrade: (handler) => {
      handlers.add(handler);
    },
    stop: () => {
      mints = [];
      stopTimer();
      seen.clear();
      primed.clear();
      discoveredPools.clear();
      baselinePools.clear();
      lastPolledPool.clear();
      nextTradeFetchAt = 0;
      consecutiveTradeFailures = 0;
    },
    pollNow,
  };
}
