import * as anchor from "@anchor-lang/core";
import type { Timba } from "../idl/idlType";
import { WalletManager } from "../src/utils/wallet";
import { getSupportedTokens } from "../src/utils/token-registry";
import type { KeypairBundle } from "./utils/keypairs";
import { bundleFromKeypair, resolveOracleOperatorBundle, uniqueSigners } from "./utils/keypairs";
import { createAnchorContext } from "./utils/anchor-context";
import { resolvePrimaryRpcEndpoint } from "../src/utils/rpc-endpoints";
import { loadWalletMnemonic } from "../src/utils/secrets";

const TOKENS_TO_DISABLE = getSupportedTokens();

const RPC_URL = resolvePrimaryRpcEndpoint(process.env.SOLANA_NETWORK);

async function disableToken(
  program: anchor.Program<Timba>,
  connection: anchor.web3.Connection,
  admin: KeypairBundle,
  oracleOperator: KeypairBundle,
  mintAddress: string,
  ticker: string,
  wallet: WalletManager,
): Promise<void> {
  const mint = new anchor.web3.PublicKey(mintAddress);
  const [gameTokenPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), mint.toBuffer()],
    program.programId,
  );

  console.log(`\n🔌 Disabling ${ticker} (mint ${mintAddress}) — PDA ${gameTokenPda.toBase58()}`);

  const accountInfo = await connection.getAccountInfo(gameTokenPda);
  if (!accountInfo) {
    console.warn(`⚠️  Game token account not found for ${ticker}. Skipping disable step.`);
    return;
  }

  const gameToken = await program.account.gameToken.fetch(gameTokenPda);

  if (!gameToken.enabled) {
    console.log(`✅ ${ticker} already disabled.`);
    return;
  }

  const [oraclePda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    program.programId,
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

  const tx = await wallet.sendAndConfirmWithResubmits(
    [instruction],
    uniqueSigners(admin.root, oracleOperator.root),
    { operationLabel: `Disable ${ticker} token` },
  );

  console.log(`🚫 ${ticker} disabled. Transaction: ${tx}`);
}

async function main() {
  console.log("🚦 Disabling game tokens on Timba program...\n");

  // Load admin/bot keypair via wallet manager
  const wallet = WalletManager.getInstance(loadWalletMnemonic());
  const adminKeypairRoot = wallet.getAdminKeypair();
  const adminBundle = bundleFromKeypair(adminKeypairRoot);

  const oracleOperatorBundle = resolveOracleOperatorBundle(adminKeypairRoot);

  const { provider, program } = createAnchorContext(adminBundle.root, {
    rpcUrl: RPC_URL,
  });

  const connection = provider.connection;
  const balanceLamports = await connection.getBalance(adminBundle.anchor.publicKey);
  console.log(
    `🔑 Admin signer: ${adminBundle.anchor.publicKey.toBase58()} — balance ${(balanceLamports / anchor.web3.LAMPORTS_PER_SOL).toFixed(4)} SOL`,
  );

  console.log(`📋 Program ID: ${program.programId.toBase58()}`);

  for (const token of TOKENS_TO_DISABLE) {
    await disableToken(
      program,
      connection,
      adminBundle,
      oracleOperatorBundle,
      token.mint,
      token.ticker,
      wallet,
    );
  }

  console.log("\n🏁 Token disable process finished.");
}

main().catch((error) => {
  console.error("❌ Failed to disable tokens:", error);
  process.exit(1);
});
