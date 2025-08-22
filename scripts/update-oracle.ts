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
    const adminWallet = new anchor.Wallet(
      adminKeypair as anchor.web3.Keypair
    );

    // Initialize provider
    const provider = new anchor.AnchorProvider(
      wallet.getConnection() as unknown as anchor.web3.Connection,
      adminWallet,
      { commitment: "confirmed" }
    );

    // Set the provider globally
    anchor.setProvider(provider);

    // Initialize program
    const program = new anchor.Program(
      idl as Coinflip,
      provider
    ) as anchor.Program<Coinflip>;
    console.log(`Program ID: ${program.programId}`);

    // Get Oracle PDA
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    console.log(`Oracle PDA: ${oraclePda.toString()}`);

    // Check current oracle config
    try {
      const currentOracle = await program.account.oracle.fetch(oraclePda);
      console.log("\nCurrent Oracle Configuration:");
      console.log(`- Operator: ${currentOracle.operator.toString()}`);
      console.log(`- Fee Percentage: ${currentOracle.feePercentage}%`);
      console.log(
        `- Min Timeout: ${currentOracle.minTimeout} seconds (${Math.round(
          currentOracle.minTimeout / 60
        )} minutes)`
      );
      console.log(
        `- Max Timeout: ${currentOracle.maxTimeout} seconds (${Math.round(
          currentOracle.maxTimeout / 60
        )} minutes)`
      );
      console.log(`- Max Tickets: ${currentOracle.maxTickets}`);
      console.log(
        `- Oracle Buffer Time: ${currentOracle.oracleBufferTime} seconds`
      );

      // Verify operator
      if (!currentOracle.operator.equals(adminKeypair.publicKey)) {
        throw new Error(
          `Operator mismatch. Expected: ${adminKeypair.publicKey.toString()}, Found: ${currentOracle.operator.toString()}`
        );
      }
    } catch (error) {
      console.error("Error fetching current oracle:", error);
      return;
    }

    // New configuration with correct values
    const newConfig = {
      // u8
      feePercentage: 1, // 1% fee
      // u64 fields must be BN
      oracleBufferTime: new anchor.BN(300),
      // u32
      maxTickets: 50000, // 50,000 max tickets
      // u64 fields must be BN
      maxTimeout: new anchor.BN(86400), // 24 hours
      minTimeout: new anchor.BN(60), // 1 minute
    };

    console.log("\nNew Oracle Configuration:");
    console.log(`- Fee Percentage: ${newConfig.feePercentage}%`);
    console.log(
      `- Min Timeout: ${newConfig.minTimeout} seconds (${Math.round(
        newConfig.minTimeout / 60
      )} minutes)`
    );
    console.log(
      `- Max Timeout: ${newConfig.maxTimeout} seconds (${Math.round(
        newConfig.maxTimeout / 60
      )} minutes)`
    );
    console.log(`- Max Tickets: ${newConfig.maxTickets}`);
    console.log(`- Oracle Buffer Time: ${newConfig.oracleBufferTime} seconds`);

    console.log("\n🔄 Updating Oracle...");

    // Update oracle configuration
    const updateInstruction = await program.methods
      .updateOracle(newConfig)
      .accounts({
        oldOracleOperator: adminKeypair.publicKey,
        newOracleOperator: adminKeypair.publicKey, // Same operator
      })
      .instruction();

    const tx = await wallet.sendTransaction(
      [updateInstruction],
      [adminKeypair]
    );
    console.log(`✅ Oracle updated successfully!`);
    console.log(`Transaction: ${tx}`);

    // Verify the update
    const updatedOracle = await program.account.oracle.fetch(oraclePda);
    console.log("\nUpdated Oracle Configuration:");
    console.log(`- Operator: ${updatedOracle.operator.toString()}`);
    console.log(`- Fee Percentage: ${updatedOracle.feePercentage}%`);
    console.log(
      `- Min Timeout: ${updatedOracle.minTimeout} seconds (${Math.round(
        updatedOracle.minTimeout / 60
      )} minutes)`
    );
    console.log(
      `- Max Timeout: ${updatedOracle.maxTimeout} seconds (${Math.round(
        updatedOracle.maxTimeout / 60
      )} minutes)`
    );
    console.log(`- Max Tickets: ${updatedOracle.maxTickets}`);
    console.log(
      `- Oracle Buffer Time: ${updatedOracle.oracleBufferTime} seconds`
    );
  } catch (error) {
    console.error("❌ Error updating Oracle:", error);
  }
};

// Run the update
updateOracle();
