import { Bot, Context } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { WalletManager } from "./utils/wallet";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createSyncNativeInstruction } from "@solana/spl-token";
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";
import { GameDatabase } from "./utils/database";
import { GameManager } from "./utils/game";
import { PDAManager } from "./utils/pda";
import { formatUserFriendlyError } from "./utils/errors";
import {
  LAMPORTS_PER_SOL,
  GAME_TIMEOUT,
  COINFLIP_MAX_PLAYERS,
  GIVEAWAY_MAX_PLAYERS,
  GAME_COMPLETION_WAIT_MS,
  EXPIRED_GAMES_CHECK_INTERVAL_MS,
  BLOCKCHAIN_SCAN_INTERVAL_MS,
  TOKEN_METADATA_CACHE_DURATION
} from "./utils/constants";
import type { ParsedAmount, PlayerData, GameCompletedEvent } from "./types";

// Initialize the bot and wallet manager
const bot = new Bot(process.env.TELEGRAM_TOKEN!);
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
const TOKEN_MINT = process.env.TOKEN_MINT!;
const TICKER = process.env.TICKER!;

// Initialize game database
const gameDb = GameDatabase.getInstance();

// Global program variable to be initialized when needed
let program: anchor.Program<Coinflip>;
let gameManager: GameManager;

// Token metadata cache
let tokenMetadata: { decimals: number } | null = null;
let tokenMetadataLastFetch: number = 0;

// ================================
// BOT SEQUENTIALIZATION
// ================================

/**
 * Configure concurrent processing with sequentialization
 * This ensures operations for the same user are processed in order
 * while allowing concurrent processing between different users
 */
const getSequentializationKey = (ctx: Context): string | string[] | undefined => {
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
};

// Configure concurrent processing with sequentialization
bot.use(sequentialize(getSequentializationKey));

// ================================
// SIMPLIFIED HELPER FUNCTIONS
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
  const lastArg = args[args.length - 1];
  if (!lastArg) return null;

  const isSol = lastArg.toUpperCase() === "SOL";
  const amountArg = args[argIndex];
  if (!amountArg) return null;

  const rawAmount = parseFloat(amountArg);

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

// Helper function to process transactions with loading state
const validateAndProcessTransaction = async (
  ctx: Context,
  telegramId: bigint,
  amount: number,
  isSol: boolean,
  description: string,
  transactionFn: (playerData: PlayerData) => Promise<string>
): Promise<void> => {
  const playerData = await getPlayerData(telegramId);
  const metadata = await getTokenMetadata();

  // Claim winnings if not using SOL
  if (!isSol) {
    await claimWinnings(playerData.keypair);
  }

  // Validate balance
  const totalBalance = isSol ? playerData.solBalance : playerData.tokenBalance + playerData.gameBalance;
  if (totalBalance < amount) {
    const balanceStr = isSol
      ? `${wallet.formatSolBalance(totalBalance)} SOL`
      : `${wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${TICKER}`;
    const needStr = isSol
      ? `${wallet.formatSolBalance(amount)} SOL`
      : `${wallet.formatTokenBalance(amount, metadata.decimals)} ${TICKER}`;

    await ctx.reply(`Insufficient balance. You have ${balanceStr} but need ${needStr}`, {
      reply_to_message_id: ctx.message?.message_id
    });
    return;
  }

  // Process transaction with loading state
  const processingMsg = await ctx.reply(`Processing ${description}...`, {
    reply_to_message_id: ctx.message?.message_id
  });

  try {
    const tx = await transactionFn(playerData);
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

// Helper function for consistent replies
const replyToMessage = async (ctx: Context, text: string, parseMode: "HTML" | "MarkdownV2" = "HTML"): Promise<void> => {
  await ctx.reply(text, {
    parse_mode: parseMode,
    reply_to_message_id: ctx.message?.message_id
  });
};

// Helper function for usage error messages
const replyUsageError = async (ctx: Context, message: string): Promise<void> => {
  return replyToMessage(ctx, message);
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
    return replyUsageError(ctx, "Usage: /coinflip <amount> <maxPlayers>\nExample: /coinflip 10 2");
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
    return replyUsageError(ctx, "Usage: /giveaway <amount> <maxPlayers>\nExample: /giveaway 100 5");
  }

  await gameManager.createGame(ctx, "giveaway", parsed.amount, maxPlayers, 1, GAME_TIMEOUT);
});

