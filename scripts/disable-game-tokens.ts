import * as anchor from "@coral-xyz/anchor";
import { Keypair as Web3Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { WalletManager } from "../src/utils/wallet";

const ORACLE_OPERATOR_KEYPAIR_ENV = "ORACLE_OPERATOR_KEYPAIR_PATH";

// Tokens to disable by default (mainnet TIMBA + WSOL)
const TOKENS_TO_DISABLE = [
  {
    mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
    ticker: "TIMBA",
  },
  {
    mint: "So11111111111111111111111111111111111111112",
    ticker: "WSOL",
  },
];

const RPC_URL =
  process.env.SOLANA_NETWORK || "https://api.mainnet-beta.solana.com";

type KeypairBundle = {
  root: Web3Keypair;
  anchor: anchor.web3.Keypair;
};

const bundleFromSecret = (secret: Uint8Array): KeypairBundle => ({
  root: Web3Keypair.fromSecretKey(secret),
  anchor: anchor.web3.Keypair.fromSecretKey(secret),
});

const bundleFromRoot = (keypair: Web3Keypair): KeypairBundle =>
  bundleFromSecret(keypair.secretKey);

const loadKeypairBundle = (filePath: string): KeypairBundle => {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return bundleFromSecret(new Uint8Array(raw));
};

const resolveOracleOperatorKeypair = (
  fallback: Web3Keypair
): KeypairBundle => {
  const configuredPath = process.env[ORACLE_OPERATOR_KEYPAIR_ENV]?.trim();
  if (!configuredPath) {
    console.log(
      "ORACLE_OPERATOR_KEYPAIR_PATH not set; using admin keypair as oracle operator."
    );
    return bundleFromRoot(fallback);
  }

  const bundle = loadKeypairBundle(configuredPath);
  console.log(
    `Oracle operator signer loaded from ${configuredPath}: ${bundle.root.publicKey.toBase58()}`
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

async function disableToken(
  program: anchor.Program<Timba>,
  connection: anchor.web3.Connection,
  admin: KeypairBundle,
  oracleOperator: KeypairBundle,
  mintAddress: string,
  ticker: string,
  wallet: WalletManager
): Promise<void> {
  const mint = new anchor.web3.PublicKey(mintAddress);
  const [gameTokenPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), mint.toBuffer()],
    program.programId
  );

  console.log(
    `\n🔌 Disabling ${ticker} (mint ${mintAddress}) — PDA ${gameTokenPda.toBase58()}`
  );

  const accountInfo = await connection.getAccountInfo(gameTokenPda);
  if (!accountInfo) {
    console.warn(
      `⚠️  Game token account not found for ${ticker}. Skipping disable step.`
    );
    return;
  }

  const gameToken = await program.account.gameToken.fetch(gameTokenPda);

  if (!gameToken.enabled) {
    console.log(`✅ ${ticker} already disabled.`);
    return;
  }

  const [oraclePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    program.programId
  );

  const config = {
    minAmount: new anchor.BN(gameToken.minAmount),
    enabled: false,
  };

  const instruction = await program.methods
    .updateToken(config)
    .accounts({
      gameToken: gameTokenPda,
      tokenMint: mint,
      oracle: oraclePda,
      oracleOperator: oracleOperator.anchor.publicKey,
    } as any)
    .instruction();

  const tx = await wallet.sendTransaction(
    [instruction],
    uniqueSigners(admin.root, oracleOperator.root)
  );

  console.log(`🚫 ${ticker} disabled. Transaction: ${tx}`);
}

async function main() {
  console.log("🚦 Disabling game tokens on Timba program...\n");

  // Load admin/bot keypair via wallet manager
  const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
  const adminKeypairRoot = wallet.getAdminKeypair();
  const adminBundle = bundleFromRoot(adminKeypairRoot);

  const oracleOperatorBundle =
    resolveOracleOperatorKeypair(adminKeypairRoot);

  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  const balanceLamports = await connection.getBalance(
    adminBundle.anchor.publicKey
  );
  console.log(
    `🔑 Admin signer: ${adminBundle.anchor.publicKey.toBase58()} — balance ${(balanceLamports / anchor.web3.LAMPORTS_PER_SOL).toFixed(4)} SOL`
  );

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

  console.log(`📋 Program ID: ${program.programId.toBase58()}`);

  for (const token of TOKENS_TO_DISABLE) {
    await disableToken(
      program,
      connection,
      adminBundle,
      oracleOperatorBundle,
      token.mint,
      token.ticker,
      wallet
    );
  }

  console.log("\n🏁 Token disable process finished.");
}

main().catch((error) => {
  console.error("❌ Failed to disable tokens:", error);
  process.exit(1);
});
