import {
  copyableHtml,
  escapeHtml,
  formatAmount,
  formatRate,
  formatSignedPercent,
  formatUsdValue,
} from "../utils/format-amount";
import { WALLET_RPC_CACHE_TTL_MS, WSOL_MINT } from "../utils/constants";
import {
  getBuiltinTokenMetadataByMint,
  getBuiltinTokenMetadataByTicker,
} from "../utils/token-registry";
import type { SwapStatRecord } from "../utils/transaction-history";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);
const POSITION_SNAPSHOT_TTL_MS = WALLET_RPC_CACHE_TTL_MS;

export type PositionFill = {
  mint: string;
  ticker: string;
  side: "buy" | "sell";
  tokenAmount: number;
  quoteMint: string;
  quoteAmount: number;
  timestamp: number;
  source?: "cash" | "rotate";
  groupId?: string;
};

type LotCost = {
  costSol: number;
  costUsdc: number;
  costUsdt: number;
};

type TokenLot = LotCost & {
  ticker: string;
  qty: number;
  buyCount: number;
  sellCount: number;
};

export type TokenHolding = {
  mint: string;
  ticker: string;
  balance: number;
  decimals: number;
  rawBalance?: string;
};

export type TokenPosition = {
  mint: string;
  ticker: string;
  balance: number;
  trackedBalance: number;
  decimals: number;
  rawBalance?: string;
  avgEntrySol: number | null;
  avgEntryUsd: number | null;
  priceUsd: number | null;
  pnlPercent: number | null;
  unrealizedUsd: number | null;
  buyCount: number;
  sellCount: number;
  solSpent: number;
  usdcSpent: number;
  usdtSpent: number;
};

export type DecimalResolver = (mint: string, ticker: string) => number | null;

export type PositionSnapshotLoader = {
  walletAddress: string;
  getHoldings: () => Promise<TokenHolding[]>;
  getSwaps: () => SwapStatRecord[];
  fetchPricesUSD: (mints: string[]) => Promise<Record<string, number>>;
  knownTokens?: Array<{ mint?: string; token_mint?: string; decimals: number }>;
};

type PositionWorkCache = {
  expiresAt: number;
  fills: PositionFill[];
  swapFingerprint: string;
  fillKnownMints: Set<string>;
  pricesUsd: Record<string, number>;
  pricedMints: Set<string>;
};

const positionWorkCache = new Map<string, PositionWorkCache>();
const pendingPositionWork = new Map<string, Promise<PositionWorkCache>>();

export function isQuoteMint(mint: string): boolean {
  return QUOTE_MINTS.has(mint);
}

export function resolveTokenDecimals(
  mint: string,
  ticker: string,
  knownByMint?: ReadonlyMap<string, number>,
): number | null {
  const known = knownByMint?.get(mint);
  if (known != null) {
    return known;
  }
  return (
    getBuiltinTokenMetadataByMint(mint)?.decimals ??
    getBuiltinTokenMetadataByTicker(ticker)?.decimals ??
    null
  );
}

export function createDecimalResolver(
  known: Array<{ mint?: string; token_mint?: string; decimals: number }>,
): DecimalResolver {
  const byMint = new Map<string, number>();
  for (const token of known) {
    const mint = token.mint ?? token.token_mint;
    if (mint && Number.isFinite(token.decimals) && token.decimals >= 0 && token.decimals <= 18) {
      byMint.set(mint, token.decimals);
    }
  }
  return (mint, ticker) => resolveTokenDecimals(mint, ticker, byMint);
}

export function rawAmountToNumber(raw: string | undefined, decimals: number): number {
  if (!raw || decimals < 0) {
    return 0;
  }

  try {
    const value = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const frac = value % base;
    return Number(whole) + Number(frac) / Number(base);
  } catch {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      return 0;
    }
    return parsed / 10 ** decimals;
  }
}

export function quoteAmountToSol(quoteMint: string, quoteAmount: number): number {
  if (quoteAmount <= 0 || quoteMint !== WSOL_MINT) {
    return 0;
  }
  return quoteAmount;
}

