import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import type { Timba } from "../idl/idlType";
import idl from "../idl/idl.json";
import { WalletManager } from "../src/utils/wallet";

// ================================
// CONFIGURATION
// ================================

const CONFIG = {
  // Network configuration
  RPC_URL: process.env.SOLANA_NETWORK || "https://api.devnet.solana.com",
  NETWORK: "devnet" as const,

  // Token configuration
  TIMBA_MINT: "BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4",
  TIMBA_TICKER: "TIMBA",

  // WSOL configuration (Wrapped SOL)
  WSOL_MINT: "So11111111111111111111111111111111111111112",
  WSOL_TICKER: "WSOL",

  // Program configuration
  ADMIN_KEYPAIR_PATH: "./admin-keypair.json",
};

// ================================
// UTILITY FUNCTIONS
// ================================

const loadKeypair = (filepath: string): Keypair => {
  try {
    const keypairData = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    return Keypair.fromSecretKey(new Uint8Array(keypairData));
  } catch (error) {
    throw new Error(`Failed to load keypair from ${filepath}: ${error}`);
  }
};

const checkBalance = async (
  connection: Connection,
  keypair: Keypair,
  minBalance: number = 0.1
): Promise<void> => {
  const balance = await connection.getBalance(keypair.publicKey);
  const solBalance = balance / LAMPORTS_PER_SOL;

  console.log(`💰 Admin balance: ${solBalance.toFixed(6)} SOL`);

  if (solBalance < minBalance) {
    throw new Error(
      `❌ Insufficient balance. Need at least ${minBalance} SOL for transactions.`
    );
  }
};

// ================================
// TOKEN INITIALIZATION FUNCTIONS
// ================================

