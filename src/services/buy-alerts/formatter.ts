import { copyableHtml, escapeHtml, formatRate, formatUsdValue } from "../../utils/format-amount";
import { NetworkDetector } from "../../utils/network-detector";
import type { BuyDex, BuyEvent, PairStats } from "./types";

export type FormatBuyAlertInput = {
  event: BuyEvent;
  ticker: string;
  pair: PairStats | null;
  solPriceUsd?: number | null;
};

function formatSolAmount(sol: number): string {
  if (!Number.isFinite(sol) || sol <= 0) {
    return "0";
  }
  const formatted = sol.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return formatted || "0";
}

export function formatMarketCapUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }

  const abs = Math.abs(value);
  const format = (scaled: number, suffix: string) => {
    const text = scaled.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
    return `${text}${suffix}`;
  };

  if (abs >= 1_000_000_000) return format(value / 1_000_000_000, "B");
  if (abs >= 1_000_000) return format(value / 1_000_000, "M");
  if (abs >= 1_000) return format(value / 1_000, "K");
  return format(value, "");
}

export function formatBuyTokenAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  return formatMarketCapUsd(value);
}

function format24hChange(value: number): string {
  const abs = Math.abs(value).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  if (value > 0) return `+${abs}%`;
  if (value < 0) return `-${abs}%`;
  return "0%";
}

export function dexMark(dex: BuyDex, dexId?: string | null): string {
  const fromPair = dexId?.trim().toLowerCase() ?? "";
  const venue = fromPair || dex;
  if (venue.includes("pump")) return "💊";
  if (venue.includes("raydium")) return "⚡";
  if (venue.includes("meteora")) return "☄️";
  if (venue.includes("orca") || venue.includes("whirlpool")) return "🐋";
  if (venue.includes("jupiter")) return "🪐";
  return "📊";
}

export function dexLabel(dex: BuyDex, dexId?: string | null): string {
  const fromPair = dexId?.trim().toLowerCase() ?? "";
  if (fromPair.startsWith("raydium")) return "Raydium AMM";
  if (fromPair === "pumpswap" || fromPair === "pump-amm") return "PumpSwap";
  if (fromPair === "pumpfun" || fromPair === "pump") return "Pump.fun";
  if (fromPair === "meteora" || fromPair.startsWith("meteora")) return "Meteora";
  if (fromPair === "orca" || fromPair === "whirlpool") return "Orca";
  if (fromPair === "jupiter") return "Jupiter";
  if (dex === "raydium") return "Raydium AMM";
  if (dex === "pump") return "Pump.fun";
  if (fromPair) return dexId!.trim();
  return "Unknown";
}

function linkedLabel(url: string | null, label: string): string {
  if (!url) return escapeHtml(label);
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

function formatWalletLabel(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatBuyAlertMessage({
  event,
  ticker,
  pair,
  solPriceUsd,
}: FormatBuyAlertInput): string {
  const displayName = pair?.tokenName?.trim() || ticker;
  const safeName = escapeHtml(displayName);
  const safeTicker = escapeHtml(ticker);
  const walletLabel = formatWalletLabel(event.trader);
  const walletUrl = NetworkDetector.buildSolscanAccountUrl(event.trader);
  const txUrl = NetworkDetector.buildSolscanTxUrl(event.signature);
  const spentSol = formatSolAmount(event.solAmount ?? 0);
  const spentUsd =
    solPriceUsd && solPriceUsd > 0 && event.solAmount != null && event.solAmount > 0
      ? formatUsdValue(event.solAmount * solPriceUsd)
      : null;
  const gotAmount = formatBuyTokenAmount(event.tokenAmount);
  const quote = escapeHtml(
    event.quoteSymbol?.trim() || event.inputSymbol?.trim() || pair?.quoteSymbol || "Unknown",
  );
  const sourceDexId = event.dexId?.trim() || (event.dex === "unknown" ? pair?.dexId?.trim() : null);
  const venue = escapeHtml(dexLabel(event.dex, sourceDexId));
  const mark = dexMark(event.dex, sourceDexId);

  let spentLine = "Spent: Unknown";
  if (event.solAmount != null && event.solAmount > 0) {
    spentLine = spentUsd
      ? `Spent: ${copyableHtml(spentSol)} SOL ($${escapeHtml(spentUsd)})`
      : `Spent: ${copyableHtml(spentSol)} SOL`;
  } else if (event.inputAmount != null && event.inputAmount > 0) {
    const inputAmount = formatBuyTokenAmount(event.inputAmount);
    const inputSymbol = event.inputSymbol?.trim();
    spentLine = inputSymbol
      ? `Spent: ${copyableHtml(inputAmount)} ${escapeHtml(inputSymbol)}`
      : `Spent: ${copyableHtml(inputAmount)}`;
  }

  const lines = [
    `<b>💰 BUY - ${safeName}</b>`,
    "",
    linkedLabel(walletUrl, walletLabel),
    spentLine,
    `Got: ${copyableHtml(gotAmount)} ${safeTicker}`,
    `DEX: ${mark} ${venue} ${quote}`,
  ];

  const priceBits: string[] = [];
  if (pair?.priceUsd && pair.priceUsd > 0) {
    priceBits.push(`$${escapeHtml(formatRate(pair.priceUsd))}`);
  }
  if (txUrl) {
    priceBits.push(linkedLabel(txUrl, "[Txn]"));
  }
  if (priceBits.length > 0) {
    lines.push(`Price: ${priceBits.join(" | ")}`);
  }

  if (event.newHolder === true) {
    lines.push("New Holder!");
  }

  const marketCap = pair?.marketCapUsd ? formatMarketCapUsd(pair.marketCapUsd) : "";
  if (marketCap) {
    lines.push(`📈 MarketCap: $${escapeHtml(marketCap)}`);
  }
  if (pair?.priceChangeH24 != null && Number.isFinite(pair.priceChangeH24)) {
    lines.push(`24h: ${format24hChange(pair.priceChangeH24)}`);
  }

  if (pair?.url) {
    lines.push("", `🔗 ${linkedLabel(pair.url, "DexScreener")}`);
  }

  return lines.join("\n");
}