export function quoteAmountToUsd(
  quoteMint: string,
  quoteAmount: number,
  solPriceUsd: number,
): number {
  if (quoteAmount <= 0) {
    return 0;
  }
  if (quoteMint === USDC_MINT || quoteMint === USDT_MINT) {
    return quoteAmount;
  }
  if (quoteMint === WSOL_MINT && solPriceUsd > 0) {
    return quoteAmount * solPriceUsd;
  }
  return 0;
}

export function fillsFromSwaps(
  swaps: SwapStatRecord[],
  resolveDecimals: DecimalResolver = resolveTokenDecimals,
): PositionFill[] {
  const fills: PositionFill[] = [];

  for (const swap of [...swaps].sort((left, right) => left.timestamp - right.timestamp)) {
    const inputMint = swap.input_mint;
    const outputMint = swap.output_mint;
    if (!inputMint || !outputMint || inputMint === outputMint) {
      continue;
    }
    if (isQuoteMint(inputMint) && isQuoteMint(outputMint)) {
      continue;
    }

    const inputDecimals = resolveDecimals(inputMint, swap.input_ticker);
    const outputDecimals = resolveDecimals(outputMint, swap.output_ticker);
    if (inputDecimals == null || outputDecimals == null) {
      continue;
    }
    const amountIn = rawAmountToNumber(swap.amount_in, inputDecimals);
    const amountOut = rawAmountToNumber(swap.amount_out, outputDecimals);
    if (amountIn <= 0 || amountOut <= 0) {
      continue;
    }

    if (isQuoteMint(inputMint) && !isQuoteMint(outputMint)) {
      fills.push({
        mint: outputMint,
        ticker: swap.output_ticker,
        side: "buy",
        tokenAmount: amountOut,
        quoteMint: inputMint,
        quoteAmount: amountIn,
        timestamp: swap.timestamp,
        source: "cash",
      });
      continue;
    }

    if (!isQuoteMint(inputMint) && isQuoteMint(outputMint)) {
      fills.push({
        mint: inputMint,
        ticker: swap.input_ticker,
        side: "sell",
        tokenAmount: amountIn,
        quoteMint: outputMint,
        quoteAmount: amountOut,
        timestamp: swap.timestamp,
        source: "cash",
      });
      continue;
    }

    const groupId = swap.signature || `${swap.timestamp}:${inputMint}:${outputMint}`;
    fills.push({
      mint: inputMint,
      ticker: swap.input_ticker,
      side: "sell",
      tokenAmount: amountIn,
      quoteMint: "",
      quoteAmount: 0,
      timestamp: swap.timestamp,
      source: "rotate",
      groupId,
    });
    fills.push({
      mint: outputMint,
      ticker: swap.output_ticker,
      side: "buy",
      tokenAmount: amountOut,
      quoteMint: "",
      quoteAmount: 0,
      timestamp: swap.timestamp,
      source: "rotate",
      groupId,
    });
  }

  return fills;
}

function compareFills(left: PositionFill, right: PositionFill): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  if (left.groupId && left.groupId === right.groupId) {
    if (left.side !== right.side) {
      return left.side === "sell" ? -1 : 1;
    }
  }
  return 0;
}

function getOrCreateLot(lots: Map<string, TokenLot>, mint: string, ticker: string): TokenLot {
  const existing = lots.get(mint);
  if (existing) {
    if (ticker) {
      existing.ticker = ticker;
    }
    return existing;
  }
  const created: TokenLot = {
    ticker,
    qty: 0,
    costSol: 0,
    costUsdc: 0,
    costUsdt: 0,
    buyCount: 0,
    sellCount: 0,
  };
  lots.set(mint, created);
  return created;
}

function lotHasCost(lot: LotCost): boolean {
  return lot.costSol > 0 || lot.costUsdc > 0 || lot.costUsdt > 0;
}