// Implement withdraw command
bot.command(["withdraw", "wh"], async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 3) {
    return replyUsageError(ctx, "Usage: /withdraw <address> <amount> or /withdraw <address> <amount> SOL");
  }

  const addressArg = args[1];
  if (!addressArg) {
    return replyToMessage(ctx, "Invalid wallet address. Please provide a valid Solana address.");
  }

  let toAddress: PublicKey;
  try {
    toAddress = new PublicKey(addressArg);
  } catch {
    return replyToMessage(ctx, "Invalid wallet address. Please provide a valid Solana address.");
  }

  const parsed = await parseAmount(args, 2);
  if (!parsed) {
    return replyToMessage(ctx, "Please provide a valid amount greater than 0.");
  }

  try {
    await validateAndProcessTransaction(
      ctx,
      telegramId,
      parsed.amount,
      parsed.isSol,
      `Withdrawal of ${parsed.formattedAmount}`,
      async (playerData) => {
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
      }
    );
  } catch (error: any) {
    await handleCommandError(ctx, error, "withdraw");
  }
});

// Implement tip command
bot.command("tip", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const repliedMessage = ctx.message?.reply_to_message;
  const args = ctx.message?.text?.split(" ");

  if (!repliedMessage || !repliedMessage.from || !args || args.length < 2) {
    return replyUsageError(ctx, "Usage: Reply to a user's message with /tip <amount> or /tip <amount> SOL");
  }

  // Check if the recipient is a bot
  if (repliedMessage.from.is_bot) {
    return replyToMessage(ctx, "You cannot tip bots!");
  }

  const recipientTelegramId = BigInt(repliedMessage.from.id);
  if (recipientTelegramId === telegramId) {
    return replyToMessage(ctx, "You can't tip yourself!");
  }

  const parsed = await parseAmount(args);
  if (!parsed) {
    return replyToMessage(ctx, "Please provide a valid amount greater than 0.");
  }

  try {
    const recipientPubKey = wallet.getPublicKey(recipientTelegramId);
    const recipientName = repliedMessage.from.username
      ? `@${repliedMessage.from.username}`
      : repliedMessage.from.first_name || "User";

    await validateAndProcessTransaction(
      ctx,
      telegramId,
      parsed.amount,
      parsed.isSol,
      `Tip of ${parsed.formattedAmount} to ${recipientName}`,
      async (playerData) => {
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
      }
    );
  } catch (error: any) {
    await handleCommandError(ctx, error, "tip");
  }
});

