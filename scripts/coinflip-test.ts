import { WalletManager } from "../src/utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { Connection, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { randomBytes } from "crypto";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT
} from "@solana/spl-token";
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";
import { GameDatabase } from "../src/utils/database";
import type { GameData } from "../src/types/database";

const TOKEN_MINT = process.env.TOKEN_MINT!;
const TICKER = process.env.TICKER!;
const SOLANA_NETWORK = process.env.SOLANA_NETWORK!;

// Test users
const user1TelegramId = BigInt(123456789);
const user2TelegramId = BigInt(987654321);

// Initialize wallet manager and database
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
const gameDb = GameDatabase.getInstance();

// Program and connection variables
let program: anchor.Program<Coinflip>;
let connection: Connection;

// Initialize Anchor provider and program
const initializeAnchorProvider = async () => {
  const adminKeypair = await wallet.getAdminKeypair();
  const adminWallet = new anchor.Wallet(adminKeypair);
  connection = new Connection(SOLANA_NETWORK, "confirmed");

  const provider = new anchor.AnchorProvider(
    connection,
    adminWallet,
    { commitment: "confirmed" }
  );

  anchor.setProvider(provider);
  return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
};

// Helper function to get player balance
const getPlayerBalance = async (telegramId: bigint) => {
  const solBalance = await wallet.getBalance(telegramId);
  const tokenBalance = await wallet.getTokenBalance(telegramId, TOKEN_MINT);
  const pubkey = (await wallet.getPublicKey(telegramId)).toBase58();

  console.log(`\n=== User ${telegramId} balance ===`);
  console.log(`Address: ${pubkey}`);
  console.log(`SOL: ${wallet.formatSolBalance(solBalance)}`);
  console.log(`${TICKER}: ${wallet.formatTokenBalance(tokenBalance, 9)}`);

  return { solBalance, tokenBalance, pubkey };
};

// Helper function to ensure a player has a balance PDA
const ensurePlayerBalance = async (playerKeypair: anchor.web3.Keypair) => {
  const [playerBalancePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player_balance"), playerKeypair.publicKey.toBuffer(), new PublicKey(TOKEN_MINT).toBuffer()],
    program.programId
  );

  try {
    await program.account.playerBalance.fetch(playerBalancePda);
    console.log(`Player balance already exists for ${playerKeypair.publicKey.toBase58()}`);
  } catch (error) {
    console.log(`Creating player balance for ${playerKeypair.publicKey.toBase58()}`);

    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializePlayerBalance()
        .accounts({
          gameToken: gameTokenPda,
          player: playerKeypair.publicKey,
        })
        .signers([playerKeypair])
        .rpc();

      console.log("Player balance created successfully");
    } catch (error) {
      console.error(`Error creating player balance: ${error}`);
      throw error;
    }
  }

  return playerBalancePda;
};

// Helper function to ensure a player has a token account
const ensureTokenAccount = async (playerKeypair: anchor.web3.Keypair) => {
  const tokenMint = new PublicKey(TOKEN_MINT);
  const tokenAccount = await getAssociatedTokenAddress(
    tokenMint,
    playerKeypair.publicKey
  );

  try {
    await connection.getTokenAccountBalance(tokenAccount);
    console.log(`Token account already exists for ${playerKeypair.publicKey.toBase58()}`);
  } catch (error) {
    console.log(`Creating token account for ${playerKeypair.publicKey.toBase58()}`);

    // Create a transaction to create the token account and fund it
    const transaction = new Transaction();

    transaction.add(
      createAssociatedTokenAccountInstruction(
        playerKeypair.publicKey,
        tokenAccount,
        playerKeypair.publicKey,
        tokenMint
      )
    );

    // Add 1 SOL to convert to WSOL
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: playerKeypair.publicKey,
        toPubkey: tokenAccount,
        lamports: LAMPORTS_PER_SOL,
      })
    );

    // Sync native instruction to update token balance
    transaction.add(createSyncNativeInstruction(tokenAccount));

    const txSignature = await connection.sendTransaction(transaction, [playerKeypair]);
    await connection.confirmTransaction(txSignature);
    console.log(`Token account created and funded with 1 WSOL for ${playerKeypair.publicKey.toBase58()}`);
  }

  return tokenAccount;
};