async function initializeToken(
  program: anchor.Program<Timba>,
  connection: Connection,
  adminKeypair: Keypair,
  wallet: WalletManager,
  tokenMint: string,
  tokenTicker: string
) {
  console.log(`\n🔄 Initializing ${tokenTicker} Game Token...`);

  // Validate token mint
  const mint = new PublicKey(tokenMint);
  console.log(`🪙 ${tokenTicker} Mint: ${mint.toBase58()}`);

  // Check if token mint exists
  const mintAccount = await connection.getAccountInfo(mint);
  if (!mintAccount) {
    throw new Error(
      `❌ Token mint ${tokenMint} does not exist on ${CONFIG.NETWORK}`
    );
  }
  console.log(`✅ ${tokenTicker} mint verified`);

  // Derive game token PDA
  const [gameTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), mint.toBuffer()],
    program.programId
  );
  console.log(`🎯 ${tokenTicker} Game Token PDA: ${gameTokenPda.toBase58()}`);

  // Derive game vault PDA
  const [gameVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_vault"), mint.toBuffer()],
    program.programId
  );
  console.log(`🏦 ${tokenTicker} Game Vault PDA: ${gameVaultPda.toBase58()}`);

  // Check if game token already exists
  try {
    const existingGameToken = await program.account.gameToken.fetch(
      gameTokenPda
    );
    console.log(`⚠️  ${tokenTicker} game token already exists!`);
    console.log(`   Min Amount: ${existingGameToken.minAmount.toString()}`);
    console.log(`   Fee Amount: ${existingGameToken.feeAmount.toString()}`);
    console.log(`   Enabled: ${existingGameToken.enabled}`);
    return {
      tokenMint,
      tokenTicker,
      gameTokenPda: gameTokenPda.toBase58(),
      gameVaultPda: gameVaultPda.toBase58(),
      alreadyExists: true,
    };
  } catch (error: any) {
    // Check if account exists but has incompatible structure
    const accountInfo = await connection.getAccountInfo(gameTokenPda);
    if (accountInfo) {
      console.log(
        `⚠️  ${tokenTicker} GameToken account exists but has incompatible structure`
      );
      console.log(`   Account Owner: ${accountInfo.owner.toBase58()}`);
      console.log(`   Account Data Length: ${accountInfo.data.length} bytes`);
      console.log(`   Account Lamports: ${accountInfo.lamports}`);
      console.log(
        `\n❌ Cannot initialize new ${tokenTicker} GameToken over existing account.`
      );
      throw new Error(
        `${tokenTicker} GameToken account exists with incompatible structure`
      );
    }

    // Game token doesn't exist, proceed with initialization
    console.log(
      `📝 ${tokenTicker} game token not found, proceeding with initialization...`
    );
  }

  // Create Associated Token Account for game vault
  const gameTokenAccount = await getAssociatedTokenAddress(
    mint,
    gameVaultPda,
    true // allowOwnerOffCurve
  );
  console.log(
    `🏪 ${tokenTicker} Game Token Account (ATA): ${gameTokenAccount.toBase58()}`
  );

  // Check if the ATA already exists, if not create it
  try {
    const accountInfo = await connection.getAccountInfo(gameTokenAccount);
    if (!accountInfo) {
      console.log(
        `🔧 Creating Associated Token Account for ${tokenTicker} game vault...`
      );

      // Create the ATA instruction
      const createAtaIx = createAssociatedTokenAccountInstruction(
        adminKeypair.publicKey, // payer
        gameTokenAccount, // ata
        gameVaultPda, // owner
        mint // mint
      );

      // Send the ATA creation transaction
      const createAtaTx = new Transaction().add(createAtaIx);
      createAtaTx.recentBlockhash = (
        await connection.getLatestBlockhash()
      ).blockhash;
      createAtaTx.feePayer = adminKeypair.publicKey;

      const createAtaTxSignature = await connection.sendTransaction(
        createAtaTx,
        [adminKeypair]
      );
      await connection.confirmTransaction(createAtaTxSignature, "confirmed");
      console.log(
        `✅ ${tokenTicker} ATA created! Transaction: ${createAtaTxSignature}`
      );
    } else {
      console.log(`✅ ${tokenTicker} ATA already exists`);
    }
  } catch (ataError) {
    console.error(`❌ Error creating ${tokenTicker} ATA:`, ataError);
    throw ataError;
  }

  // Initialize game token
  console.log(`\n🔄 Initializing ${tokenTicker} game token...`);
  const tokenInstruction = await program.methods
    .initializeToken({
      minAmount: new anchor.BN(tokenTicker === "WSOL" ? 10_000_000 : 1_000), // 0.01 SOL for WSOL, 1000 lamports for others
      enabled: true,
    })
    .accounts({
      tokenMint: mint,
      oracleOperator: adminKeypair.publicKey,
    })
    .instruction();

  const tx = await wallet.sendTransaction([tokenInstruction], [adminKeypair]);
  console.log(`✅ ${tokenTicker} game token initialized successfully!`);

  // Verify initialization
  console.log(`\n🔍 Verifying ${tokenTicker} initialization...`);
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Retry fetching the account with exponential backoff
  let gameTokenData: any = null;
  let retries = 0;
  const maxRetries = 5;

  while (retries < maxRetries) {
    try {
      gameTokenData = await program.account.gameToken.fetch(gameTokenPda);
      break;
    } catch (error: any) {
      retries++;
      if (retries === maxRetries) {
        console.error(
          `❌ Failed to verify ${tokenTicker} account after ${maxRetries} attempts`
        );
        throw error;
      }
      console.log(
        `⏳ Attempt ${retries}/${maxRetries} - ${tokenTicker} account not found, retrying in ${
          retries * 2
        } seconds...`
      );
      await new Promise((resolve) => setTimeout(resolve, retries * 2000));
    }
  }

  if (!gameTokenData) {
    throw new Error(
      `Failed to fetch ${tokenTicker} game token data after successful initialization`
    );
  }

  return {
    tokenMint,
    tokenTicker,
    gameTokenPda: gameTokenPda.toBase58(),
    gameVaultPda: gameVaultPda.toBase58(),
    gameTokenAccount: gameTokenAccount.toBase58(),
    minAmount: gameTokenData.minAmount.toString(),
    feeAmount: gameTokenData.feeAmount.toString(),
    enabled: gameTokenData.enabled,
    transaction: tx,
    alreadyExists: false,
  };
}

// ================================
// MAIN FUNCTION
// ================================