// Implement wrap command
bot.command("wrap", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const args = ctx.message?.text?.split(" ");

  if (!args) return;

  const amount = parseFloat(args?.[1] || "0") * LAMPORTS_PER_SOL;

  if (amount <= 0) {
    return replyUsageError(ctx, "Usage: /wrap <amount>\nExample: /wrap 0.1");
  }

  try {
    await validateAndProcessTransaction(
      ctx,
      telegramId,
      amount,
      true, // isSol
      `Wrapping ${wallet.formatSolBalance(amount)} SOL to WSOL`,
      async (playerData) => {
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
      }
    );
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
    `/oracle - Check Oracle configuration\n` +
    `/scan - Scan blockchain for orphaned games (private chat only)\n\n` +
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
  if (!signature) {
    return ctx.reply("Usage: /checktx <transaction_signature>", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  try {
    console.log(`Checking transaction: ${signature}`);

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

    let response = `🔐 <b>Your Private Key</b>\n\n`;
    response += `⚠️ <b>SECURITY WARNING:</b>\n`;
    response += `• Never share your private key with anyone\n`;
    response += `• Store it securely offline\n`;
    response += `• Anyone with this key has full access to your wallet\n\n`;
    response += `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>\n\n`;
    response += `Private Key (Array Format):\n<code>${privateKeyString}</code>\n\n`;
    response += `Private Key (Base58 Format):\n<code>${Buffer.from(playerData.keypair.secretKey).toString('base64')}</code>\n\n`;
    response += `💡 You can import this key into Phantom, Solflare, or other Solana wallets.`;

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

// Add after the existing commands, before the callback query handler
bot.command("scan", async (ctx: Context) => {
  // Only allow this command in private chats or from specific users for security
  if (ctx.chat?.type !== "private") {
    return ctx.reply("🔒 This command can only be used in private messages for security reasons.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  try {
    const processingMsg = await ctx.reply("🔍 Starting blockchain scan for orphaned games...", {
      reply_to_message_id: ctx.message?.message_id
    });

    await gameManager.scanBlockchainForOrphanedGames();

    // Get statistics after the scan
    const stats = gameDb.getOrphanedGameStats();

    let response = "✅ Blockchain scan completed successfully!\n\n";
    response += `📊 <b>Orphaned Game Statistics:</b>\n`;
    response += `Total Found: ${stats.total}\n`;
    response += `Active: ${stats.active}\n`;
    response += `Completed: ${stats.completed}\n`;
    response += `Failed: ${stats.failed}\n\n`;
    response += `Check console logs for detailed information.`;

    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      response,
      { parse_mode: "HTML" }
    );
  } catch (error) {
    await handleCommandError(ctx, error, "scan");
  }
});

// Handle callback queries for game actions
bot.on("callback_query", async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  if (!callbackData || !ctx.from) return;

  const splitData = callbackData.split("_");
  if (splitData.length < 2) return;

  const [action, gameAddress] = splitData;
  if (!gameAddress) return;

  const game = await gameDb.getGame(gameAddress);

  if (!game) {
    await ctx.answerCallbackQuery("Game not found!");
    return;
  }

  // Check if the game is completed before allowing any actions
  if (game.status === "completed") {
    // For completed games, update the message with final state instead of just showing a popup
    try {
      const creatorUsername = await gameManager.getGameCreatorUsername(ctx, game.game_address);
      const gameData = gameDb.getGame(game.game_address);

      if (gameData) {
        // Determine game type from database
        const gameType = gameData.game_type ?
          gameData.game_type.charAt(0).toUpperCase() + gameData.game_type.slice(1) :
          "Game";

        await gameManager.updateGameMessage(
          ctx,
          game.game_address,
          gameType,
          Number(game.amount),
          creatorUsername,
          "Completed",
          gameData.winner_address || undefined
        );

        const statusMessage = gameData.winner_address === "cancelled" ? "cancelled" : "completed";
        await ctx.answerCallbackQuery(`Game ${statusMessage} - message updated!`);
      } else {
        const statusMessage = game.winner_address === "cancelled" ? "cancelled" : "completed";
        await ctx.answerCallbackQuery(`This game has already been ${statusMessage}!`);
      }
    } catch (error) {
      console.error("Error updating completed game message:", error);
      const statusMessage = game.winner_address === "cancelled" ? "cancelled" : "completed";
      await ctx.answerCallbackQuery(`This game has already been ${statusMessage}!`);
    }
    return;
  }

  try {
    const gamePda = new PublicKey(gameAddress);
    const telegramId = BigInt(ctx.from.id);
    const playerKp = wallet.getKeyPair(telegramId);

    switch (action) {
      case "join":
        await handleJoinGame(ctx, gamePda, playerKp, telegramId, game);
        break;
      case "unjoin":
        await gameManager.unjoinGame(ctx, gamePda, playerKp);
        await ctx.answerCallbackQuery("Successfully unjoined the game!");
        break;
      case "refresh":
        await handleRefreshGame(ctx, gamePda, game);
        break;
    }
  } catch (error: any) {
    console.error(`Error in callback ${action}:`, error);

    // Handle specific case where account doesn't exist (game was completed/cancelled)
    if (error.message?.includes('Account does not exist')) {
      // Update database if needed
      if (game.status === "active") {
        gameDb.completeGame(game.game_address, "cancelled", Date.now());
      }
      await ctx.answerCallbackQuery("This game is no longer active!");
    } else {
      const userFriendlyError = formatUserFriendlyError(error, wallet);
      await ctx.answerCallbackQuery(userFriendlyError.substring(0, 180));
    }
  }
});

// Helper functions for callback handling
const handleJoinGame = async (ctx: any, gamePda: PublicKey, playerKp: any, telegramId: bigint, game: any) => {
  if (game.status !== "active") {
    await ctx.answerCallbackQuery("This game is no longer active!");
    return;
  }

  try {
    const gameAccount = await program.account.game.fetch(gamePda);
    const players = gameAccount.players;

    const isAlreadyInGame = players.some((p: PublicKey) => p.equals(playerKp.publicKey));
    if (isAlreadyInGame) {
      await ctx.answerCallbackQuery("You have already joined this game!");
      return;
    }

    if (players.length >= gameAccount.maxPlayers) {
      await ctx.answerCallbackQuery("This game is already full!");
      return;
    }

    // Check balance
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
          return 0;
        }
      })()
    ]);

    const gameAmount = Number(gameAccount.amount);
    const totalBalance = tokenBalance + gameBalance;

    // Only check balance for coinflips, giveaways are free to join
    const currentGameType = Object.keys(gameAccount.gameType)[0];
    if (currentGameType === "coinflip" && totalBalance < gameAmount) {
      const metadata = await getTokenMetadata();
      await ctx.answerCallbackQuery(`Insufficient balance. You have ${wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${TICKER} but need ${wallet.formatTokenBalance(gameAmount, metadata.decimals)} ${TICKER}`);
      return;
    }

    // Ensure player balance and join
    await gameManager.ensurePlayerBalance(playerKp);

    if (gameAccount.isPrivate) {
      const result = await gameManager.joinPrivateGame(gamePda, playerKp, ctx.chat?.id || 0);
      if (!result.success) {
        await ctx.answerCallbackQuery(result.error || "Failed to join private game");
        return;
      }
    } else {
      const tx = await program.methods
        .joinGame()
        .accounts({
          game: gamePda,
          player: playerKp.publicKey,
        })
        .signers([playerKp])
        .rpc();
      await wallet.confirmTransaction(tx);
    }

    // Save player mapping and participant
    const playerPubkey = playerKp.publicKey.toBase58();
    gameDb.savePlayerMapping(playerPubkey, telegramId.toString());
    gameDb.saveGameParticipant(game.game_address, telegramId.toString(), playerPubkey);

    // Update game message
    const creatorUsername = await gameManager.getGameCreatorUsername(ctx, game.game_address);
    const gameTypeKeys = Object.keys(gameAccount.gameType);
    const gameType = gameTypeKeys[0] ? gameTypeKeys[0].charAt(0).toUpperCase() + gameTypeKeys[0].slice(1) : "Game";
    await gameManager.updateGameMessage(ctx, game.game_address, gameType, Number(game.amount), creatorUsername, "Active");

    // Send join notification
    const joinerUsername = ctx.from?.username || ctx.from?.first_name || "Player";
    const updatedGameAccount = await program.account.game.fetch(gamePda);
    const playerCount = updatedGameAccount.players.length;
    const maxPlayers = gameAccount.maxPlayers;
    const gameName = gameType.toLowerCase();

    const gameMessage = gameManager.getActiveGameMessage(game.game_address);
    await ctx.reply(
      `🎮 @${joinerUsername} joined the ${gameName}! (${playerCount}/${maxPlayers} players)`,
      {
        parse_mode: "HTML",
        reply_to_message_id: gameMessage?.messageId
      }
    );

    // Auto-complete if full
    if (updatedGameAccount.players.length === gameAccount.maxPlayers) {
      await new Promise(resolve => setTimeout(resolve, GAME_COMPLETION_WAIT_MS));
      const finalGameAccount = await program.account.game.fetch(gamePda);
      if (finalGameAccount.players.length === gameAccount.maxPlayers) {
        const completed = await gameManager.autoCompleteGame(gamePda);
        if (!completed) {
          ctx.reply("⚠️ Game is full but could not be automatically completed. Please try again later or contact support.");
        }
      }
    }
  } catch (error: any) {
    // Handle specific case where account doesn't exist
    if (error.message?.includes('Account does not exist')) {
      // Update database if needed
      if (game.status === "active") {
        gameDb.completeGame(game.game_address, "cancelled", Date.now());
      }
      await ctx.answerCallbackQuery("This game is no longer active!");
    } else {
      // Re-throw the error to be handled by the outer catch block
      throw error;
    }
  }
};