function aggregateTokenHoldings(holdings: TokenHolding[]): TokenHolding[] {
  const byMint = new Map<string, TokenHolding>();

  for (const holding of holdings) {
    const existing = byMint.get(holding.mint);
    if (!existing) {
      byMint.set(holding.mint, { ...holding });
      continue;
    }

    existing.balance += holding.balance;
    if (!existing.ticker && holding.ticker) {
      existing.ticker = holding.ticker;
    }

    const existingRaw = existing.rawBalance?.trim();
    const holdingRaw = holding.rawBalance?.trim();
    if (
      existing.decimals === holding.decimals &&
      existingRaw &&
      holdingRaw &&
      /^\d+$/.test(existingRaw) &&
      /^\d+$/.test(holdingRaw)
    ) {
      existing.rawBalance = (BigInt(existingRaw) + BigInt(holdingRaw)).toString();
    } else {
      existing.rawBalance = undefined;
    }
  }

  return [...byMint.values()];
}

function reduceLot(lot: TokenLot, tokenAmount: number): LotCost {
  const sold = Math.min(tokenAmount, lot.qty);
  if (lot.qty <= 0 || sold <= 0) {
    return { costSol: 0, costUsdc: 0, costUsdt: 0 };
  }
  const fraction = sold / lot.qty;
  const costSol = lot.costSol * fraction;
  const costUsdc = lot.costUsdc * fraction;
  const costUsdt = lot.costUsdt * fraction;
  lot.costSol -= costSol;
  lot.costUsdc -= costUsdc;
  lot.costUsdt -= costUsdt;
  lot.qty -= sold;
  return { costSol, costUsdc, costUsdt };
}

function addCashCost(lot: TokenLot, quoteMint: string, quoteAmount: number): void {
  if (quoteAmount <= 0) {
    return;
  }
  if (quoteMint === WSOL_MINT) {
    lot.costSol += quoteAmount;
    return;
  }
  if (quoteMint === USDC_MINT) {
    lot.costUsdc += quoteAmount;
    return;
  }
  if (quoteMint === USDT_MINT) {
    lot.costUsdt += quoteAmount;
  }
}

export function applyFillsToLots(fills: PositionFill[]): Map<string, TokenLot> {
  const lots = new Map<string, TokenLot>();
  const rotatedCost = new Map<string, LotCost>();

  for (const fill of [...fills].sort(compareFills)) {
    const lot = getOrCreateLot(lots, fill.mint, fill.ticker);
    const source = fill.source ?? "cash";

    if (source === "rotate" && fill.side === "sell") {
      const moved = reduceLot(lot, fill.tokenAmount);
      if (fill.groupId) {
        rotatedCost.set(fill.groupId, moved);
      }
      lot.sellCount += 1;
      continue;
    }

    if (source === "rotate" && fill.side === "buy") {
      const moved = (fill.groupId ? rotatedCost.get(fill.groupId) : undefined) ?? {
        costSol: 0,
        costUsdc: 0,
        costUsdt: 0,
      };
      lot.qty += fill.tokenAmount;
      lot.costSol += moved.costSol;
      lot.costUsdc += moved.costUsdc;
      lot.costUsdt += moved.costUsdt;
      continue;
    }

    if (fill.side === "buy") {
      lot.qty += fill.tokenAmount;
      addCashCost(lot, fill.quoteMint, fill.quoteAmount);
      lot.buyCount += 1;
      continue;
    }

    reduceLot(lot, fill.tokenAmount);
    lot.sellCount += 1;
  }

  return lots;
}

function collectPositionPriceMints(fills: PositionFill[], holdings: TokenHolding[]): string[] {
  const lots = applyFillsToLots(fills);
  const tokenMints = new Set<string>();
  let needsSolPrice = false;

  for (const holding of aggregateTokenHoldings(holdings)) {
    if (holding.balance <= 0 || isQuoteMint(holding.mint)) {
      continue;
    }
    const lot = lots.get(holding.mint);
    if (!lot || lot.qty <= 0 || !lotHasCost(lot)) {
      continue;
    }
    tokenMints.add(holding.mint);
    needsSolPrice ||= lot.costSol > 0;
  }

  return [...(needsSolPrice ? [WSOL_MINT] : []), ...tokenMints];
}

