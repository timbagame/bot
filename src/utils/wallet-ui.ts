import { escapeHtml, formatUsdValue } from "./format-amount";
import { LAMPORTS_PER_SOL } from "./constants";

export type TokenDisplayLine = {
  ticker: string;
  amount: string;
  usdValue?: string;
  unit?: string;
};

export type WalletTokenBalance = {
  mint: string;
  ticker: string;
  balance: number;
  decimals: number;
};

export type BuildWalletTokenLinesParams = {
  solBalanceLamports: number;
  tokenBalances: WalletTokenBalance[];
  formatSolBalance: (lamports: number) => string;
  formatTokenBalance?: (balance: number, decimals: number) => string;
  getPriceUSD: (reference: string) => Promise<number>;
};

export async function buildWalletTokenLines({
  solBalanceLamports,
  tokenBalances,
  formatSolBalance,
  formatTokenBalance,
  getPriceUSD,
}: BuildWalletTokenLinesParams): Promise<TokenDisplayLine[]> {
  const solFormatted = formatSolBalance(solBalanceLamports);
  const solPriceUSD = await getPriceUSD("SOL");
  const solDecimalBalance = solBalanceLamports / LAMPORTS_PER_SOL;

  const lines: TokenDisplayLine[] = [
    {
      ticker: "SOL",
      amount: solFormatted,
      usdValue: formatUsdValue(solDecimalBalance * solPriceUSD),
      unit: "SOL",
    },
  ];

  for (const token of tokenBalances) {
    if (!token || token.balance <= 0 || token.ticker === "SOL") {
      continue;
    }

    const formattedAmount = formatTokenBalance
      ? formatTokenBalance(token.balance, token.decimals)
      : String(token.balance / Math.pow(10, token.decimals));

    const reference = token.mint || token.ticker;
    const tokenPriceUSD = await getPriceUSD(reference);
    const tokenDecimalBalance = token.balance / Math.pow(10, token.decimals);

    lines.push({
      ticker: token.ticker,
      amount: formattedAmount,
      usdValue: formatUsdValue(tokenDecimalBalance * tokenPriceUSD),
    });
  }

  return lines;
}

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
