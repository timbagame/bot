import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import * as anchor from "@coral-xyz/anchor";
import * as fs from 'fs';
import * as path from 'path';
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";

// ================================
// CONFIGURATION
// ================================

const CONFIG = {
  // Network configuration
  RPC_URL: process.env.SOLANA_NETWORK || 'https://api.devnet.solana.com',
  NETWORK: 'devnet' as const,

  // Token configuration
  TIMBA_MINT: 'BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4',
  TIMBA_TICKER: 'TIMBA',

  // Program configuration
  ADMIN_KEYPAIR_PATH: './admin-keypair.json'
};

// ================================
// UTILITY FUNCTIONS
// ================================

const loadKeypair = (filepath: string): Keypair => {
  try {
    const keypairData = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(keypairData));
  } catch (error) {
    throw new Error(`Failed to load keypair from ${filepath}: ${error}`);
  }
};

const checkBalance = async (connection: Connection, keypair: Keypair, minBalance: number = 0.1): Promise<void> => {
  const balance = await connection.getBalance(keypair.publicKey);
  const solBalance = balance / LAMPORTS_PER_SOL;

  console.log(`💰 Admin balance: ${solBalance.toFixed(6)} SOL`);

  if (solBalance < minBalance) {
    throw new Error(`❌ Insufficient balance. Need at least ${minBalance} SOL for transactions.`);
  }
};

// ================================
// MAIN FUNCTION
// ================================

