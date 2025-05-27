import * as anchor from "@coral-xyz/anchor";
import { WalletManager } from "../src/utils/wallet";
import { PDAManager } from "../src/utils/pda";
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";

// Initialize wallet manager
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);

const updateOracle = async () => {
  try {
    console.log("🔄 Starting Oracle Update...");

    // Get admin keypair
    const adminKeypair = wallet.getAdminKeypair();
    console.log(`Admin public key: ${adminKeypair.publicKey.toString()}`);

    // Create wallet adapter for Anchor
    const adminWallet = new anchor.Wallet(adminKeypair);

    // Initialize provider
    const provider = new anchor.AnchorProvider(
      wallet.getConnection(),
      adminWallet,
      { commitment: "confirmed" }
    );

    // Set the provider globally
    anchor.setProvider(provider);

    // Initialize program
    const program = new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
    console.log(`Program ID: ${program.programId}`);

    // Get Oracle PDA
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    console.log(`Oracle PDA: ${oraclePda.toString()}`);

    // Check current oracle config
    try {
      const currentOracle = await program.account.oracle.fetch(oraclePda);
      console.log("\nCurrent Oracle Configuration:");
      console.log(`- Authority: ${currentOracle.authority.toString()}`);
      console.log(`- Fee Percentage: ${currentOracle.feePercentage}%`);
      console.log(`- Min Timeout: ${currentOracle.minTimeout} seconds (${Math.round(currentOracle.minTimeout / 60)} minutes)`);
      console.log(`- Max Timeout: ${currentOracle.maxTimeout} seconds (${Math.round(currentOracle.maxTimeout / 60)} minutes)`);
      console.log(`- Max Players: ${currentOracle.maxPlayers}`);
      console.log(`- Oracle Buffer Time: ${currentOracle.oracleBufferTime} seconds`);

      // Verify authority
      if (!currentOracle.authority.equals(adminKeypair.publicKey)) {
        throw new Error(`Authority mismatch. Expected: ${adminKeypair.publicKey.toString()}, Found: ${currentOracle.authority.toString()}`);
      }
    } catch (error) {
      console.error("Error fetching current oracle:", error);
      return;
    }

    // New configuration with correct values
    const newConfig = {
      feePercentage: 1,        // 1% fee
      oracleBufferTime: 300,    // 5 minute buffer
      maxPlayers: 100,         // 100 max players
      maxTimeout: 7200,        // 2 hours max timeout
      minTimeout: 300          // 5 minutes min timeout
    };

    console.log("\nNew Oracle Configuration:");
    console.log(`- Fee Percentage: ${newConfig.feePercentage}%`);
    console.log(`- Min Timeout: ${newConfig.minTimeout} seconds (${Math.round(newConfig.minTimeout / 60)} minutes)`);
    console.log(`- Max Timeout: ${newConfig.maxTimeout} seconds (${Math.round(newConfig.maxTimeout / 60)} minutes)`);
    console.log(`- Max Players: ${newConfig.maxPlayers}`);
    console.log(`- Oracle Buffer Time: ${newConfig.oracleBufferTime} seconds`);

    console.log("\n🔄 Updating Oracle...");

    // Update oracle configuration
    const tx = await program.methods
      .updateOracle(newConfig)
      .accounts({
        oldAuthority: adminKeypair.publicKey,
        newAuthority: adminKeypair.publicKey, // Same authority
      })
      .signers([adminKeypair]) // Both old and new authority are the same
      .rpc();

    console.log(`✅ Oracle updated successfully!`);
    console.log(`Transaction: ${tx}`);

    // Verify the update
    const updatedOracle = await program.account.oracle.fetch(oraclePda);
    console.log("\nUpdated Oracle Configuration:");
    console.log(`- Authority: ${updatedOracle.authority.toString()}`);
    console.log(`- Fee Percentage: ${updatedOracle.feePercentage}%`);
    console.log(`- Min Timeout: ${updatedOracle.minTimeout} seconds (${Math.round(updatedOracle.minTimeout / 60)} minutes)`);
    console.log(`- Max Timeout: ${updatedOracle.maxTimeout} seconds (${Math.round(updatedOracle.maxTimeout / 60)} minutes)`);
    console.log(`- Max Players: ${updatedOracle.maxPlayers}`);
    console.log(`- Oracle Buffer Time: ${updatedOracle.oracleBufferTime} seconds`);

  } catch (error) {
    console.error("❌ Error updating Oracle:", error);
  }
};

// Run the update
updateOracle();