export function buildTokenPositions(args: {
  fills: PositionFill[];
  holdings: TokenHolding[];
  pricesUsd: Record<string, number>;
}): TokenPosition[] {
  const solPriceUsd = args.pricesUsd[WSOL_MINT] ?? 0;
  const lots = applyFillsToLots(args.fills);
  const positions: TokenPosition[] = [];

  for (const holding of aggregateTokenHoldings(args.holdings)) {
    if (holding.balance <= 0 || isQuoteMint(holding.mint)) {
      continue;
    }

    const lot = lots.get(holding.mint);
    if (!lot || lot.qty <= 0 || !lotHasCost(lot)) {
      continue;
    }

    const { qty, costSol, costUsdc, costUsdt, buyCount, sellCount } = lot;
    const costUsd = costUsdc + costUsdt;
    const markedUsd = costUsd + (solPriceUsd > 0 ? costSol * solPriceUsd : 0);
    const avgEntrySol = costSol > 0 ? costSol / qty : null;
    const priceUsd = args.pricesUsd[holding.mint] ?? 0;
    const avgEntryUsd = markedUsd > 0 ? markedUsd / qty : null;
    const pnlPercent =
      avgEntryUsd != null && avgEntryUsd > 0 && priceUsd > 0
        ? (priceUsd - avgEntryUsd) / avgEntryUsd
        : null;
    const markedQty = Math.min(holding.balance, qty);
    const unrealizedUsd =
      avgEntryUsd != null && priceUsd > 0 ? (priceUsd - avgEntryUsd) * markedQty : null;

    positions.push({
      mint: holding.mint,
      ticker: holding.ticker || lot.ticker,
      balance: holding.balance,
      trackedBalance: qty,
      decimals: holding.decimals,
      rawBalance: holding.rawBalance,
      avgEntrySol,
      avgEntryUsd,
      priceUsd: priceUsd > 0 ? priceUsd : null,
      pnlPercent,
      unrealizedUsd,
      buyCount,
      sellCount,
      solSpent: costSol,
      usdcSpent: costUsdc,
      usdtSpent: costUsdt,
    });
  }

  return sortTokenPositions(positions);
}

export function positionUsdValue(position: TokenPosition): number {
  if (position.priceUsd == null || position.priceUsd <= 0 || position.balance <= 0) {
    return 0;
  }
  return position.balance * position.priceUsd;
}

export function sortTokenPositions(positions: TokenPosition[]): TokenPosition[] {
  return [...positions].sort((left, right) => {
    const valueDiff = positionUsdValue(right) - positionUsdValue(left);
    if (valueDiff !== 0) {
      return valueDiff;
    }
    const pnlDiff = Math.abs(right.pnlPercent ?? 0) - Math.abs(left.pnlPercent ?? 0);
    if (pnlDiff !== 0) {
      return pnlDiff;
    }
    return left.ticker.localeCompare(right.ticker);
  });
}

export { formatSignedPercent };

