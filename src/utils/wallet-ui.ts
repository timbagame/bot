import { escapeHtml } from "./format-amount";

export type TokenDisplayLine = {
  ticker: string;
  amount: string;
  usdValue?: string;
  unit?: string;
};

/**
 * Build the wallet caption text shown in the wallet UI.
 * Includes a token list where each line follows the format:
 * TICKER: amount [UNIT] ($usdValue)
 */
export function buildWalletCaption(
  walletAddress: string,
  tokenLines: TokenDisplayLine[]
): string {
  const lines: string[] = [];

  lines.push(
    `Solana Address · <a href="https://solscan.io/account/${encodeURIComponent(
      walletAddress
    )}">🅴</a>`
  );
  lines.push("");
  lines.push(`<code>${escapeHtml(walletAddress)}</code> (Tap to copy)`);
  lines.push("");

  for (const line of tokenLines) {
    const parts: string[] = [];
    parts.push(`${escapeHtml(line.ticker)}:`);

    const amountLabel = line.unit
      ? `${escapeHtml(line.amount)} ${escapeHtml(line.unit)}`
      : escapeHtml(line.amount);
    parts.push(amountLabel);

    if (line.usdValue !== undefined) {
      parts.push(`($${line.usdValue})`);
    }

    lines.push(parts.join(" "));
  }

  return lines.join("\n");
}