// Add a new helper function to ensure admin's playerBalance and token accounts exist
const ensureAdminPlayerBalance = async (adminKeypair: anchor.web3.Keypair) => {
  // First make sure admin has a token account
  const adminTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(TOKEN_MINT),
    adminKeypair.publicKey
  );

  try {
    await connection.getTokenAccountBalance(adminTokenAccount);
    console.log(`Admin token account already exists: ${adminTokenAccount.toBase58()}`);
  } catch (error) {
    console.log(`Creating token account for Oracle authority: ${adminTokenAccount.toBase58()}`);

    // Create a transaction to create the token account
    const transaction = new Transaction();

    transaction.add(
      createAssociatedTokenAccountInstruction(
        adminKeypair.publicKey,
        adminTokenAccount,
        adminKeypair.publicKey,
        new PublicKey(TOKEN_MINT)
      )
    );

    // If token is WSOL, fund it with a small amount
    if (TOKEN_MINT === NATIVE_MINT.toBase58()) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: adminKeypair.publicKey,
          toPubkey: adminTokenAccount,
          lamports: LAMPORTS_PER_SOL * 0.01, // Small amount to convert to WSOL
        })
      );

      // Sync native instruction to update token balance
      transaction.add(createSyncNativeInstruction(adminTokenAccount));
    }

    const txSignature = await connection.sendTransaction(transaction, [adminKeypair]);
    await connection.confirmTransaction(txSignature);
    console.log(`Created and funded admin token account: ${adminTokenAccount.toBase58()}`);
  }

  // Now ensure player balance account exists
  const [playerBalancePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player_balance"), adminKeypair.publicKey.toBuffer(), new PublicKey(TOKEN_MINT).toBuffer()],
    program.programId
  );

  try {
    await program.account.playerBalance.fetch(playerBalancePda);
    console.log(`Admin player balance account already exists: ${playerBalancePda.toBase58()}`);
  } catch (error) {
    console.log(`Creating player balance account for Oracle authority (for fee collection): ${playerBalancePda.toBase58()}`);

    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .initializePlayerBalance()
        .accounts({
          gameToken: gameTokenPda,
          player: adminKeypair.publicKey,
        })
        .signers([adminKeypair])
        .rpc();

      console.log("Admin player balance account created for fee collection");
    } catch (error) {
      console.error(`Error creating admin player balance account: ${error}`);
      throw error;
    }
  }

  return playerBalancePda;
};

