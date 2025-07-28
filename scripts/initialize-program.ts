import { WalletManager } from "../src/utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";

// Initialize wallet manager
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);

// Initialize Anchor with a wallet for admin operations
const initializeAnchorProvider = async () => {
  // Get admin keypair from JSON file
  const adminKeypair = await wallet.getAdminKeypair();

  // Create a wallet adapter for Anchor
  const adminWallet = new anchor.Wallet(adminKeypair);

  // Initialize provider with connection from wallet manager
  const provider = new anchor.AnchorProvider(
    wallet.getConnection(),
    adminWallet,
    { commitment: "confirmed" }
  );

  // Set the provider globally
  anchor.setProvider(provider);

  return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
};

// Initialize Oracle if it doesn't exist
const initializeOracle = async (program: anchor.Program<Coinflip>) => {
  try {
    // Get Oracle PDA
    const [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle")],
      program.programId
    );

    // Check if Oracle exists
    try {
      const oracleAccount = await program.account.oracle.fetch(oraclePda);
      console.log(`Oracle already exists, operator: ${oracleAccount.operator.toString()}`);
      return oraclePda;
    } catch (error) {
      console.log("Oracle doesn't exist, creating...");
    }

    // Get admin keypair from JSON file
    const adminKeypair = wallet.getAdminKeypair();

    // Initialize Oracle
    const oracleConfig = {
      feePercentage: 1,        // 1% fee
      oracleBufferTime: 300,   // 5 minute buffer
      maxTickets: 1000000,         // 1.000.000 max tickets
      maxTimeout: 86400,        // 24 hours max timeout
      minTimeout: 60          // 1 minute min timeout
    };

    const oracleInstruction = await program.methods
      .initializeOracle(oracleConfig)
      .accounts({
        oracleOperator: adminKeypair.publicKey,
      })
      .instruction();

    const tx = await wallet.sendTransaction([oracleInstruction], [adminKeypair]);
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
    const program = await initializeAnchorProvider();
    console.log(`Program ID: ${program.programId.toBase58()}`);

    // Initialize Oracle
    const oraclePda = await initializeOracle(program);
    if (!oraclePda) {
      console.log("Failed to initialize Oracle. Aborting.");
      return;
    }

    console.log("Program initialization completed successfully!");
    console.log("Note: Game tokens should be initialized separately using the initialize-game-token.ts script");
  } catch (error) {
    console.error("Error initializing program:", error);
  }
};

// Run the initialization
initializeProgram().catch(console.error);
