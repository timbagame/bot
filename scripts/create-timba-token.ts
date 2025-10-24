import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { NetworkDetector } from "../src/utils/network-detector";

// ================================
// CONFIGURATION
// ================================

const CONFIG = {
  // Network configuration
  RPC_URL: "https://api.devnet.solana.com",
  NETWORK: "devnet" as const,

  // Token configuration
  TOKEN_NAME: "TIMBA",
  TOKEN_SYMBOL: "TIMBA",
  TOKEN_DECIMALS: 9,

  // Mint configuration
  TARGET_ADDRESS: "BqqxezbGRYGu7BU2NCNif6TocL2zLQrjjToVcVXTsw1R",
  MINT_AMOUNT: 1_000_000_000, // 1 billion tokens

  // Authority configuration
  ADMIN_KEYPAIR_PATH: "./admin-keypair.json",
};

// ================================
// MAIN FUNCTION
// ================================

async function createTimbaToken() {
  console.log("🚀 Creating TIMBA token on devnet...\n");

  // Connect to devnet
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  console.log("✅ Connected to devnet");

  // Load or create mint authority
  let mintAuthority: Keypair;
  try {
    // Try to load existing admin keypair
    if (fs.existsSync(CONFIG.ADMIN_KEYPAIR_PATH)) {
      const adminKeypairData = JSON.parse(
        fs.readFileSync(CONFIG.ADMIN_KEYPAIR_PATH, "utf-8")
      );
      mintAuthority = Keypair.fromSecretKey(new Uint8Array(adminKeypairData));
      console.log("✅ Loaded admin keypair as mint authority");
    } else {
      throw new Error("Admin keypair not found");
    }
  } catch (error) {
    console.log("⚠️  Admin keypair not found, creating new mint authority...");
    mintAuthority = Keypair.generate();

    // Request airdrop for the new keypair
    console.log("💧 Requesting SOL airdrop...");
    const airdropSignature = await connection.requestAirdrop(
      mintAuthority.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSignature);
    console.log("✅ Airdrop confirmed");
  }

  console.log(`🔑 Mint Authority: ${mintAuthority.publicKey.toBase58()}`);

  // Check SOL balance
  const balance = await connection.getBalance(mintAuthority.publicKey);
  console.log(`💰 SOL Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  if (balance < 0.1 * LAMPORTS_PER_SOL) {
    console.log("💧 Requesting additional SOL airdrop...");
    const airdropSignature = await connection.requestAirdrop(
      mintAuthority.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSignature);
    console.log("✅ Additional airdrop confirmed");
  }

  try {
    // Step 1: Create the mint
    console.log("\n📝 Creating token mint...");
    const mint = await createMint(
      connection,
      mintAuthority,
      mintAuthority.publicKey, // mint authority
      mintAuthority.publicKey, // freeze authority
      CONFIG.TOKEN_DECIMALS
    );

    console.log(`✅ Token mint created: ${mint.toBase58()}`);

    // Step 2: Get or create associated token account for target address
    console.log("\n🏦 Setting up token account for target address...");
    const targetPublicKey = new PublicKey(CONFIG.TARGET_ADDRESS);

    const targetTokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      mintAuthority,
      mint,
      targetPublicKey
    );

    console.log(
      `✅ Target token account: ${targetTokenAccount.address.toBase58()}`
    );

    // Step 3: Mint tokens to the target address
    console.log("\n🏭 Minting tokens...");
    const mintAmount = CONFIG.MINT_AMOUNT * Math.pow(10, CONFIG.TOKEN_DECIMALS); // Convert to raw amount

    const mintSignature = await mintTo(
      connection,
      mintAuthority,
      mint,
      targetTokenAccount.address,
      mintAuthority.publicKey,
      mintAmount
    );

    console.log(
      `✅ Minted ${CONFIG.MINT_AMOUNT.toLocaleString()} ${
        CONFIG.TOKEN_SYMBOL
      } tokens`
    );
    console.log(`📝 Mint transaction: ${mintSignature}`);

    // Step 4: Display summary
    console.log("\n🎉 TIMBA Token Creation Summary:");
    console.log("=====================================");
    console.log(`Token Name: ${CONFIG.TOKEN_NAME}`);
    console.log(`Token Symbol: ${CONFIG.TOKEN_SYMBOL}`);
    console.log(`Token Decimals: ${CONFIG.TOKEN_DECIMALS}`);
    console.log(`Token Mint Address: ${mint.toBase58()}`);
    console.log(`Mint Authority: ${mintAuthority.publicKey.toBase58()}`);
    console.log(`Target Address: ${CONFIG.TARGET_ADDRESS}`);
    console.log(
      `Target Token Account: ${targetTokenAccount.address.toBase58()}`
    );
    console.log(
      `Minted Amount: ${CONFIG.MINT_AMOUNT.toLocaleString()} ${
        CONFIG.TOKEN_SYMBOL
      }`
    );
    console.log(`Network: ${CONFIG.NETWORK}`);
    console.log("\n🔗 Solscan URL:");
    console.log(
      NetworkDetector.buildSolscanTokenUrl(
        mint.toBase58(),
        CONFIG.NETWORK
      ) ?? `Explorer not available for ${CONFIG.NETWORK}`
    );

    // Step 5: Save token info to file
    const tokenInfo = {
      name: CONFIG.TOKEN_NAME,
      symbol: CONFIG.TOKEN_SYMBOL,
      decimals: CONFIG.TOKEN_DECIMALS,
      mint: mint.toBase58(),
      mintAuthority: mintAuthority.publicKey.toBase58(),
      targetAddress: CONFIG.TARGET_ADDRESS,
      targetTokenAccount: targetTokenAccount.address.toBase58(),
      mintedAmount: CONFIG.MINT_AMOUNT,
      network: CONFIG.NETWORK,
      createdAt: new Date().toISOString(),
      mintTransaction: mintSignature,
    };

    const outputPath = path.join(process.cwd(), "timba-token-info.json");
    fs.writeFileSync(outputPath, JSON.stringify(tokenInfo, null, 2));
    console.log(`\n💾 Token info saved to ${outputPath}`);

    // Step 6: Save mint authority keypair if it was generated
    if (!fs.existsSync(CONFIG.ADMIN_KEYPAIR_PATH)) {
      const mintAuthorityPath = path.join(
        process.cwd(),
        "timba-mint-authority.json"
      );
      fs.writeFileSync(
        mintAuthorityPath,
        JSON.stringify(Array.from(mintAuthority.secretKey))
      );
      console.log(`💾 Mint authority keypair saved to ${mintAuthorityPath}`);
      console.log("⚠️  Keep this keypair secure - it controls the token mint!");
    }

    return {
      mint: mint.toBase58(),
      mintAuthority: mintAuthority.publicKey.toBase58(),
      targetTokenAccount: targetTokenAccount.address.toBase58(),
      mintTransaction: mintSignature,
    };
  } catch (error) {
    console.error("❌ Error creating token:", error);
    throw error;
  }
}

// ================================
// SCRIPT EXECUTION
// ================================

if (require.main === module) {
  createTimbaToken()
    .then((result) => {
      console.log("\n✅ TIMBA token creation completed successfully!");
      console.log("📋 Result:", result);
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Failed to create TIMBA token:", error);
      process.exit(1);
    });
}

export { createTimbaToken, CONFIG };
