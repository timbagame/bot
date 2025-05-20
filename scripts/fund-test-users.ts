import { WalletManager } from "../src/utils/wallet";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress, NATIVE_MINT, createSyncNativeInstruction, getAccount } from "@solana/spl-token";

const TOKEN_MINT = process.env.TOKEN_MINT!;
const SOLANA_NETWORK = process.env.SOLANA_NETWORK!;

// Test users
const user1TelegramId = BigInt(123456789);
const user2TelegramId = BigInt(987654321);

// Initialize wallet manager
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);

// Function to airdrop SOL to a wallet
const airdropSol = async (connection: Connection, address: PublicKey, amount: number = 1) => {
  try {
    console.log(`Airdropping ${amount} SOL to ${address.toBase58()}...`);
    const signature = await connection.requestAirdrop(address, amount * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature);
    const balance = await connection.getBalance(address);
    console.log(`New SOL balance: ${balance / LAMPORTS_PER_SOL}`);
    return true;
  } catch (error) {
    console.error(`Error airdropping SOL: ${error}`);
    return false;
  }
};

// Function to fund a WSOL account
const fundWsol = async (connection: Connection, senderKp: Keypair, userAddress: PublicKey, amount: number) => {
  try {
    // Verify TOKEN_MINT is the native mint
    const tokenMint = new PublicKey(TOKEN_MINT);
    const nativeMint = NATIVE_MINT;

    if (!tokenMint.equals(nativeMint)) {
      console.log("TOKEN_MINT is not the native WSOL mint. This function only works for WSOL.");
      return false;
    }

    // Get the user's associated token account for WSOL
    const userAta = await getAssociatedTokenAddress(
      tokenMint,
      userAddress
    );

    // Check if the token account exists
    const userAtaInfo = await connection.getAccountInfo(userAta);

    // Create a transaction to handle the WSOL funding
    let transaction = new Transaction();

    // If the account doesn't exist, create it
    if (!userAtaInfo) {
      console.log(`Creating WSOL account for ${userAddress.toBase58()}...`);
      transaction.add(
        createAssociatedTokenAccountInstruction(
          senderKp.publicKey, // Payer
          userAta, // Associated token account address
          userAddress, // Owner
          tokenMint // Mint
        )
      );
    }

    // Check sender's SOL balance
    const senderBalance = await connection.getBalance(senderKp.publicKey);
    console.log(`Sender has ${senderBalance / LAMPORTS_PER_SOL} SOL available`);

    // Calculate how much to send in this transaction
    // Make sure we're working with integers by using Math.floor
    const amountLamports = Math.floor(amount);
    const amountToSend = Math.min(amountLamports, Math.floor(senderBalance - 1_000_000)); // Leave 0.001 SOL for fees

    if (amountToSend <= 0) {
      console.log("Insufficient SOL balance for funding");
      return false;
    }

    console.log(`Sending ${amountToSend / LAMPORTS_PER_SOL} SOL to WSOL account...`);

    // Send SOL to the token account
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: senderKp.publicKey,
        toPubkey: userAta,
        lamports: amountToSend,
      })
    );

    // Sync native instruction to update token balance
    transaction.add(createSyncNativeInstruction(userAta));

    // Send the transaction
    const signature = await connection.sendTransaction(transaction, [senderKp]);
    await connection.confirmTransaction(signature);

    console.log(`Successfully funded ${amountToSend / LAMPORTS_PER_SOL} WSOL to ${userAddress.toBase58()}`);
    return true;
  } catch (error) {
    console.error(`Error funding WSOL: ${error}`);
    return false;
  }
};

// Helper function to get token balance
const getTokenBalance = async (connection: Connection, userAddress: PublicKey, tokenMint: PublicKey): Promise<number> => {
  try {
    const ata = await getAssociatedTokenAddress(tokenMint, userAddress);
    try {
      const tokenAccount = await getAccount(connection, ata);
      return Number(tokenAccount.amount);
    } catch (error) {
      console.log(`Token account ${ata.toBase58()} not found for user ${userAddress.toBase58()}, returning balance 0.`);
      return 0;
    }
  } catch (error) {
    console.error(`Error getting token balance: ${error}`);
    return 0;
  }
};

// Main function to fund test users
const main = async () => {
  // Create connection to local validator
  const connection = new Connection(SOLANA_NETWORK);

  // Get test users and admin keypairs using WalletManager
  const user1Keypair = await wallet.getKeyPair(user1TelegramId);
  const user2Keypair = await wallet.getKeyPair(user2TelegramId);
  const adminKeypair = await wallet.getAdminKeypair();

  console.log(`User 1 public key: ${user1Keypair.publicKey.toBase58()}`);
  console.log(`User 2 public key: ${user2Keypair.publicKey.toBase58()}`);
  console.log(`Admin public key: ${adminKeypair.publicKey.toBase58()}`);

  // Airdrop SOL to all accounts
  console.log("Airdropping SOL to user accounts...");
  await Promise.all([
    airdropSol(connection, user1Keypair.publicKey, 10),
    airdropSol(connection, user2Keypair.publicKey, 10),
    airdropSol(connection, adminKeypair.publicKey, 50)
  ]);

  // Fund user1 with WSOL (sending from admin)
  console.log("Funding user1 with WSOL...");
  await fundWsol(connection, adminKeypair, user1Keypair.publicKey, 20 * LAMPORTS_PER_SOL);

  // Fund user2 with WSOL (sending from admin)
  console.log("Funding user2 with WSOL...");
  // Ensure user2 has at least 20 WSOL for testing
  await fundWsol(connection, adminKeypair, user2Keypair.publicKey, 20 * LAMPORTS_PER_SOL);

  // Check final balances
  console.log("\nChecking final balances...");
  const tokenMintPubkey = new PublicKey(TOKEN_MINT);

  const [user1Sol, user1Wsol] = await Promise.all([
    connection.getBalance(user1Keypair.publicKey).then(b => b / LAMPORTS_PER_SOL),
    getTokenBalance(connection, user1Keypair.publicKey, tokenMintPubkey).then(b => b / LAMPORTS_PER_SOL)
  ]);

  const [user2Sol, user2Wsol] = await Promise.all([
    connection.getBalance(user2Keypair.publicKey).then(b => b / LAMPORTS_PER_SOL),
    getTokenBalance(connection, user2Keypair.publicKey, tokenMintPubkey).then(b => b / LAMPORTS_PER_SOL)
  ]);

  console.log(`User 1: ${user1Sol} SOL, ${user1Wsol} WSOL`);
  console.log(`User 2: ${user2Sol} SOL, ${user2Wsol} WSOL`);

  // For the coinflip test, we need at least 10 WSOL each
  const requiredWsol = 10;
  if (user1Wsol < requiredWsol || user2Wsol < requiredWsol) {
    console.warn(`\n⚠️ WARNING: One or both users do not have enough WSOL for the coinflip test (need ${requiredWsol} WSOL each)`);
  } else {
    console.log(`\n✅ Both users have sufficient WSOL (${requiredWsol} WSOL each) for testing!`);
  }
};

// Run the fund function
main().catch(console.error);
