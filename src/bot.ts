import { Bot, Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { WalletManager } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createSyncNativeInstruction } from "@solana/spl-token";
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";
import { GameDatabase } from "./utils/database";
import { SystemProgram } from "@solana/web3.js";
import { GameManager } from "./utils/game";
import { PDAManager } from "./utils/pda";
import { parseTransactionError, truncateErrorForCallback, formatUserFriendlyError } from "./utils/errors";
import {
  LAMPORTS_PER_SOL,
  GAME_TIMEOUT,
  COINFLIP_MAX_PLAYERS,
  GIVEAWAY_MAX_PLAYERS,
  RETRY_DELAY_MS,
  GAME_COMPLETION_WAIT_MS,
  EXPIRED_GAMES_CHECK_INTERVAL_MS,
  TOKEN_METADATA_CACHE_DURATION
} from "./utils/constants";
import type { ParsedAmount, PlayerData, GameCompletedEvent } from "./types";

// Initialize the bot and wallet manager
const bot = new Bot(process.env.TELEGRAM_TOKEN!);
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
const TOKEN_MINT = process.env.TOKEN_MINT!;
const TICKER = process.env.TICKER!;

// Configure concurrent processing with sequentialization
// This ensures operations for the same user are processed in order
// while allowing concurrent processing between different users
bot.use(sequentialize((ctx) => {
  // Sequentialize by user ID for all user operations
  const userId = ctx.from?.id?.toString();
  if (!userId) return undefined;

  // For callback queries, also sequentialize by game address to prevent race conditions
  if (ctx.callbackQuery?.data) {
    const callbackData = ctx.callbackQuery.data;
    if (callbackData.startsWith("join_") || callbackData.startsWith("unjoin_") || callbackData.startsWith("refresh_")) {
      const gameAddress = callbackData.split("_")[1];
      return [userId, `game_${gameAddress}`];
    }
  }

  return userId;
}));

// Add token metadata cache at the top level
let tokenMetadata: { decimals: number } | null = null;
let tokenMetadataLastFetch: number = 0;

// Initialize game database
const gameDb = GameDatabase.getInstance();

// Global program variable to be initialized when needed
let program: anchor.Program<Coinflip>;
let gameManager: GameManager;

// ================================
// HELPER FUNCTIONS
// ================================

// Helper function to get token metadata with caching
const getTokenMetadata = async () => {
  const now = Date.now();
  if (!tokenMetadata || now - tokenMetadataLastFetch > TOKEN_METADATA_CACHE_DURATION) {
    tokenMetadata = await wallet.getTokenMetadata(TOKEN_MINT);
    tokenMetadataLastFetch = now;
  }
  return tokenMetadata;
};

// Helper function to parse and validate amounts
const parseAmount = async (args: string[], argIndex: number = 1): Promise<ParsedAmount | null> => {
  if (!args || args.length <= argIndex) return null;

  const metadata = await getTokenMetadata();
  const isSol = args[args.length - 1].toUpperCase() === "SOL";
  const amountStr = isSol ? args[argIndex] : args[argIndex];
  const rawAmount = parseFloat(amountStr);

  if (isNaN(rawAmount) || rawAmount <= 0) return null;

  const amount = rawAmount * (isSol ? LAMPORTS_PER_SOL : Math.pow(10, metadata.decimals));
  const formattedAmount = isSol
    ? wallet.formatSolBalance(amount) + " SOL"
    : wallet.formatTokenBalance(amount, metadata.decimals) + " " + TICKER;

  return { amount, isSol, formattedAmount };
};

// Helper function to get player data - optimized
const getPlayerData = async (telegramId: bigint): Promise<PlayerData> => {
  const keypair = wallet.getKeyPair(telegramId);

  // Batch fetch balances concurrently
  const [tokenBalance, solBalance] = await Promise.all([
    wallet.getTokenBalance(telegramId, TOKEN_MINT),
    wallet.getBalance(telegramId)
  ]);

  // Get player's game balance
  let gameBalance = 0;
  try {
    const playerBalancePda = PDAManager.getPlayerBalancePDA(
      keypair.publicKey,
      new PublicKey(TOKEN_MINT),
      program.programId
    );
    const playerBalanceAccount = await program.account.playerBalance.fetch(playerBalancePda);
    gameBalance = Number(playerBalanceAccount.amount);
  } catch (error) {
    // Player balance account doesn't exist yet
  }

  return { keypair, tokenBalance, solBalance, gameBalance };
};

// Helper function to check and claim winnings
const checkAndClaimWinnings = async (playerKp: anchor.web3.Keypair, isSol: boolean): Promise<number> => {
  if (isSol) return 0;
  return await claimWinnings(playerKp);
};

// Helper function to validate balance
const validateBalance = async (playerData: PlayerData, amount: number, isSol: boolean): Promise<string | null> => {
  const metadata = await getTokenMetadata();

  if (isSol) {
    if (playerData.solBalance < amount) {
      return `Insufficient SOL balance. You have ${wallet.formatSolBalance(playerData.solBalance)} SOL but need ${wallet.formatSolBalance(amount)} SOL`;
    }
  } else {
    const totalBalance = playerData.tokenBalance + playerData.gameBalance;
    if (totalBalance < amount) {
      return `Insufficient balance. You have ${wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${TICKER} but need ${wallet.formatTokenBalance(amount, metadata.decimals)} ${TICKER}`;
    }
  }

  return null; // No error
};

