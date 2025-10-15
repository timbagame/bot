import { escapeHtml } from "./format-amount";

export type TokenDisplayLine = { ticker: string; formatted: string };

/**
 * Build the wallet caption text shown in the wallet UI.
 * Format matches TIMBA V1 style with Solana address and balances.
 */
export function buildWalletCaption(
  solFormatted: string,
  tokens: TokenDisplayLine[],
  walletAddress: string,
  solUsdPrice?: number,
  timbaUsdPrice?: number
): string {
  const lines: string[] = [];
  
  // Solana Address with clickable link to Solscan
  lines.push(`Solana Address · <a href="https://solscan.io/account/${encodeURIComponent(walletAddress)}">🅴</a>`);
  lines.push("");
  lines.push(`<code>${escapeHtml(walletAddress)}</code> (Tap to copy)`);
  lines.push("");
  
  // Fee balance (SOL) with USD value
  const solUsdValue = solUsdPrice ? (parseFloat(solFormatted) * solUsdPrice).toFixed(2) : "0.00";
  lines.push(`Fee balance: ${escapeHtml(solFormatted)} SOL ($${solUsdValue})`);
  
  // Find TIMBA token specifically
  const timbaToken = tokens.find(t => t.ticker === "TIMBA");
  if (timbaToken) {
    const timbaUsdValue = timbaUsdPrice ? (parseFloat(timbaToken.formatted) * timbaUsdPrice).toFixed(2) : "0.00";
    lines.push(`Timba balance: ${escapeHtml(timbaToken.formatted)} TIMBA ($${timbaUsdValue})`);
  } else {
    lines.push(`Timba balance: 0 TIMBA ($0.00)`);
  }
  
  // Show other tokens if any (excluding TIMBA since it's shown above)
  const otherTokens = tokens.filter(t => t.ticker !== "TIMBA");
  for (const token of otherTokens) {
    if (parseFloat(token.formatted) > 0) {
      lines.push(`${escapeHtml(token.ticker)} balance: ${escapeHtml(token.formatted)} ${escapeHtml(token.ticker)}`);
    }
  }
  
  return lines.join("\n");
}

