import { ReferralProvider } from "../src/utils/referral-client";
import { PublicKey, sendAndConfirmTransaction } from "#solana";
import { getReferralConfig } from "../src/utils/token-registry";
import { loadWalletMnemonic } from "../src/utils/secrets";
import { WalletManager } from "../src/utils/wallet";

export async function initializeReferralTokenAccounts(mintAddresses: string[]): Promise<void> {
  if (mintAddresses.length === 0) {
    throw new Error("Provide at least one token mint to initialize.");
  }

  const wallet = WalletManager.getInstance(loadWalletMnemonic());
  const payer = await wallet.getOperatorKeypair();
  const connection = wallet.getConnection();
  const provider = new ReferralProvider(connection);
  const referralAccount = new PublicKey(getReferralConfig().referralAccount);

  for (const mintAddress of [...new Set(mintAddresses)]) {
    const mint = new PublicKey(mintAddress);
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
  initializeReferralTokenAccounts(process.argv.slice(2)).catch((error) => {
    console.error("Failed to initialize referral token accounts:", error);
    process.exit(1);
  });
}