// Function to create a coinflip game
const createCoinflipGame = async (creatorTelegramId: bigint, amount: number) => {
  console.log(`\n=== User ${creatorTelegramId} creating a coinflip game for ${amount} tokens ===`);

  // Get creator keypair
  const playerKp = await wallet.getKeyPair(creatorTelegramId);
  console.log(`Creator public key: ${playerKp.publicKey.toBase58()}`);

  // Check token balance
  const tokenBalance = await wallet.getTokenBalance(creatorTelegramId, TOKEN_MINT);
  console.log(`Creator balance: ${wallet.formatTokenBalance(tokenBalance, 9)} ${TICKER}`);

  if (tokenBalance < amount) {
    console.log(`Insufficient balance: ${tokenBalance} < ${amount}`);
    return null;
  }

  // Generate a 64-byte random key
  const secretKey = randomBytes(64);
  console.log(`Generated secret key (${secretKey.length} bytes): ${secretKey.toString('hex')}`);

  // Hash the 64-byte key to create a 32-byte hash for PDA derivation
  const crypto = require('crypto');
  const randomHash = crypto.createHash('sha256').update(secretKey).digest();
  console.log(`Hash for game seed (${randomHash.length} bytes): ${randomHash.toString('hex')}`);

  // Get program addresses using the 32-byte hash
  const [gamePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game"), randomHash],
    program.programId
  );

  console.log(`Game PDA: ${gamePda.toBase58()}`);

  // Ensure player has balance PDA
  const playerBalancePda = await ensurePlayerBalance(playerKp);

  const [oraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("oracle")],
    program.programId
  );

  const [gameTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), new PublicKey(TOKEN_MINT).toBuffer()],
    program.programId
  );

  const [gameVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_vault"), new PublicKey(TOKEN_MINT).toBuffer()],
    program.programId
  );

  // Ensure token account exists
  const playerTokenAccount = await ensureTokenAccount(playerKp);

  const gameTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(TOKEN_MINT),
    gameVaultPda,
    true
  );

  console.log("Initializing game...");

  try {
    // Call the contract to create the game
    const tx = await program.methods
      .initializeGame(
        { coinflip: {} }, // Choose Coinflip game type
        new anchor.BN(amount), // Amount as BN
        2,               // Max players
        2,               // Min players
        3600,            // Timeout (1 hour)
        false,           // Not private
        [...randomHash]  // Use the 32-byte hash for initialization
      )
      .accounts({
        player: playerKp.publicKey,
        playerBalance: playerBalancePda,
        oracle: oraclePda,
        gameToken: gameTokenPda,
        playerTokenAccount: playerTokenAccount,
        gameTokenAccount: gameTokenAccount,
      })
      .signers([playerKp])
      .rpc();

    console.log(`Game created! Transaction: ${tx}`);

    // Save the ORIGINAL 64-byte key in the database
    gameDb.saveGame(
      gamePda.toBase58(),
      creatorTelegramId.toString(),
      secretKey.toString('hex'), // Store the original 64-byte key
      amount
    );

    console.log(`Saved to database: ${gamePda.toBase58()}, secret key length: ${secretKey.toString('hex').length / 2} bytes`);

    // Give time for transaction to be confirmed and indexed
    console.log("Waiting 5 seconds for game creation to be confirmed...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify game was created
    try {
      const gameAccount = await program.account.game.fetch(gamePda);
      console.log(`Game status: ${Object.keys(gameAccount.status)[0]}`);
      console.log(`Game amount: ${gameAccount.amount.toString()}`);
      console.log(`Game players: ${gameAccount.players.length}`);
      return { gamePda, secretKey }; // Return both the PDA and the original 64-byte key
    } catch (error) {
      console.error(`Error fetching newly created game: ${error}`);
      return null;
    }
  } catch (error) {
    console.error(`Error creating game: ${error}`);
    return null;
  }
};

