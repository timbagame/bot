import { Bot, Context } from "grammy";
import { WalletManager } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, createSyncNativeInstruction } from "@solana/spl-token";
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";
import { GameDatabase } from "./utils/database";
import { SystemProgram } from "@solana/web3.js";
import { GameManager } from "./utils/game";

// Initialize the bot and wallet manager
const bot = new Bot(process.env.TELEGRAM_TOKEN!);
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
const TOKEN_MINT = process.env.TOKEN_MINT!;
const TICKER = process.env.TICKER!;
const LAMPORTS_PER_SOL = 1_000_000_000; // Assuming 9 decimals for SOL

// Cache for token metadata
let tokenMetadata: { decimals: number } | null = null;

// Initialize game database
const gameDb = GameDatabase.getInstance();

// Initialize Anchor with a wallet for admin operations
const initializeAnchorProvider = async () => {
  // Get admin keypair from the JSON file
  const adminKeypair = await wallet.getAdminKeypair();

  // Create a wallet adapter for Anchor
  const adminWallet = new anchor.Wallet(adminKeypair);

  // Initialize provider with connection from wallet manager
  const provider = new anchor.AnchorProvider(
    wallet.connection,
    adminWallet,
    { commitment: "confirmed" }
  );

  // Set the provider globally
  anchor.setProvider(provider);

  return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
};

// Global program variable to be initialized when needed
let program: anchor.Program<Coinflip>;
let gameManager: GameManager;

// Initialize program when bot starts
const setupAnchor = async () => {
  try {
    program = await initializeAnchorProvider();
    console.log(`Initialized Anchor program: ${program.programId}`);

    // Initialize game manager
    gameManager = GameManager.getInstance(program, wallet, gameDb, TOKEN_MINT, TICKER);

    // Check if Oracle is already initialized
    try {
      const [oraclePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("oracle")],
        program.programId
      );

      const oracleAccount = await program.account.oracle.fetch(oraclePda);
      console.log(`Oracle found, authority: ${oracleAccount.authority.toString()}`);
    } catch (error) {
      console.log("Oracle not found, it might need to be initialized");
    }

    // Check if game token is initialized
    try {
      const [gameTokenPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("game_token"), new PublicKey(TOKEN_MINT).toBuffer()],
        program.programId
      );

      const gameTokenAccount = await program.account.gameToken.fetch(gameTokenPda);
      console.log(`Game token found: ${gameTokenAccount.ticker}`);
    } catch (error) {
      console.log("Game token not found, it might need to be initialized");
    }
  } catch (error) {
    console.error("Error initializing Anchor program:", error);
    console.error("Make sure admin-keypair.json exists in the project root directory.");
    throw error;
  }
};

// Helper function to get token metadata
const getTokenMetadata = async () => {
  if (!tokenMetadata) {
    tokenMetadata = await wallet.getTokenMetadata(TOKEN_MINT);
  }
  return tokenMetadata;
};

// Helper function to format balance message
const formatBalanceMessage = async (playerKp: anchor.web3.Keypair, balance: any, tokenBalance: number, solBalance: number, metadata: { decimals: number }): Promise<string> => {
  let response = "💰 <b>Your Balance</b>\n\n";
  response += `Wallet Address: <code>${playerKp.publicKey.toBase58()}</code>\n`;
  response += `SOL Balance: ${wallet.formatSolBalance(solBalance)} SOL\n`;
  response += `Game Balance: ${wallet.formatTokenBalance(Number(balance.amount), metadata.decimals)} ${TICKER}\n`;
  response += `Wallet Balance: ${wallet.formatTokenBalance(tokenBalance, metadata.decimals)} ${TICKER}`;
  return response;
};

// Helper function to format error message
const formatErrorMessage = (error: any, prefix: string = "❌"): string => {
  return `${prefix} ${error.message || "Unknown error"}`;
};