async function initializeGameToken() {
  console.log('🚀 Initializing TIMBA Game Token...\n');

  // Connect to network
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');
  console.log(`✅ Connected to ${CONFIG.NETWORK}`);

  // Load admin keypair
  const adminKeypair = loadKeypair(CONFIG.ADMIN_KEYPAIR_PATH);
  console.log(`🔑 Admin keypair loaded: ${adminKeypair.publicKey.toBase58()}`);

  // Check balance
  await checkBalance(connection, adminKeypair);

  // Setup Anchor provider
  const adminWallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, adminWallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  // Initialize program
  const program = new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
  console.log(`📋 Program ID: ${program.programId.toBase58()}`);

  try {
    // Validate TIMBA mint
    const timbaMint = new PublicKey(CONFIG.TIMBA_MINT);
    console.log(`🪙 TIMBA Mint: ${timbaMint.toBase58()}`);

    // Check if token mint exists
    const mintAccount = await connection.getAccountInfo(timbaMint);
    if (!mintAccount) {
      throw new Error(`❌ Token mint ${CONFIG.TIMBA_MINT} does not exist on ${CONFIG.NETWORK}`);
    }
    console.log('✅ Token mint verified');

    // Derive game token PDA
    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), timbaMint.toBuffer()],
      program.programId
    );
    console.log(`🎯 Game Token PDA: ${gameTokenPda.toBase58()}`);

    // Derive game vault PDA
    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), timbaMint.toBuffer()],
      program.programId
    );
    console.log(`🏦 Game Vault PDA: ${gameVaultPda.toBase58()}`);

    // Check if game token already exists
    try {
      const existingGameToken = await program.account.gameToken.fetch(gameTokenPda);
      console.log('⚠️  Game token already exists!');
      console.log(`   Min Amount: ${existingGameToken.minAmount.toString()}`);
      console.log(`   Fee Amount: ${existingGameToken.feeAmount.toString()}`);
      console.log(`   Enabled: ${existingGameToken.enabled}`);
      console.log(`   Initialized: ${new Date().toISOString()}`);
      return;
    } catch (error: any) {
      // Check if account exists but has incompatible structure
      const accountInfo = await connection.getAccountInfo(gameTokenPda);
      if (accountInfo) {
        console.log('⚠️  GameToken account exists but has incompatible structure (likely from old contract version)');
        console.log(`   Account Owner: ${accountInfo.owner.toBase58()}`);
        console.log(`   Account Data Length: ${accountInfo.data.length} bytes`);
        console.log(`   Account Lamports: ${accountInfo.lamports}`);
        console.log('\n❌ Cannot initialize new GameToken over existing account.');
        console.log('💡 You may need to:');
        console.log('   1. Close the old account first, or');
        console.log('   2. Use a migration script to update the account structure, or');
        console.log('   3. Deploy with a different program ID');
        throw new Error('GameToken account exists with incompatible structure');
      }

      // Game token doesn't exist, proceed with initialization
      console.log('📝 Game token not found, proceeding with initialization...');
    }

    // Create Associated Token Account for game vault
    const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
    const gameTokenAccount = await getAssociatedTokenAddress(
      timbaMint,
      gameVaultPda,
      true // allowOwnerOffCurve
    );
    console.log(`🏪 Game Token Account (ATA): ${gameTokenAccount.toBase58()}`);

    // Check if the ATA already exists, if not create it
    try {
      const accountInfo = await connection.getAccountInfo(gameTokenAccount);
      if (!accountInfo) {
        console.log('🔧 Creating Associated Token Account for game vault...');

        // Create the ATA instruction
        const createAtaIx = createAssociatedTokenAccountInstruction(
          adminKeypair.publicKey, // payer
          gameTokenAccount, // ata
          gameVaultPda, // owner
          timbaMint // mint
        );

        // Send the ATA creation transaction
        const { Transaction } = await import('@solana/web3.js');
        const createAtaTx = new Transaction().add(createAtaIx);
        createAtaTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        createAtaTx.feePayer = adminKeypair.publicKey;

        const createAtaTxSignature = await connection.sendTransaction(createAtaTx, [adminKeypair]);
        await connection.confirmTransaction(createAtaTxSignature, 'confirmed');
        console.log(`✅ ATA created! Transaction: ${createAtaTxSignature}`);
      } else {
        console.log('✅ ATA already exists');
      }
    } catch (ataError) {
      console.error('❌ Error creating ATA:', ataError);
      throw ataError;
    }

    // Initialize game token
    console.log('\n🔄 Initializing game token...');
    const tx = await program.methods
      .initializeToken({
        minAmount: new anchor.BN(1_000), // Minimum amount in lamports (0.001 token)
        enabled: true // Enabled
      })
      .accounts({
        tokenMint: timbaMint,
        authority: adminKeypair.publicKey,
      })
      .signers([adminKeypair])
      .rpc();

    console.log(`✅ Game token initialized successfully!`);
    console.log(`📝 Transaction: ${tx}`);

    // Verify initialization
    console.log('\n🔍 Verifying initialization...');
    const gameTokenData = await program.account.gameToken.fetch(gameTokenPda);

    console.log('\n🎉 Game Token Details:');
    console.log('=====================================');
    console.log(`Token Mint: ${CONFIG.TIMBA_MINT}`);
    console.log(`Min Amount: ${gameTokenData.minAmount.toString()}`);
    console.log(`Fee Amount: ${gameTokenData.feeAmount.toString()}`);
    console.log(`Enabled: ${gameTokenData.enabled}`);
    console.log(`Game Token PDA: ${gameTokenPda.toBase58()}`);
    console.log(`Authority: ${adminKeypair.publicKey.toBase58()}`);
    console.log(`Network: ${CONFIG.NETWORK}`);
    console.log(`Initialized at: ${new Date().toISOString()}`);

    // Display summary
    console.log('\n📋 Summary:');
    console.log(`• Token: ${CONFIG.TIMBA_TICKER}`);
    console.log(`• Mint: ${CONFIG.TIMBA_MINT}`);
    console.log(`• Game Token PDA: ${gameTokenPda.toBase58()}`);
    console.log(`• Game Token Account (ATA): ${gameTokenAccount.toBase58()}`);
    console.log(`• Transaction: ${tx}`);

    console.log('\n🔗 Explorer Links:');
    console.log(`• Transaction: https://solscan.io/tx/${tx}?cluster=${CONFIG.NETWORK}`);
    console.log(`• Token Mint: https://solscan.io/token/${CONFIG.TIMBA_MINT}?cluster=${CONFIG.NETWORK}`);
    console.log(`• Game Token PDA: https://solscan.io/account/${gameTokenPda.toBase58()}?cluster=${CONFIG.NETWORK}`);
    console.log(`• Game Token Account: https://solscan.io/account/${gameTokenAccount.toBase58()}?cluster=${CONFIG.NETWORK}`);

    // Save initialization info
    const initInfo = {
      tokenMint: CONFIG.TIMBA_MINT,
      tokenTicker: CONFIG.TIMBA_TICKER,
      gameTokenPda: gameTokenPda.toBase58(),
      authority: adminKeypair.publicKey.toBase58(),
      transaction: tx,
      network: CONFIG.NETWORK,
      initializedAt: new Date().toISOString()
    };

    const outputPath = path.join(process.cwd(), 'timba-game-token-info.json');
    fs.writeFileSync(outputPath, JSON.stringify(initInfo, null, 2));
    console.log(`\n💾 Initialization info saved to ${outputPath}`);

  } catch (error: any) {
    console.error('\n❌ Error initializing game token:', error);

    if (error.message?.includes('already in use')) {
      console.log('💡 The game token may already be initialized. Run the script again to verify.');
    } else if (error.message?.includes('insufficient')) {
      console.log('💡 Make sure you have enough SOL for transaction fees.');
    } else if (error.message?.includes('signature verification failed')) {
      console.log('💡 Make sure the admin keypair has the correct permissions.');
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
      console.log('\n✅ TIMBA game token initialization completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Failed to initialize TIMBA game token:', error);
      process.exit(1);
    });
}

export { initializeGameToken, CONFIG };
