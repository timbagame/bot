export type TokenBalance = {
  mint: string;
  ticker: string;
  balance: number; // raw units
  decimals: number;
  rawBalance: string;
  lamports: bigint;
  formattedBalance?: string;
  decimalBalance?: number;
  truncated?: boolean;
};

/**
 * Merge WSOL token balance into native SOL balance for display.
 * Returns the new SOL balance (lamports) and a token list without WSOL.
 */
export function mergeWsolIntoSol(
  solLamports: number,
  tokenBalances: TokenBalance[],
  wsolMint: string
): { solLamports: number; tokenBalances: TokenBalance[] } {
  const idx = tokenBalances.findIndex((t) => t.mint === wsolMint);
  if (idx === -1) {
    return { solLamports, tokenBalances };
  }
  const mergedSol = solLamports + tokenBalances[idx]!.balance;
  const prunedTokens = tokenBalances.slice(0, idx).concat(tokenBalances.slice(idx + 1));
  return { solLamports: mergedSol, tokenBalances: prunedTokens };
}