// Helper function to process transactions with loading state
const processTransaction = async (
  ctx: Context,
  description: string,
  transactionFn: () => Promise<string>
): Promise<void> => {
  const processingMsg = await ctx.reply(`Processing ${description}...`, {
    reply_to_message_id: ctx.message?.message_id
  });

  try {
    const tx = await transactionFn();

    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      `${description} successful! 💸\n\nTransaction: ${tx}`,
      { parse_mode: "HTML" }
    );
  } catch (error: any) {
    const userFriendlyError = formatUserFriendlyError(error, wallet);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      userFriendlyError,
      { parse_mode: "HTML" }
    );
    throw error;
  }
};

// Helper function to handle errors consistently
const handleCommandError = async (ctx: Context, error: any, commandName: string): Promise<void> => {
  console.error(`Error in ${commandName} command:`, error);
  const userFriendlyError = formatUserFriendlyError(error, wallet);
  await ctx.reply(userFriendlyError, {
    reply_to_message_id: ctx.message?.message_id
  });
};

// Helper function to validate address
const validateAddress = (addressStr: string): PublicKey | null => {
  try {
    return new PublicKey(addressStr);
  } catch {
    return null;
  }
};

// ================================
// ANCHOR SETUP
// ================================

// Initialize Anchor with a wallet for admin operations
const initializeAnchorProvider = async () => {
  // Get admin keypair from the JSON file
  const adminKeypair = wallet.getAdminKeypair();

  // Create a wallet adapter for Anchor
  const adminWallet = new anchor.Wallet(adminKeypair);

  // Initialize provider with connection from wallet manager
  const provider = new anchor.AnchorProvider(
    wallet.getConnection(),
    adminWallet,
    { commitment: "confirmed" }
  );

  // Set the provider globally
  anchor.setProvider(provider);

  return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
};

// Initialize program when bot starts
const setupAnchor = async () => {
  try {
    program = await initializeAnchorProvider();
    console.log(`Initialized Anchor program: ${program.programId}`);

    // Initialize game manager
    gameManager = GameManager.getInstance(program, wallet, gameDb, TOKEN_MINT, TICKER);

    // Check if Oracle is already initialized
    try {
      const oraclePda = PDAManager.getOraclePDA(program.programId);

      const oracleAccount = await program.account.oracle.fetch(oraclePda);
      console.log(`Oracle found, authority: ${oracleAccount.authority.toString()}`);
    } catch (error) {
      console.log("Oracle not found, it might need to be initialized");
    }

    // Check if game token is initialized
    try {
      const gameTokenPda = PDAManager.getGameTokenPDA(
        new PublicKey(TOKEN_MINT),
        program.programId
      );

      const gameTokenAccount = await program.account.gameToken.fetch(gameTokenPda);
      console.log(`Game token found: ${gameTokenAccount.tokenMint.toString()}`);
    } catch (error) {
      console.log("Game token not found, it might need to be initialized");
    }
  } catch (error) {
    console.error("Error initializing Anchor program:", error);
    console.error("Make sure admin-keypair.json exists in the project root directory.");
    throw error;
  }
};

// ================================
// BOT COMMANDS
// ================================

// Optimize balance command
bot.command(["start", "balance"], async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  try {
    const playerData = await getPlayerData(telegramId);
    const metadata = await getTokenMetadata();

    // Get player's balance PDA
    const playerBalancePda = PDAManager.getPlayerBalancePDA(
      playerData.keypair.publicKey,
      new PublicKey(TOKEN_MINT),
      program.programId
    );

    const balance = await program.account.playerBalance.fetch(playerBalancePda).catch(() => ({ amount: 0 }));

    let response = "💰 <b>Your Balance</b>\n\n";
    response += `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>\n`;
    response += `SOL Balance: ${wallet.formatSolBalance(playerData.solBalance)} SOL\n`;
    response += `Token Balance: ${wallet.formatTokenBalance(playerData.tokenBalance + Number(balance.amount), metadata.decimals)} ${TICKER}`;

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "balance");
  }
});

