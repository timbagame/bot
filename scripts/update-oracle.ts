import * as anchor from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { WalletManager } from "../src/utils/wallet";
import { PDAManager } from "../src/utils/pda";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";

const ORACLE_OPERATOR_KEYPAIR_ENV = "ORACLE_OPERATOR_KEYPAIR_PATH";
const NEW_ORACLE_OPERATOR_KEYPAIR_ENV = "NEW_ORACLE_OPERATOR_KEYPAIR_PATH";

const loadKeypairFromPath = (filePath: string): Keypair => {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  const secret = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
};

const loadOperatorKeypair = (
  envVarName: string,
  defaultKeypair: Keypair,
  role: string
): Keypair => {
  const configuredPath = process.env[envVarName]?.trim();
  if (!configuredPath) {
    console.log(
      `${role}: using default keypair ${defaultKeypair.publicKey.toBase58()}`
    );
    return defaultKeypair;
  }

  try {
    const keypair = loadKeypairFromPath(configuredPath);
    console.log(
      `${role}: loaded ${keypair.publicKey.toBase58()} from ${configuredPath}`
    );
    return keypair;
  } catch (error) {
    console.error(
      `${role}: failed to load keypair from ${configuredPath}:`,
      error
    );
    throw error;
  }
};

const uniqueSigners = (...signers: Keypair[]): Keypair[] => {
  const seen = new Set<string>();
  const deduped: Keypair[] = [];
  for (const signer of signers) {
    if (!signer) continue;
    const key = signer.publicKey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(signer);
  }
  return deduped;
};

// Initialize wallet manager
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);

const updateOracle = async () => {
  try {
    console.log("🔄 Starting Oracle Update...");

    // Get admin keypair
    const adminKeypair = wallet.getAdminKeypair();
    console.log(`Admin public key: ${adminKeypair.publicKey.toString()}`);

    const currentOracleOperatorKeypair = loadOperatorKeypair(
      ORACLE_OPERATOR_KEYPAIR_ENV,
      adminKeypair,
      "Current oracle operator"
    );

    const newOracleOperatorKeypair = loadOperatorKeypair(
      NEW_ORACLE_OPERATOR_KEYPAIR_ENV,
      currentOracleOperatorKeypair,
      "New oracle operator"
    );

    // Create wallet adapter for Anchor
    const adminWallet = new anchor.Wallet(
      adminKeypair as unknown as anchor.web3.Keypair
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
      idl as Timba,
      provider
    ) as anchor.Program<Timba>;
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