// Function to join a coinflip game
const joinGame = async (joinerTelegramId: bigint, gamePda: PublicKey) => {
  console.log(`\n=== User ${joinerTelegramId} joining game ${gamePda.toBase58()} ===`);

  // Get joiner keypair
  const playerKp = await wallet.getKeyPair(joinerTelegramId);
  console.log(`Joiner public key: ${playerKp.publicKey.toBase58()}`);

  try {
    // Fetch game to verify it exists and is active
    const gameAccount = await program.account.game.fetch(gamePda);

    // Check if game is active
    if (Object.keys(gameAccount.status)[0] !== 'active') {
      console.log(`This game is ${Object.keys(gameAccount.status)[0]}, not active.`);
      return false;
    }

    // Check if user is already in the game
    const players = gameAccount.players;
    if (players.some((player: PublicKey) => player.equals(playerKp.publicKey))) {
      console.log("You have already joined this game.");
      return false;
    }

    // Check if game is full
    if (players.length >= gameAccount.maxPlayers) {
      console.log("This game is already full.");
      return false;
    }

    // Check user balance
    const tokenBalance = await wallet.getTokenBalance(joinerTelegramId, TOKEN_MINT);
    const gameAmount = Number(gameAccount.amount);
    console.log(`Joiner balance: ${wallet.formatTokenBalance(tokenBalance, 9)} ${TICKER}`);
    console.log(`Game amount: ${wallet.formatTokenBalance(gameAmount, 9)} ${TICKER}`);

    if (tokenBalance < gameAmount) {
      console.log(`Insufficient balance: ${tokenBalance} < ${gameAmount}`);
      return false;
    }

    // Ensure player has balance PDA
    const playerBalancePda = await ensurePlayerBalance(playerKp);

    const [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle")],
      program.programId
    );

    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    // Ensure token account exists
    const playerTokenAccount = await ensureTokenAccount(playerKp);

    const gameTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(TOKEN_MINT),
      gameVaultPda,
      true
    );

    console.log("Joining game...");

    // Call the contract to join the game
    const tx = await program.methods
      .joinGame()
      .accounts({
        game: gamePda,
        player: playerKp.publicKey,
        playerBalance: playerBalancePda,
        oracle: oraclePda,
        gameToken: gameTokenPda,
        playerTokenAccount: playerTokenAccount,
        gameTokenAccount: gameTokenAccount,
      })
      .signers([playerKp])
      .rpc();

    console.log(`Joined game! Transaction: ${tx}`);

    // Wait for join to be confirmed
    console.log("Waiting 5 seconds for game join to be confirmed...");
    await new Promise(resolve => setTimeout(resolve, 5000));

    return true;
  } catch (error) {
    console.error(`Error joining game: ${error}`);
    return false;
  }
};

