import * as anchor from "@coral-xyz/anchor";
import { PDAManager } from "../src/utils/pda";
import {
  resolveKeypairFromEnv,
  resolveOracleOperatorKeypair,
  uniqueSigners,
} from "./utils/keypairs";
import { loadProgramContext } from "./utils/anchor-context";

const NEW_ORACLE_OPERATOR_KEYPAIR_ENV = "NEW_ORACLE_OPERATOR_KEYPAIR_PATH";

const updateOracle = async () => {
  try {
    console.log("🔄 Starting Oracle Update...");

    const { wallet, adminKeypair, program } = loadProgramContext();
    console.log(`Admin public key: ${adminKeypair.publicKey.toString()}`);

    const currentOracleOperatorKeypair = resolveOracleOperatorKeypair(
      adminKeypair,
      { description: "Current oracle operator keypair" }
    );

    const newOracleOperatorKeypair = resolveKeypairFromEnv(
      NEW_ORACLE_OPERATOR_KEYPAIR_ENV,
      currentOracleOperatorKeypair,
      "New oracle operator keypair"
    );

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
      if (
        !currentOracle.operator.equals(
          currentOracleOperatorKeypair.publicKey
        )
      ) {
        throw new Error(
          `Operator mismatch. Expected: ${currentOracleOperatorKeypair.publicKey.toString()}, Found: ${currentOracle.operator.toString()}`
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
      maxTickets: 100, // 100 max tickets
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
    if (
      !newOracleOperatorKeypair.publicKey.equals(
        currentOracleOperatorKeypair.publicKey
      )
    ) {
      console.log(
        `- Transferring operator authority to ${newOracleOperatorKeypair.publicKey.toBase58()}`
      );
    }

    console.log("\n🔄 Updating Oracle...");

    // Update oracle configuration
    const updateInstruction = await program.methods
      .updateOracle(newConfig)
      .accounts({
        oldOracleOperator: currentOracleOperatorKeypair.publicKey,
        newOracleOperator: newOracleOperatorKeypair.publicKey,
      })
      .instruction();

    const tx = await wallet.sendTransaction(
      [updateInstruction],
      uniqueSigners(
        adminKeypair,
        currentOracleOperatorKeypair,
        newOracleOperatorKeypair
      )
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
