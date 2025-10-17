import * as anchor from "@coral-xyz/anchor";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { WalletManager } from "../src/utils/wallet";
import { GameDatabase } from "../src/utils/game-database";
import { GameManager } from "../src/utils/game";

const requireEnvVar = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
};

async function main(): Promise<void> {
  console.log("🧹 Starting orphaned game cleanup...\n");

  const mnemonic = requireEnvVar("MNEMONIC");
  const rpcEndpoint = requireEnvVar("SOLANA_NETWORK");

  const wallet = WalletManager.getInstance(mnemonic);
  const adminKeypair = wallet.getAdminKeypair();
  const connection = wallet.getConnection();

  const provider = new anchor.AnchorProvider(
    connection as unknown as anchor.web3.Connection,
    new anchor.Wallet(adminKeypair as unknown as anchor.web3.Keypair),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  const program = new anchor.Program(
    idl as Timba,
    provider
  ) as anchor.Program<Timba>;

  console.log(`📋 Program ID: ${program.programId.toBase58()}`);
  console.log(`🌐 RPC endpoint: ${rpcEndpoint}`);

  const gameDb = GameDatabase.getInstance();
  const gameManager = GameManager.getInstance(program, wallet, gameDb);

  await gameManager.scanBlockchainForOrphanedGames();

  console.log("\n✅ Orphaned game cleanup finished.");
}

main().catch((error) => {
  console.error("❌ Failed to close orphaned games:", error);
  process.exit(1);
});
