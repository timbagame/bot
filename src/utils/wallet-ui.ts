import { escapeHtml } from "./format-amount";

export type TokenDisplayLine = { ticker: string; formatted: string };

/**
 * Build the wallet caption text shown in the wallet UI.
 * Keeps formatting consistent across private and group contexts.
 */
export function buildWalletCaption(
  solFormatted: string,
  tokens: TokenDisplayLine[],
  totalUsd: number,
  walletAddress: string
): string {
  const lines: string[] = [];
  lines.push(`SOL: ${escapeHtml(solFormatted)}`);
  for (const t of tokens) {
    lines.push(`${escapeHtml(t.ticker)}: ${escapeHtml(t.formatted)}`);
  }
  lines.push("");
  lines.push(`TOTAL USD: $${escapeHtml(totalUsd.toFixed(2))}`);
  lines.push("");
  lines.push(`<code>${escapeHtml(walletAddress)}</code>`);
  return lines.join("\n");
}