async function initializeGameToken() {
  console.log("🚀 Initializing Game Tokens (TIMBA + WSOL)...\n");

  // Connect to network
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  console.log(`✅ Connected to ${CONFIG.NETWORK}`);

  // Load admin keypair
  const adminKeypair = loadKeypair(CONFIG.ADMIN_KEYPAIR_PATH);
  console.log(`🔑 Admin keypair loaded: ${adminKeypair.publicKey.toBase58()}`);

  // Check balance
  await checkBalance(connection, adminKeypair, 0.2); // Need more SOL for multiple token initializations

  // Setup Anchor provider
  const adminWallet = new anchor.Wallet(
    adminKeypair as unknown as anchor.web3.Keypair
  );
  const provider = new anchor.AnchorProvider(
    connection as unknown as anchor.web3.Connection,
    adminWallet,
    {
      commitment: "confirmed",
    }
  );
  anchor.setProvider(provider);

  // Initialize program
  const program = new anchor.Program(
    idl as Timba,
    provider
  ) as anchor.Program<Timba>;
  console.log(`📋 Program ID: ${program.programId.toBase58()}`);

  // Create wallet manager for transaction sending
  const wallet = WalletManager.getInstance(process.env.MNEMONIC!);

  try {
    const results = [];

    // Initialize TIMBA token
    console.log("\n" + "=".repeat(50));
    console.log("🟡 INITIALIZING TIMBA TOKEN");
    console.log("=".repeat(50));

    const timbaResult = await initializeToken(
      program,
      connection,
      adminKeypair,
      wallet,
      CONFIG.TIMBA_MINT,
      CONFIG.TIMBA_TICKER
    );
    results.push(timbaResult);

    // Initialize WSOL token
    console.log("\n" + "=".repeat(50));
    console.log("🔵 INITIALIZING WSOL TOKEN");
    console.log("=".repeat(50));

    const wsolResult = await initializeToken(
      program,
      connection,
      adminKeypair,
      wallet,
      CONFIG.WSOL_MINT,
      CONFIG.WSOL_TICKER
    );
    results.push(wsolResult);

    // Display comprehensive summary
    console.log("\n" + "=".repeat(60));
    console.log("🎉 INITIALIZATION COMPLETE - SUMMARY");
    console.log("=".repeat(60));

    results.forEach((result, index) => {
      const status = result.alreadyExists
        ? "Already Existed"
        : "Newly Initialized";
      console.log(`\n${index + 1}. ${result.tokenTicker} Token [${status}]:`);
      console.log(`   • Mint: ${result.tokenMint}`);
      console.log(`   • Game Token PDA: ${result.gameTokenPda}`);
      console.log(`   • Game Vault PDA: ${result.gameVaultPda}`);

      if (!result.alreadyExists) {
        console.log(`   • Game Token Account: ${result.gameTokenAccount}`);
        console.log(`   • Min Amount: ${result.minAmount}`);
        console.log(`   • Fee Amount: ${result.feeAmount}`);
        console.log(`   • Enabled: ${result.enabled}`);
        console.log(`   • Transaction: ${result.transaction}`);
      }
    });

    // Explorer links
    console.log("\n🔗 Explorer Links:");
    results.forEach((result) => {
      if (!result.alreadyExists) {
        console.log(`\n${result.tokenTicker}:`);
        console.log(
          `• Transaction: https://solscan.io/tx/${result.transaction}?cluster=${CONFIG.NETWORK}`
        );
        console.log(
          `• Token Mint: https://solscan.io/token/${result.tokenMint}?cluster=${CONFIG.NETWORK}`
        );
        console.log(
          `• Game Token PDA: https://solscan.io/account/${result.gameTokenPda}?cluster=${CONFIG.NETWORK}`
        );
        console.log(
          `• Game Token Account: https://solscan.io/account/${result.gameTokenAccount}?cluster=${CONFIG.NETWORK}`
        );
      }
    });

    // Save initialization info
    const initInfo = {
      network: CONFIG.NETWORK,
      programId: program.programId.toBase58(),
      authority: adminKeypair.publicKey.toBase58(),
      initializedAt: new Date().toISOString(),
      tokens: results.map((result) => ({
        ticker: result.tokenTicker,
        mint: result.tokenMint,
        gameTokenPda: result.gameTokenPda,
        gameVaultPda: result.gameVaultPda,
        ...(result.alreadyExists
          ? { status: "already_existed" }
          : {
              gameTokenAccount: result.gameTokenAccount,
              minAmount: result.minAmount,
              feeAmount: result.feeAmount,
              enabled: result.enabled,
              transaction: result.transaction,
              status: "newly_initialized",
            }),
      })),
    };

    const outputPath = path.join(process.cwd(), "game-tokens-info.json");
    fs.writeFileSync(outputPath, JSON.stringify(initInfo, null, 2));
    console.log(`\n💾 Initialization info saved to ${outputPath}`);
  } catch (error: any) {
    console.error("\n❌ Error initializing game tokens:", error);

    if (error.message?.includes("already in use")) {
      console.log(
        "💡 One or more game tokens may already be initialized. Check the output above."
      );
    } else if (error.message?.includes("insufficient")) {
      console.log("💡 Make sure you have enough SOL for transaction fees.");
    } else if (error.message?.includes("signature verification failed")) {
      console.log(
        "💡 Make sure the admin keypair has the correct permissions."
      );
    }

    throw error;
  }
}

// ================================
// SCRIPT EXECUTION
// ================================

if (require.main === module) {
  initializeGameToken()
    .then(() => {
      console.log("\n✅ Game tokens initialization completed successfully!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n❌ Failed to initialize game tokens:", error);
      process.exit(1);
    });
}

export { initializeGameToken, initializeToken, CONFIG };