export function buildDexScreenerTokenUrl(mint: string): string {
  return `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;
}

function formatQuoteSpent(amount: number, ticker: string): string | null {
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  const text = amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `${text} ${ticker}`;
}

export function formatSolSpent(sol: number): string {
  return formatQuoteSpent(sol, "SOL") ?? "0 SOL";
}

export function formatPositionSpent(position: {
  solSpent?: number;
  usdcSpent?: number;
  usdtSpent?: number;
}): string {
  const parts = [
    formatQuoteSpent(position.solSpent ?? 0, "SOL"),
    formatQuoteSpent(position.usdcSpent ?? 0, "USDC"),
    formatQuoteSpent(position.usdtSpent ?? 0, "USDT"),
  ].filter((part): part is string => part != null);
  return parts.length > 0 ? parts.join(" + ") : "-";
}

function formatExactTokenAmount(value: number, decimals: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const places = Math.min(Math.max(0, Math.trunc(decimals)), 18);
  return value.toFixed(places).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function formatPositionBag(position: TokenPosition): string {
  const raw = position.rawBalance?.trim();
  const decimals = position.decimals;
  if (raw && /^-?\d+$/.test(raw) && Number.isInteger(decimals) && decimals >= 0) {
    return formatAmount(raw, decimals, { trim: true });
  }
  if (Number.isInteger(decimals) && decimals >= 0) {
    return formatExactTokenAmount(position.balance, decimals);
  }
  return formatExactTokenAmount(position.balance, 18);
}

function formatPositionTracked(position: TokenPosition): string {
  const decimals = Number.isInteger(position.decimals) ? position.decimals : 18;
  return formatExactTokenAmount(position.trackedBalance, decimals);
}

export const POSITIONS_PAGE_SIZE = 3;

export function formatPositionMessage(position: TokenPosition): string {
  const dexLink = `<a href="${buildDexScreenerTokenUrl(position.mint)}">📈</a>`;
  const title = `📊 ${escapeHtml(position.ticker)} ${dexLink}`;
  const mark = position.priceUsd != null ? `$${formatRate(position.priceUsd)}` : "-";
  const avgEntry = position.avgEntryUsd != null ? `$${formatRate(position.avgEntryUsd)}` : "-";
  const valueUsd =
    position.priceUsd != null && position.balance > 0
      ? ` ($${formatUsdValue(position.balance * position.priceUsd)})`
      : "";
  const pnl =
    position.pnlPercent == null
      ? "-"
      : `${formatSignedPercent(position.pnlPercent)}${
          position.unrealizedUsd != null
            ? ` (${position.unrealizedUsd >= 0 ? "+" : "-"}$${formatUsdValue(Math.abs(position.unrealizedUsd))})`
            : ""
        }${position.pnlPercent > 0 ? " 🟢" : position.pnlPercent < 0 ? " 🟥" : ""}`;
  const spent =
    position.buyCount > 0
      ? `${formatPositionSpent(position)}, ${position.buyCount} buy${
          position.buyCount === 1 ? "" : "s"
        }`
      : formatPositionSpent(position);

  const lines = [
    title,
    "",
    `<code>${position.mint}</code> (Tap to copy)`,
    "",
    `Mark: ${mark}`,
    `Avg entry: ${avgEntry}`,
    `Balance: ${copyableHtml(formatPositionBag(position))}${valueUsd}`,
  ];

  const pnlScope = formatUnrealizedScopeLine(position);
  if (pnlScope) {
    lines.push(pnlScope);
  }

  lines.push("", `Unrealized: ${pnl}`, `Spent: ${spent}`);
  return lines.join("\n");
}

export function formatUnrealizedScopeLine(position: TokenPosition): string | null {
  const tracked = position.trackedBalance;
  const balance = position.balance;
  if (!(tracked > 0 && Number.isFinite(tracked))) {
    return null;
  }

  const swapQty = formatPositionTracked(position);
  if (!(tracked < balance * 0.99)) {
    return null;
  }

  const swapUsd =
    position.priceUsd != null && position.priceUsd > 0
      ? ` ($${formatUsdValue(tracked * position.priceUsd)})`
      : "";
  return `on ${swapQty}${swapUsd}`;
}

export function formatPositionsPage(
  positions: TokenPosition[],
  options: { page?: number; pageCount?: number } = {},
): string {
  const cards = positions.map((position) => formatPositionMessage(position));
  const pageCount = options.pageCount ?? 1;
  const page = options.page ?? 0;
  if (pageCount > 1) {
    return [`📊 Positions (${page + 1}/${pageCount})`, "", cards.join("\n\n")].join("\n");
  }
  return cards.join("\n\n");
}

export function pnlByMint(positions: TokenPosition[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const position of positions) {
    if (position.pnlPercent != null) {
      map.set(position.mint, position.pnlPercent);
    }
  }
  return map;
}

function mergePricedMints(
  pricesUsd: Record<string, number>,
  pricedMints: Set<string>,
  fetched: Record<string, number>,
  missingPrices: string[],
): void {
  for (const mint of missingPrices) {
    const price = fetched[mint];
    if (price && Number.isFinite(price) && price > 0) {
      pricesUsd[mint] = price;
      pricedMints.add(mint);
    }
  }
}

function fingerprintSwaps(swaps: SwapStatRecord[]): string {
  if (swaps.length === 0) {
    return "0";
  }
  const first = swaps[0];
  const last = swaps[swaps.length - 1];
  return `${swaps.length}:${first?.signature ?? ""}:${last?.signature ?? ""}:${last?.timestamp ?? 0}`;
}

function collectKnownMints(
  knownTokens: Array<{ mint?: string; token_mint?: string; decimals: number }> | undefined,
  holdings: TokenHolding[],
): Set<string> {
  const mints = new Set<string>();
  for (const token of knownTokens ?? []) {
    const mint = token.mint ?? token.token_mint;
    if (mint) {
      mints.add(mint);
    }
  }
  for (const holding of holdings) {
    if (holding.mint) {
      mints.add(holding.mint);
    }
  }
  return mints;
}

function knownMintsGrew(previous: Set<string>, next: Set<string>): boolean {
  for (const mint of next) {
    if (!previous.has(mint)) {
      return true;
    }
  }
  return false;
}

function buildFillsForHoldings(
  swaps: SwapStatRecord[],
  knownTokens: Array<{ mint?: string; token_mint?: string; decimals: number }> | undefined,
  holdings: TokenHolding[],
): PositionFill[] {
  return fillsFromSwaps(swaps, createDecimalResolver([...(knownTokens ?? []), ...holdings]));
}

async function resolvePositionWork(
  args: PositionSnapshotLoader,
  holdings: TokenHolding[],
  swaps: SwapStatRecord[],
): Promise<PositionWorkCache> {
  const swapFingerprint = fingerprintSwaps(swaps);
  const fillKnownMints = collectKnownMints(args.knownTokens, holdings);
  const cached = positionWorkCache.get(args.walletAddress);
  const now = Date.now();
  const cacheFresh = Boolean(cached && cached.expiresAt > now);

  let fills = cached?.fills;
  if (
    !cacheFresh ||
    !cached ||
    cached.swapFingerprint !== swapFingerprint ||
    !fills ||
    knownMintsGrew(cached.fillKnownMints, fillKnownMints)
  ) {
    fills = buildFillsForHoldings(swaps, args.knownTokens, holdings);
  }

  const neededPrices = collectPositionPriceMints(fills, holdings);

  const pricesUsd = { ...(cacheFresh && cached ? cached.pricesUsd : {}) };
  const pricedMints = new Set(cacheFresh && cached ? cached.pricedMints : []);
  const missingPrices = neededPrices.filter((mint) => !pricedMints.has(mint));
  if (missingPrices.length > 0) {
    mergePricedMints(
      pricesUsd,
      pricedMints,
      await args.fetchPricesUSD(missingPrices),
      missingPrices,
    );
  }

  const next: PositionWorkCache = {
    expiresAt: now + POSITION_SNAPSHOT_TTL_MS,
    fills,
    swapFingerprint,
    fillKnownMints:
      cacheFresh && cached
        ? new Set([...cached.fillKnownMints, ...fillKnownMints])
        : fillKnownMints,
    pricesUsd,
    pricedMints,
  };
  positionWorkCache.set(args.walletAddress, next);
  return next;
}

export function clearPositionSnapshot(walletAddress?: string): void {
  if (walletAddress) {
    positionWorkCache.delete(walletAddress);
    pendingPositionWork.delete(walletAddress);
    return;
  }
  positionWorkCache.clear();
  pendingPositionWork.clear();
}

export async function loadTokenPositionsForWallet(
  args: PositionSnapshotLoader,
): Promise<TokenPosition[]> {
  const holdings = await args.getHoldings();
  const swaps = args.getSwaps();
  const cacheKey = args.walletAddress;
  const pending = pendingPositionWork.get(cacheKey);
  if (pending) {
    const work = await pending;
    const neededPrices = collectPositionPriceMints(work.fills, holdings);
    const missingPrices = neededPrices.filter((mint) => !work.pricedMints.has(mint));
    if (missingPrices.length > 0) {
      mergePricedMints(
        work.pricesUsd,
        work.pricedMints,
        await args.fetchPricesUSD(missingPrices),
        missingPrices,
      );
    }
    return buildTokenPositions({ fills: work.fills, holdings, pricesUsd: work.pricesUsd });
  }

  const workPromise = resolvePositionWork(args, holdings, swaps);
  pendingPositionWork.set(cacheKey, workPromise);
  try {
    const work = await workPromise;
    return buildTokenPositions({ fills: work.fills, holdings, pricesUsd: work.pricesUsd });
  } finally {
    pendingPositionWork.delete(cacheKey);
  }
}
