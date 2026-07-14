import * as anchor from "@anchor-lang/core";
import { PDAManager } from "../src/utils/pda";
import {
  resolveKeypairFromEnv,
  resolveOracleOperatorKeypair,
  uniqueSigners,
} from "./utils/keypairs";
import { loadProgramContext } from "./utils/anchor-context";
import { createOracleConfig, logOracleConfig } from "./utils/oracle-config";

const NEW_ORACLE_OPERATOR_KEYPAIR_ENV = "NEW_ORACLE_OPERATOR_KEYPAIR_PATH";

const updateOracle = async () => {
  try {
    console.log("🔄 Starting Oracle Update...");

    const { wallet, adminKeypair, program } = loadProgramContext();
    console.log(`Admin public key: ${adminKeypair.publicKey.toString()}`);

    const currentOracleOperatorKeypair = resolveOracleOperatorKeypair(adminKeypair, {
      description: "Current oracle operator keypair",
    });

    const newOracleOperatorKeypair = resolveKeypairFromEnv(
      NEW_ORACLE_OPERATOR_KEYPAIR_ENV,
      currentOracleOperatorKeypair,
      "New oracle operator keypair",
    );

    console.log(`Program ID: ${program.programId}`);

    // Get Oracle PDA
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    console.log(`Oracle PDA: ${oraclePda.toString()}`);

    // Check current oracle config
    try {
      const currentOracle = await program.account.oracle.fetch(oraclePda);
      logOracleConfig(
        createOracleConfig({
          feePercentage: currentOracle.feePercentage,
          oracleBufferTime: new anchor.BN(currentOracle.oracleBufferTime.toString()),
          maxTickets: currentOracle.maxTickets,
          maxTimeout: new anchor.BN(currentOracle.maxTimeout.toString()),
          minTimeout: new anchor.BN(currentOracle.minTimeout.toString()),
        }),
        { heading: "Current Oracle Configuration" },
      );

      // Verify operator
      if (!currentOracle.operator.equals(currentOracleOperatorKeypair.publicKey)) {
        throw new Error(
          `Operator mismatch. Expected: ${currentOracleOperatorKeypair.publicKey.toString()}, Found: ${currentOracle.operator.toString()}`,
        );
      }
    } catch (error) {
      console.error("Error fetching current oracle:", error);
      return;
    }

    // New configuration with correct values
    const newConfig = createOracleConfig();
    logOracleConfig(newConfig, { heading: "New Oracle Configuration" });
    if (!newOracleOperatorKeypair.publicKey.equals(currentOracleOperatorKeypair.publicKey)) {
      console.log(
        `- Transferring operator authority to ${newOracleOperatorKeypair.publicKey.toBase58()}`,
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

    const tx = await wallet.sendAndConfirmWithResubmits(
      [updateInstruction],
      uniqueSigners(adminKeypair, currentOracleOperatorKeypair, newOracleOperatorKeypair),
      { operationLabel: "Update oracle config" },
    );

    console.log(`✅ Oracle updated successfully!`);
    console.log(`Transaction: ${tx}`);

    // Verify the update
    const updatedOracle = await program.account.oracle.fetch(oraclePda);
    logOracleConfig(
      createOracleConfig({
        feePercentage: updatedOracle.feePercentage,
        oracleBufferTime: new anchor.BN(updatedOracle.oracleBufferTime.toString()),
        maxTickets: updatedOracle.maxTickets,
        maxTimeout: new anchor.BN(updatedOracle.maxTimeout.toString()),
        minTimeout: new anchor.BN(updatedOracle.minTimeout.toString()),
      }),
      { heading: "Updated Oracle Configuration" },
    );
  } catch (error) {
    console.error("❌ Error updating Oracle:", error);
  }
};

// Run the update
updateOracle();
