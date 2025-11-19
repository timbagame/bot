import * as anchor from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram, PublicKey, Connection, sendAndConfirmRawTransaction } from "@solana/web3.js";
import type { Timba } from "../idl/idlType";
import { WalletManager } from "../src/utils/wallet";
import {
  getSupportedTokens,
  type TokenConfig,
} from "../src/utils/token-registry";
import { getReferralTokenEntries } from "../src/utils/token-registry";
import type { KeypairBundle } from "./utils/keypairs";
import {
  bundleFromKeypair,
  resolveOracleOperatorBundle,
  uniqueSigners,
} from "./utils/keypairs";
import { createAnchorContext } from "./utils/anchor-context";
import { resolvePrimaryRpcEndpoint } from "../src/utils/rpc-endpoints";
import { resolveTokenPriceUSD } from "../src/utils/prices";
import { ReferralProvider } from "@jup-ag/referral-sdk";

const RPC_URL = resolvePrimaryRpcEndpoint(process.env.SOLANA_NETWORK);

const TOKENS: TokenConfig[] = getSupportedTokens();
const REFERRAL_ENTRIES = getReferralTokenEntries();

const shouldWithdrawToken = async (
  wallet: WalletManager,
  config: TokenConfig,
  pendingFees: bigint,
  decimals: number
) => {
  const formattedPending = wallet.formatTokenBalance(
    Number(pendingFees),
    decimals
  );
  const tokenAmount = Number(pendingFees) / 10 ** decimals;
  const priceData = await resolveTokenPriceUSD({
    tokenMint: config.mint,
    tokenTicker: config.ticker,
  });
  const tokenUsdValue = tokenAmount * (priceData?.price ?? 0);
  if (tokenUsdValue < 5) {
    console.log(
      `ℹ️  Skipping ${config.ticker} withdrawal: ${formattedPending} ≈ $${
        tokenUsdValue.toFixed(2)
      } (< $5).`
    );
    return { shouldWithdraw: false, formattedPending, tokenUsdValue };
  }
  return { shouldWithdraw: true, formattedPending, tokenUsdValue };
};

async function processTokenFee(
  program: anchor.Program<Timba>,
  connection: anchor.web3.Connection,
  wallet: WalletManager,
  adminBundle: KeypairBundle,
  operatorBundle: KeypairBundle,
  config: TokenConfig
): Promise<boolean> {
  const mint = new anchor.web3.PublicKey(config.mint);
  const [oraclePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    program.programId
  );
  const [gameTokenPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), mint.toBuffer()],
    program.programId
  );
  const [gameVaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game_vault"), mint.toBuffer()],
    program.programId
  );

  const gameTokenInfo = await connection.getAccountInfo(gameTokenPda);
  if (!gameTokenInfo) {
    console.warn(
      `⚠️  No game token configuration found for ${config.ticker}; skipping.`
    );
    return false;
  }

  const gameToken = await program.account.gameToken.fetch(gameTokenPda);
  const pendingFees = BigInt(gameToken.feeAmount.toString());
  if (pendingFees === 0n) {
    console.log(`ℹ️  No pending fees for ${config.ticker}; skipping.`);
    return false;
  }

  const metadata = await wallet.getTokenMetadata(config.mint);
  const { shouldWithdraw, formattedPending } = await shouldWithdrawToken(
    wallet,
    config,
    pendingFees,
    metadata.decimals
  );
  if (!shouldWithdraw) return false;

  const {
    address: operatorAta,
    instructions: operatorAtaInstructions,
    programId: tokenProgramId,
    created: operatorAtaCreated,
  } = await wallet.ensureAssociatedTokenAccount(
    operatorBundle.anchor.publicKey,
    mint,
    adminBundle.root
  );
  const gameVaultAta = getAssociatedTokenAddressSync(
    mint,
    gameVaultPda,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  console.log(
    `➡️  Withdrawing ${formattedPending} ${
      config.ticker
    } to ${operatorBundle.anchor.publicKey.toBase58()}`
  );

  const instruction = await program.methods
    .withdrawTokenFee()
    .accounts({
      oracle: oraclePda,
      oracleOperator: operatorBundle.anchor.publicKey,
      oracleOperatorTokenAccount: operatorAta,
      systemProgram: SystemProgram.programId,
      gameTokenCtx: {
        tokenMint: mint,
        gameToken: gameTokenPda,
        gameVault: gameVaultPda,
        gameTokenAccount: gameVaultAta,
        tokenProgram: tokenProgramId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
    } as any)
    .instruction();
  const instructions = [...operatorAtaInstructions, instruction];

  if (operatorAtaCreated) {
    console.log(
      `🔧 Created oracle operator ATA ${operatorAta.toBase58()} for ${
        config.ticker
      }`
    );
  }

  const tx = await wallet.sendAndConfirmWithResubmits(
    instructions,
    uniqueSigners(adminBundle.root, operatorBundle.root),
    { operationLabel: `Withdraw ${config.ticker} fees` }
  );

  console.log(`   ✅ Withdrawn. Transaction: ${tx}`);
  return true;
}

async function runReferralSweep(
  connection: anchor.web3.Connection,
  adminBundle: KeypairBundle
): Promise<void> {
  if (REFERRAL_ENTRIES.length === 0) {
    console.log("ℹ️  No referral entries configured; skipping referral claims.");
    return;
  }

  const referralEntry = REFERRAL_ENTRIES[0];
  if (!referralEntry?.referralAccount) {
    console.log("ℹ️  No referral account configured; skipping referral claims.");
    return;
  }

  const referralAccount = new PublicKey(referralEntry.referralAccount);
  const provider = new ReferralProvider(connection as unknown as Connection);

  console.log("💸 Collecting Jupiter referral fees...");

  const transactions = await provider.claimAllV2({
    payerPubKey: adminBundle.anchor.publicKey,
    referralAccountPubKey: referralAccount,
  });

  if (!transactions.length) {
    console.log("ℹ️  No referral fee transactions to claim.");
    return;
  }

  console.log(`🧾 Found ${transactions.length} referral transaction(s). Processing...`);

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!tx) continue;
    tx.sign([adminBundle.anchor]);
    const sig = await sendAndConfirmRawTransaction(
      connection as unknown as Connection,
      Buffer.from(tx.serialize())
    );
    console.log(`   ✅ Referral claim ${i + 1}/${transactions.length}: ${sig}`);
  }
}

async function main() {
  console.log("💸 Collecting oracle fees for configured tokens...\n");

  const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
  const adminRoot = wallet.getAdminKeypair();
  const adminBundle = bundleFromKeypair(adminRoot);
  const operatorBundle = resolveOracleOperatorBundle(adminRoot);

  const { provider, program } = createAnchorContext(adminBundle.root, {
    rpcUrl: RPC_URL,
  });
  const connection = provider.connection;

  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(
    `Admin payer: ${adminBundle.anchor.publicKey.toBase58()}, Oracle operator: ${operatorBundle.anchor.publicKey.toBase58()}`
  );

  for (const token of TOKENS) {
    try {
      await processTokenFee(
        program,
        connection,
        wallet,
        adminBundle,
        operatorBundle,
        token
      );
    } catch (error) {
      console.error(`❌ Failed withdrawing ${token.ticker}:`, error);
    }
  }

  try {
    await runReferralSweep(connection, adminBundle);
  } catch (error) {
    console.error("❌ Failed withdrawing referral fees:", error);
  }

  console.log("\n🏁 Fee withdrawal run completed.");
}

main().catch((error) => {
  console.error("❌ Fee withdrawal script failed:", error);
  process.exit(1);
});
