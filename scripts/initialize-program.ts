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
    const adminKeypair = wallet.getAdminKeypair();

    // Initialize Oracle
    const oracleConfig = {
      feePercentage: 1,        // 1% fee
      oracleBufferTime: 300,   // 5 minute buffer
      maxPlayers: 100,         // 100 max players
      maxTimeout: 7200,        // 2 hours max timeout
      minTimeout: 300          // 5 minutes min timeout
    };

    const oracleInstruction = await program.methods
      .initializeOracle(oracleConfig)
      .accounts({
        authority: adminKeypair.publicKey,
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
      console.log(`Game Token already exists with min amount: ${gameTokenAccount.minAmount.toString()}`);
      return gameTokenPda;
    } catch (error) {
      console.log("Game Token doesn't exist, creating...");
    }

    // Get admin keypair from JSON file
    const adminKeypair = wallet.getAdminKeypair();

    // Get Game Vault PDA
    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), tokenMintPubkey.toBuffer()],
      program.programId
    );

    // Get Game Token Account (ATA) - this needs to be created first
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
    const gameTokenAccount = await getAssociatedTokenAddress(
      tokenMintPubkey,
      gameVaultPda,
      true // allowOwnerOffCurve
    );

    console.log(`Game Vault PDA: ${gameVaultPda.toBase58()}`);
    console.log(`Game Token Account (ATA): ${gameTokenAccount.toBase58()}`);

    // Check if the ATA already exists, if not create it
    try {
      const accountInfo = await wallet.getConnection().getAccountInfo(gameTokenAccount);
      if (!accountInfo) {
        console.log("Creating Associated Token Account for game vault...");

        // Create the ATA instruction
        const createAtaIx = createAssociatedTokenAccountInstruction(
          adminKeypair.publicKey, // payer
          gameTokenAccount, // ata
          gameVaultPda, // owner
          tokenMintPubkey // mint
        );

        // Send the ATA creation transaction
        const createAtaTx = await wallet.sendTransaction([createAtaIx], [adminKeypair]);
        await wallet.confirmTransaction(createAtaTx);
        console.log(`ATA created! Transaction: ${createAtaTx}`);
      } else {
        console.log("ATA already exists");
      }
    } catch (ataError) {
      console.error("Error creating ATA:", ataError);
      throw ataError;
    }

    // Now initialize Game Token
    console.log("Initializing game token...");
    const tokenInstruction = await program.methods
      .initializeToken(
        new anchor.BN(1_000), // Minimum amount in lamports (0.001 token)
        true // Enabled
      )
      .accounts({
        tokenMint: tokenMintPubkey,
        authority: adminKeypair.publicKey,
      })
      .instruction();

    const tx = await wallet.sendTransaction([tokenInstruction], [adminKeypair]);
    await wallet.confirmTransaction(tx);
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
