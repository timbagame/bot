import * as anchor from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import type { Timba } from "../idl/idlType";
import { WalletManager } from "../src/utils/wallet";
import {
  getSupportedTokens,
  type TokenConfig,
} from "../src/utils/token-registry";
import type { KeypairBundle } from "./utils/keypairs";
import {
  bundleFromKeypair,
  resolveOracleOperatorBundle,
  uniqueSigners,
} from "./utils/keypairs";
import { createAnchorContext } from "./utils/anchor-context";

const RPC_URL =
  process.env["SOLANA_NETWORK"] || "https://api.mainnet-beta.solana.com";

const TOKENS: TokenConfig[] = getSupportedTokens();

async function withdrawTokenFee(
  program: anchor.Program<Timba>,
  connection: anchor.web3.Connection,
  wallet: WalletManager,
  adminBundle: KeypairBundle,
  operatorBundle: KeypairBundle,
  config: TokenConfig
): Promise<void> {
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
    return;
  }

  const gameToken = await program.account.gameToken.fetch(gameTokenPda);
  const pendingFees = BigInt(gameToken.feeAmount.toString());
  if (pendingFees === 0n) {
    console.log(`ℹ️  No pending fees for ${config.ticker}; skipping.`);
    return;
  }

  const metadata = await wallet.getTokenMetadata(config.mint);
  const formattedPending = wallet.formatTokenBalance(
    Number(pendingFees),
    metadata.decimals
  );

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
    `➡️  Withdrawing ${formattedPending} ${config.ticker} to ${operatorBundle.anchor.publicKey.toBase58()}`
  );

  const instruction = await program.methods
    .withdrawTokenFee()
    .accounts({
      gameToken: gameTokenPda,
      tokenMint: mint,
      gameVault: gameVaultPda,
      oracle: oraclePda,
      oracleOperator: operatorBundle.anchor.publicKey,
      oracleOperatorTokenAccount: operatorAta,
      gameTokenAccount: gameVaultAta,
      systemProgram: SystemProgram.programId,
      tokenProgram: tokenProgramId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    } as any)
    .instruction();
  const instructions = [...operatorAtaInstructions, instruction];

  if (operatorAtaCreated) {
    console.log(
      `🔧 Created oracle operator ATA ${operatorAta.toBase58()} for ${config.ticker}`
    );
  }

  const tx = await wallet.sendTransaction(
    instructions,
    uniqueSigners(adminBundle.root, operatorBundle.root)
  );

  console.log(`   ✅ Withdrawn. Transaction: ${tx}`);
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
      await withdrawTokenFee(
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

  console.log("\n🏁 Fee withdrawal run completed.");
}

main().catch((error) => {
  console.error("❌ Fee withdrawal script failed:", error);
  process.exit(1);
});
