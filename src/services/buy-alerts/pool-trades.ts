import { z } from "zod";
import { WSOL_MINT } from "../../utils/constants";
import { fetchDexScreenerPairStats } from "./dexscreener";
import { mapDexFromPool } from "./parser";
import type { BuyEvent, BuyFeed, PairStats } from "./types";

const GECKO_POOL_TRADES_URL = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const TRADE_FETCH_TIMEOUT_MS = 5_000;
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
    data: z.array(geckoTradeSchema).optional(),
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

  const kind = (attrs.kind ?? "").trim().toLowerCase();
  if (kind && kind !== "buy") {
    return null;
  }

  const trader = (attrs.tx_from_address ?? "").trim();
  const tokenAmount = parseFiniteNumber(attrs.to_token_amount);
  const fromAmount = parseFiniteNumber(attrs.from_token_amount);
  if (!trader || tokenAmount == null || tokenAmount <= 0) {
    return null;
  }

  const solAmount = isSolMint(fromMint) ? (fromAmount ?? 0) : 0;

  return {
    signature: attrs.tx_hash.trim(),
    mint,
    trader,
    solAmount,
    tokenAmount,
    dex: mapDexFromPool(dexId),
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
  fetchTrades?: (pairAddress: string) => Promise<unknown>;
  intervalMs?: number;
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
    return { data: [] };
  }
  return response.json();
}

export type PoolTradePoller = BuyFeed & {
  pollNow: () => Promise<void>;
};

export function createPoolTradePoller(options: PoolTradePollerOptions = {}): PoolTradePoller {
  const fetchPairStats = options.fetchPairStats ?? fetchDexScreenerPairStats;
  const fetchTrades = options.fetchTrades ?? fetchGeckoTrades;
  const intervalMs = options.intervalMs ?? POOL_TRADE_POLL_MS;

  let mints: string[] = [];
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const handlers = new Set<(event: BuyEvent) => void>();
  const seen = new Map<string, Set<string>>();
  const primed = new Set<string>();

  const emit = (event: BuyEvent) => {
    for (const handler of handlers) {
      handler(event);
    }
  };

  const pollMint = async (mint: string) => {
    const pair = await fetchPairStats(mint);
    const pairAddress = pair?.pairAddress?.trim();
    if (!pairAddress) {
      return;
    }

    let payload: unknown;
    try {
      payload = await fetchTrades(pairAddress);
    } catch {
      return;
    }

    const parsed = geckoTradesResponseSchema.safeParse(payload);
    const trades = parsed.success ? (parsed.data.data ?? []) : [];
    const known = seen.get(mint) ?? new Set<string>();
    const isFirstPass = !primed.has(mint);

    for (const trade of trades) {
      const event = parseGeckoPoolTrade(mint, trade, pair?.dexId);
      if (!event) continue;
      if (!rememberSignature(known, event.signature)) continue;
      if (!isFirstPass) {
        emit(event);
      }
    }

    seen.set(mint, known);
    primed.add(mint);
  };

  let pollChain = Promise.resolve();

  const pollNow = async () => {
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
    await next;
  };

  const startTimer = () => {
    if (timer || mints.length === 0) return;
    timer = setInterval(() => {
      void pollNow();
    }, intervalMs);
    if (typeof (timer as NodeJS.Timeout).unref === "function") {
      (timer as NodeJS.Timeout).unref();
    }
    void pollNow();
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
      for (const mint of Array.from(seen.keys())) {
        if (!nextSet.has(mint)) {
          seen.delete(mint);
          primed.delete(mint);
        }
      }
      mints = Array.from(nextSet);
      cursor = 0;
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
    },
    pollNow,
  };
}