// Function to complete a game with either a GameData object or a gamePda + secretKey
const completeGame = async (gamePdaOrData: PublicKey | GameData, secretKeyBuf?: Buffer) => {
  let gamePda: PublicKey;
  let secretKeyBuffer: Buffer;

  // Handle both calling patterns
  if (gamePdaOrData instanceof PublicKey) {
    console.log(`\n=== Completing coinflip game: ${gamePdaOrData.toBase58()} ===`);
    gamePda = gamePdaOrData;

    if (!secretKeyBuf) {
      // Try to get from database
      const gameData = gameDb.getGame(gamePda.toBase58());
      if (!gameData) {
        console.error(`Game data not found for ${gamePda.toBase58()}`);
        return { success: false, error: "Game data not found" };
      }
      secretKeyBuffer = Buffer.from(gameData.secret_key, "hex");
    } else {
      secretKeyBuffer = secretKeyBuf;
    }
  } else {
    // Handle GameData parameter
    console.log(`\n=== Completing coinflip game: ${gamePdaOrData.game_address} ===`);
    gamePda = new PublicKey(gamePdaOrData.game_address);
    secretKeyBuffer = Buffer.from(gamePdaOrData.secret_key, "hex");
  }

  console.log(`Secret key buffer length: ${secretKeyBuffer.length} bytes`);
  console.log(`Secret key (hex): ${secretKeyBuffer.toString('hex')}`);

  try {
    // Get the admin keypair from JSON file
    const adminKp = await wallet.getAdminKeypair();
    console.log(`Admin public key: ${adminKp.publicKey.toBase58()}`);

    // Hash the 64-byte key to create a 32-byte hash for PDA verification
    const crypto = require('crypto');
    const randomHash = crypto.createHash('sha256').update(secretKeyBuffer).digest();
    console.log(`Hash for verification (${randomHash.length} bytes): ${randomHash.toString('hex')}`);

    // Verify PDA derivation with the hash of the 64-byte key
    const [derivedGamePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game"), randomHash],
      program.programId
    );

    console.log(`Derived game PDA: ${derivedGamePda.toBase58()}`);
    console.log(`Does it match our game PDA? ${derivedGamePda.equals(gamePda)}`);

    // Get all the required PDAs for the transaction
    const [oraclePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle")],
      program.programId
    );

    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    // Verify if the admin is indeed the oracle authority
    try {
      const oracleAccount = await program.account.oracle.fetch(oraclePda);
      console.log(`Oracle authority: ${oracleAccount.authority.toBase58()}`);
      console.log(`Admin public key: ${adminKp.publicKey.toBase58()}`);
      console.log(`Is admin the oracle authority? ${oracleAccount.authority.equals(adminKp.publicKey)}`);
    } catch (error) {
      console.error(`Error fetching oracle account: ${error}`);
      return { success: false, error };
    }

    // Fetch the game account to check its status and get the players
    let gameAccount;
    try {
      gameAccount = await program.account.game.fetch(gamePda);
      console.log(`Game status: ${Object.keys(gameAccount.status)[0]}`);
      console.log(`Game amount: ${gameAccount.amount.toString()}`);
      console.log(`Game players: ${gameAccount.players.length}`);

      // Check if the game is already completed
      if (Object.keys(gameAccount.status)[0] !== 'active') {
        console.log(`Game is not active, cannot complete. Current status: ${Object.keys(gameAccount.status)[0]}`);
        return { success: false, error: "Game not active" };
      }
    } catch (error) {
      console.error(`Error fetching game account: ${error}`);
      return { success: false, error };
    }

    // Calculate the winner using the same algorithm as the contract
    let winnerIndex = 0;
    const nPlayers = gameAccount.players.length;

    if (nPlayers > 1) {
      // Get the first 8 bytes of the secret key
      const randomBytes = secretKeyBuffer.subarray(0, 8);
      // Convert to a u64 (little-endian)
      const randomNumber = BigInt('0x' + Buffer.from(randomBytes).reverse().toString('hex'));
      const maxValid = BigInt('0xFFFFFFFFFFFFFFFF') - (BigInt('0xFFFFFFFFFFFFFFFF') % BigInt(nPlayers));
      const finalNumber = randomNumber % maxValid;
      winnerIndex = Number(finalNumber % BigInt(nPlayers));
    }

    const winnerBalancePda = gameAccount.players[winnerIndex];
    console.log(`Calculated winner: ${winnerBalancePda.toBase58()} (index ${winnerIndex})`);

    console.log(`Winner player balance PDA: ${winnerBalancePda.toBase58()}`);

    // Ensure the admin's player balance PDA exists (for fee collection)
    await ensureAdminPlayerBalance(adminKp);

    // Convert Buffer to array for the transaction
    // Use the FULL 64-byte key here, as the program expects
    const secretKeyArray = Array.from(secretKeyBuffer);

    // Complete the game by calling the contract
    console.log(`Completing game with secret key of length ${secretKeyArray.length} bytes...`);
    const tx = await program.methods
      .completeGame(secretKeyArray) // Use the full 64-byte key
      .accounts({
        game: gamePda,
        oracle: oraclePda,
        authority: adminKp.publicKey,
        playerBalance: winnerBalancePda, // Pass the winner's player balance instead of admin's
        gameToken: gameTokenPda,
      })
      .signers([adminKp])
      .rpc();

    console.log(`Game completed successfully! Transaction: ${tx}`);

    // Fetch completed game to see winner
    const completedGameAccount = await program.account.game.fetch(gamePda);
    const winnerPubkeyStr = completedGameAccount.winner.toString();

    console.log(`Game status after completion: ${Object.keys(completedGameAccount.status)[0]}`);
    console.log(`Winner: ${winnerPubkeyStr}`);

    // Update game in database
    gameDb.completeGame(gamePda.toBase58(), winnerPubkeyStr);

    return { success: true, winnerPubkey: winnerPubkeyStr };
  } catch (error) {
    console.error(`Error completing game: ${error}`);
    return { success: false, error };
  }
};