// Simplified coinflip command
bot.command(["coinflip", "cf"], async (ctx) => {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(" ");
  if (!args) return;

  const parsed = await parseAmount(args);
  const maxPlayers = parseInt(args?.[2] || COINFLIP_MAX_PLAYERS.toString()) || COINFLIP_MAX_PLAYERS;

  if (!parsed) {
    return ctx.reply("Usage: /coinflip <amount> <maxPlayers>\nExample: /coinflip 10 2", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  await gameManager.createGame(ctx, "coinflip", parsed.amount, maxPlayers, 2, GAME_TIMEOUT);
});

// Simplified giveaway command
bot.command(["giveaway", "ga"], async (ctx) => {
  if (!ctx.from) return;

  const args = ctx.message?.text?.split(" ");
  if (!args) return;

  const parsed = await parseAmount(args);
  const maxPlayers = parseInt(args?.[2] || GIVEAWAY_MAX_PLAYERS.toString()) || GIVEAWAY_MAX_PLAYERS;

  if (!parsed) {
    return ctx.reply("Usage: /giveaway <amount> <maxPlayers>\nExample: /giveaway 100 5", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  await gameManager.createGame(ctx, "giveaway", parsed.amount, maxPlayers, 1, GAME_TIMEOUT);
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

  const toAddress = validateAddress(args[1]);
  if (!toAddress) {
    return ctx.reply("Invalid wallet address. Please provide a valid Solana address.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const parsed = await parseAmount(args, 2);
  if (!parsed) {
    return ctx.reply("Please provide a valid amount greater than 0.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  try {
    const playerData = await getPlayerData(telegramId);

    // Claim winnings if not using SOL
    await checkAndClaimWinnings(playerData.keypair, parsed.isSol);

    // Validate balance
    const balanceError = await validateBalance(playerData, parsed.amount, parsed.isSol);
    if (balanceError) {
      return ctx.reply(balanceError, {
        reply_to_message_id: ctx.message?.message_id
      });
    }

    // Process transaction
    await processTransaction(ctx, `Withdrawal of ${parsed.formattedAmount}`, async () => {
      if (parsed.isSol) {
        const transferSolIx = SystemProgram.transfer({
          fromPubkey: playerData.keypair.publicKey,
          toPubkey: toAddress,
          lamports: parsed.amount,
        });
        return await wallet.signAndSend([transferSolIx], [playerData.keypair]);
      } else {
        return await wallet.transferToken(telegramId, toAddress, parsed.amount, TOKEN_MINT);
      }
    });

  } catch (error: any) {
    await handleCommandError(ctx, error, "withdraw");
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

  // Check if the recipient is a bot
  if (replyToMessage.from.is_bot) {
    return ctx.reply("You cannot tip bots!", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const recipientTelegramId = BigInt(replyToMessage.from.id);
  if (recipientTelegramId === telegramId) {
    return ctx.reply("You can't tip yourself!", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const parsed = await parseAmount(args);
  if (!parsed) {
    return ctx.reply("Please provide a valid amount greater than 0.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  try {
    const playerData = await getPlayerData(telegramId);

    // Claim winnings if not using SOL
    await checkAndClaimWinnings(playerData.keypair, parsed.isSol);

    // Get recipient public key
    const recipientPubKey = wallet.getPublicKey(recipientTelegramId);

    // Validate balance
    const balanceError = await validateBalance(playerData, parsed.amount, parsed.isSol);
    if (balanceError) {
      return ctx.reply(balanceError, {
        reply_to_message_id: ctx.message?.message_id
      });
    }

    // Process transaction
    const recipientName = replyToMessage.from.username
      ? `@${replyToMessage.from.username}`
      : replyToMessage.from.first_name || "User";
    await processTransaction(ctx, `Tip of ${parsed.formattedAmount} to ${recipientName}`, async () => {
      if (parsed.isSol) {
        const transferSolIx = SystemProgram.transfer({
          fromPubkey: playerData.keypair.publicKey,
          toPubkey: recipientPubKey,
          lamports: parsed.amount,
        });
        return await wallet.signAndSend([transferSolIx], [playerData.keypair]);
      } else {
        return await wallet.transferToken(telegramId, recipientPubKey, parsed.amount, TOKEN_MINT);
      }
    });

  } catch (error: any) {
    await handleCommandError(ctx, error, "tip");
  }
});

// Implement wrap command
bot.command("wrap", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const args = ctx.message?.text?.split(" ");

  if (!args) return;

  const amount = parseFloat(args?.[1] || "0") * LAMPORTS_PER_SOL; // Convert to lamports

  if (amount <= 0) {
    return ctx.reply("Usage: /wrap <amount>\nExample: /wrap 0.1", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  try {
    const playerData = await getPlayerData(telegramId);

    // Check SOL balance
    if (playerData.solBalance < amount) {
      return ctx.reply(`Insufficient SOL balance. You have ${wallet.formatSolBalance(playerData.solBalance)} SOL but are trying to wrap ${wallet.formatSolBalance(amount)} SOL`, {
        reply_to_message_id: ctx.message?.message_id
      });
    }

    // Process transaction
    await processTransaction(ctx, `Wrapping ${wallet.formatSolBalance(amount)} SOL to WSOL`, async () => {
      const wsolMint = new PublicKey(TOKEN_MINT);
      const { address: wsolAccount, instructions: createAtaIx } = await wallet.findOrCreateAssociatedTokenAccount(
        playerData.keypair.publicKey,
        wsolMint,
        playerData.keypair
      );

      const transferSolIx = SystemProgram.transfer({
        fromPubkey: playerData.keypair.publicKey,
        toPubkey: wsolAccount,
        lamports: amount,
      });

      const syncNativeIx = createSyncNativeInstruction(wsolAccount);
      const allInstructions = [...createAtaIx, transferSolIx, syncNativeIx];

      return await wallet.signAndSend(allInstructions, [playerData.keypair]);
    });

  } catch (error: any) {
    await handleCommandError(ctx, error, "wrap");
  }
});

// Implement help command
bot.command("help", async (ctx: Context) => {
  const helpText =
    `<b>📝 Available Commands:</b>\n\n` +
    `/start, /balance - Show your wallet address and balances\n` +
    `/wrap &lt;amount&gt; - Convert SOL to WSOL\n` +
    `/coinflip &lt;amount&gt; &lt;maxPlayers&gt; - Create a new coinflip game\n` +
    `/cf &lt;amount&gt; &lt;maxPlayers&gt; - Shorthand for coinflip command\n` +
    `/giveaway &lt;amount&gt; &lt;maxPlayers&gt; - Create a new giveaway\n` +
    `/ga &lt;amount&gt; &lt;maxPlayers&gt; - Shorthand for giveaway command\n` +
    `/withdraw &lt;address&gt; &lt;amount&gt; - Withdraw tokens to external wallet\n` +
    `/wh &lt;address&gt; &lt;amount&gt; - Shorthand for withdraw command\n` +
    `/tip &lt;amount&gt; - Reply to a user's message to send them tokens\n` +
    `/privatekey, /pk - Get your wallet private key (private chat only)\n` +
    `/active - Show your active games\n` +
    `/games - Show your recent games\n` +
    `/debug - Show detailed wallet debug info (reply to user for their info too)\n` +
    `/checktx &lt;signature&gt; - Check transaction details and status\n` +
    `/oracle - Check Oracle configuration\n\n` +
    `<b>ℹ️ Important:</b> Your player balance account will be automatically initialized when needed.`;

  await ctx.reply(helpText, {
    parse_mode: "HTML",
    reply_to_message_id: ctx.message?.message_id
  });
});

// Add after the help command, before the active command
bot.command("debug", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const replyToMessage = ctx.message?.reply_to_message;

  try {
    const playerData = await getPlayerData(telegramId);
    const metadata = await getTokenMetadata();

    let response = `🔍 <b>Debug Info for ${ctx.from?.first_name || 'You'}</b>\n\n`;
    response += `Telegram ID: <code>${telegramId}</code>\n`;
    response += `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>\n`;
    response += `SOL Balance: ${wallet.formatSolBalance(playerData.solBalance)} SOL\n`;
    response += `Token Balance: ${wallet.formatTokenBalance(playerData.tokenBalance, metadata.decimals)} ${TICKER}\n`;
    response += `Game Balance: ${wallet.formatTokenBalance(playerData.gameBalance, metadata.decimals)} ${TICKER}\n\n`;

    // Get token account address
    const { getAssociatedTokenAddress } = await import("@solana/spl-token");
    const tokenAccount = await getAssociatedTokenAddress(
      new PublicKey(TOKEN_MINT),
      playerData.keypair.publicKey
    );
    response += `Token Account: <code>${tokenAccount.toBase58()}</code>\n\n`;

    // If replying to someone, show their info too
    if (replyToMessage && replyToMessage.from && !replyToMessage.from.is_bot) {
      const recipientTelegramId = BigInt(replyToMessage.from.id);
      const recipientData = await getPlayerData(recipientTelegramId);
      const recipientTokenAccount = await getAssociatedTokenAddress(
        new PublicKey(TOKEN_MINT),
        recipientData.keypair.publicKey
      );

      response += `<b>Reply Target: ${replyToMessage.from.first_name || 'User'}</b>\n`;
      response += `Telegram ID: <code>${recipientTelegramId}</code>\n`;
      response += `Wallet Address: <code>${recipientData.keypair.publicKey.toBase58()}</code>\n`;
      response += `SOL Balance: ${wallet.formatSolBalance(recipientData.solBalance)} SOL\n`;
      response += `Token Balance: ${wallet.formatTokenBalance(recipientData.tokenBalance, metadata.decimals)} ${TICKER}\n`;
      response += `Game Balance: ${wallet.formatTokenBalance(recipientData.gameBalance, metadata.decimals)} ${TICKER}\n`;
      response += `Token Account: <code>${recipientTokenAccount.toBase58()}</code>\n`;
    }

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "debug");
  }
});

// Add after the debug command
bot.command("checktx", async (ctx: Context) => {
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 2) {
    return ctx.reply("Usage: /checktx <transaction_signature>", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const signature = args[1];

  try {
    console.log(`Checking transaction: ${signature}`);

    // Get transaction details
    const connection = wallet.getConnection();
    const txDetails = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!txDetails) {
      return ctx.reply("Transaction not found or not confirmed yet.", {
        reply_to_message_id: ctx.message?.message_id
      });
    }

    let response = `🔍 <b>Transaction Details</b>\n\n`;
    response += `Signature: <code>${signature}</code>\n`;
    response += `Slot: ${txDetails.slot}\n`;
    response += `Block Time: ${txDetails.blockTime ? new Date(txDetails.blockTime * 1000).toISOString() : 'Unknown'}\n`;
    response += `Fee: ${txDetails.meta?.fee || 0} lamports\n`;
    response += `Status: ${txDetails.meta?.err ? '❌ Failed' : '✅ Success'}\n`;

    if (txDetails.meta?.err) {
      response += `Error: <code>${JSON.stringify(txDetails.meta.err)}</code>\n`;
    }

    // Check token transfers in the transaction
    if (txDetails.meta?.preTokenBalances && txDetails.meta?.postTokenBalances) {
      response += `\n<b>Token Balance Changes:</b>\n`;

      const preBalances = txDetails.meta.preTokenBalances;
      const postBalances = txDetails.meta.postTokenBalances;

      // Group balances by account
      const balanceChanges = new Map();

      preBalances.forEach(balance => {
        if (balance.mint === TOKEN_MINT) {
          balanceChanges.set(balance.accountIndex, {
            account: balance.owner,
            pre: balance.uiTokenAmount.uiAmount || 0,
            post: 0
          });
        }
      });

      postBalances.forEach(balance => {
        if (balance.mint === TOKEN_MINT) {
          const existing = balanceChanges.get(balance.accountIndex) || {
            account: balance.owner,
            pre: 0,
            post: 0
          };
          existing.post = balance.uiTokenAmount.uiAmount || 0;
          balanceChanges.set(balance.accountIndex, existing);
        }
      });

      balanceChanges.forEach((change, accountIndex) => {
        const diff = change.post - change.pre;
        const direction = diff > 0 ? '📈' : diff < 0 ? '📉' : '➖';
        response += `${direction} Account ${accountIndex}: ${change.pre} → ${change.post} ${TICKER} (${diff > 0 ? '+' : ''}${diff})\n`;
      });
    }

    // Show account keys involved
    if (txDetails.transaction.message) {
      response += `\n<b>Accounts involved:</b>\n`;
      try {
        const accountKeys = txDetails.transaction.message.getAccountKeys();
        accountKeys.keySegments().forEach((segment: any[], segmentIndex: number) => {
          segment.forEach((key: any, index: number) => {
            const globalIndex = segmentIndex * segment.length + index;
            response += `${globalIndex}: <code>${key.toBase58()}</code>\n`;
          });
        });
      } catch (error) {
        // Handle different transaction message formats
        response += `Unable to parse account keys\n`;
      }
    }

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });

  } catch (error: any) {
    console.error("Error checking transaction:", error);
    await ctx.reply(`Error checking transaction: ${error.message}`, {
      reply_to_message_id: ctx.message?.message_id
    });
  }
});

// Implement active command to show only active games
bot.command("active", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);

  try {
    const { activeGames, totalTokensInGames } = await gameManager.getUserGames(ctx, telegramId);
    const metadata = await getTokenMetadata();

    let response = activeGames || "You don't have any active games.";

    // Add total tokens in active games
    if (totalTokensInGames > 0) {
      response += `\n\n💰 Total tokens in active games: ${wallet.formatTokenBalance(totalTokensInGames, metadata.decimals)} ${TICKER}`;
    }

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "active");
  }
});

// Modify games command to show only recent games
bot.command("games", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);

  try {
    const { recentGames } = await gameManager.getUserGames(ctx, telegramId);
    const response = recentGames || "You don't have any recent games.";

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "games");
  }
});

// Add after the existing commands, before the callback query handler
bot.command(["privatekey", "pk"], async (ctx: Context) => {
  // Only allow this command in private chats for security
  if (ctx.chat?.type !== "private") {
    return ctx.reply("🔒 This command can only be used in private messages for security reasons. Please message me directly.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const telegramId = BigInt(ctx.from?.id || 0);

  try {
    const playerData = await getPlayerData(telegramId);
    const privateKeyArray = Array.from(playerData.keypair.secretKey);
    const privateKeyString = `[${privateKeyArray.join(',')}]`;

    let response = "🔐 <b>Your Private Key</b>\n\n";
    response += "⚠️ <b>SECURITY WARNING:</b>\n";
    response += "• Never share your private key with anyone\n";
    response += "• Store it securely offline\n";
    response += "• Anyone with this key has full access to your wallet\n\n";
    response += `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>\n\n`;
    response += `Private Key (Array Format):\n<code>${privateKeyString}</code>\n\n`;
    response += `Private Key (Base58 Format):\n<code>${Buffer.from(playerData.keypair.secretKey).toString('base64')}</code>\n\n`;
    response += "💡 You can import this key into Phantom, Solflare, or other Solana wallets.";

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "privatekey");
  }
});

// Add after the existing commands, before the callback query handler
bot.command("oracle", async (ctx: Context) => {
  try {
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    const oracleAccount = await program.account.oracle.fetch(oraclePda);

    let response = "🔮 <b>Oracle Configuration</b>\n\n";
    response += `Authority: <code>${oracleAccount.authority.toString()}</code>\n`;
    response += `Fee Percentage: ${oracleAccount.feePercentage}%\n`;
    response += `Min Timeout: ${oracleAccount.minTimeout} seconds (${oracleAccount.minTimeout / 60} minutes)\n`;
    response += `Max Timeout: ${oracleAccount.maxTimeout} seconds (${oracleAccount.maxTimeout / 60} minutes)\n`;
    response += `Max Players: ${oracleAccount.maxPlayers}\n`;
    response += `Oracle Buffer Time: ${oracleAccount.oracleBufferTime} seconds\n\n`;
    response += `Current Game Timeout: ${GAME_TIMEOUT} seconds (${GAME_TIMEOUT / 60} minutes)`;

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "oracle");
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
      const playerKp = wallet.getKeyPair(telegramId);
      console.log(`Player public key: ${playerKp.publicKey.toBase58()}`);
      const metadata = await getTokenMetadata();

      // Fetch game to verify it exists and is active
      const gamePda = new PublicKey(gameAddress);
      console.log(`Fetching game account for ${gamePda.toBase58()}`);
      const gameAccount = await program.account.game.fetch(gamePda);
      console.log(`Current players in game: ${gameAccount.players.length}`);

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

      // Batch fetch balances for better performance
      const [tokenBalance, gameBalance] = await Promise.all([
        wallet.getTokenBalance(telegramId, TOKEN_MINT),
        (async () => {
          try {
            const playerBalancePda = PDAManager.getPlayerBalancePDA(
              playerKp.publicKey,
              new PublicKey(TOKEN_MINT),
              program.programId
            );
            const playerBalance = await program.account.playerBalance.fetch(playerBalancePda);
            return Number(playerBalance.amount);
          } catch (error) {
            console.log("Player balance account not found or error fetching it");
            return 0;
          }
        })()
      ]);

      const gameAmount = Number(gameAccount.amount);
      console.log(`Player balance: ${tokenBalance}, game amount: ${gameAmount}`);
      const totalBalance = tokenBalance + gameBalance;
      console.log(`Total balance (wallet + game): ${totalBalance}`);

      if (totalBalance < gameAmount) {
        await ctx.answerCallbackQuery(`Insufficient balance. You have ${wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${TICKER} but need ${wallet.formatTokenBalance(gameAmount, metadata.decimals)} ${TICKER}`);
        return;
      }

      console.log("All checks passed, proceeding with join transaction");

      // Ensure player has balance PDA
      const playerBalancePda = await gameManager.ensurePlayerBalance(playerKp);
      console.log(`Player balance PDA: ${playerBalancePda.toBase58()}`);

      // Check if game is private and handle accordingly
      if (gameAccount.isPrivate) {
        console.log("Game is private, using oracle authorization");
        const result = await gameManager.joinPrivateGame(
          gamePda,
          playerKp,
          ctx.chat?.id || 0
        );

        if (!result.success) {
          await ctx.answerCallbackQuery(result.error || "Failed to join private game");
          return;
        }

        console.log(`Successfully joined private game with tx: ${result.tx}`);
      } else {
        // Original logic for public games
        console.log("Game is public, using standard join");

        console.log("Sending join transaction...");
        // Call the contract to join the game
        const tx = await program.methods
          .joinGame()
          .accounts({
            game: gamePda,
            player: playerKp.publicKey,
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
            await wallet.confirmTransaction(tx);
            confirmed = true;
          } catch (error) {
            console.error(`Confirmation attempt ${4 - retries} failed:`, error);
            retries--;
            if (retries > 0) {
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
          }
        }

        if (!confirmed) {
          throw new Error("Failed to confirm transaction after multiple attempts");
        }
        console.log("Transaction confirmed");
      }

      // Verify player was added to the game with retries
      console.log("Verifying player was added to game...");
      let verificationRetries = 3;
      let playerWasAdded = false;
      let updatedGameAccount: any;
      while (verificationRetries > 0 && !playerWasAdded) {
        try {
          updatedGameAccount = await program.account.game.fetch(gamePda);
          console.log(`Current players in game: ${updatedGameAccount.players.length}`);
          console.log(`Player public key to check: ${playerKp.publicKey.toBase58()}`);
          console.log("Current players in game:");
          updatedGameAccount.players.forEach((p: PublicKey) => {
            console.log(`- ${p.toBase58()}`);
          });

          playerWasAdded = updatedGameAccount.players.some((p: PublicKey) => {
            const isAdded = p.equals(playerKp.publicKey);
            console.log(`Checking player public key ${p.toBase58()} against ${playerKp.publicKey.toBase58()}: ${isAdded}`);
            return isAdded;
          });

          if (!playerWasAdded) {
            console.log(`Verification attempt ${4 - verificationRetries} failed: Player not found in game`);
            verificationRetries--;
            if (verificationRetries > 0) {
              console.log("Waiting 2 seconds before next verification attempt...");
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            }
          } else {
            console.log("Player was successfully verified in the game!");
          }
        } catch (error) {
          console.error(`Verification attempt ${4 - verificationRetries} failed with error:`, error);
          verificationRetries--;
          if (verificationRetries > 0) {
            console.log("Waiting 2 seconds before next verification attempt...");
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
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
      gameDb.savePlayerMapping(playerPubkey, telegramId.toString());

      // Save game participant record
      console.log(`Saving game participant record - Game: ${gameAddress}, Telegram ID: ${telegramId.toString()}, Public Key: ${playerPubkey}`);
      gameDb.saveGameParticipant(gameAddress, telegramId.toString(), playerPubkey);

      // Update game message with current status
      const creatorUsername = await gameManager.getGameCreatorUsername(ctx, gameAddress);
      console.log("Updating game message...");
      const gameType = Object.keys(gameAccount.gameType)[0].charAt(0).toUpperCase() + Object.keys(gameAccount.gameType)[0].slice(1);
      await gameManager.updateGameMessage(
        ctx,
        gameAddress,
        gameType,
        Number(game.amount),
        creatorUsername,
        "Active",
        undefined
      );

      // Send a reply notification that the user joined
      const joinerUsername = ctx.from?.username || ctx.from?.first_name || "Player";
      const playerCount = updatedGameAccount.players.length;
      const maxPlayers = gameAccount.maxPlayers;
      const gameName = gameType.toLowerCase();

      // Get the game message for reply_to_message_id
      const gameMessage = gameManager.getActiveGameMessage(gameAddress);

      console.log(`🎮 Sending join notification for @${joinerUsername} (${playerCount}/${maxPlayers} players)`);
      await ctx.reply(
        `🎮 @${joinerUsername} joined the ${gameName}! (${playerCount}/${maxPlayers} players)`,
        {
          parse_mode: "HTML",
          reply_to_message_id: gameMessage?.messageId
        }
      );
      console.log(`✅ Join notification sent successfully`);

      // Check if this was the last player needed to fill the game
      if (updatedGameAccount.players.length === gameAccount.maxPlayers) {
        console.log(`Game ${gamePda.toBase58()} is full, waiting for join transaction to be fully processed...`);
        // Wait for 5 seconds to ensure join transaction and message update are fully processed
        await new Promise(resolve => setTimeout(resolve, GAME_COMPLETION_WAIT_MS));

        // Verify game is still full
        try {
          const finalGameAccount = await program.account.game.fetch(gamePda);
          if (finalGameAccount.players.length === gameAccount.maxPlayers) {
            console.log(`Join transaction fully processed, attempting to complete game...`);
            // Automatically complete the game
            const completed = await gameManager.autoCompleteGame(gamePda);
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
      const userFriendlyError = parseTransactionError(error, wallet);
      await ctx.answerCallbackQuery(truncateErrorForCallback(userFriendlyError));
    }
  } else if (callbackData.startsWith("refresh_")) {
    const gameAddress = callbackData.split("_")[1];
    const game = gameDb.getGame(gameAddress);

    if (!game) {
      await ctx.answerCallbackQuery("Game not found!");
      return;
    }

    try {
      const gamePda = new PublicKey(gameAddress);
      const currentGameAccount = await program.account.game.fetch(gamePda);
      const creatorUsername = await gameManager.getGameCreatorUsername(ctx, gameAddress);

      // Get the actual game type from the game account
      const gameType = Object.keys(currentGameAccount.gameType)[0].charAt(0).toUpperCase() + Object.keys(currentGameAccount.gameType)[0].slice(1);

      // Update game message with current status
      await gameManager.updateGameMessage(
        ctx,
        gameAddress,
        gameType,
        Number(game.amount),
        creatorUsername,
        "Active", // Since we can no longer get status from game account, assume active if it exists
        undefined
      );

      await ctx.answerCallbackQuery("Game status refreshed!");
    } catch (error) {
      console.error("Error refreshing game:", error);
      await ctx.answerCallbackQuery("Error refreshing game status!");
    }
  } else if (callbackData.startsWith("unjoin_")) {
    const gameAddress = callbackData.split("_")[1];
    const game = gameDb.getGame(gameAddress);

    if (!game) {
      await ctx.answerCallbackQuery("Game not found!");
      return;
    }

    try {
      const gamePda = new PublicKey(gameAddress);
      const telegramId = BigInt(ctx.from.id);
      const playerKp = wallet.getKeyPair(telegramId);

      // Call unjoin function
      await gameManager.unjoinGame(ctx, gamePda, playerKp);
      await ctx.answerCallbackQuery("Successfully unjoined the game!");
    } catch (error: any) {
      console.error("Error unjoining game:", error);
      const userFriendlyError = parseTransactionError(error, wallet);
      await ctx.answerCallbackQuery(truncateErrorForCallback(userFriendlyError));
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

  // Set up global event listener for GameCompleted events
  console.log("Setting up GameCompleted event listener...");
  program.addEventListener('gameCompleted', async (event: GameCompletedEvent) => {
    try {
      console.log(`🎉 GameCompleted event received for game: ${event.gameKey.toString()}`);

      const gameAddress = event.gameKey.toString();
      const winnerAddress = event.winner.toString();

      // Update database with completion
      const blockTime = await wallet.getBlockchainTime();
      const completedAt = blockTime * 1000;
      gameDb.completeGame(gameAddress, winnerAddress, completedAt);
      console.log(`💾 Updated database with completion for game ${gameAddress}`);

      // Get game info for notifications
      const gameData = gameDb.getGame(gameAddress);
      if (!gameData || !gameData.chat_id) {
        console.log(`No game data or chat_id found for game ${gameAddress}`);
        return;
      }

      // Create a context-like object for notifications
      const dummyCtx = {
        api: bot.api,
        chat: { id: gameData.chat_id },
        reply: async (text: string, options?: any) => {
          try {
            return await bot.api.sendMessage(gameData.chat_id!, text, options);
          } catch (error) {
            console.error(`Error sending notification to chat ${gameData.chat_id}:`, error);
          }
        }
      } as unknown as Context;

      // Update game message to show completion
      const creatorTelegramId = gameDb.getCreatorTelegramId(gameAddress);
      if (creatorTelegramId) {
        const creatorUsername = await gameManager.getUsernameFromTelegramId(dummyCtx, creatorTelegramId);
        const gameType = Object.keys(event.gameType)[0].charAt(0).toUpperCase() + Object.keys(event.gameType)[0].slice(1);

        await gameManager.updateGameMessage(
          dummyCtx,
          gameAddress,
          gameType,
          Number(event.amount),
          creatorUsername,
          "Completed",
          winnerAddress
        );
        console.log(`📝 Updated game message for completed game ${gameAddress}`);
      }

      // Send simplified completion notification
      try {
        const metadata = await wallet.getTokenMetadata(TOKEN_MINT);
        const winnerUsername = await gameManager.getPlayerUsername(dummyCtx, winnerAddress);
        const winnerAmount = Number(event.winnerAmount);
        const gameType = Object.keys(event.gameType)[0].charAt(0).toUpperCase() + Object.keys(event.gameType)[0].slice(1);

        let notificationText = `🎉 <b>${gameType} Completed!</b>\n\n`;
        notificationText += `🏆 Winner: @${winnerUsername}\n`;
        notificationText += `💰 Prize: ${wallet.formatTokenBalance(winnerAmount, metadata.decimals)} ${TICKER}`;

        // Get the game message for reply_to_message_id
        const gameMessage = gameManager.getActiveGameMessage(gameAddress);
        const replyToMessageId = gameMessage?.messageId;

        await dummyCtx.reply(notificationText, {
          parse_mode: "HTML",
          reply_to_message_id: replyToMessageId
        });
        console.log(`🎊 Sent completion notification for game ${gameAddress}`);
      } catch (error) {
        console.error("Error sending completion notification:", error);
      }

      console.log(`✅ Successfully processed GameCompleted event for game ${gameAddress}`);
    } catch (error) {
      console.error("Error processing GameCompleted event:", error);
    }
  });

  console.log("GameCompleted event listener set up successfully");

  // Start periodic check for expired games
  setInterval(async () => {
    try {
      const allGames = await gameDb.getAllGames();
      for (const game of allGames) {
        try {
          // Skip games that are already completed
          if (game.status === "completed") {
            continue;
          }

          const gamePda = new PublicKey(game.game_address);
          const gameAccount = await program.account.game.fetch(gamePda);

          // Check if game is expired
          const blockTime = await wallet.getBlockchainTime();
          const createdAt = Number(gameAccount.createdAt);
          const timeout = Number(gameAccount.timeout);
          const expiresAt = createdAt + timeout;
          const isExpired = blockTime > expiresAt;

          if (isExpired) {
            console.log(`Processing expired game ${game.game_address}`);
            // Create a dummy context for message updates
            const dummyCtx = {
              api: bot.api,
              chat: { id: game.chat_id },
              reply: async (text: string) => {
                console.log(`Game ${game.game_address} update: ${text}`);
              },
              update: {} as any,
              me: {} as any,
              match: {} as any,
              message: {} as any
            } as unknown as Context;

            // Handle the expired game
            const result = await gameManager.handleExpiredGame(dummyCtx, gamePda, gameAccount);
            if (result) {
              console.log(`Successfully processed expired game ${game.game_address}`);
            }
          }
        } catch (error: any) {
          // If we can't fetch the game account, it might be completed and closed
          // Check if it's in our database as completed
          if (error.message?.includes('Account does not exist')) {
            const gameData = gameDb.getGame(game.game_address);
            if (gameData && gameData.status !== "completed") {
              console.log(`Game ${game.game_address} account not found but not marked as completed in DB - marking as completed`);
              // Mark as completed if the account is gone but not marked in DB
              gameDb.completeGame(game.game_address, "cancelled", Date.now());
            }
          } else {
            console.error(`Error processing game ${game.game_address}:`, error);
          }
        }
      }
    } catch (error) {
      console.error("Error in periodic game check:", error);
    }
  }, EXPIRED_GAMES_CHECK_INTERVAL_MS); // Check every minute

  // Start the bot with concurrent processing
  console.log("Starting bot with concurrent processing...");
  const handle = run(bot, {
    runner: {
      fetch: {
        // Only handle updates we actually process
        allowed_updates: [
          "message",
          "callback_query"
        ]
      }
    }
  });

  // Set up graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
    try {
      await handle?.stop();
      console.log("✅ Bot stopped successfully");
      process.exit(0);
    } catch (error) {
      console.error("❌ Error during shutdown:", error);
      process.exit(1);
    }
  };

  // Handle different shutdown signals
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // Handle the runner task completion
  handle?.task()?.then(() => {
    console.log("🏁 Bot runner task completed");
  }).catch((error) => {
    console.error("❌ Bot runner task failed:", error);
  });

  console.log("✅ Bot is running with concurrent processing!");
  console.log("📊 Concurrent update processing is now enabled");
  console.log("🔄 Game operations are sequentialized per user to prevent conflicts");
}).catch(error => {
  console.error("Failed to setup Anchor:", error);
});

// Helper function to claim winnings
const claimWinnings = async (playerKp: anchor.web3.Keypair): Promise<number> => {
  console.log(`🏆 Starting claim winnings process for player: ${playerKp.publicKey.toBase58()}`);

  // Get program addresses
  const playerBalancePda = PDAManager.getPlayerBalancePDA(
    playerKp.publicKey,
    new PublicKey(TOKEN_MINT),
    program.programId
  );

  console.log(`  Player Balance PDA: ${playerBalancePda.toBase58()}`);

  try {
    // Get player balance
    const playerBalance = await program.account.playerBalance.fetch(playerBalancePda);
    const claimableAmount = Number(playerBalance.amount);

    console.log(`  Claimable amount: ${claimableAmount} (raw), ${claimableAmount / Math.pow(10, 9)} (UI)`);

    if (claimableAmount <= 0) {
      console.log(`  No winnings to claim, returning 0`);
      return 0;
    }

    console.log(`  Executing withdrawPlayerBalance() transaction...`);

    // Call the contract to withdraw player balance
    const tx = await program.methods
      .withdrawPlayerBalance()
      .accounts({
        player: playerKp.publicKey,
        tokenMint: new PublicKey(TOKEN_MINT),
      })
      .signers([playerKp])
      .rpc();

    console.log(`  Withdraw transaction signature: ${tx}`);

    // Wait for confirmation
    await wallet.confirmTransaction(tx);
    console.log(`  Withdraw transaction confirmed`);

    // Verify the withdrawal worked
    try {
      const updatedPlayerBalance = await program.account.playerBalance.fetch(playerBalancePda);
      const remainingAmount = Number(updatedPlayerBalance.amount);
      console.log(`  Remaining balance after withdrawal: ${remainingAmount}`);
    } catch (error) {
      console.log(`  Could not fetch updated balance: ${error}`);
    }

    console.log(`✅ Claim winnings completed successfully, claimed: ${claimableAmount}`);
    return claimableAmount;
  } catch (error: any) {
    if (error.message?.includes('Account does not exist')) {
      console.log(`  Player balance account does not exist, no winnings to claim`);
      return 0;
    }
    console.error(`❌ Error in claim winnings: ${error}`);
    throw error;
  }
};
