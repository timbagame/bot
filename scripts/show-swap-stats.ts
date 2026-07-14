import { TransactionHistory } from "../src/utils/transaction-history";
import { getBuiltinTokenMetadataByMint, getTokenByMint } from "../src/utils/token-registry";

const displayToken = (mint: string): string =>
  getTokenByMint(mint)?.ticker ?? getBuiltinTokenMetadataByMint(mint)?.ticker ?? mint;

export function showSwapStats(): void {
  const stats = TransactionHistory.getInstance().getSwapTokenStats();

  if (stats.length === 0) {
    console.log("No successful Jupiter swaps recorded yet.");
    return;
  }

  console.log("Token | Input | Output | Referral fee mint | Last trade");
  for (const stat of stats) {
    console.log(
      [
        `${displayToken(stat.mint)} (${stat.mint})`,
        stat.inputSwaps,
        stat.outputSwaps,
        stat.feeMintSelections,
        new Date(stat.lastTradedAt).toISOString(),
      ].join(" | "),
    );
  }
}

if (import.meta.main) {
  showSwapStats();
}