const handleRefreshGame = async (ctx: any, gamePda: PublicKey, game: any) => {
  // First check if the game is completed in the database
  const gameData = gameDb.getGame(game.game_address);
  if (!gameData) {
    await ctx.answerCallbackQuery("Game not found!");
    return;
  }

  // If the game is completed, we can't fetch the account from blockchain since it's closed
  if (gameData.status === "completed") {
    await ctx.answerCallbackQuery("This game has already been completed!");
    return;
  }

  try {
    // Only try to fetch from blockchain if the game is still active
    const currentGameAccount = await program.account.game.fetch(gamePda);
    const creatorUsername = await gameManager.getGameCreatorUsername(ctx, game.game_address);
    const gameTypeKeys = Object.keys(currentGameAccount.gameType);
    const gameType = gameTypeKeys[0] ? gameTypeKeys[0].charAt(0).toUpperCase() + gameTypeKeys[0].slice(1) : "Game";

    await gameManager.updateGameMessage(
      ctx,
      game.game_address,
      gameType,
      Number(game.amount),
      creatorUsername,
      "Active"
    );

    await ctx.answerCallbackQuery("Game status refreshed!");
  } catch (error: any) {
    // Handle the case where the account doesn't exist (game was completed/cancelled)
    if (error.message?.includes('Account does not exist')) {
      // Mark the game as completed in the database if it's not already
      if (gameData.status === "active") {
        gameDb.completeGame(game.game_address, "cancelled", Date.now());
      }
      await ctx.answerCallbackQuery("This game is no longer active!");
    } else {
      console.error(`Error refreshing game ${game.game_address}:`, error);
      await ctx.answerCallbackQuery("Error refreshing game status!");
    }
  }
};

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Helper function to claim winnings
const claimWinnings = async (playerKp: anchor.web3.Keypair): Promise<number> => {
  const playerBalancePda = PDAManager.getPlayerBalancePDA(
    playerKp.publicKey,
    new PublicKey(TOKEN_MINT),
    program.programId
  );

  try {
    const playerBalance = await program.account.playerBalance.fetch(playerBalancePda);
    const claimableAmount = Number(playerBalance.amount);

    if (claimableAmount <= 0) {
      return 0;
    }

    const tx = await program.methods
      .withdrawPlayerBalance()
      .accounts({
        player: playerKp.publicKey,
        tokenMint: new PublicKey(TOKEN_MINT),
      })
      .signers([playerKp])
      .rpc();

    await wallet.confirmTransaction(tx);
    return claimableAmount;
  } catch (error: any) {
    if (error.message?.includes('Account does not exist')) {
      return 0;
    }
    throw error;
  }
};

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
        const gameTypeKeys = Object.keys(event.gameType);
        const gameType = gameTypeKeys[0] ? gameTypeKeys[0].charAt(0).toUpperCase() + gameTypeKeys[0].slice(1) : "Game";

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
        const gameTypeKeys = Object.keys(event.gameType);
        const gameType = gameTypeKeys[0] ? gameTypeKeys[0].charAt(0).toUpperCase() + gameTypeKeys[0].slice(1) : "Game";

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

          // Skip orphaned games - they are handled by blockchain scan
          if (game.creator_telegram_id === "orphaned") {
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

  // Start periodic blockchain scan for orphaned games (less frequent)
  setInterval(async () => {
    try {
      await gameManager.scanBlockchainForOrphanedGames();
    } catch (error) {
      console.error("Error in periodic blockchain scan:", error);
    }
  }, BLOCKCHAIN_SCAN_INTERVAL_MS); // Check every 15 minutes

  console.log(`🔍 Periodic blockchain scan enabled (every ${BLOCKCHAIN_SCAN_INTERVAL_MS / 60000} minutes)`);

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
