import { WalletManager } from "../src/utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";

const TOKEN_MINT = process.env.TOKEN_MINT!;

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
      console.log(`Oracle already exists, authority: ${oracleAccount.authority.toString()}`);
      return oraclePda;
    } catch (error) {
      console.log("Oracle doesn't exist, creating...");
    }

    // Get admin keypair from JSON file
    const adminKeypair = await wallet.getAdminKeypair();

    // Initialize Oracle
    const tx = await program.methods
      .initializeOracle(
        5, // Fee percentage
        60, // Oracle buffer time
        100, // Max players
        7200, // Max timeout
        300 // Min timeout
      )
      .accounts({
        authority: adminKeypair.publicKey,
      })
      .signers([adminKeypair])
      .rpc();

    console.log(`Oracle initialized! Transaction: ${tx}`);
    return oraclePda;
  } catch (error) {
    console.error("Error initializing Oracle:", error);
    return null;
  }
};

// Initialize Game Token if it doesn't exist
const initializeGameToken = async (program: anchor.Program<Coinflip>) => {
  try {
    const tokenMintPubkey = new PublicKey(TOKEN_MINT);

    // Get Game Token PDA
    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), tokenMintPubkey.toBuffer()],
      program.programId
    );

    // Check if Game Token exists
    try {
      const gameTokenAccount = await program.account.gameToken.fetch(gameTokenPda);
      console.log(`Game Token already exists: ${gameTokenAccount.tokenMint.toString()}`);
      return gameTokenPda;
    } catch (error) {
      console.log("Game Token doesn't exist, creating...");
    }

    // Get admin keypair from JSON file
    const adminKeypair = await wallet.getAdminKeypair();

    // Initialize Game Token
    const tx = await program.methods
      .initializeToken(
        new anchor.BN(1_000), // Minimum amount in lamports (0.001 token)
        true // Enabled
      )
      .accounts({
        tokenMint: tokenMintPubkey,
        authority: adminKeypair.publicKey,
      })
      .signers([adminKeypair])
      .rpc();

    console.log(`Game Token initialized! Transaction: ${tx}`);
    return gameTokenPda;
  } catch (error) {
    console.error("Error initializing Game Token:", error);
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

    // Initialize Game Token
    const gameTokenPda = await initializeGameToken(program);
    if (!gameTokenPda) {
      console.log("Failed to initialize Game Token. Aborting.");
      return;
    }

    console.log("Program initialization completed successfully!");
  } catch (error) {
    console.error("Error initializing program:", error);
  }
};

// Run the initialization
initializeProgram().catch(console.error);
