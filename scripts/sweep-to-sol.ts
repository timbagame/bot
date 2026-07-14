import { PublicKey } from "@solana/web3.js";
import { WalletManager } from "../src/utils/wallet";
import { getSupportedTokens, WSOL_MINT } from "../src/utils/token-registry";
import { getUsdPrice } from "../src/utils/price-service";
import { SwapManager } from "../src/utils/swap-manager";
import type { SwapRequest } from "../src/utils/swap/types";
import { unwrapWsolBalance } from "../src/services/fee-sweeper";
import { loadWalletMnemonic } from "../src/utils/secrets";

async function getTotalTokenBalanceLamports(
  connection: ReturnType<WalletManager["getConnection"]>,
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  let total = 0n;
  // Fallback to parsed accounts to avoid manual decoding
  const parsed = await connection.getParsedTokenAccountsByOwner(owner, {
    mint,
  });
  for (const acc of parsed.value) {
    const amountStr = acc.account.data.parsed.info.tokenAmount.amount as string;
    total += BigInt(amountStr);
  }
  return total;
}

async function main() {
  const wallet = WalletManager.getInstance(loadWalletMnemonic());
  const admin = wallet.getAdminKeypair();
  const connection = wallet.getConnection();
  const swapManager = new SwapManager(connection, wallet);

  const tokens = getSupportedTokens().filter((t) => t.mint !== WSOL_MINT && t.ticker !== "SOL");

  console.log("💱 Sweeping eligible token balances to SOL (>$5 value)...\n");

  for (const token of tokens) {
    try {
      const mintPubkey = new PublicKey(token.mint);
      const balance = await getTotalTokenBalanceLamports(connection, admin.publicKey, mintPubkey);
      if (balance === 0n) {
        console.log(`ℹ️  No balance for ${token.ticker}; skipping.`);
        continue;
      }

      const metadata = await wallet.getTokenMetadata(token.mint);
      const amountDecimal = Number(balance) / 10 ** metadata.decimals;
      const price = await getUsdPrice({
        tokenMint: token.mint,
      });
      const usdValue = amountDecimal * (price?.price ?? 0);
      if (usdValue < 5) {
        console.log(
          `ℹ️  ${token.ticker} balance ${amountDecimal.toFixed(6)} ≈ $${usdValue.toFixed(
            2,
          )}; skipping (<$5).`,
        );
        continue;
      }

      console.log(
        `➡️  Swapping ${amountDecimal.toFixed(6)} ${token.ticker} (~$${usdValue.toFixed(
          2,
        )}) to SOL`,
      );

      const swapRequest: SwapRequest = {
        inputMint: token.mint,
        outputMint: WSOL_MINT,
        amount: balance.toString(),
        userKeypair: admin,
        inputDecimals: metadata.decimals,
        outputDecimals: 9,
        inputTicker: token.ticker,
        outputTicker: "SOL",
      } as any;

      const quote = await swapManager.getQuote(swapRequest);
      const sig = await swapManager.executeJupiterSwap(swapRequest, quote);
      console.log(`   ✅ Swap submitted: ${sig}`);
    } catch (error) {
      console.error(`❌ Failed to sweep ${token.ticker}:`, error);
    }
  }

  console.log("\n🏁 Sweep complete.");

  await unwrapWsolBalance(wallet, connection, admin.publicKey, admin, getUsdPrice);
}

main().catch((error) => {
  console.error("❌ Sweep script failed:", error);
  process.exit(1);
});
