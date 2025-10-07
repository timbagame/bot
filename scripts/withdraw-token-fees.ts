import * as anchor from "@coral-xyz/anchor";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair as Web3Keypair, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { WalletManager } from "../src/utils/wallet";

const ORACLE_OPERATOR_KEYPAIR_ENV = "ORACLE_OPERATOR_KEYPAIR_PATH";
const RPC_URL =
  process.env["SOLANA_NETWORK"] || "https://api.mainnet-beta.solana.com";

type TokenConfig = {
  mint: string;
  ticker: string;
};

const TOKENS: TokenConfig[] = [
  {
    mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
    ticker: "TIMBA",
  },
  {
    mint: "So11111111111111111111111111111111111111112",
    ticker: "WSOL",
  },
];

type KeypairBundle = {
  root: Web3Keypair;
  anchor: anchor.web3.Keypair;
};

const bundleFromSecret = (secret: Uint8Array): KeypairBundle => ({
  root: Web3Keypair.fromSecretKey(secret),
  anchor: anchor.web3.Keypair.fromSecretKey(secret),
});

const bundleFromRoot = (root: Web3Keypair): KeypairBundle =>
  bundleFromSecret(root.secretKey);

const loadKeypairBundle = (filePath: string): KeypairBundle => {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  const secret = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return bundleFromSecret(new Uint8Array(secret));
};

const resolveOracleOperatorBundle = (
  fallback: Web3Keypair
): KeypairBundle => {
  const configured = process.env[ORACLE_OPERATOR_KEYPAIR_ENV]?.trim();
  if (!configured) {
    console.log(
      "ORACLE_OPERATOR_KEYPAIR_PATH not set; using admin keypair as oracle operator."
    );
    return bundleFromRoot(fallback);
  }

  const bundle = loadKeypairBundle(configured);
  console.log(
    `Oracle operator signer loaded from ${configured}: ${bundle.root.publicKey.toBase58()}`
  );
  return bundle;
};

const uniqueSigners = (...signers: Web3Keypair[]): Web3Keypair[] => {
  const seen = new Set<string>();
  const deduped: Web3Keypair[] = [];
  for (const signer of signers) {
    const key = signer.publicKey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(signer);
  }
  return deduped;
};

async function ensureAtaInstruction(
  connection: anchor.web3.Connection,
  payer: anchor.web3.PublicKey,
  owner: anchor.web3.PublicKey,
  mint: anchor.web3.PublicKey
): Promise<anchor.web3.TransactionInstruction | null> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const accountInfo = await connection.getAccountInfo(ata);
  if (accountInfo) return null;
  return createAssociatedTokenAccountInstruction(
    payer,
    ata,
    owner,
    mint
  );
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
    false
  );
  const gameVaultAta = getAssociatedTokenAddressSync(
    mint,
    gameVaultPda,
    true
  );

  const ataIx = await ensureAtaInstruction(
    connection,
    adminBundle.anchor.publicKey,
    operatorBundle.anchor.publicKey,
    mint
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
      tokenProgram: TOKEN_PROGRAM_ID,
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
  const adminBundle = bundleFromRoot(adminRoot);
  const operatorBundle = resolveOracleOperatorBundle(adminRoot);

  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(adminBundle.anchor),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const program = new anchor.Program(
    idl as Timba,
    provider
  ) as anchor.Program<Timba>;

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
