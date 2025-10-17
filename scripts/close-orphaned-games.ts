import * as anchor from "@coral-xyz/anchor";
import type { AnchorProvider } from "@coral-xyz/anchor";
import { Wallet } from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { WalletManager } from "../src/utils/wallet";
import { GameDatabase } from "../src/utils/game-database";
import { GameManager } from "../src/utils/game";

const MNEMONIC_ENV = "MNEMONIC";

const requireEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${key} is required`);
  }
  return value;
};

const getWallet = (): WalletManager => {
  const mnemonic = requireEnv(MNEMONIC_ENV);
  return WalletManager.getInstance(mnemonic);
};

const createAnchorProgram = async (
  wallet: WalletManager
): Promise<anchor.Program<Timba>> => {
  const adminKeypair = wallet.getAdminKeypair();

  const anchorWallet = new Wallet(adminKeypair as unknown as anchor.web3.Keypair);
  const connection = wallet.getConnection() as unknown as Connection;

  const provider: AnchorProvider = new anchor.AnchorProvider(
    connection,
    anchorWallet,
    { commitment: "confirmed" }
  );

  anchor.setProvider(provider);

  return new anchor.Program(idl as Timba, provider) as anchor.Program<Timba>;
};

const closeOrphanedGames = async () => {
  console.log("🔍 Starting orphaned game cleanup script...");

  try {
    const wallet = getWallet();
    const program = await createAnchorProgram(wallet);
    const gameDb = GameDatabase.getInstance();
    const gameManager = GameManager.getInstance(program, wallet, gameDb);

    await gameManager.scanBlockchainForOrphanedGames();

    console.log("✅ Completed orphaned game cleanup");
  } catch (error) {
    console.error("❌ Failed to close orphaned games:", error);
    process.exit(1);
  }
};

closeOrphanedGames();
