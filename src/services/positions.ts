import {
  formatRate,
  formatSignedPercent,
  formatTokenDisplay,
  formatUsdValue,
} from "../utils/format-amount";
import { WSOL_MINT } from "../utils/constants";
import {
  getBuiltinTokenMetadataByMint,
  getBuiltinTokenMetadataByTicker,
} from "../utils/token-registry";
import type { SwapStatRecord } from "../utils/transaction-history";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

export type PositionFill = {
  mint: string;
  ticker: string;
  side: "buy" | "sell";
  tokenAmount: number;
  quoteMint: string;
  quoteAmount: number;
  timestamp: number;
};

export type TokenHolding = {
  mint: string;
  ticker: string;
  balance: number;
  decimals: number;
};

export type TokenPosition = {
  mint: string;
  ticker: string;
  balance: number;
  trackedBalance: number;
  avgEntrySol: number | null;
  avgEntryUsd: number | null;
  priceUsd: number | null;
  pnlPercent: number | null;
  unrealizedUsd: number | null;
  buyCount: number;
  sellCount: number;
  solSpent: number;
};

export type DecimalResolver = (mint: string, ticker: string) => number;

export function isQuoteMint(mint: string): boolean {
  return QUOTE_MINTS.has(mint);
}

export function resolveTokenDecimals(
  mint: string,
  ticker: string,
  knownByMint?: ReadonlyMap<string, number>,
): number {
  return (
    knownByMint?.get(mint) ??
    getBuiltinTokenMetadataByMint(mint)?.decimals ??
    getBuiltinTokenMetadataByTicker(ticker)?.decimals ??
    6
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

export function quoteAmountToSol(
  quoteMint: string,
  quoteAmount: number,
  solPriceUsd: number,
): number {
  if (quoteAmount <= 0) {
    return 0;
  }
  if (quoteMint === WSOL_MINT) {
    return quoteAmount;
  }
  if ((quoteMint === USDC_MINT || quoteMint === USDT_MINT) && solPriceUsd > 0) {
    return quoteAmount / solPriceUsd;
  }
  return 0;
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
      });
    }
  }

  return fills;
}

export function buildTokenPositions(args: {
  fills: PositionFill[];
  holdings: TokenHolding[];
  pricesUsd: Record<string, number>;
}): TokenPosition[] {
  const solPriceUsd = args.pricesUsd[WSOL_MINT] ?? 0;
  const fillsByMint = new Map<string, PositionFill[]>();

  for (const fill of args.fills) {
    const list = fillsByMint.get(fill.mint) ?? [];
    list.push(fill);
    fillsByMint.set(fill.mint, list);
  }

  const positions: TokenPosition[] = [];

  for (const holding of args.holdings) {
    if (holding.balance <= 0 || isQuoteMint(holding.mint) || holding.ticker === "SOL") {
      continue;
    }

    const fills = fillsByMint.get(holding.mint) ?? [];
    let qty = 0;
    let costSol = 0;
    let costUsd = 0;
    let solSpent = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const fill of fills) {
      const quoteSol = quoteAmountToSol(fill.quoteMint, fill.quoteAmount, solPriceUsd);
      const quoteUsd = quoteAmountToUsd(fill.quoteMint, fill.quoteAmount, solPriceUsd);
      if (fill.side === "buy") {
        qty += fill.tokenAmount;
        costSol += quoteSol;
        costUsd += quoteUsd;
        solSpent += quoteSol;
        buyCount += 1;
        continue;
      }

      const sold = Math.min(fill.tokenAmount, qty);
      if (qty > 0 && sold > 0) {
        const remaining = (qty - sold) / qty;
        costSol *= remaining;
        costUsd *= remaining;
        qty -= sold;
      }
      sellCount += 1;
    }

    if (buyCount === 0 || qty <= 0 || (costSol <= 0 && costUsd <= 0)) {
      continue;
    }

    const avgEntrySol = costSol > 0 ? costSol / qty : null;
    const priceUsd = args.pricesUsd[holding.mint] ?? 0;
    const avgEntryUsd =
      costUsd > 0
        ? costUsd / qty
        : avgEntrySol != null && solPriceUsd > 0
          ? avgEntrySol * solPriceUsd
          : null;
    const pnlPercent =
      avgEntryUsd != null && avgEntryUsd > 0 && priceUsd > 0
        ? (priceUsd - avgEntryUsd) / avgEntryUsd
        : null;
    const markedQty = Math.min(holding.balance, qty);
    const unrealizedUsd =
      avgEntryUsd != null && priceUsd > 0 ? (priceUsd - avgEntryUsd) * markedQty : null;

    positions.push({
      mint: holding.mint,
      ticker: holding.ticker,
      balance: holding.balance,
      trackedBalance: qty,
      avgEntrySol,
      avgEntryUsd,
      priceUsd: priceUsd > 0 ? priceUsd : null,
      pnlPercent,
      unrealizedUsd,
      buyCount,
      sellCount,
      solSpent,
    });
  }

  return positions;
}

export { formatSignedPercent };

export function buildDexScreenerTokenUrl(mint: string): string {
  return `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;
}

export function formatSolSpent(sol: number): string {
  if (!Number.isFinite(sol) || sol <= 0) {
    return "0 SOL";
  }
  const text = sol.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `${text} SOL`;
}

export function formatPositionMessage(
  position: TokenPosition,
  options: { index: number; count: number },
): string {
  const title =
    options.count > 1
      ? `📊 ${position.ticker} · ${options.index + 1}/${options.count}`
      : `📊 ${position.ticker}`;
  const price = position.priceUsd != null ? `$${formatRate(position.priceUsd)}` : "—";
  const avgEntry = position.avgEntryUsd != null ? `$${formatRate(position.avgEntryUsd)}` : "—";
  const valueUsd =
    position.priceUsd != null && position.balance > 0
      ? ` ($${formatUsdValue(position.balance * position.priceUsd)})`
      : "";
  const pnl =
    position.pnlPercent == null
      ? "—"
      : `${formatSignedPercent(position.pnlPercent)}${
          position.unrealizedUsd != null
            ? ` (${position.unrealizedUsd >= 0 ? "+" : "-"}$${formatUsdValue(Math.abs(position.unrealizedUsd))})`
            : ""
        }${position.pnlPercent > 0 ? " 🟢" : position.pnlPercent < 0 ? " 🟥" : ""}`;
  const buys = `${formatSolSpent(position.solSpent)} · ${position.buyCount} buy${
    position.buyCount === 1 ? "" : "s"
  }`;

  const lines = [
    title,
    "",
    `<code>${position.mint}</code> (Tap to copy)`,
    "",
    `Price: ${price}`,
    `Avg entry: ${avgEntry}`,
    `Balance: ${formatTokenDisplay(position.balance)}${valueUsd}`,
  ];

  if (position.trackedBalance > 0 && position.trackedBalance < position.balance * 0.99) {
    lines.push(`Bot lot: ${formatTokenDisplay(position.trackedBalance)}`);
  }

  lines.push("", `Unrealized: ${pnl}`, `Spent: ${buys}`);
  return lines.join("\n");
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
