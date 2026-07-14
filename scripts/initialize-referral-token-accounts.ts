import { ReferralProvider } from "@jup-ag/referral-sdk";
import { PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { getReferralTokenEntries } from "../src/utils/token-registry";
import { loadWalletMnemonic } from "../src/utils/secrets";
import { WalletManager } from "../src/utils/wallet";

export async function initializeReferralTokenAccounts(): Promise<void> {
  const wallet = WalletManager.getInstance(loadWalletMnemonic());
  const payer = wallet.getAdminKeypair();
  const connection = wallet.getConnection();
  const provider = new ReferralProvider(connection);
  const entries = getReferralTokenEntries();

  for (const entry of entries) {
    const mint = new PublicKey(entry.mint);
    const referralAccount = new PublicKey(entry.referralAccount);
    const transaction = await provider.initializeReferralTokenAccountV2({
      payerPubKey: payer.publicKey,
      referralAccountPubKey: referralAccount,
      mint,
    });
    if (await connection.getAccountInfo(transaction.tokenAccount)) {
      console.log(`${mint.toBase58()}: referral token account already exists`);
      continue;
    }
    const simulation = await connection.simulateTransaction(transaction.tx, [payer]);
    if (simulation.value.err) {
      throw new Error(
        `${mint.toBase58()} referral account simulation failed: ${JSON.stringify(simulation.value.err)}`,
      );
    }
    const signature = await sendAndConfirmTransaction(connection, transaction.tx, [payer]);
    console.log(`${mint.toBase58()}: ${signature}`);
  }
}

if (import.meta.main) {
  initializeReferralTokenAccounts().catch((error) => {
    console.error("Failed to initialize referral token accounts:", error);
    process.exit(1);
  });
}
