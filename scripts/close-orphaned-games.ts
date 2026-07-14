import { GameDatabase } from "../src/utils/game-database";
import { GameManager } from "../src/utils/game";
import { resolvePrimaryRpcEndpoint } from "../src/utils/rpc-endpoints";
import { loadProgramContext } from "../src/utils/anchor-context";
import { loadWalletMnemonic } from "../src/utils/secrets";

const requireEnvVar = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
};

export async function closeOrphanedGames(): Promise<void> {
  console.log("🧹 Starting orphaned game cleanup...\n");

  const mnemonic = loadWalletMnemonic();
  const rpcEndpoint = resolvePrimaryRpcEndpoint(requireEnvVar("SOLANA_NETWORK"));

  const { wallet, program } = loadProgramContext({
    mnemonic,
    rpcUrl: rpcEndpoint,
  });

  console.log(`📋 Program ID: ${program.programId.toBase58()}`);
  console.log(`🌐 RPC endpoint: ${rpcEndpoint}`);

  const gameDb = GameDatabase.getInstance();
  const gameManager = GameManager.getInstance(program, wallet, gameDb);

  await gameManager.scanBlockchainForOrphanedGames();

  console.log("\n✅ Orphaned game cleanup finished.");
}

if (import.meta.main) {
  closeOrphanedGames().catch((error) => {
    console.error("❌ Failed to close orphaned games:", error);
    process.exit(1);
  });
}