// Command to display balance and wallet info
bot.command(["start", "balance"], async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  try {
    const playerKp = await wallet.getKeyPair(telegramId);
    const playerPubkey = playerKp.publicKey;
    const metadata = await getTokenMetadata();

    // Get player's balance PDA
    const [playerBalancePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("player_balance"), playerPubkey.toBuffer(), new PublicKey(TOKEN_MINT).toBuffer()],
      program.programId
    );

    // Get balances
    const balance = await program.account.playerBalance.fetch(playerBalancePda);
    const tokenBalance = await wallet.getTokenBalance(telegramId, TOKEN_MINT);
    const solBalance = await wallet.getBalance(telegramId);

    const response = await formatBalanceMessage(playerKp, balance, tokenBalance, solBalance, metadata);

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    console.error("Error in balance command:", error);
    await ctx.reply(formatErrorMessage(error), {
      reply_to_message_id: ctx.message?.message_id
    });
  }
});

// Simplified coinflip command
bot.command(["coinflip", "cf"], async (ctx) => {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(" ");
  const metadata = await getTokenMetadata();
  const amount = parseFloat(args?.[1] || "0") * Math.pow(10, metadata.decimals);
  const maxPlayers = parseInt(args?.[2] || "2") || 2;

  if (amount <= 0) {
    return ctx.reply("Usage: /coinflip <amount> <maxPlayers>\nExample: /coinflip 10 2", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  await gameManager.createGame(ctx, "coinflip", amount, maxPlayers, 2, 3600);
});

// Simplified giveaway command
bot.command("giveaway", async (ctx) => {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(" ");
  const metadata = await getTokenMetadata();
  const amount = parseFloat(args?.[1] || "0") * Math.pow(10, metadata.decimals);
  const maxPlayers = parseInt(args?.[2] || "5") || 5;

  if (amount <= 0) {
    return ctx.reply("Usage: /giveaway <amount> <maxPlayers>\nExample: /giveaway 100 5", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  await gameManager.createGame(ctx, "giveaway", amount, maxPlayers, 1, 7200);
});

// Implement withdraw command
bot.command(["withdraw", "wh"], async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 3) {
    return ctx.reply("Usage: /withdraw <address> <amount> or /withdraw <address> <amount> SOL", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  let toAddress: PublicKey;
  try {
    toAddress = new PublicKey(args[1]);
  } catch (error) {
    return ctx.reply("Invalid wallet address. Please provide a valid Solana address.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const metadata = await getTokenMetadata();
  const isSol = args[args.length - 1].toUpperCase() === "SOL";
  const amountStr = isSol ? args[2] : args[2];
  const amount = parseFloat(amountStr) * (isSol ? LAMPORTS_PER_SOL : Math.pow(10, metadata.decimals));

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply("Please provide a valid amount greater than 0.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  try {
    // Get player keypair
    const playerKp = await wallet.getKeyPair(telegramId);

    // First try to claim any winnings if not using SOL
    if (!isSol) {
      const claimableAmount = await claimWinnings(playerKp);
      if (claimableAmount > 0) {
        console.log(`Claimed ${claimableAmount} tokens from winnings`);
      }
    }

    // Check appropriate balance
    if (isSol) {
      const solBalance = await wallet.getBalance(telegramId);
      if (solBalance < amount) {
        return ctx.reply(`Insufficient SOL balance. You have ${wallet.formatSolBalance(solBalance)} SOL but are trying to withdraw ${wallet.formatSolBalance(amount)} SOL`, {
          reply_to_message_id: ctx.message?.message_id
        });
      }
    } else {
      const tokenBalance = await wallet.getTokenBalance(telegramId, TOKEN_MINT);
      if (tokenBalance < amount) {
        return ctx.reply(`Insufficient balance. You have ${wallet.formatTokenBalance(tokenBalance, metadata.decimals)} ${TICKER} but are trying to withdraw ${wallet.formatTokenBalance(amount, metadata.decimals)} ${TICKER}`, {
          reply_to_message_id: ctx.message?.message_id
        });
      }
    }

    // Send message to indicate processing
    const processingMsg = await ctx.reply(`Processing withdrawal of ${isSol ? wallet.formatSolBalance(amount) + " SOL" : wallet.formatTokenBalance(amount, metadata.decimals) + " " + TICKER}...`, {
      reply_to_message_id: ctx.message?.message_id
    });

    let tx: string;
    if (isSol) {
      // Native SOL transfer
      const transferSolIx = SystemProgram.transfer({
        fromPubkey: playerKp.publicKey,
        toPubkey: toAddress,
        lamports: amount,
      });
      tx = await wallet.signAndSend([transferSolIx], [playerKp]);
    } else {
      // WSOL transfer
      tx = await wallet.transferToken(telegramId, toAddress, amount, TOKEN_MINT);
    }

    // Update message with success
    ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      `Withdrawal successful! 💸\n\nAmount: ${isSol ? wallet.formatSolBalance(amount) + " SOL" : wallet.formatTokenBalance(amount, metadata.decimals) + " " + TICKER}\nTo: ${toAddress.toBase58().slice(0, 8)}...\n\nTransaction: ${tx}`,
      { parse_mode: "HTML" }
    );

  } catch (error: any) {
    console.error("Error processing withdrawal:", error);
    ctx.reply(`Error processing withdrawal: ${error.message || "Unknown error"}`, {
      reply_to_message_id: ctx.message?.message_id
    });
  }
});

// Implement tip command
bot.command("tip", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const replyToMessage = ctx.message?.reply_to_message;
  const args = ctx.message?.text?.split(" ");

  if (!replyToMessage || !replyToMessage.from || !args || args.length < 2) {
    return ctx.reply("Usage: Reply to a user's message with /tip <amount> or /tip <amount> SOL", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const recipientTelegramId = BigInt(replyToMessage.from.id);
  if (recipientTelegramId === telegramId) {
    return ctx.reply("You can't tip yourself!", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const metadata = await getTokenMetadata();
  const isSol = args[args.length - 1].toUpperCase() === "SOL";
  const amountStr = isSol ? args[1] : args[1];
  const amount = parseFloat(amountStr) * (isSol ? LAMPORTS_PER_SOL : Math.pow(10, metadata.decimals));

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply("Please provide a valid amount greater than 0.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  try {
    // Get player keypair
    const playerKp = await wallet.getKeyPair(telegramId);

    // First try to claim any winnings if not using SOL
    if (!isSol) {
      const claimableAmount = await claimWinnings(playerKp);
      if (claimableAmount > 0) {
        console.log(`Claimed ${claimableAmount} tokens from winnings`);
      }
    }

    // Get recipient public key
    const recipientPubKey = await wallet.getPublicKey(recipientTelegramId);

    // Check appropriate balance
    if (isSol) {
      const solBalance = await wallet.getBalance(telegramId);
      if (solBalance < amount) {
        return ctx.reply(`Insufficient SOL balance. You have ${wallet.formatSolBalance(solBalance)} SOL but are trying to tip ${wallet.formatSolBalance(amount)} SOL`, {
          reply_to_message_id: ctx.message?.message_id
        });
      }
    } else {
      const tokenBalance = await wallet.getTokenBalance(telegramId, TOKEN_MINT);
      if (tokenBalance < amount) {
        return ctx.reply(`Insufficient balance. You have ${wallet.formatTokenBalance(tokenBalance, metadata.decimals)} ${TICKER} but are trying to tip ${wallet.formatTokenBalance(amount, metadata.decimals)} ${TICKER}`, {
          reply_to_message_id: ctx.message?.message_id
        });
      }
    }

    // Send message to indicate processing
    const processingMsg = await ctx.reply(`Processing tip of ${isSol ? wallet.formatSolBalance(amount) + " SOL" : wallet.formatTokenBalance(amount, metadata.decimals) + " " + TICKER}...`, {
      reply_to_message_id: ctx.message?.message_id
    });

    let tx: string;
    if (isSol) {
      // Native SOL transfer
      const transferSolIx = SystemProgram.transfer({
        fromPubkey: playerKp.publicKey,
        toPubkey: recipientPubKey,
        lamports: amount,
      });
      tx = await wallet.signAndSend([transferSolIx], [playerKp]);
    } else {
      // WSOL transfer
      tx = await wallet.transferToken(telegramId, recipientPubKey, amount, TOKEN_MINT);
    }

    // Update message with success
    const recipientName = replyToMessage.from.first_name || "User";
    ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      `Tip sent successfully! 🎁\n\nAmount: ${isSol ? wallet.formatSolBalance(amount) + " SOL" : wallet.formatTokenBalance(amount, metadata.decimals) + " " + TICKER}\nTo: ${recipientName}\n\nTransaction: ${tx}`,
      { parse_mode: "HTML" }
    );

  } catch (error: any) {
    console.error("Error processing tip:", error);
    ctx.reply(`Error processing tip: ${error.message || "Unknown error"}`, {
      reply_to_message_id: ctx.message?.message_id
    });
  }
});

// Implement wrap command
bot.command("wrap", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const args = ctx.message?.text?.split(" ");
  const amount = parseFloat(args?.[1] || "0") * LAMPORTS_PER_SOL; // Convert to lamports

  if (amount <= 0) {
    return ctx.reply("Usage: /wrap <amount>\nExample: /wrap 0.1", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  try {
    // Check SOL balance
    const solBalance = await wallet.getBalance(telegramId);
    if (solBalance < amount) {
      return ctx.reply(`Insufficient SOL balance. You have ${wallet.formatSolBalance(solBalance)} SOL but are trying to wrap ${wallet.formatSolBalance(amount)} SOL`, {
        reply_to_message_id: ctx.message?.message_id
      });
    }

    // Get player keypair
    const playerKp = await wallet.getKeyPair(telegramId);

    // Get or create WSOL token account
    const wsolMint = new PublicKey(TOKEN_MINT);
    const { address: wsolAccount, instructions: createAtaIx } = await wallet.findOrCreateAssociatedTokenAccount(
      playerKp.publicKey,
      wsolMint,
      playerKp
    );

    // Create transfer SOL instruction
    const transferSolIx = SystemProgram.transfer({
      fromPubkey: playerKp.publicKey,
      toPubkey: wsolAccount,
      lamports: amount,
    });

    // Create sync native instruction to convert SOL to WSOL
    const syncNativeIx = createSyncNativeInstruction(wsolAccount);

    // Send message to indicate processing
    const processingMsg = await ctx.reply(`Wrapping ${wallet.formatSolBalance(amount)} SOL to WSOL...`, {
      reply_to_message_id: ctx.message?.message_id
    });

    // Combine and send instructions
    const allInstructions = [...createAtaIx, transferSolIx, syncNativeIx];
    const tx = await wallet.signAndSend(allInstructions, [playerKp]);

    // Update message with success
    ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      `Successfully wrapped ${wallet.formatSolBalance(amount)} SOL to WSOL! 💰\n\nTransaction: ${tx}`,
      { parse_mode: "HTML" }
    );

  } catch (error: any) {
    console.error("Error wrapping SOL:", error);
    ctx.reply(`Error wrapping SOL: ${error.message || "Unknown error"}`, {
      reply_to_message_id: ctx.message?.message_id
    });
  }
});

// Implement help command
bot.command("help", async (ctx: Context) => {
  ctx.reply(
    `<b>📝 Available Commands:</b>\n\n` +
    `/start, /balance - Show your wallet address and balances\n` +
    `/wrap &lt;amount&gt; - Convert SOL to WSOL\n` +
    `/coinflip &lt;amount&gt; &lt;maxPlayers&gt; - Create a new coinflip game\n` +
    `/cf &lt;amount&gt; &lt;maxPlayers&gt; - Shorthand for coinflip command\n` +
    `/giveaway &lt;amount&gt; &lt;maxPlayers&gt; - Create a new giveaway\n` +
    `/ga &lt;amount&gt; &lt;maxPlayers&gt; - Shorthand for giveaway command\n` +
    `/withdraw &lt;address&gt; &lt;amount&gt; - Withdraw tokens to external wallet\n` +
    `/wh &lt;address&gt; &lt;amount&gt; - Shorthand for withdraw command\n` +
    `/tip &lt;amount&gt; - Reply to a user's message to send them tokens\n\n` +
    `<b>ℹ️ Important:</b> Your player balance account will be automatically initialized when needed.`,
    {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    }
  );
});

// Implement games command to show all games user is participating in
bot.command("games", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);

  try {
    const { activeGames, recentGames, totalTokensInGames } = await gameManager.getUserGames(ctx, telegramId);
    const metadata = await getTokenMetadata();

    let response = "";
    let hasGames = false;

    // Combine sections
    if (activeGames) {
      response += activeGames;
      hasGames = true;
    }
    if (recentGames) {
      response += recentGames;
      hasGames = true;
    }

    if (!hasGames) {
      response += "You don't have any active or recent games.";
    }

    // Add total tokens in active games
    if (totalTokensInGames > 0) {
      response += `\n\n💰 Total tokens in active games: ${wallet.formatTokenBalance(totalTokensInGames, metadata.decimals)} ${TICKER}`;
    }

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    console.error("Error in games command:", error);
    await ctx.reply("❌ An error occurred while fetching your games. Please try again later.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }
});

// Handle callback queries for game actions
bot.on("callback_query", async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  if (!callbackData || !ctx.from) return;  // Add check for ctx.from

  if (callbackData.startsWith("join_")) {
    const gameAddress = callbackData.split("_")[1];
    const game = await gameDb.getGame(gameAddress);

    if (!game) {
      console.log("Game not found in database");
      await ctx.answerCallbackQuery("Game not found!");
      return;
    }

    if (game.status !== "active") {
      console.log(`Game status is ${game.status}, not active`);
      await ctx.answerCallbackQuery("This game is no longer active!");
      return;
    }

    try {
      // Get player keypair
      const telegramId = BigInt(ctx.from.id);
      console.log(`Processing join for Telegram ID: ${telegramId}`);
      const playerKp = await wallet.getKeyPair(telegramId);
      console.log(`Player public key: ${playerKp.publicKey.toBase58()}`);
      const metadata = await getTokenMetadata();

      // Fetch game to verify it exists and is active
      const gamePda = new PublicKey(gameAddress);
      console.log(`Fetching game account for ${gamePda.toBase58()}`);
      const gameAccount = await program.account.game.fetch(gamePda);
      console.log(`Current players in game: ${gameAccount.players.length}`);

      // Check if game is active
      const gameStatus = Object.keys(gameAccount.status)[0].toLowerCase();
      console.log(`Game status: ${gameStatus}`);
      if (gameStatus !== 'active') {
        console.log(`Game is not active, status is ${gameStatus}`);
        await ctx.answerCallbackQuery("This game is no longer active!");
        return;
      }

      // Check if user is already in the game
      const players = gameAccount.players;
      const isAlreadyInGame = players.some((p: PublicKey) => p.equals(playerKp.publicKey));
      console.log(`Player already in game: ${isAlreadyInGame}`);
      if (isAlreadyInGame) {
        await ctx.answerCallbackQuery("You have already joined this game!");
        return;
      }

      // Check if user is the creator of the game
      const isCreator = gameAccount.creator.equals(playerKp.publicKey);
      console.log(`Player is creator: ${isCreator}`);
      if (isCreator) {
        await ctx.answerCallbackQuery("You are the creator of this game!");
        return;
      }

      // Check if game is full
      console.log(`Game max players: ${gameAccount.maxPlayers}, current players: ${players.length}`);
      if (players.length >= gameAccount.maxPlayers) {
        console.log("Game is full");
        await ctx.answerCallbackQuery("This game is already full!");
        return;
      }

      // Check user balance
      const tokenBalance = await wallet.getTokenBalance(telegramId, TOKEN_MINT);
      const gameAmount = Number(gameAccount.amount);
      console.log(`Player balance: ${tokenBalance}, game amount: ${gameAmount}`);

      // Get player's game balance
      let gameBalance = 0;
      try {
        const [playerBalancePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("player_balance"), playerKp.publicKey.toBuffer(), new PublicKey(TOKEN_MINT).toBuffer()],
          program.programId
        );
        const playerBalance = await program.account.playerBalance.fetch(playerBalancePda);
        gameBalance = Number(playerBalance.amount);
      } catch (error) {
        console.log("Player balance account not found or error fetching it");
      }

      const totalBalance = tokenBalance + gameBalance;
      console.log(`Total balance (wallet + game): ${totalBalance}`);

      if (totalBalance < gameAmount) {
        await ctx.answerCallbackQuery(`Insufficient balance. You have ${wallet.formatTokenBalance(tokenBalance, metadata.decimals)} ${TICKER} in wallet and ${wallet.formatTokenBalance(gameBalance, metadata.decimals)} ${TICKER} in game balance (total: ${wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${TICKER}) but the game requires ${wallet.formatTokenBalance(gameAmount, metadata.decimals)} ${TICKER}`);
        return;
      }

      console.log("All checks passed, proceeding with join transaction");

      // Ensure player has balance PDA
      const playerBalancePda = await gameManager.ensurePlayerBalance(playerKp);
      console.log(`Player balance PDA: ${playerBalancePda.toBase58()}`);

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

      // Get token accounts
      const playerTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(TOKEN_MINT),
        playerKp.publicKey
      );
      const gameTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(TOKEN_MINT),
        gameVaultPda,
        true
      );

      console.log("Sending join transaction...");
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

      console.log(`Join transaction sent: ${tx}`);

      // Wait for transaction confirmation with retries
      console.log("Waiting for transaction confirmation...");
      let retries = 3;
      let confirmed = false;
      while (retries > 0 && !confirmed) {
        try {
          const confirmation = await wallet.connection.confirmTransaction(tx);
          if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${confirmation.value.err}`);
          }
          confirmed = true;
        } catch (error) {
          console.error(`Confirmation attempt ${4 - retries} failed:`, error);
          retries--;
          if (retries > 0) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between retries
          }
        }
      }

      if (!confirmed) {
        throw new Error("Failed to confirm transaction after multiple attempts");
      }
      console.log("Transaction confirmed");

      // Verify player was added to the game with retries
      console.log("Verifying player was added to game...");
      retries = 3;
      let playerWasAdded = false;
      let updatedGameAccount: any;
      while (retries > 0 && !playerWasAdded) {
        try {
          updatedGameAccount = await program.account.game.fetch(gamePda);
          console.log(`Current players in game: ${updatedGameAccount.players.length}`);
          console.log(`Player balance PDA to check: ${playerBalancePda.toBase58()}`);
          console.log("Current players in game:");
          updatedGameAccount.players.forEach((p: PublicKey) => {
            console.log(`- ${p.toBase58()}`);
          });

          playerWasAdded = updatedGameAccount.players.some((p: PublicKey) => {
            const isAdded = p.equals(playerBalancePda);
            console.log(`Checking player balance PDA ${p.toBase58()} against ${playerBalancePda.toBase58()}: ${isAdded}`);
            return isAdded;
          });

          if (!playerWasAdded) {
            console.log(`Verification attempt ${4 - retries} failed: Player not found in game`);
            retries--;
            if (retries > 0) {
              console.log("Waiting 2 seconds before next verification attempt...");
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between retries
            }
          } else {
            console.log("Player was successfully verified in the game!");
          }
        } catch (error) {
          console.error(`Verification attempt ${4 - retries} failed with error:`, error);
          retries--;
          if (retries > 0) {
            console.log("Waiting 2 seconds before next verification attempt...");
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds between retries
          }
        }
      }

      console.log(`Final verification result - Player was added to game: ${playerWasAdded}`);

      if (!playerWasAdded) {
        console.error("Player was not added to the game after transaction confirmation");
        await ctx.answerCallbackQuery("Error: Failed to join game. Please try again.");
        return;
      }

      // Save player mapping after confirming player was added
      const playerPubkey = playerKp.publicKey.toBase58();
      console.log(`Saving player mapping for joiner - Public Key: ${playerPubkey}, Telegram ID: ${telegramId.toString()}`);
      await gameDb.savePlayerMapping(playerPubkey, telegramId.toString());
      // Also save mapping for the balance PDA
      console.log(`Saving player mapping for balance PDA - PDA: ${playerBalancePda.toBase58()}, Telegram ID: ${telegramId.toString()}`);
      await gameDb.savePlayerMapping(playerBalancePda.toBase58(), telegramId.toString());

      // Update game message with current status
      const creatorUsername = await gameManager.getGameCreatorUsername(ctx, gameAddress);
      console.log("Updating game message...");
      await gameManager.updateGameMessage(
        ctx,
        gameAddress,
        "Coinflip",
        Number(game.amount),
        creatorUsername,
        "Active",
        undefined
      );

      // Check if this was the last player needed to fill the game
      if (updatedGameAccount.players.length === gameAccount.maxPlayers) {
        console.log(`Game ${gamePda.toBase58()} is full, waiting for join transaction to be fully processed...`);
        // Wait for 5 seconds to ensure join transaction and message update are fully processed
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Verify game is still full and active
        try {
          const finalGameAccount = await program.account.game.fetch(gamePda);
          if (finalGameAccount.players.length === gameAccount.maxPlayers &&
              Object.keys(finalGameAccount.status)[0].toLowerCase() === 'active') {
            console.log(`Join transaction fully processed, attempting to complete game...`);
            // Automatically complete the game
            const completed = await gameManager.autoCompleteGame(ctx, gamePda);
            if (!completed) {
              ctx.reply("⚠️ Game is full but could not be automatically completed. Please try again later or contact support.");
            }
          } else {
            console.log(`Game state changed after join, skipping auto-completion`);
          }
        } catch (error) {
          console.error(`Error verifying game state before completion:`, error);
        }
      }

      console.log("Join process completed successfully");

    } catch (error: any) {
      console.error("Error joining game:", error);
      await ctx.answerCallbackQuery(`Error joining game: ${error.message || "Unknown error"}`);
    }
  } else if (callbackData.startsWith("refresh_")) {
    const gameAddress = callbackData.split("_")[1];
    const game = await gameDb.getGame(gameAddress);

    if (!game) {
      await ctx.answerCallbackQuery("Game not found!");
      return;
    }

    try {
      const gamePda = new PublicKey(gameAddress);
      const currentGameAccount = await program.account.game.fetch(gamePda);
      const creatorUsername = await gameManager.getGameCreatorUsername(ctx, gameAddress);

      // Update game message with current status
      await gameManager.updateGameMessage(
        ctx,
        gameAddress,
        "Coinflip",
        Number(game.amount),
        creatorUsername,
        Object.keys(currentGameAccount.status)[0],
        currentGameAccount.winner?.toString()
      );

      await ctx.answerCallbackQuery("Game status refreshed!");
    } catch (error) {
      console.error("Error refreshing game:", error);
      await ctx.answerCallbackQuery("Error refreshing game status!");
    }
  } else if (callbackData.startsWith("unjoin_")) {
    const gameAddress = callbackData.split("_")[1];
    const game = await gameDb.getGame(gameAddress);

    if (!game) {
      await ctx.answerCallbackQuery("Game not found!");
      return;
    }

    try {
      const gamePda = new PublicKey(gameAddress);
      const telegramId = BigInt(ctx.from.id);
      const playerKp = await wallet.getKeyPair(telegramId);

      // Call unjoin function
      await gameManager.unjoinGame(ctx, gamePda, playerKp);
      await ctx.answerCallbackQuery("Successfully unjoined the game!");
    } catch (error: any) {
      console.error("Error unjoining game:", error);
      await ctx.answerCallbackQuery(`Error unjoining game: ${error.message || "Unknown error"}`);
    }
  }
});

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Start the bot and setup Anchor
setupAnchor().then(async () => {
  console.log("Starting bot...");

  // Reload game message mappings from database
  await gameManager.reloadGameMessages();
  console.log(`Reloaded game message mappings from database`);

  bot.start();
}).catch(error => {
  console.error("Failed to setup Anchor:", error);
});

// Helper function to claim winnings
const claimWinnings = async (playerKp: anchor.web3.Keypair): Promise<number> => {
  // Get program addresses
  const [playerBalancePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("player_balance"), playerKp.publicKey.toBuffer(), new PublicKey(TOKEN_MINT).toBuffer()],
    program.programId
  );

  // Get player balance
  const playerBalance = await program.account.playerBalance.fetch(playerBalancePda);
  const claimableAmount = Number(playerBalance.amount);

  if (claimableAmount <= 0) {
    return 0;
  }

  const [gameTokenPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_token"), new PublicKey(TOKEN_MINT).toBuffer()],
    program.programId
  );

  const [gameVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_vault"), new PublicKey(TOKEN_MINT).toBuffer()],
    program.programId
  );

  // Get player's token account
  const playerTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(TOKEN_MINT),
    playerKp.publicKey
  );

  // Get game's token account
  const gameTokenAccount = await getAssociatedTokenAddress(
    new PublicKey(TOKEN_MINT),
    gameVaultPda,
    true
  );

  // Call the contract to claim the win
  await program.methods
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

  return claimableAmount;
};
