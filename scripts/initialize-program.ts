import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { Timba } from "../idl/idlType";
import type { WalletManager } from "../src/utils/wallet";
import {
  resolveOracleOperatorKeypair,
  uniqueSigners,
} from "./utils/keypairs";
import {
  createOracleConfig,
  logOracleConfig,
} from "./utils/oracle-config";
import { loadProgramContext } from "./utils/anchor-context";

// Initialize Oracle if it doesn't exist
const initializeOracle = async (
  program: anchor.Program<Timba>,
  wallet: WalletManager
) => {
  try {
    // Get Oracle PDA
    const [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle")],
      program.programId
    );

    // Check if Oracle exists
    try {
      const oracleAccount = await program.account.oracle.fetch(oraclePda);
      console.log(
        `Oracle already exists, operator: ${oracleAccount.operator.toString()}`
      );
      return oraclePda;
    } catch (error) {
      console.log("Oracle doesn't exist, creating...");
    }

    // Get admin keypair from JSON file
    const adminKeypair = wallet.getAdminKeypair();
    const oracleOperatorKeypair = resolveOracleOperatorKeypair(adminKeypair);

    // Initialize Oracle
    const oracleConfig = createOracleConfig();
    logOracleConfig(oracleConfig, {
      heading: "Initialized oracle configuration",
    });

    const oracleInstruction = await program.methods
      .initializeOracle(oracleConfig)
      .accounts({
        oracleOperator: oracleOperatorKeypair.publicKey,
      })
      .instruction();

    const tx = await wallet.sendTransaction(
      [oracleInstruction],
      uniqueSigners(adminKeypair, oracleOperatorKeypair)
    );
    console.log(`Oracle initialized! Transaction: ${tx}`);
    return oraclePda;
  } catch (error) {
    console.error("Error initializing Oracle:", error);
    return null;
  }
};

// Main function
const initializeProgram = async () => {
  try {
    console.log("Initializing program...");
    const { wallet, program } = loadProgramContext();
    console.log(`Program ID: ${program.programId.toBase58()}`);

    // Initialize Oracle
    const oraclePda = await initializeOracle(program, wallet);
    if (!oraclePda) {
      console.log("Failed to initialize Oracle. Aborting.");
      return;
    }

    console.log("Program initialization completed successfully!");
    console.log(
      "Note: Game tokens should be initialized separately using the initialize-game-token.ts script"
    );
  } catch (error) {
    console.error("Error initializing program:", error);
  }
};

// Run the initialization
initializeProgram().catch(console.error);
