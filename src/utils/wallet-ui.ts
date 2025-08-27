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
  lines.push(`SOL: ${solFormatted}`);
  for (const t of tokens) {
    lines.push(`${t.ticker}: ${t.formatted}`);
  }
  lines.push("");
  lines.push(`TOTAL USD: $${totalUsd.toFixed(2)}`);
  lines.push("");
  lines.push(`<code>${walletAddress}</code>`);
  return lines.join("\n");
}

