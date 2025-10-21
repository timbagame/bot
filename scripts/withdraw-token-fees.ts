import * as anchor from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
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

async function ensureAtaInstruction(
  connection: anchor.web3.Connection,
  payer: anchor.web3.PublicKey,
  owner: anchor.web3.PublicKey,
  mint: anchor.web3.PublicKey,
  tokenProgramId: anchor.web3.PublicKey
): Promise<anchor.web3.TransactionInstruction | null> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const accountInfo = await connection.getAccountInfo(ata);
  if (accountInfo) return null;
  return createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    mint,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

const tokenProgramCache = new Map<string, anchor.web3.PublicKey>();

async function resolveTokenProgramId(
  connection: anchor.web3.Connection,
  mint: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey> {
  const cacheKey = mint.toBase58();
  const cached = tokenProgramCache.get(cacheKey);
  if (cached) return cached;

  const accountInfo = await connection.getAccountInfo(mint);
  if (!accountInfo) {
    console.warn(
      `⚠️  Unable to fetch mint account info for ${cacheKey}; defaulting to SPL Token program.`
    );
    tokenProgramCache.set(cacheKey, TOKEN_PROGRAM_ID);
    return TOKEN_PROGRAM_ID;
  }

  const programId = accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  tokenProgramCache.set(cacheKey, programId);
  return programId;
}

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

  const tokenProgramId = await resolveTokenProgramId(connection, mint);

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

  const operatorAta = getAssociatedTokenAddressSync(
    mint,
    operatorBundle.anchor.publicKey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const gameVaultAta = getAssociatedTokenAddressSync(
    mint,
    gameVaultPda,
    true,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const ataIx = await ensureAtaInstruction(
    connection,
    adminBundle.anchor.publicKey,
    operatorBundle.anchor.publicKey,
    mint,
    tokenProgramId
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

  const instructions = ataIx ? [ataIx, instruction] : [instruction];

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