// Function to claim winnings
const claimWinnings = async (telegramId: bigint) => {
  console.log(`\n=== User ${telegramId} claiming winnings ===`);

  // Get player keypair
  const playerKp = await wallet.getKeyPair(telegramId);

  try {
    // Get program addresses
    const [playerBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player_balance"), playerKp.publicKey.toBuffer(), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    // Get player balance
    const playerBalance = await program.account.playerBalance.fetch(playerBalancePda);
    const claimableAmount = Number(playerBalance.amount);

    if (claimableAmount <= 0) {
      console.log(`No winnings to claim. Current game balance is 0 ${TICKER}.`);
      return false;
    }

    console.log(`Claimable amount: ${wallet.formatTokenBalance(claimableAmount, 9)} ${TICKER}`);

    const [gameTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_token"), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    const [gameVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("game_vault"), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    // Ensure token account exists
    const playerTokenAccount = await ensureTokenAccount(playerKp);

    // Get game's token account
    const gameTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(TOKEN_MINT),
      gameVaultPda,
      true
    );

    console.log("Claiming winnings...");

    // Call the contract to claim the win
    const tx = await program.methods
      .claimWin()
      .accounts({
        playerBalance: playerBalancePda,
        player: playerKp.publicKey,
        gameToken: gameTokenPda,
        playerTokenAccount: playerTokenAccount,
        gameTokenAccount: gameTokenAccount,
        gameVault: gameVaultPda,
      })
      .signers([playerKp])
      .rpc();

    console.log(`Winnings claimed! Transaction: ${tx}`);
    return true;
  } catch (error) {
    console.error(`Error claiming winnings: ${error}`);
    return false;
  }
};

// Main test function
const runTest = async () => {
  console.log("=== Starting Coinflip Test ===");
  console.log("Initializing Anchor program...");

  try {
    program = await initializeAnchorProvider();
    console.log(`Program ID: ${program.programId.toBase58()}`);

    // Check initial balances
    await getPlayerBalance(user1TelegramId);
    await getPlayerBalance(user2TelegramId);

    // Set game amount based on game token minimum
    const amount = 10_000_000; // 10 WSOL as configured in the game token

    // Step 1: User 1 creates a coinflip game
    console.log("\nStep 1: Creating Coinflip game...");
    const result = await createCoinflipGame(user1TelegramId, amount);
    if (!result) {
      console.log("❌ Failed to create game. Test aborted.");
      return;
    }

    const { gamePda, secretKey } = result;

    // Step 2: User 2 joins the game
    console.log("\nStep 2: Joining the game...");
    const joined = await joinGame(user2TelegramId, gamePda);
    if (!joined) {
      console.log("❌ Failed to join game. Test aborted.");
      return;
    }

    // Step 3: Complete the game
    console.log("\nStep 3: Completing the game...");
    const completed = await completeGame(gamePda, secretKey);
    if (!completed.success) {
      console.log("❌ Failed to complete game. Test aborted.");
      return;
    }

    // Step 4: Check balances after game
    console.log("\nStep 4: Checking balances after game completion...");
    await getPlayerBalance(user1TelegramId);
    await getPlayerBalance(user2TelegramId);

    // Step 5: Claim winnings (determine winner)
    console.log("\nStep 5: Claiming winnings...");
    console.log("Attempting to claim winnings for both players (only winner should succeed):");

    const user1Pubkey = (await wallet.getPublicKey(user1TelegramId)).toString();
    const user2Pubkey = (await wallet.getPublicKey(user2TelegramId)).toString();

    const isUser1Winner = completed.winnerPubkey === user1Pubkey;
    const isUser2Winner = completed.winnerPubkey === user2Pubkey;

    if (isUser1Winner) {
      console.log("User 1 was the winner!");
    } else if (isUser2Winner) {
      console.log("User 2 was the winner!");
    } else {
      console.log("Unknown winner...");
    }

    await claimWinnings(user1TelegramId);
    await claimWinnings(user2TelegramId);

    // Step 6: Check final balances
    console.log("\nStep 6: Checking final balances...");
    await getPlayerBalance(user1TelegramId);
    await getPlayerBalance(user2TelegramId);

    console.log("\n✅ Test completed successfully!");
  } catch (error) {
    console.error("Error during test:", error);
    console.log("❌ Test failed.");
  }
};

// Run the test
runTest().catch(console.error);
