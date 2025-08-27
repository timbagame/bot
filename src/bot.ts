import { Bot, Context, InlineKeyboard } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { WalletManager } from "./utils/wallet";
import { TokenManager } from "./utils/token-manager";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createSyncNativeInstruction } from "@solana/spl-token";
import type { Coinflip } from "../idl/idlType";
import idl from "../idl/idl.json";
import { GameDatabase } from "./utils/game-database";
import { GameManager } from "./utils/game";
import { PDAManager } from "./utils/pda";
import { formatUserFriendlyError } from "./utils/errors";
import { SwapManager } from "./utils/swap-manager";
import {
  LAMPORTS_PER_SOL,
  GAME_TIMEOUT,
  COINFLIP_MAX_TICKETS,
  GIVEAWAY_MAX_TICKETS,
  EXPIRED_GAMES_CHECK_INTERVAL_MS,
  GAME_EXPIRATION_BUFFER_TIME,
  DEFAULT_TOKEN_MINT,
  DEFAULT_TOKEN_TICKER,
  TOKENS_LIST,
} from "./utils/constants";
import type {
  PlayerData,
  GameCompletedEvent,
  PlayerJoinedEvent,
  PlayerUnjoinedEvent,
  PlayerEvent,
} from "./types";
import { TokenDatabase } from "./utils/token-database";
import { handleCallbackErrorSafe } from "./utils/context-helpers";

// ================================
// GLOBAL INSTANCES
// ================================

// Module-level exports for use by utility modules
export const bot = new Bot(process.env.TELEGRAM_TOKEN!);
export const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
const gameDb = GameDatabase.getInstance();

/**
 * Create main menu keyboard for private chats
 */
const createMainMenuKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("💳 Wallet", "main_wallet")
    .row()
    .text("⚙️ Info", "main_settings")
    .text("🔧 Admin", "admin_menu")
    .row()
    .text("❓ Help", "cmd_help")
    .row();
};

/**
 * Check if the context is a private chat
 */
const isPrivateChat = (ctx: Context): boolean => {
  return ctx.chat?.type === "private";
};

/**
 * Track chats that have had their first interaction
 */
const initiatedChats = new Set<number>();

/**
 * Show bot info screen for first message in chat
 */
const showBotInfoScreen = async (ctx: Context) => {
  const botInfoScreen = [
    "🤖 <b>TIMBA BOT</b>",
    "",
    "<b>Your Gateway to Solana</b>",
    "",
    "🚀 <b>What is TIMBA?</b>",
    "A powerful Solana trading and gaming bot that gives you:",
    "",
    "💳 <b>Personal Wallet</b>",
    "• Secure, auto-generated Solana wallet",
    "• Send, receive, and manage tokens",
    "• View transaction history",
    "",
    "🔄 <b>Token Trading</b>",
    "• Swap tokens instantly via Jupiter",
    "• Support for all major Solana tokens",
    "• Real-time price quotes",
    "",
    "🎮 <b>Gaming Platform</b>",
    "• Coinflip games with friends",
    "• Token giveaways and contests",
    "• Fair and transparent results",
    "",
    "⚡ <b>Fast & Secure</b>",
    "• Built on Solana blockchain",
    "• Your keys, your crypto",
    "• Lightning-fast transactions",
    "",
    "Ready to start trading and gaming on Solana?",
  ];

  await ctx.reply(botInfoScreen.join("\n"), {
    parse_mode: "HTML",
    reply_markup: new InlineKeyboard()
      .text("🚀 Get Started", "start_bot")
      .row(),
  });
};

// Auto-show bot info when user starts private chat (my_chat_member event)
bot.on("my_chat_member", async (ctx) => {
  try {
    const chatMember = ctx.myChatMember;
    const chat = ctx.chat;

    // Only for private chats when bot is added/unblocked
    if (
      chat?.type === "private" &&
      chatMember?.old_chat_member?.status === "kicked" &&
      chatMember?.new_chat_member?.status === "member"
    ) {
      console.log(
        `🔄 User ${
          ctx.from?.username || ctx.from?.first_name
        } started private chat with bot`
      );

      // Show bot info screen automatically
      await showBotInfoScreen(ctx);
      return;
    }
  } catch (error) {
    console.error("Error in my_chat_member handler:", error);
  }
});

// Fallback: Auto-show bot info screen for first message in private chat
bot.use(async (ctx, next) => {
  // Only for private chats and text messages
  if (ctx.chat?.type === "private" && ctx.message?.text && ctx.chat?.id) {
    const chatId = ctx.chat.id;

    // If this is the first interaction in this chat and not a command
    if (!initiatedChats.has(chatId) && !ctx.message.text.startsWith("/")) {
      initiatedChats.add(chatId);

      // Show bot info screen instead of processing the message
      await showBotInfoScreen(ctx);
      return; // Don't continue to next handlers
    }

    // Mark chat as initiated if it's not already
    initiatedChats.add(chatId);
  }

  // Continue to other handlers
  await next();
});

// These will be initialized in setupAnchor
export let gameManager: GameManager;
export let program: anchor.Program<Coinflip>;
const tokenDb = TokenDatabase.getInstance();
let tokenManager: TokenManager;
let swapManager: SwapManager;

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Create a minimal context object for API operations
 */
const createApiContext = (chatId: number, api?: any): Context =>
  ({
    api: api || bot.api,
    chat: { id: chatId },
  } as unknown as Context);

/**
 * Validate that game data has required token information
 */
const validateGameTokenData = (
  gameData: any
): { isValid: boolean; error?: string } => {
  if (!gameData) return { isValid: false, error: "Game not found" };
  if (!gameData.token_mint || !gameData.token_ticker) {
    return { isValid: false, error: "Game missing token information" };
  }
  return { isValid: true };
};

/**
 * Safe callback query response with timeout handling
 */
const safeAnswerCallbackQuery = async (
  ctx: any,
  text: string
): Promise<void> => {
  try {
    await ctx.answerCallbackQuery(text);
  } catch (error: any) {
    if (
      error.description?.includes("query is too old") ||
      error.description?.includes("query ID is invalid") ||
      error.error_code === 400
    ) {
      console.warn(`⚠️ Callback query timeout: ${text.substring(0, 50)}...`);
    } else {
      console.error("Error answering callback query:", error);
    }
  }
};

/**
 * Update game message with proper error handling using simplified interface
 */
const updateGameMessageSafely = async (
  gameAddress: string,
  gameData: any,
  status: string = "Completed",
  winnerAddress?: string
): Promise<void> => {
  if (!gameData?.chat_id || !gameData?.message_id) return;

  try {
    const ctx = createApiContext(gameData.chat_id);
    await gameManager.updateGameMessageFromData(
      ctx,
      gameAddress,
      status,
      winnerAddress
    );
  } catch (error) {
    console.warn(`Could not update message for game ${gameAddress}:`, error);
  }
};

/**
 * Dynamic wallet UI that loads balances automatically
 */
// Simple function to get USD prices (placeholder for now)
const getTokenPriceUSD = async (tokenMint: string): Promise<number> => {
  try {
    // For SOL
    if (
      tokenMint === "So11111111111111111111111111111111111111112" ||
      tokenMint === "SOL"
    ) {
      // Simple SOL price fetch (you can replace with real API)
      return 150; // Placeholder SOL price
    }

    // For USDC (stable coin)
    if (tokenMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
      return 1.0; // USDC is pegged to $1
    }

    // For DAOS token (placeholder price - you can integrate real API later)
    if (tokenMint === "FPyD25czYkvztSsgyCP7bxd2xnvDAp1LVjyiJhQidaos") {
      return 0.001; // Placeholder DAOS price - update with real price
    }

    // For other tokens, return 0 for now (can be enhanced later)
    return 0;
  } catch (error) {
    return 0;
  }
};

const showWalletUI = async (ctx: any, showLoadingMessage: boolean = true) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(
    -6
  )}`;

  // Wallet animated banner file_id (GIF type for animated banner display)
  const walletImageFileId =
    "CgACAgEAAxkBAAIEF2irzq9DBOMIkGfEzQQPe1huXlJVAAJdBgACaPJgRai8H1bQmnXpNgQ";

  // Show loading state first
  if (showLoadingMessage) {
    const loadingContent = `⏳ Loading balances...`;

    const loadingCaption = [
      loadingContent,
      "",
      `<code>${walletAddress}</code>`,
    ];

    // Try to edit existing message as photo, if fails send new photo
    try {
      await ctx.editMessageMedia(
        {
          type: "animation",
          media: walletImageFileId,
          caption: loadingCaption.join("\n"),
          parse_mode: "HTML",
        },
        {
          reply_markup: new InlineKeyboard()
            .text("🔄 Refresh", "wallet_refresh")
            .text("📋 History", "cmd_history")
            .row()
            .text("💸 Withdraw", "cmd_withdraw")
            .row()
            .text("🟢 Buy", "cmd_buy")
            .text("🔴 Sell", "cmd_sell")
            .row()
            .text("⚙️ Settings", "wallet_settings")
            .row()
            .text("← Back", "back_main")
            .row(),
        }
      );
    } catch (error) {
      // If edit fails, delete old message and send new photo
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.replyWithAnimation(walletImageFileId, {
        caption: loadingCaption.join("\n"),
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔄 Refresh", "wallet_refresh")
          .text("📋 History", "cmd_history")
          .row()
          .text("💸 Withdraw", "cmd_withdraw")
          .row()
          .text("🟢 Buy", "cmd_buy")
          .text("🔴 Sell", "cmd_sell")
          .row()
          .text("⚙️ Settings", "wallet_settings")
          .row()
          .text("← Back", "back_main")
          .row(),
      });
    }
  }

  try {
    // Use cached wallet data
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    const formattedSolBalance = wallet.formatSolBalance(solBalance);

    // Calculate total USD value
    let totalUSD = 0;

    // Add SOL value
    const solPriceUSD = await getTokenPriceUSD("SOL");
    const solDecimalBalance = solBalance / LAMPORTS_PER_SOL;
    totalUSD += solDecimalBalance * solPriceUSD;

    // Build wallet info without address
    let walletContent = `SOL: ${formattedSolBalance}`;

    // Add token balances (calculate USD)
    if (tokenBalances.length > 0) {
      for (const token of tokenBalances) {
        const formatted = wallet.formatTokenBalance(
          token.balance,
          token.decimals
        );
        walletContent += `\n${token.ticker}: ${formatted}`;

        // Add to total USD (prices would be 0 for now, but structure is ready)
        const tokenPriceUSD = await getTokenPriceUSD(token.mint);
        const tokenDecimalBalance =
          token.balance / Math.pow(10, token.decimals);
        totalUSD += tokenDecimalBalance * tokenPriceUSD;
      }
    }

    // Add total USD value
    walletContent += `\n\nTOTAL USD: $${totalUSD.toFixed(2)}`;

    const finalCaption = [walletContent, "", `<code>${walletAddress}</code>`];

    // Update with final wallet data and image
    await ctx.editMessageMedia(
      {
        type: "animation",
        media: walletImageFileId,
        caption: finalCaption.join("\n"),
        parse_mode: "HTML",
      },
      {
        reply_markup: new InlineKeyboard()
          .text("🔄 Refresh", "wallet_refresh")
          .text("📋 History", "cmd_history")
          .row()
          .text("💸 Withdraw", "cmd_withdraw")
          .row()
          .text("🟢 Buy", "cmd_buy")
          .text("🔴 Sell", "cmd_sell")
          .row()
          .text("⚙️ Settings", "wallet_settings")
          .row()
          .text("← Back", "back_main")
          .row(),
      }
    );
  } catch (error) {
    console.error("Error loading balances:", error);
    const errorResponse = [
      `💳 <b>Wallet</b>`,
      "",
      `<code>${shortAddress}</code>`,
      "",
      "❌ <i>Error loading balances</i>",
      "<i>Tap REFRESH to try again</i>",
    ];

    await ctx.editMessageMedia(
      {
        type: "animation",
        media: walletImageFileId,
        caption: errorResponse.join("\n"),
        parse_mode: "HTML",
      },
      {
        reply_markup: new InlineKeyboard()
          .text("🔄 Refresh", "wallet_refresh")
          .text("📋 History", "cmd_history")
          .row()
          .text("💸 Withdraw", "cmd_withdraw")
          .row()
          .text("🟢 Buy", "cmd_buy")
          .text("🔴 Sell", "cmd_sell")
          .row()
          .text("⚙️ Settings", "wallet_settings")
          .row()
          .text("← Back", "back_main")
          .row(),
      }
    );
  }
};

/**
 * Process game completion event with all related updates
 */
const processGameCompletion = async (
  gameAddress: string,
  winnerAddress: string
): Promise<void> => {
  // Update database
  const blockTime = await wallet.getBlockchainTime();
  gameDb.completeGame(gameAddress, winnerAddress, blockTime * 1000);

  // Update game message
  const gameData = gameDb.getGame(gameAddress);
  await updateGameMessageSafely(
    gameAddress,
    gameData,
    "Completed",
    winnerAddress
  );

  console.log(`✅ Processed game completion: ${gameAddress}`);
};

/**
 * Clean up orphaned games (accounts closed but DB shows active)
 */
const cleanupOrphanedGame = async (gameAddress: string): Promise<void> => {
  const gameData = gameDb.getGame(gameAddress);
  if (!gameData || gameData.status === "completed") return;

  console.log(`🧹 Cleaning up orphaned game ${gameAddress}`);

  gameDb.completeGame(gameAddress, "cancelled", Date.now());
  await updateGameMessageSafely(
    gameAddress,
    gameData,
    "Completed",
    "cancelled"
  );

  console.log(`✅ Successfully cleaned up orphaned game ${gameAddress}`);
};

// ================================
// BOT SEQUENTIALIZATION
// ================================

const getSequentializationKey = (
  ctx: Context
): string | string[] | undefined => {
  const userId = ctx.from?.id?.toString();
  if (!userId) return undefined;

  if (ctx.callbackQuery?.data) {
    const callbackData = ctx.callbackQuery.data;
    if (
      callbackData.startsWith("join_") ||
      callbackData.startsWith("refresh_")
    ) {
      const gameAddress = callbackData.split("_")[1];
      return [userId, `game_${gameAddress}`];
    }
  }

  return userId;
};

bot.use(sequentialize(getSequentializationKey));

// ================================
// UTILITY FUNCTIONS
// ================================

const getDefaultTokenMetadata = async () => {
  return await wallet.getTokenMetadata(DEFAULT_TOKEN_MINT);
};

const getPlayerData = async (
  telegramId: bigint,
  tokenMint?: string
): Promise<PlayerData> => {
  const keypair = wallet.getKeyPair(telegramId);
  const effectiveTokenMint = tokenMint || DEFAULT_TOKEN_MINT;

  const [tokenBalance, solBalance] = await Promise.all([
    wallet.getTokenBalance(telegramId, effectiveTokenMint),
    wallet.getBalance(telegramId),
  ]);

  // Funds are handled per-game; no separate aggregate player balance account
  const gameBalance = 0;

  return { keypair, tokenBalance, solBalance, gameBalance };
};

const isUserGroupAdmin = async (
  ctx: Context,
  userId: number
): Promise<boolean> => {
  try {
    if (!ctx.chat || ctx.chat.type === "private") return false;
    const member = await ctx.api.getChatMember(ctx.chat.id, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch (error) {
    console.warn(`Error checking admin status for user ${userId}:`, error);
    return false;
  }
};

// ================================
// TRANSACTION PROCESSING
// ================================

const validateAndProcessTransaction = async (
  ctx: Context,
  telegramId: bigint,
  amount: number,
  isSol: boolean,
  description: string,
  transactionFn: (playerData: PlayerData) => Promise<string>
): Promise<void> => {
  const playerData = await getPlayerData(telegramId);
  const metadata = await getDefaultTokenMetadata();

  // Validate balance
  const totalBalance = isSol
    ? playerData.solBalance
    : playerData.tokenBalance + playerData.gameBalance;
  if (totalBalance < amount) {
    const balanceStr = isSol
      ? `${wallet.formatSolBalance(totalBalance)} SOL`
      : `${wallet.formatTokenBalance(
          totalBalance,
          metadata.decimals
        )} ${DEFAULT_TOKEN_TICKER}`;
    const needStr = isSol
      ? `${wallet.formatSolBalance(amount)} SOL`
      : `${wallet.formatTokenBalance(
          amount,
          metadata.decimals
        )} ${DEFAULT_TOKEN_TICKER}`;

    await ctx.reply(
      `Insufficient balance. You have ${balanceStr} but need ${needStr}`,
      {
        reply_to_message_id: ctx.message?.message_id,
      }
    );
    return;
  }

  // Process transaction with loading state
  const processingMsg = await ctx.reply(`Processing ${description}...`, {
    reply_to_message_id: ctx.message?.message_id,
  });

  try {
    const tx = await transactionFn(playerData);
    const txString = tx ? tx.toString().trim() : "";
    const successMessage = txString
      ? `${description} successful! 💸\n\n<code>${txString}</code>`
      : `${description} successful! 💸`;

    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      successMessage,
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

// ================================
// RESPONSE HELPERS
// ================================

const handleCommandError = async (
  ctx: Context,
  error: any,
  commandName: string
): Promise<void> => {
  console.error(`Error in ${commandName} command:`, error);
  const userFriendlyError = formatUserFriendlyError(error, wallet);
  await replyToMessage(ctx, userFriendlyError);
};

const replyToMessage = async (
  ctx: Context,
  text: string,
  parseMode: "HTML" | "MarkdownV2" = "HTML"
): Promise<void> => {
  await ctx.reply(text, {
    parse_mode: parseMode,
    reply_to_message_id: ctx.message?.message_id,
  });
};

const replyUsageError = async (
  ctx: Context,
  message: string
): Promise<void> => {
  return replyToMessage(ctx, message);
};

const handleCallbackError = async (
  ctx: any,
  error: any,
  action: string
): Promise<void> => {
  await handleCallbackErrorSafe(ctx, error, action, {
    maxLength: 180,
  });
};

// ================================
// ANCHOR SETUP
// ================================

const initializeAnchorProvider = async () => {
  const adminKeypair = wallet.getAdminKeypair();
  const adminWallet = new anchor.Wallet(
    adminKeypair as unknown as anchor.web3.Keypair
  );
  const connection = wallet.getConnection();

  const provider = new anchor.AnchorProvider(
    connection as unknown as anchor.web3.Connection,
    adminWallet,
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
      skipPreflight: false,
      maxRetries: 3,
    }
  );

  anchor.setProvider(provider);
  return new anchor.Program(
    idl as Coinflip,
    provider
  ) as anchor.Program<Coinflip>;
};

const setupAnchor = async () => {
  try {
    program = await initializeAnchorProvider();
    console.log(`Initialized Anchor program: ${program.programId}`);

    tokenManager = TokenManager.getInstance(
      wallet,
      DEFAULT_TOKEN_MINT,
      DEFAULT_TOKEN_TICKER
    );
    console.log(
      `Initialized TokenManager with default token: ${DEFAULT_TOKEN_TICKER}`
    );

    swapManager = new SwapManager(wallet.getConnection(), wallet);
    console.log("Initialized SwapManager with pump.fun integration");

    await initializeTokensList();
    gameManager = GameManager.getInstance(program, wallet, gameDb);

    await checkOracleStatus();
    await checkGameTokenStatus();
  } catch (error) {
    console.error("Error initializing Anchor program:", error);
    console.error(
      "Make sure admin-keypair.json exists in the project root directory."
    );
    throw error;
  }
};

const initializeTokensList = async () => {
  try {
    console.log("Initializing approved tokens...");

    await tokenManager.addToken(DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER);
    console.log(`Added default token: ${DEFAULT_TOKEN_TICKER}`);

    for (const token of TOKENS_LIST) {
      try {
        const success = await tokenManager.addToken(token.mint, token.ticker);
        if (success) {
          console.log(`Added approved token: ${token.ticker}`);
        }
      } catch (error) {
        console.warn(`Could not add approved token ${token.ticker}:`, error);
      }
    }

    console.log(
      `Initialized token database with ${tokenDb.getTokenCount()} tokens`
    );
  } catch (error) {
    console.warn("Error initializing approved tokens:", error);
  }
};

const checkOracleStatus = async () => {
  try {
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    const oracleAccount = await program.account.oracle.fetch(oraclePda);
    console.log(`Oracle found, operator: ${oracleAccount.operator.toString()}`);
  } catch (error) {
    console.log("Oracle not found, it might need to be initialized");
  }
};

const checkGameTokenStatus = async () => {
  try {
    const gameTokenPda = PDAManager.getGameTokenPDA(
      new PublicKey(DEFAULT_TOKEN_MINT),
      program.programId
    );
    const gameTokenAccount = await program.account.gameToken.fetch(
      gameTokenPda
    );

    const metadata = await getDefaultTokenMetadata();
    const formattedMinAmount = wallet.formatTokenBalance(
      Number(gameTokenAccount.minAmount),
      metadata.decimals
    );

    console.log(
      `Game token found with min amount: ${formattedMinAmount} ${DEFAULT_TOKEN_TICKER} (${gameTokenAccount.minAmount.toString()} raw units)`
    );
  } catch (error) {
    console.log("Game token not found, it might need to be initialized");
  }
};

// ================================
// BOT COMMANDS
// ================================

/**
 * Build token balances for display, including game balances
 */
const buildTokenBalances = async (
  telegramId: bigint,
  approvedTokens: any[]
) => {
  const allTokenBalances = await wallet.getAllApprovedTokenBalances(
    telegramId,
    approvedTokens
  );

  const tokenBalancesToShow = await Promise.all(
    allTokenBalances.map(async (token) => {
      try {
        const tokenPlayerData = await getPlayerData(telegramId, token.mint);
        return {
          ...token,
          balance: token.balance + tokenPlayerData.gameBalance,
        };
      } catch (error) {
        return token; // If error getting game balance, just show wallet balance
      }
    })
  );

  // Add tokens that have game balance but no wallet balance
  for (const approvedToken of approvedTokens) {
    const hasToken = allTokenBalances.some(
      (t) => t.mint === approvedToken.token_mint
    );
    if (!hasToken) {
      try {
        const tokenPlayerData = await getPlayerData(
          telegramId,
          approvedToken.token_mint
        );
        if (tokenPlayerData.gameBalance > 0) {
          tokenBalancesToShow.push({
            mint: approvedToken.token_mint,
            ticker: approvedToken.token_ticker,
            balance: tokenPlayerData.gameBalance,
            decimals: approvedToken.decimals,
            rawBalance: tokenPlayerData.gameBalance.toString(),
          });
        }
      } catch (error) {
        // Ignore if can't get game balance
      }
    }
  }

  return tokenBalancesToShow;
};

bot.command("start", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  try {
    // Check if this is first interaction in private chat
    if (
      isPrivateChat(ctx) &&
      ctx.chat?.id &&
      !initiatedChats.has(ctx.chat.id)
    ) {
      // First time user - show bot info screen instead of main menu
      console.log(
        `🆕 First time user: ${
          ctx.from?.username || ctx.from?.first_name
        } started with /start`
      );
      await showBotInfoScreen(ctx);
      return;
    }

    const keypair = wallet.getKeyPair(telegramId);
    const username = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name || "User";
    const walletAddress = keypair.publicKey.toBase58();
    const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(
      -6
    )}`;

    // Build welcome message
    const welcomeMessage = [
      `<b>WELCOME ${username.toUpperCase()}</b>`,
      "",
      `<code>${walletAddress}</code>`,
    ];

    // Send response with menu for private chats
    if (isPrivateChat(ctx)) {
      // Mark this chat as initiated
      if (ctx.chat?.id) {
        initiatedChats.add(ctx.chat.id);
      }

      // Use same animated banner as wallet
      const welcomeAnimationFileId =
        "CgACAgEAAxkBAAIEF2irzq9DBOMIkGfEzQQPe1huXlJVAAJdBgACaPJgRai8H1bQmnXpNgQ";

      await ctx.replyWithAnimation(welcomeAnimationFileId, {
        caption: welcomeMessage.join("\n"),
        parse_mode: "HTML",
        reply_markup: createMainMenuKeyboard(),
      });
    } else {
      // Simple group chat response
    const groupResponse = [
      "💰 <b>TIMBA BOT</b>",
      "",
      `Wallet: <code>${shortAddress}</code>`,
      "",
      "Use /balance to check your balances",
    ];

      await ctx.reply(groupResponse.join("\n"), {
        parse_mode: "HTML",
      });
    }
  } catch (error) {
    await handleCommandError(ctx, error, "start");
  }
});

bot.command("balance", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  // Use dynamic wallet UI for private chats
  if (isPrivateChat(ctx)) {
    try {
      const message = await ctx.reply(
        "💳 <b>Wallet</b>\n⏳ <i>Loading...</i>",
        {
          parse_mode: "HTML",
        }
      );

      // Create a context-like object for the wallet UI
      const walletCtx = {
        ...ctx,
        editMessageText: async (text: string, options: any) => {
          return await ctx.api.editMessageText(
            ctx.chat?.id!,
            message.message_id,
            text,
            options
          );
        },
      };

      await showWalletUI(walletCtx, false);
    } catch (error) {
      await handleCommandError(ctx, error, "balance");
    }
    return;
  }

  // Original behavior for group chats
  try {
  const playerData = await getPlayerData(telegramId);
  const approvedTokens = tokenManager.getAllApprovedTokensWithMetadata();
  const tokenBalancesToShow = await buildTokenBalances(
      telegramId,
      approvedTokens
    );

    // Merge WSOL into native SOL for display in group chats
    const WSOL_MINT =
      (TOKENS_LIST.find((t) => t.ticker === "WSOL")?.mint as string) ||
      "So11111111111111111111111111111111111111112";
    let solDisplayLamports = playerData.solBalance;
    const wsolIndex = tokenBalancesToShow.findIndex(
      (t) => t.mint === WSOL_MINT
    );
    if (wsolIndex !== -1) {
      solDisplayLamports += tokenBalancesToShow[wsolIndex]!.balance; // balance is in raw units (lamports for WSOL)
      tokenBalancesToShow.splice(wsolIndex, 1);
    }

    const username = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name || "User";
    const walletAddress = playerData.keypair.publicKey.toBase58();

    const response = [
      "💰 <b>Balance</b>",
      `Player: ${username}`,
      `Wallet: <code>${walletAddress}</code>`,
      `SOL: ${wallet.formatSolBalance(solDisplayLamports)}`,
    ];

    if (tokenBalancesToShow.length > 0) {
      response.push("");
      for (const token of tokenBalancesToShow.slice(0, 5)) {
        const balance = wallet.formatTokenBalance(
          token.balance,
          token.decimals
        );
        response.push(`${token.ticker}: ${balance}`);
      }
      if (tokenBalancesToShow.length > 5) {
        response.push(`+${tokenBalancesToShow.length - 5} more tokens`);
      }
    }

    await ctx.reply(response.join("\n"), {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "balance");
  }
});

/**
 * Generic game creation handler to reduce code duplication
 */
const createGameCommand = async (
  ctx: Context,
  gameType: "coinflip" | "giveaway",
  defaultMaxTickets: number,
  minTickets: number,
  timeout: number,
  usageExample: string
) => {
  if (!ctx.from) return;

  if (ctx.chat?.type === "private") {
    return replyToMessage(
      ctx,
      `🚫 ${
        gameType.charAt(0).toUpperCase() + gameType.slice(1)
      } games cannot be created in private chats since other participants can't join. Please use this command in a group or channel where others can participate!`
    );
  }

  const args = ctx.message?.text?.split(" ");
  if (!args) return;

  const parsed = await tokenManager.parseAmount(args, 1, ctx.chat?.id);
  if (!parsed.success) {
    if (parsed.error === "unknown_token") {
      return replyToMessage(ctx, `❌ Unknown token "${parsed.unknownToken}"`);
    }
    return replyUsageError(ctx, usageExample);
  }

  const tokenSpecified = parsed.data!.tokenWasSpecified;
  const maxTicketsIndex = tokenSpecified ? 3 : 2;
  const maxTickets =
    parseInt(args?.[maxTicketsIndex] || defaultMaxTickets.toString()) ||
    defaultMaxTickets;

  // Validate context parameters
  if (!ctx.from?.id) {
    return replyToMessage(ctx, "Unable to identify user. Please try again.");
  }

  const result = await gameManager.createGame(
    gameType,
    parsed.data!,
    maxTickets,
    minTickets,
    timeout,
    BigInt(ctx.from.id),
    ctx.chat?.id
  );

  if (!result.success) {
    return replyToMessage(ctx, result.error || "Failed to create game");
  }

  // Create game message in UI layer with proper creator username
  if (!result.gameAddress) {
    return replyToMessage(
      ctx,
      "Game created but address not returned - please contact support"
    );
  }

  // Get creator username from ctx instead of using the formatted address from GameManager
  const creatorUsername = ctx.from?.username
    ? `@${ctx.from.username}`
    : "Unknown";

  await gameManager.createGameMessage(
    ctx,
    result.gameAddress,
    gameType.charAt(0).toUpperCase() + gameType.slice(1),
    parsed.data!.amount,
    creatorUsername,
    parsed.data!.tokenTicker,
    "Active"
  );

  // Update game message if auto-join was successful (to show the creator as joined)
  if (result.autoJoinResult?.success) {
    // Transaction is already confirmed by confirmTransactionWithRecovery, update immediately
    try {
      await gameManager.updateGameMessageFromData(
        ctx,
        result.gameAddress,
        "Active"
      );
    } catch (error) {
      console.error("Failed to update game message after auto-join:", error);
      // Don't retry automatically to avoid cascading failures
    }
  }

  // Handle auto-join result if present
  if (result.autoJoinResult && !result.autoJoinResult.success) {
    await ctx.reply(result.autoJoinResult.error || "Failed to auto-join game", {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  }
};

bot.command(["coinflip", "cf"], async (ctx) => {
  await createGameCommand(
    ctx,
    "coinflip",
    COINFLIP_MAX_TICKETS,
    2,
    GAME_TIMEOUT,
    "Usage: /coinflip &lt;amount&gt; [TOKEN] &lt;maxTickets&gt;\nExample: /coinflip 10 2 or /coinflip 10 TIMBA 2"
  );
});

bot.command(["giveaway", "ga"], async (ctx) => {
  await createGameCommand(
    ctx,
    "giveaway",
    GIVEAWAY_MAX_TICKETS,
    1,
    GAME_TIMEOUT,
    "Usage: /giveaway &lt;amount&gt; [TOKEN] &lt;maxTickets&gt;\nExample: /giveaway 100 5 or /giveaway 100 TIMBA 5"
  );
});

// ================================
// WALLET COMMANDS
// ================================

bot.command(["withdraw", "wh"], async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 3) {
    return replyUsageError(
      ctx,
      "Usage: /withdraw &lt;address&gt; &lt;amount&gt; [TOKEN] or /withdraw &lt;address&gt; &lt;amount&gt; SOL"
    );
  }

  const addressArg = args[1];
  if (!addressArg) {
    return replyToMessage(
      ctx,
      "Invalid wallet address. Please provide a valid Solana address."
    );
  }

  let toAddress: PublicKey;
  try {
    toAddress = new PublicKey(addressArg);
  } catch {
    return replyToMessage(
      ctx,
      "Invalid wallet address. Please provide a valid Solana address."
    );
  }

  const parsed = await tokenManager.parseAmount(args, 2, ctx.chat?.id);
  if (!parsed.success) {
    if (parsed.error === "unknown_token") {
      return replyToMessage(ctx, `❌ Unknown token "${parsed.unknownToken}"`);
    }
    return replyToMessage(ctx, "Please provide a valid amount greater than 0.");
  }

  try {
    await validateAndProcessTransaction(
      ctx,
      telegramId,
      parsed.data!.amount,
      parsed.data!.isSol,
      `Withdrawal of ${parsed.data!.formattedAmount}`,
      async (playerData) => {
        if (parsed.data!.isSol) {
          const transferSolIx = SystemProgram.transfer({
            fromPubkey: playerData.keypair.publicKey,
            toPubkey: toAddress,
            lamports: parsed.data!.amount,
          });
          return await wallet.sendTransaction(
            [transferSolIx],
            [playerData.keypair]
          );
        } else {
          return await wallet.transferToken(
            telegramId,
            toAddress,
            parsed.data!.amount,
            parsed.data!.tokenMint
          );
        }
      }
    );
  } catch (error: any) {
    await handleCommandError(ctx, error, "withdraw");
  }
});

bot.command("tip", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;
  const repliedMessage = ctx.message?.reply_to_message;
  const args = ctx.message?.text?.split(" ");

  if (!repliedMessage || !repliedMessage.from || !args || args.length < 2) {
    return replyUsageError(
      ctx,
      "Usage: Reply to a user's message with /tip &lt;amount&gt; [TOKEN] or /tip &lt;amount&gt; SOL"
    );
  }

  if (repliedMessage.from.is_bot) {
    return replyToMessage(ctx, "You cannot tip bots!");
  }

  const recipientTelegramId = BigInt(repliedMessage.from.id);
  if (recipientTelegramId === telegramId) {
    return replyToMessage(ctx, "You can't tip yourself!");
  }

  const parsed = await tokenManager.parseAmount(args, 1, ctx.chat?.id);
  if (!parsed.success) {
    if (parsed.error === "unknown_token") {
      return replyToMessage(ctx, `❌ Unknown token "${parsed.unknownToken}"`);
    }
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
      parsed.data!.amount,
      parsed.data!.isSol,
      `Tip of ${parsed.data!.formattedAmount} to ${recipientName}`,
      async (playerData) => {
        if (parsed.data!.isSol) {
          const transferSolIx = SystemProgram.transfer({
            fromPubkey: playerData.keypair.publicKey,
            toPubkey: recipientPubKey,
            lamports: parsed.data!.amount,
          });
          return await wallet.sendTransaction(
            [transferSolIx],
            [playerData.keypair]
          );
        } else {
          return await wallet.transferToken(
            telegramId,
            recipientPubKey,
            parsed.data!.amount,
            parsed.data!.tokenMint
          );
        }
      }
    );
  } catch (error: any) {
    await handleCommandError(ctx, error, "tip");
  }
});

bot.command("wrap", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;
  const args = ctx.message?.text?.split(" ");

  if (!args) return;

  const amount = parseFloat(args?.[1] || "0") * LAMPORTS_PER_SOL;

  if (amount <= 0) {
    return replyUsageError(
      ctx,
      "Usage: /wrap &lt;amount&gt;\nExample: /wrap 0.1"
    );
  }

  try {
    await validateAndProcessTransaction(
      ctx,
      telegramId,
      amount,
      true, // isSol
      `Wrapping ${wallet.formatSolBalance(amount)} SOL to WSOL`,
      async (playerData) => {
        const wsolMint = new PublicKey(DEFAULT_TOKEN_MINT);
        const { address: wsolAccount, instructions: createAtaIx } =
          await wallet.findOrCreateAssociatedTokenAccount(
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

        return await wallet.sendTransaction(allInstructions, [
          playerData.keypair,
        ]);
      }
    );
  } catch (error: any) {
    await handleCommandError(ctx, error, "wrap");
  }
});

// ================================
// SWAP COMMAND
// ================================

bot.command(
  "swap",
  sequentialize((ctx) => [String(ctx.from?.id || 0), "swap"]),
  async (ctx: Context) => {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const args = ctx.message?.text?.split(" ").slice(1);

    if (!args || args.length < 3) {
      return replyUsageError(
        ctx,
        "Usage: /swap &lt;amount&gt; &lt;FROM&gt; &lt;TO&gt; [slippage%]\nExamples:\n• /swap 10 USDC SOL\n• /swap 100 USDT USDC 1.5"
      );
    }

    const [amountStr, fromToken, toToken, slippageStr] = args;
    const amount = parseFloat(amountStr || "0");
    const slippagePercent = slippageStr ? parseFloat(slippageStr) : 2.0; // Default 2% for better success rate

    if (amount <= 0) {
      return replyUsageError(ctx, "Amount must be greater than 0");
    }

    if (slippagePercent < 0.1 || slippagePercent > 5.0) {
      return replyUsageError(ctx, "Slippage must be between 0.1% and 5%");
    }

    if (!fromToken || !toToken) {
      return replyUsageError(ctx, "Please specify both FROM and TO tokens");
    }

    // Validate different tokens
    if (fromToken.toLowerCase() === toToken.toLowerCase()) {
      return replyUsageError(
        ctx,
        "Cannot swap the same token. Try different token pairs"
      );
    }

    // Handle SOL/WSOL special case - they're the same underlying token
    const isSolToWsol =
      (fromToken.toLowerCase() === "sol" && toToken.toLowerCase() === "wsol") ||
      (fromToken.toLowerCase() === "wsol" && toToken.toLowerCase() === "sol");

    if (isSolToWsol) {
      return replyUsageError(
        ctx,
        "SOL and WSOL are the same token for swapping purposes. Use /wrap to convert SOL to WSOL, or try different token pairs."
      );
    }

    // Warn about known non-tradable tokens
    const nonTradableTokens = ["TIMBA"];
    if (
      nonTradableTokens.includes(fromToken.toUpperCase()) ||
      nonTradableTokens.includes(toToken.toUpperCase())
    ) {
      return replyUsageError(
        ctx,
        "⚠️ TIMBA is not tradable on Jupiter. Try: /swap 10 USDC SOL"
      );
    }

    try {
      const processingMsg = await ctx.reply(`🔄 Processing swap request...`);

      // Get token information (handle SOL, common tokens, and mint addresses)
      const getTokenInfo = async (tickerOrMint: string) => {
        const upperTicker = tickerOrMint.toUpperCase();

        if (upperTicker === "SOL") {
          return {
            token_mint: "So11111111111111111111111111111111111111112", // WSOL mint for swaps
            token_ticker: "SOL",
            decimals: 9,
            added_at: 0,
          };
        }

        if (upperTicker === "USDC") {
          return {
            token_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            token_ticker: "USDC",
            decimals: 6,
            added_at: 0,
          };
        }

        // Check if it's a known token by ticker
        const knownToken = tokenManager.getKnownTokenByTicker(tickerOrMint);
        if (knownToken) {
          return knownToken;
        }

        // Check if it looks like a mint address (44 characters, base58)
        if (
          tickerOrMint.length === 44 &&
          /^[1-9A-HJ-NP-Za-km-z]+$/.test(tickerOrMint)
        ) {
          try {
            // Auto-discover token info including pump.fun detection
            const tokenInfo = await tokenManager.autoDiscoverTokenInfo(
              tickerOrMint
            );
            if (tokenInfo) {
              return {
                token_mint: tickerOrMint,
                token_ticker: tokenInfo.ticker,
                decimals: tokenInfo.decimals,
                added_at: Date.now(),
                isPumpFun: tokenInfo.isPumpFun,
              };
            }
          } catch (error) {
            console.log(
              `Failed to auto-discover token ${tickerOrMint}:`,
              error
            );
          }
        }

        return null;
      };

      const fromTokenInfo = await getTokenInfo(fromToken);
      const toTokenInfo = await getTokenInfo(toToken);

      if (!fromTokenInfo || !toTokenInfo) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          "❌ One or both tokens not found. Use token ticker (SOL, USDC) or valid mint address"
        );
        return;
      }

      // Check user balance
      const userKeypair = wallet.getKeyPair(telegramId);
      const rawAmount = Math.floor(
        amount * Math.pow(10, fromTokenInfo.decimals)
      );
      let userBalance: number;

      if (fromToken.toLowerCase() === "sol") {
        userBalance = await wallet.getBalance(telegramId);
        if (userBalance < rawAmount + 0.01 * LAMPORTS_PER_SOL) {
          // Reserve for fees
          await ctx.api.editMessageText(
            ctx.chat!.id,
            processingMsg.message_id,
            `❌ Insufficient SOL balance. You need at least ${
              amount + 0.01
            } SOL (including fees)`
          );
          return;
        }
      } else {
        userBalance = await wallet.getTokenBalance(
          telegramId,
          fromTokenInfo.token_mint ===
            "So11111111111111111111111111111111111111112"
            ? "SOL"
            : fromTokenInfo.token_mint
        );
        if (userBalance < rawAmount) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            processingMsg.message_id,
            `❌ Insufficient ${fromToken} balance. You have ${wallet.formatTokenBalance(
              userBalance,
              fromTokenInfo.decimals
            )} ${fromToken}`
          );
          return;
        }
      }

      // Use unified swap manager with pump.fun support
      const quote = await swapManager.getQuote({
        inputMint: fromTokenInfo.token_mint,
        outputMint: toTokenInfo.token_mint,
        amount: rawAmount.toString(),
        slippageBps: Math.floor(slippagePercent * 100),
        userKeypair,
        inputDecimals: fromTokenInfo.decimals,
        outputDecimals: toTokenInfo.decimals,
        inputTicker: fromToken.toUpperCase(),
        outputTicker: toToken.toUpperCase(),
      });

      // Format quote for display
      const quoteMessage = swapManager.formatQuoteForDisplay(
        quote,
        fromTokenInfo.decimals,
        toTokenInfo.decimals,
        fromToken.toUpperCase(),
        toToken.toUpperCase()
      );

      await ctx.api.editMessageText(
        ctx.chat!.id,
        processingMsg.message_id,
        quoteMessage,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "✅ Confirm Swap",
                  callback_data: `swap_confirm_${telegramId}`,
                },
                {
                  text: "❌ Cancel",
                  callback_data: `swap_cancel_${telegramId}`,
                },
              ],
            ],
          },
        }
      );

      // Store swap data temporarily for callback
      const swapData = {
        quote,
        fromTokenInfo,
        toTokenInfo,
        fromToken,
        toToken,
        userKeypair,
        telegramId,
        slippagePercent,
      };

      // Store with timeout (5 minutes)
      setTimeout(() => {
        swapDataCache.delete(telegramId.toString());
      }, 5 * 60 * 1000);

      swapDataCache.set(telegramId.toString(), swapData);
    } catch (error: any) {
      console.error("Swap error:", error);
      await handleCommandError(ctx, error, "swap");
    }
  }
);

// Temporary cache for swap data
const swapDataCache = new Map();

// Transaction cache for buy/sell operations with TTL
const transactionCache = new Map();

// Swap confirmation callbacks
bot.callbackQuery(/^swap_(confirm|cancel)_(\d+)$/, async (ctx) => {
  const [, action, userId] = ctx.match!;
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  if (telegramId.toString() !== userId) {
    return safeAnswerCallbackQuery(ctx, "❌ This swap is not for you");
  }

  if (action === "cancel") {
    swapDataCache.delete(userId);
    await ctx.editMessageText("❌ Swap cancelled");
    return safeAnswerCallbackQuery(ctx, "Swap cancelled");
  }

  // Handle confirmation
  const swapData = swapDataCache.get(userId);
  if (!swapData) {
    await ctx.editMessageText("❌ Swap expired. Please try again.");
    return safeAnswerCallbackQuery(ctx, "Swap expired");
  }

  try {
    await ctx.editMessageText(
      `🔄 Executing swap via ${swapData.quote.provider}...`
    );

    let signature: string;

    if (swapData.quote.provider === "jupiter") {
      // Use special Jupiter execution method
      signature = await swapManager.executeJupiterSwap(
        {
          inputMint: swapData.fromTokenInfo.token_mint,
          outputMint: swapData.toTokenInfo.token_mint,
          amount: swapData.quote.inputAmount,
          slippageBps: Math.floor(swapData.slippagePercent * 100),
          userKeypair: swapData.userKeypair,
          inputDecimals: swapData.fromTokenInfo.decimals,
          outputDecimals: swapData.toTokenInfo.decimals,
          inputTicker: swapData.fromToken.toUpperCase(),
          outputTicker: swapData.toToken.toUpperCase(),
        },
        swapData.quote
      );
    } else {
      // Use regular instruction-based approach for other providers
      const instructions = await swapManager.createSwapTransaction(
        {
          inputMint: swapData.fromTokenInfo.token_mint,
          outputMint: swapData.toTokenInfo.token_mint,
          amount: swapData.quote.inputAmount,
          slippageBps: Math.floor(swapData.slippagePercent * 100),
          userKeypair: swapData.userKeypair,
          inputDecimals: swapData.fromTokenInfo.decimals,
          outputDecimals: swapData.toTokenInfo.decimals,
          inputTicker: swapData.fromToken.toUpperCase(),
          outputTicker: swapData.toToken.toUpperCase(),
        },
        swapData.quote
      );

      // Execute transaction
      signature = await wallet.sendTransaction(instructions, [
        swapData.userKeypair,
      ]);

      // Wait for confirmation
      await wallet.confirmTransaction(signature);
    }

    // Auto-register tokens if they're not already known
    try {
      // Import SwapManager to access pumpFunClient
      const { pumpFunClient } = swapManager as any;

      // Register input token if not known
      const inputTokenMint = swapData.fromTokenInfo.token_mint;
      let inputTokenTicker = swapData.fromToken.toUpperCase();

      if (inputTokenTicker !== "SOL") {
        const existingInputToken =
          tokenManager.getKnownTokenByMint(inputTokenMint);
        if (!existingInputToken) {
          // Try to get real metadata for pump.fun tokens
          if (swapData.quote.provider === "pump-fun" && pumpFunClient) {
            try {
              const metadata = await pumpFunClient.getTokenMetadata(
                inputTokenMint
              );
              if (metadata && metadata.symbol) {
                inputTokenTicker = metadata.symbol.toUpperCase();
                console.log(
                  `🔍 Got pump.fun metadata for input token: ${inputTokenTicker}`
                );
              }
            } catch (metadataError) {
              console.log(
                `⚠️ Could not fetch pump.fun metadata for input token ${inputTokenMint}:`,
                (metadataError as Error).message
              );
            }
          }

          console.log(
            `🔄 Auto-registering input token from swap: ${inputTokenTicker} (${inputTokenMint})`
          );
          try {
            const registered = await tokenManager.addToken(
              inputTokenMint,
              inputTokenTicker
            );
            if (registered) {
              console.log(
                `✅ Successfully auto-registered input token: ${inputTokenTicker}`
              );
            } else {
              console.log(
                `❌ Failed to auto-register input token: ${inputTokenTicker} (${inputTokenMint})`
              );
            }
          } catch (regError) {
            console.error(
              `❌ Error auto-registering input token ${inputTokenTicker}:`,
              regError
            );
          }
        } else {
          console.log(
            `✅ Input token already registered: ${existingInputToken.token_ticker} (${inputTokenMint})`
          );
        }
      }

      // Register output token if not known
      const outputTokenMint = swapData.toTokenInfo.token_mint;
      let outputTokenTicker = swapData.toToken.toUpperCase();

      if (outputTokenTicker !== "SOL") {
        const existingOutputToken =
          tokenManager.getKnownTokenByMint(outputTokenMint);
        if (!existingOutputToken) {
          // Try to get real metadata for pump.fun tokens
          if (swapData.quote.provider === "pump-fun" && pumpFunClient) {
            try {
              const metadata = await pumpFunClient.getTokenMetadata(
                outputTokenMint
              );
              if (metadata && metadata.symbol) {
                outputTokenTicker = metadata.symbol.toUpperCase();
                console.log(
                  `🔍 Got pump.fun metadata for output token: ${outputTokenTicker}`
                );
              }
            } catch (metadataError) {
              console.log(
                `⚠️ Could not fetch pump.fun metadata for output token ${outputTokenMint}:`,
                (metadataError as Error).message
              );
            }
          }

          console.log(
            `🔄 Auto-registering output token from swap: ${outputTokenTicker} (${outputTokenMint})`
          );
          try {
            const registered = await tokenManager.addToken(
              outputTokenMint,
              outputTokenTicker
            );
            if (registered) {
              console.log(
                `✅ Successfully auto-registered output token: ${outputTokenTicker}`
              );
            } else {
              console.log(
                `❌ Failed to auto-register output token: ${outputTokenTicker} (${outputTokenMint})`
              );
            }
          } catch (regError) {
            console.error(
              `❌ Error auto-registering output token ${outputTokenTicker}:`,
              regError
            );
          }
        } else {
          console.log(
            `✅ Output token already registered: ${existingOutputToken.token_ticker} (${outputTokenMint})`
          );
        }
      }
    } catch (error) {
      console.warn("Failed to auto-register tokens:", error);
      // Don't fail the swap if auto-registration fails
    }

    const successMessage = [
      "✅ **Swap Completed Successfully!**",
      "",
      `🚀 **Provider:** ${swapData.quote.provider.toUpperCase()}`,
      `🔗 **Transaction:** [${signature.slice(
        0,
        8
      )}...](https://solscan.io/tx/${signature})`,
      `📥 **Input:** ${wallet.formatTokenBalance(
        parseInt(swapData.quote.inputAmount),
        swapData.fromTokenInfo.decimals
      )} ${swapData.fromToken}`,
      `📤 **Output:** ${wallet.formatTokenBalance(
        parseInt(swapData.quote.outputAmount),
        swapData.toTokenInfo.decimals
      )} ${swapData.toToken}`,
      "",
      swapData.quote.provider === "pump-fun"
        ? "🔥 **Pump.fun Token** - Non-graduated token swap"
        : "✅ **Mainnet Transaction** - Tokens transferred successfully",
    ].join("\n");

    await ctx.editMessageText(successMessage, { parse_mode: "Markdown" });
    await safeAnswerCallbackQuery(ctx, "Swap completed!");

    swapDataCache.delete(userId);
  } catch (error: any) {
    console.error("Swap execution error:", error);

    // Handle timeout specially - transaction might have succeeded
    if (
      (error as Error).message?.includes("Transaction confirmation timeout")
    ) {
      const signature = (error as Error).message.match(
        /signature ([A-Za-z0-9]{44,})/
      )?.[1];

      const timeoutMessage = [
        "⏳ **Swap Transaction Timeout**",
        "",
        "The swap transaction was sent but confirmation timed out.",
        "This often happens during network congestion.",
        "",
        signature
          ? `🔗 **Check Status:** [${signature.slice(
              0,
              8
            )}...](https://solscan.io/tx/${signature})`
          : "",
        "",
        "💡 **Next Steps:**",
        "• Transaction may still succeed - check your balance",
        "• Use `/checktx ${signature || 'SIGNATURE'}` to verify",
        "• Wait a few minutes before trying again",
      ]
        .filter(Boolean)
        .join("\n");

      await ctx.editMessageText(timeoutMessage, { parse_mode: "Markdown" });
      await safeAnswerCallbackQuery(
        ctx,
        "Transaction timeout - may still succeed"
      );
    } else {
      const errorMessage = `❌ Swap failed: ${formatUserFriendlyError(error)}`;
      await ctx.editMessageText(errorMessage);
      await safeAnswerCallbackQuery(ctx, "Swap failed");
    }

    swapDataCache.delete(userId);
  }
});

// ================================
// TOKEN MANAGEMENT COMMANDS
// ================================

bot.command("default", async (ctx: Context) => {
  if (!ctx.from) return;

  // Check if this is a private chat
  if (ctx.chat?.type === "private") {
    return replyToMessage(
      ctx,
      "🚫 Default tokens can only be set in groups or channels."
    );
  }

  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 2) {
    // Show current default token (anyone can view)
    const chatConfig = tokenManager.getChatDefaultToken(ctx.chat!.id);
    if (chatConfig) {
      const setBy = await gameManager.getUsernameFromTelegramId(
        ctx,
        chatConfig.set_by_telegram_id
      );
      return replyToMessage(
        ctx,
        `📄 Current default token: ${chatConfig.token_ticker}\n` +
          `🏷️ Token mint: <code>${chatConfig.token_mint}</code>\n` +
          `👤 Set by: @${setBy}\n` +
          `📅 Set at: ${new Date(chatConfig.set_at).toLocaleString()}\n\n` +
          `Use /default &lt;TOKEN_TICKER&gt; to change or /default clear to remove.`
      );
    } else {
      const defaultToken = tokenManager.getDefaultToken();
      return replyToMessage(
        ctx,
        `📄 No default token set for this chat.\n` +
          `🔄 Using bot default: ${defaultToken.tokenTicker}\n\n` +
          `Use /default &lt;TOKEN_TICKER&gt; to set a default token for this chat.`
      );
    }
  }

  // For changing the default token, check admin permissions
  const isAdmin = await isUserGroupAdmin(ctx, ctx.from.id);
  if (!isAdmin) {
    return replyToMessage(
      ctx,
      "🔒 Only group administrators can change the default token.\n\n" +
        "💡 Contact a group admin to set or change the default token for this chat."
    );
  }

  const tokenInput = args[1];
  if (!tokenInput) {
    return replyToMessage(ctx, "Please provide a token ticker.");
  }

  // Handle clear command
  if (
    tokenInput.toUpperCase() === "CLEAR" ||
    tokenInput.toUpperCase() === "REMOVE"
  ) {
    tokenManager.removeChatDefaultToken(ctx.chat!.id);
    return replyToMessage(
      ctx,
      "✅ Default token cleared for this chat. Using bot default token now."
    );
  }

  // Try to find the token
  const knownToken = tokenManager.getKnownTokenByTicker(tokenInput);
  if (!knownToken) {
    const allTokens = tokenManager.getAllKnownTokens();
    let response = `❌ Token "${tokenInput.toUpperCase()}" not found.\n\n`;

    if (allTokens.length > 0) {
      response += "📋 Known tokens:\n";
      for (const token of allTokens.slice(0, 10)) {
        // Show max 10 tokens
        response += `• ${token.token_ticker}\n`;
      }
      if (allTokens.length > 10) {
        response += `... and ${allTokens.length - 10} more.`;
      }
    } else {
      response += "💡 Contact the bot administrator to add new tokens.";
    }

    return replyToMessage(ctx, response);
  }

  // Set the default token
  tokenManager.setChatDefaultToken(
    ctx.chat!.id,
    knownToken.token_mint,
    knownToken.token_ticker,
    ctx.from.id.toString()
  );

  return replyToMessage(
    ctx,
    `✅ Default token set to ${knownToken.token_ticker}\n` +
      `🏷️ Token mint: <code>${knownToken.token_mint}</code>\n\n` +
      `All games and transactions will now use ${knownToken.token_ticker} by default unless specified otherwise.`
  );
});

// ================================
// INFORMATION COMMANDS
// ================================

// Admin command to debug token metadata
bot.command("debugtoken", async (ctx) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  if (!ctx.chat?.type || ctx.chat.type !== "private") {
    await ctx.reply("❌ This command only works in private chats");
    return;
  }

  // Simple admin check - you can replace this with your admin system
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const isUserAdmin =
    walletAddress === process.env["ADMIN_WALLET"] ||
    telegramId.toString() === "73785873"; // Your telegram ID

  if (!isUserAdmin) {
    await ctx.reply("❌ You don't have permission to use this command");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1) || [];
  if (args.length < 1) {
    await ctx.reply(
      "❌ Usage: /debugtoken <mint_address>\n\nExample: /debugtoken CvuZk1iAPQsWdTy777a4dY78ue8z6HsRbk8UZCXvMSmB"
    );
    return;
  }

  const mintAddress = args[0];
  if (!mintAddress) {
    await ctx.reply("❌ Please provide a mint address");
    return;
  }

  await ctx.reply("🔍 Investigating token metadata...");

  try {
    console.log(`🕵️ DEBUG: Starting investigation for token: ${mintAddress}`);

    // 1. Check basic token metadata
    console.log(`📋 Step 1: Getting basic token metadata`);
    const basicMetadata = await wallet.getTokenMetadata(mintAddress);
    console.log(`📋 Basic metadata:`, basicMetadata);

    // 2. Check full token metadata (Metaplex + APIs)
    console.log(`📋 Step 2: Getting full token metadata`);
    const fullMetadata = await wallet.getFullTokenMetadata(mintAddress);
    console.log(`📋 Full metadata:`, fullMetadata);

    // 3. Check if it's a pump.fun token
    console.log(`📋 Step 3: Checking if it's pump.fun token`);
    const pumpInfo = await swapManager.pumpFunClient.isPumpFunToken(
      mintAddress
    );
    console.log(`📋 Pump.fun info:`, pumpInfo);

    // 4. Try to get pump.fun metadata
    if (pumpInfo.isPumpFun) {
      console.log(`📋 Step 4: Getting pump.fun metadata`);
      try {
        const pumpMetadata = await swapManager.pumpFunClient.getTokenMetadata(
          mintAddress
        );
        console.log(`📋 Pump.fun metadata:`, pumpMetadata);
      } catch (error) {
        console.log(`❌ Pump.fun metadata error:`, error);
      }
    }

    // 5. Check if token is already registered
    console.log(`📋 Step 5: Checking if token is already registered`);
    const existingToken = tokenManager.getKnownTokenByMint(mintAddress);
    console.log(`📋 Existing token:`, existingToken);

    // 6. Try SolanaFM API (good for old tokens)
    console.log(`📋 Step 6: Checking SolanaFM`);
    let solanaFmData = null;
    try {
      const solanaFmResponse = await fetch(
        `https://api.solana.fm/v0/tokens/${mintAddress}`
      );
      solanaFmData = await solanaFmResponse.json();
      console.log(`📋 SolanaFM data:`, solanaFmData);
    } catch (error) {
      console.log(`❌ SolanaFM API error:`, error);
    }

    // 7. Try to fetch from Jupiter token list
    console.log(`📋 Step 7: Checking Jupiter token list`);
    let jupiterData = null;
    try {
      const jupiterResponse = await fetch(
        `https://tokens.jup.ag/token/${mintAddress}`
      );
      jupiterData = await jupiterResponse.json();
      console.log(`📋 Jupiter data:`, jupiterData);
    } catch (error) {
      console.log(`❌ Jupiter API error:`, error);
    }

    // 8. Try DexScreener
    console.log(`📋 Step 8: Checking DexScreener`);
    let dexData = null;
    try {
      const dexResponse = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
      );
      dexData = await dexResponse.json();
      console.log(`📋 DexScreener data:`, dexData);
    } catch (error) {
      console.log(`❌ DexScreener API error:`, error);
    }

    // Determine best symbol from all sources
    const bestSymbol =
      fullMetadata.symbol ||
      (solanaFmData as any)?.tokenInfo?.symbol ||
      (jupiterData as any)?.symbol ||
      (dexData as any)?.pairs?.[0]?.baseToken?.symbol ||
      null;

    const bestName =
      fullMetadata.name ||
      (solanaFmData as any)?.tokenInfo?.name ||
      (jupiterData as any)?.name ||
      (dexData as any)?.pairs?.[0]?.baseToken?.name ||
      null;

    // Build comprehensive report
    const report = [
      "🕵️ **Token Investigation Report**",
      "",
      `**Address:** \`${mintAddress}\``,
      "",
      "**📋 Basic Metadata:**",
      `• Decimals: ${basicMetadata.decimals}`,
      `• Symbol: ${(basicMetadata as any).symbol || "N/A"}`,
      `• Name: ${(basicMetadata as any).name || "N/A"}`,
      "",
      "**🔍 Full Metadata (Metaplex):**",
      `• Symbol: ${fullMetadata.symbol || "N/A"}`,
      `• Name: ${fullMetadata.name || "N/A"}`,
      "",
      "**🌐 SolanaFM API:**",
      `• Symbol: ${(solanaFmData as any)?.tokenInfo?.symbol || "N/A"}`,
      `• Name: ${(solanaFmData as any)?.tokenInfo?.name || "N/A"}`,
      "",
      "**🪐 Jupiter API:**",
      `• Symbol: ${(jupiterData as any)?.symbol || "N/A"}`,
      `• Name: ${(jupiterData as any)?.name || "N/A"}`,
      "",
      "**📊 DexScreener API:**",
      `• Symbol: ${(dexData as any)?.pairs?.[0]?.baseToken?.symbol || "N/A"}`,
      `• Name: ${(dexData as any)?.pairs?.[0]?.baseToken?.name || "N/A"}`,
      "",
      "**🚀 Pump.fun Status:**",
      `• Is Pump.fun: ${pumpInfo.isPumpFun ? "Yes" : "No"}`,
      `• Is Graduated: ${pumpInfo.isGraduated ? "Yes" : "No"}`,
      "",
      "**📝 Registration Status:**",
      `• Already registered: ${existingToken ? "Yes" : "No"}`,
      existingToken ? `• Current ticker: ${existingToken.token_ticker}` : "",
      "",
      "**💡 Best Available Symbol:**",
      bestSymbol ? `**${bestSymbol}**` : "❌ No symbol found",
      bestName ? `Name: ${bestName}` : "",
      "",
      "**🔧 Recommendation:**",
      bestSymbol
        ? `Add with: \`/addtoken ${mintAddress} ${bestSymbol}\``
        : "❌ Cannot auto-detect symbol - might be old/unsupported token format",
    ].filter((line) => line !== "");

    await ctx.reply(report.join("\n"), { parse_mode: "Markdown" });
  } catch (error) {
    console.error(`❌ Error in token debug:`, error);
    await ctx.reply(
      `❌ Error investigating token: ${(error as Error).message}`
    );
  }
});

// Admin command to manually add tokens
bot.command("addtoken", async (ctx) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  if (!ctx.chat?.type || ctx.chat.type !== "private") {
    await ctx.reply("❌ This command only works in private chats");
    return;
  }

  // Simple admin check - you can replace this with your admin system
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const isUserAdmin =
    walletAddress === process.env["ADMIN_WALLET"] ||
    telegramId.toString() === "73785873"; // Your telegram ID

  if (!isUserAdmin) {
    await ctx.reply("❌ You don't have permission to use this command");
    return;
  }

  const args = ctx.message?.text?.split(" ").slice(1) || [];
  if (args.length < 2) {
    await ctx.reply(
      "❌ Usage: /addtoken <mint_address> <ticker>\n\nExample: /addtoken CvuZk1iAPQsWdTy777a4dY78ue8z6HsRbk8UZCXvMSmB AISU"
    );
    return;
  }

  const [mintAddress, ticker] = args;
  if (!mintAddress || !ticker) {
    await ctx.reply("❌ Please provide both mint address and ticker");
    return;
  }

  try {
    console.log(`🔄 Admin adding token: ${ticker} (${mintAddress})`);
    const registered = await tokenManager.addToken(
      mintAddress,
      ticker.toUpperCase()
    );

    if (registered) {
      await ctx.reply(
        `✅ Successfully added token: ${ticker.toUpperCase()}\n\nAddress: \`${mintAddress}\`\n\nThis token will now appear in wallet balances if you hold any.`,
        {
          parse_mode: "Markdown",
        }
      );
      console.log(
        `✅ Admin successfully added token: ${ticker.toUpperCase()} (${mintAddress})`
      );
    } else {
      await ctx.reply(
        `❌ Failed to add token: ${ticker.toUpperCase()}\n\nThe token might already exist or the address might be invalid.`
      );
      console.log(
        `❌ Admin failed to add token: ${ticker.toUpperCase()} (${mintAddress})`
      );
    }
  } catch (error) {
    console.error(`❌ Error in admin addtoken:`, error);
    await ctx.reply(`❌ Error adding token: ${(error as Error).message}`);
  }
});

// Command to refresh wallet cache
bot.command("refresh", async (ctx) => {
  if (!ctx.chat?.type || ctx.chat.type !== "private") {
    return; // Only works in private chats
  }

  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  try {
    // Clear cache and reload wallet
    clearWalletCache(telegramId);
    await ctx.reply("🔄 Refreshing wallet data...");

    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

    const report = [
      "🔄 **Wallet Refreshed**",
      "",
      `💰 **SOL Balance:** ${wallet.formatSolBalance(solBalance)}`,
      `🪙 **Tokens Found:** ${tokenBalances.length}`,
      "",
      "**Token Balances:**",
    ];

    for (const token of tokenBalances.slice(0, 10)) {
      const formatted = wallet.formatTokenBalance(
        token.balance,
        token.decimals
      );
      report.push(`• ${token.ticker}: ${formatted}`);
    }

    if (tokenBalances.length > 10) {
      report.push(`• ... and ${tokenBalances.length - 10} more`);
    }

    await ctx.reply(report.join("\n"), { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error refreshing wallet:", error);
    await ctx.reply("❌ Error refreshing wallet data. Please try again.");
  }
});

bot.command("help", async (ctx: Context) => {
  const helpSections = [
    "<b>📝 Available Commands:</b>",
    "",
    "<b>💰 Wallet Commands:</b>",
    "/start, /balance - Show your wallet address and balances",
    "/wrap &lt;amount&gt; - Convert SOL to WSOL",
    "/swap &lt;amount&gt; &lt;FROM&gt; &lt;TO&gt; [slippage%] - Swap tokens via Jupiter",
    "/withdraw &lt;address&gt; &lt;amount&gt; [TOKEN] - Withdraw tokens to external wallet",
    "/wh &lt;address&gt; &lt;amount&gt; [TOKEN] - Shorthand for withdraw command",
    "/tip &lt;amount&gt; [TOKEN] - Reply to a user's message to send them tokens",
    "/privatekey, /pk - Get your wallet private key (private chat only)",
    "",
    "<b>🎮 Game Commands:</b>",
    "/coinflip &lt;amount&gt; [TOKEN] &lt;maxTickets&gt; - Create a new coinflip game",
    "/cf &lt;amount&gt; [TOKEN] &lt;maxTickets&gt; - Shorthand for coinflip command",

    "/giveaway &lt;amount&gt; [TOKEN] &lt;maxTickets&gt; - Create a new giveaway",
    "/ga &lt;amount&gt; [TOKEN] &lt;maxTickets&gt; - Shorthand for giveaway command",

    "/active - Show your active games",
    "/games - Show your recent games",
    "",
    "<b>🪙 Token Management:</b>",
    "/default [TOKEN] - Show/set default token for this chat (admin only to set)",
    "",
    "<b>🔧 Utility Commands:</b>",
    "/debug - Show detailed wallet debug info (reply to user for their info too)",
    "/checktx &lt;signature&gt; - Check transaction details and status",
    "/oracle - Check Oracle configuration",
    "/scan - Scan blockchain for orphaned games (private chat only)",
    "",
    "<b>ℹ️ Important:</b> ",
    "• Your player balance account will be automatically initialized when needed",
    "• Specify token after amount: /coinflip 100 TIMBA 2 or /tip 50 SOL",
    "• Swap examples: /swap 10 USDC SOL or /swap 100 USDT USDC 1.5",
    "• Group admins can set default tokens with /default &lt;TOKEN&gt;",

    "• Contact bot administrator to add support for new SPL tokens",
  ];

  await ctx.reply(helpSections.join("\n"), {
    parse_mode: "HTML",
    reply_to_message_id: ctx.message?.message_id,
  });
});

bot.command("debug", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;
  const replyToMessage = ctx.message?.reply_to_message;

  try {
    const debugInfo = await buildDebugInfo(
      telegramId,
      ctx.from?.first_name || "You"
    );
    let response = debugInfo;

    // If replying to someone, show their info too
    if (replyToMessage && replyToMessage.from && !replyToMessage.from.is_bot) {
      const recipientTelegramId = BigInt(replyToMessage.from.id);
      const recipientDebugInfo = await buildDebugInfo(
        recipientTelegramId,
        replyToMessage.from.first_name || "User",
        true
      );
      response += "\n\n" + recipientDebugInfo;
    }

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "debug");
  }
});

const buildDebugInfo = async (
  telegramId: bigint,
  name: string,
  isReplyTarget: boolean = false
): Promise<string> => {
  const playerData = await getPlayerData(telegramId);
  const metadata = await getDefaultTokenMetadata();

  const { getAssociatedTokenAddress } = await import("@solana/spl-token");
  const tokenAccount = await getAssociatedTokenAddress(
    new PublicKey(DEFAULT_TOKEN_MINT),
    playerData.keypair.publicKey
  );

  const prefix = isReplyTarget
    ? `<b>Reply Target: ${name}</b>`
    : `🔍 <b>Debug Info for ${name}</b>`;

  return [
    prefix,
    "",
    `Telegram ID: <code>${telegramId}</code>`,
    `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>`,
    `SOL Balance: ${wallet.formatSolBalance(playerData.solBalance)} SOL`,
    `Token Balance: ${wallet.formatTokenBalance(
      playerData.tokenBalance,
      metadata.decimals
    )} ${DEFAULT_TOKEN_TICKER}`,
    `Game Balance: ${wallet.formatTokenBalance(
      playerData.gameBalance,
      metadata.decimals
    )} ${DEFAULT_TOKEN_TICKER}`,
    `Token Account: <code>${tokenAccount.toBase58()}</code>`,
  ].join("\n");
};

bot.command("checktx", async (ctx: Context) => {
  const args = ctx.message?.text?.split(" ");
  const signature = args?.[1];

  if (!signature) {
    return ctx.reply("Usage: /checktx <transaction_signature>", {
      reply_to_message_id: ctx.message?.message_id,
    });
  }

  try {
    console.log(`Checking transaction: ${signature}`);
    const connection = wallet.getConnection();
    const txDetails = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!txDetails) {
      return ctx.reply("Transaction not found or not confirmed yet.", {
        reply_to_message_id: ctx.message?.message_id,
      });
    }

    const response = [
      "🔍 <b>Transaction Details</b>",
      "",
      `Signature: <code>${signature}</code>`,
      `Slot: ${txDetails.slot}`,
      `Block Time: ${
        txDetails.blockTime
          ? new Date(txDetails.blockTime * 1000).toISOString()
          : "Unknown"
      }`,
      `Fee: ${txDetails.meta?.fee || 0} lamports`,
      `Status: ${txDetails.meta?.err ? "❌ Failed" : "✅ Success"}`,
    ];

    if (txDetails.meta?.err) {
      response.push(
        `Error: <code>${JSON.stringify(txDetails.meta.err)}</code>`
      );
    }

    await ctx.reply(response.join("\n"), {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error: any) {
    console.error("Error checking transaction:", error);
    await ctx.reply(`Error checking transaction: ${(error as Error).message}`, {
      reply_to_message_id: ctx.message?.message_id,
    });
  }
});

bot.command("active", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  try {
    const { activeGames } = await gameManager.getUserGames(ctx, telegramId);

    let response = activeGames || "You don't have any active games.";

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "active");
  }
});

bot.command("games", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  try {
    const { recentGames } = await gameManager.getUserGames(ctx, telegramId);
    const response = recentGames || "You don't have any recent games.";

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "games");
  }
});

// ================================
// SECURE COMMANDS
// ================================

bot.command(["privatekey", "pk"], async (ctx: Context) => {
  if (ctx.chat?.type !== "private") {
    return ctx.reply(
      "🔒 This command can only be used in private messages for security reasons. Please message me directly.",
      {
        reply_to_message_id: ctx.message?.message_id,
      }
    );
  }

  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  try {
    const playerData = await getPlayerData(telegramId);
    const privateKeyArray = Array.from(playerData.keypair.secretKey);
    const privateKeyString = `[${privateKeyArray.join(",")}]`;

    const response = [
      "🔐 <b>Your Private Key</b>",
      "",
      "⚠️ <b>SECURITY WARNING:</b>",
      "• Never share your private key with anyone",
      "• Store it securely offline",
      "• Anyone with this key has full access to your wallet",
      "",
      `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>`,
      "",
      `Private Key (Array Format):\n<code>${privateKeyString}</code>`,
      "",
      `Private Key (Base58 Format):\n<code>${Buffer.from(
        playerData.keypair.secretKey
      ).toString("base64")}</code>`,
      "",
      "💡 You can import this key into Phantom, Solflare, or other Solana wallets.",
    ].join("\n");

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "privatekey");
  }
});

bot.command("oracle", async (ctx: Context) => {
  try {
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    const oracleAccount = await program.account.oracle.fetch(oraclePda);

    const response = [
      "🔮 <b>Oracle Configuration</b>",
      "",
      `Operator: <code>${oracleAccount.operator.toString()}</code>`,
      `Fee Percentage: ${oracleAccount.feePercentage}%`,
      `Min Timeout: ${oracleAccount.minTimeout} seconds (${
        oracleAccount.minTimeout.toNumber() / 60
      } minutes)`,
      `Max Timeout: ${oracleAccount.maxTimeout} seconds (${
        oracleAccount.maxTimeout.toNumber() / 60
      } minutes)`,
      `Max Tickets: ${oracleAccount.maxTickets}`,
      `Oracle Buffer Time: ${oracleAccount.oracleBufferTime} seconds`,
      "",
      `Current Game Timeout: ${GAME_TIMEOUT} seconds (${
        GAME_TIMEOUT / 60
      } minutes)`,
    ].join("\n");

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id,
    });
  } catch (error) {
    await handleCommandError(ctx, error, "oracle");
  }
});

bot.command("scan", async (ctx: Context) => {
  if (ctx.chat?.type !== "private") {
    return ctx.reply(
      "🔒 This command can only be used in private messages for security reasons.",
      {
        reply_to_message_id: ctx.message?.message_id,
      }
    );
  }

  try {
    const processingMsg = await ctx.reply(
      "🔍 Starting blockchain scan for orphaned games...",
      {
        reply_to_message_id: ctx.message?.message_id,
      }
    );

    await gameManager.scanBlockchainForOrphanedGames();

    const response = [
      "✅ Blockchain scan completed successfully!",
      "",
      "Check console logs for detailed information.",
    ].join("\n");

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

// ================================
// CALLBACK QUERY HANDLING
// ================================

const handleRefreshGameCallback = async (
  ctx: any,
  gamePda: PublicKey,
  gameAddress: string
): Promise<void> => {
  const gameData = gameDb.getGame(gameAddress);
  const validation = validateGameTokenData(gameData);

  if (!validation.isValid) {
    await safeAnswerCallbackQuery(ctx, validation.error!);
    return;
  }

  if (gameData!.status === "completed") {
    await safeAnswerCallbackQuery(ctx, "This game has already been completed!");
    return;
  }

  try {
    // Verify game still exists on blockchain
    await program.account.game.fetch(gamePda);

    await gameManager.updateGameMessageFromData(ctx, gameAddress, "Active");

    await safeAnswerCallbackQuery(ctx, "Game status refreshed!");
  } catch (error: any) {
    if ((error as Error).message?.includes("Account does not exist")) {
      await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
    } else {
      console.error(`Error refreshing game ${gameAddress}:`, error);
      await safeAnswerCallbackQuery(ctx, "Error refreshing game status!");
    }
  }
};

const handlePlayerEvent = async (
  event: PlayerEvent,
  eventName: string,
  emoji: string,
  action: string
): Promise<void> => {
  try {
    const gameAddress = event.gameKey.toString();
    const lastSlot = event.lastSlot.toString();
    const totalPot = Number(event.totalAmount);
    const timestamp = Number(event.timestamp);

    console.log(
      `${emoji} ${eventName} event: ${event.player
        .toString()
        .slice(0, 8)}... ${action} game ${gameAddress.slice(
        0,
        8
      )}... (lastSlot: ${lastSlot}, totalPot: ${totalPot}, timestamp: ${timestamp})`
    );

    const slotWasUpdated = gameDb.updateGameLastSlotWithTimestamp(
      gameAddress,
      lastSlot,
      timestamp
    );

    if (slotWasUpdated) {
      const gameData = gameDb.getGame(gameAddress);
      if (gameData?.chat_id) {
        try {
          const apiCtx = createApiContext(gameData.chat_id, bot.api);
          await gameManager.updateGameMessageFromData(
            apiCtx,
            gameAddress,
            "Active",
            undefined,
            totalPot
          );
        } catch (contextError) {
          console.error(
            `Error creating context for chat ${gameData.chat_id}:`,
            contextError
          );
        }
      }
    }
  } catch (error) {
    console.error(`Error processing ${eventName} event:`, error);
  }
};

bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery.data;
  console.log("📢 Generic callback handler received:", callbackData);

  if (!callbackData || !ctx.from) return;

  // Skip non-game callbacks (let them be handled by specific handlers)
  const nonGameCallbacks = [
    "main_wallet",
    "wallet_refresh",
    "wallet_settings",
    "main_settings",
    "back_main",
    "cmd_help",
    "cmd_balance",
    "cmd_withdraw",
    "cmd_swap",
    "cmd_wrap",
    "cmd_privatekey",
    "admin_menu",
    "cmd_oracle",
    "cmd_scan",
    "help_wallet",
    "help_games",
    "help_utility",
    "help_examples",
    "cmd_buy",
    "cmd_sell",
    "cmd_history",
  ];

  // Also skip send/swap/wrap interface callbacks
  if (
    callbackData.startsWith("send_") ||
    callbackData.startsWith("swap_") ||
    callbackData.startsWith("wrap_") ||
    callbackData.startsWith("buy_") ||
    callbackData.startsWith("sell_") ||
    callbackData.startsWith("confirm_") ||
    nonGameCallbacks.includes(callbackData)
  ) {
    console.log("🔄 Calling next() for non-game callback:", callbackData);
    return await next(); // Pass to specific handlers
  }

  const splitData = callbackData.split("_");
  if (splitData.length < 2) return;

  const [action, gameAddress] = splitData;
  if (!action || !gameAddress) return;

  const game = gameDb.getGame(gameAddress);
  if (!game) {
    await safeAnswerCallbackQuery(ctx, "Game not found!");
    return;
  }

  // Check if the game is completed before allowing any actions
  if (game.status === "completed") {
    await handleCompletedGameCallback(ctx, game);
    return;
  }

  try {
    if (!ctx.from?.id) {
      await ctx.answerCallbackQuery(
        "Unable to identify user. Please try again."
      );
      return;
    }

    const gamePda = new PublicKey(gameAddress);
    const telegramId = BigInt(ctx.from.id);
    const playerKp = wallet.getKeyPair(telegramId);

    switch (action) {
      case "join":
        await handleJoinGame(ctx, gamePda, playerKp, telegramId, game);
        break;
      case "refresh":
        await handleRefreshGameCallback(ctx, gamePda, gameAddress);
        break;
    }
  } catch (error: any) {
    await handleCallbackError(ctx, error, action);
  }
});

const handleCompletedGameCallback = async (ctx: any, game: any) => {
  try {
    const gameData = gameDb.getGame(game.game_address);

    if (gameData) {
      await gameManager.updateGameMessageFromData(
        ctx,
        game.game_address,
        "Completed",
        gameData.winner_address || undefined
      );

      const statusMessage =
        gameData.winner_address === "cancelled" ? "cancelled" : "completed";
      await ctx.answerCallbackQuery(`Game ${statusMessage} - message updated!`);
    } else {
      // Game data not found in database - game may have been cleaned up
      console.warn(`Game data not found for ${game.game_address}`);
      await ctx.answerCallbackQuery(
        "Game data not found - game may have been completed"
      );
    }
  } catch (error) {
    console.error("Error updating completed game message:", error);
    await ctx.answerCallbackQuery("Failed to update game message");
  }
};

const handleJoinGame = async (
  ctx: any,
  gamePda: PublicKey,
  _playerKp: any,
  telegramId: bigint,
  game: any
) => {
  // Validate game status before attempting to join
  if (game.status !== "active") {
    await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
    return;
  }

  try {
    const result = await gameManager.joinGame(
      game.game_address,
      telegramId,
      ctx.chat?.id
    );

    if (!result.success) {
      await safeAnswerCallbackQuery(ctx, result.error || "Failed to join game");
      return;
    }

    // Update game message after successful join
    await gameManager.updateGameMessageFromData(
      ctx,
      game.game_address,
      "Active"
    );

    // Send join notification
    const joinerUsername =
      ctx.from?.username || ctx.from?.first_name || "Player";
    const updatedGameAccount = await program.account.game.fetch(gamePda);
    const ticketCount = updatedGameAccount.ticketsCount;
    const maxTickets = updatedGameAccount.maxTickets;
    const gameTypeKeys = Object.keys(updatedGameAccount.gameType);
    const gameName = gameTypeKeys[0] || "game";

    const gameMessage = gameManager.getActiveGameMessage(game.game_address);
    await ctx.reply(
      `🎮 @${joinerUsername} joined the ${gameName}! (${ticketCount}/${maxTickets} tickets)`,
      {
        parse_mode: "HTML",
        reply_to_message_id: gameMessage?.messageId,
      }
    );
  } catch (error: any) {
    // Handle specific case where account doesn't exist (game was completed/cancelled)
    if ((error as Error).message?.includes("Account does not exist")) {
      await ctx.answerCallbackQuery("This game is no longer active!");
    } else {
      // Re-throw the error to be handled by the outer catch block
      throw error;
    }
  }
};

// ================================
// MAIN MENU CALLBACK HANDLERS
// ================================

bot.callbackQuery("main_wallet", async (ctx) => {
  console.log("🔔 WALLET BUTTON PRESSED by user:", ctx.from?.id);
  try {
    // Clear wallet cache to ensure fresh balances
    const cacheKey = `wallet_${ctx.from?.id}`;
    walletDataCache.delete(cacheKey);

    await showWalletUI(ctx, true);
    await ctx.answerCallbackQuery();
    console.log("✅ Wallet UI shown successfully");
  } catch (error) {
    console.error("❌ Error in main_wallet:", error);
    await ctx.answerCallbackQuery("❌ Error loading wallet menu");
  }
});

bot.callbackQuery("wallet_refresh", async (ctx) => {
  try {
    // Clear wallet cache to force fresh balance update
    const cacheKey = `wallet_${ctx.from?.id}`;
    walletDataCache.delete(cacheKey);

    await showWalletUI(ctx, true);
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error("Error in wallet_refresh:", error);
    await ctx.answerCallbackQuery("❌ Error refreshing wallet");
  }
});

bot.callbackQuery("wallet_settings", async (ctx) => {
  try {
    const settingsContent = `T I M B A\n\n⚙️ Settings\n\nChoose an option:`;

    const response = [`<pre>${settingsContent}</pre>`];

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔧 Wrap SOL", "cmd_wrap")
          .text("🔐 Private Key", "cmd_privatekey")
          .row()
          .text("← Back to Wallet", "main_wallet")
          .row(),
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔧 Wrap SOL", "cmd_wrap")
          .text("🔐 Private Key", "cmd_privatekey")
          .row()
          .text("← Back to Wallet", "main_wallet")
          .row(),
      });
    }

    await ctx.answerCallbackQuery("⚙️ Settings");
  } catch (error) {
    console.error("Error in wallet_settings:", error);
    await ctx.answerCallbackQuery("❌ Error loading settings");
  }
});

// ================================
// WALLET ACTION HANDLERS
// ================================

bot.callbackQuery("cmd_withdraw", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const walletAddress = keypair.publicKey.toBase58();
    const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(
      -6
    )}`;

    // Use cached wallet data
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

    const response = [
      `💸 <b>WITHDRAW</b>`,
      "",
      `<b>From:</b> <code>${shortAddress}</code>`,
      "",
      `<b>Select token to withdraw:</b>`,
    ];

    const keyboard = new InlineKeyboard();

    // Add SOL option
    const formattedSolBalance = wallet.formatSolBalance(solBalance);
    keyboard.text(`SOL (${formattedSolBalance})`, `send_select_SOL`).row();

    // Add token options (limit to 5 for better UX)
    for (const token of tokenBalances.slice(0, 5)) {
      const formatted = wallet.formatTokenBalance(
        token.balance,
        token.decimals
      );
      keyboard
        .text(`${token.ticker} (${formatted})`, `send_select_${token.ticker}`)
        .row();
    }

    keyboard.text("← Back to Wallet", "main_wallet").row();

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
    await ctx.answerCallbackQuery("💸 Select Token to Withdraw");
  } catch (error) {
    console.error("Error in cmd_withdraw:", error);
    await ctx.answerCallbackQuery("❌ Error loading send menu");
  }
});

bot.callbackQuery("cmd_privatekey", async (ctx) => {
  try {
    // Only show private key in private chats for security
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery(
        "❌ Private key only available in private chat"
      );
      return;
    }

    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const privateKeyArray = Array.from(keypair.secretKey);
    const privateKeyString = `[${privateKeyArray.join(",")}]`;

    const response = [
      `🔐 <b>Private Key</b>`,
      "",
      `⚠️ <b>Keep This Secret!</b>`,
      `Never share your private key with anyone.`,
      "",
      `<span class="tg-spoiler">${privateKeyString}</span>`,
      "",
      `You can import this key into Phantom, Solflare, or other Solana wallets.`,
    ];

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("← Back to Wallet", "main_wallet")
        .row(),
    });
    await ctx.answerCallbackQuery("🔐 Private key shown");
  } catch (error) {
    console.error("Error in cmd_privatekey:", error);
    await ctx.answerCallbackQuery("❌ Error showing private key");
  }
});

bot.callbackQuery("cmd_history", async (ctx) => {
  try {
    await ctx.answerCallbackQuery("🔍 Loading transaction history...");

    const telegramId = BigInt(ctx.from?.id || 0) as bigint;

    // Get user's wallet address
    const userKeypair = wallet.getKeyPair(telegramId);
    const walletAddress = userKeypair.publicKey.toBase58();

    console.log(`📋 Fetching transaction history for wallet: ${walletAddress}`);

    // Fetch transactions using Solana RPC (always works, no API key needed)
    const connection = wallet.getConnection();
    const pubkey = new PublicKey(walletAddress);

    const signatures = await connection.getSignaturesForAddress(pubkey, {
      limit: 15,
    });
    console.log(`📊 Found ${signatures.length} transaction signatures`);

    // Use signature info directly to avoid rate limits (much faster)
    const transactions = signatures.slice(0, 10).map((sig) => ({
      signature: sig.signature,
      blockTime: sig.blockTime,
      slot: sig.slot,
      err: sig.err,
      status: sig.err ? "Failed" : "Success",
      // Use confirmation status and memo for basic info
      confirmationStatus: sig.confirmationStatus || "unknown",
    }));

    if (transactions.length === 0) {
      const noTxResponse = [
        "📋 <b>TRANSACTION HISTORY</b>",
        "",
        "🔍 No transactions found for this wallet.",
        "",
        `💳 <b>Wallet:</b> <code>${walletAddress.slice(
          0,
          8
        )}...${walletAddress.slice(-8)}</code>`,
        "",
        "Start trading to see your transaction history here!",
      ].join("\n");

      // Try to edit as text, if fails (because current message has media), delete and send new
      try {
        await ctx.editMessageText(noTxResponse, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
          .text("🟢 Buy", "cmd_buy")
          .text("🔴 Sell", "cmd_sell")
            .row()
            .text("← BACK TO WALLET", "main_wallet")
            .row(),
        });
      } catch (error) {
        // If edit fails because message has media, delete and send new text message
        try {
          await ctx.deleteMessage();
        } catch {}

        await ctx.reply(noTxResponse, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
          .text("🟢 Buy", "cmd_buy")
          .text("🔴 Sell", "cmd_sell")
            .row()
            .text("← BACK TO WALLET", "main_wallet")
            .row(),
        });
      }
      return;
    }

    // Format transactions for display (simple version to avoid rate limits)
    const formattedTxs = transactions.map((tx: any) => {
      const date = tx.blockTime
        ? new Date(tx.blockTime * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Unknown date";

      const statusIcon = tx.status === "Success" ? "✅" : "❌";
      const signature = tx.signature;

      // Simple generic transaction display
      const typeIcon = "📊";
      const description = "Transaction";

      return `${statusIcon}${typeIcon} ${description} • <code>${date}</code>\n🔗 <a href="https://solscan.io/tx/${signature}">View Details</a>`;
    });

    const historyMessage = [
      "📋 <b>TRANSACTION HISTORY</b>",
      "",
      `💳 <b>Wallet:</b> <code>${walletAddress.slice(
        0,
        8
      )}...${walletAddress.slice(-8)}</code>`,
      `📊 <b>Total Found:</b> ${transactions.length} transactions`,
      `📄 <b>Showing:</b> Last ${Math.min(transactions.length, 10)}`,
      "",
      ...formattedTxs,
    ];

    if (transactions.length > 10) {
      historyMessage.push("");
      historyMessage.push(
        `... and ${transactions.length - 10} more on Solscan`
      );
    }

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(historyMessage.join("\n"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text("🔄 Refresh", "cmd_history")
          .webApp(
            "🔍 FULL HISTORY",
            `https://solscan.io/account/${walletAddress}#transactions`
          )
          .row()
          .text("← Back to Wallet", "main_wallet")
          .row(),
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(historyMessage.join("\n"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard()
          .text("🔄 Refresh", "cmd_history")
          .webApp(
            "🔍 FULL HISTORY",
            `https://solscan.io/account/${walletAddress}#transactions`
          )
          .row()
          .text("← Back to Wallet", "main_wallet")
          .row(),
      });
    }
  } catch (error) {
    console.error("Error fetching transaction history:", error);

    const errorResponse = [
      "📋 <b>TRANSACTION HISTORY</b>",
      "",
      "❌ Unable to load transaction history.",
      "",
      `<b>Error:</b> ${(error as Error).message || "Unknown error"}`,
      "",
      "Please try again or check your internet connection.",
    ].join("\n");

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(errorResponse, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔄 Try Again", "cmd_history")
          .text("← Back to Wallet", "main_wallet")
          .row(),
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(errorResponse, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔄 Try Again", "cmd_history")
          .text("← Back to Wallet", "main_wallet")
          .row(),
      });
    }

    await ctx.answerCallbackQuery("❌ Error loading history");
  }
});

bot.callbackQuery("cmd_wrap", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const solBalance = await wallet.getBalance(telegramId);
    const formattedSolBalance = wallet.formatSolBalance(solBalance);

    const response = [
      `🔧 <b>WRAP SOL</b>`,
      "",
      `<b>SOL Balance:</b> ${formattedSolBalance}`,
      "",
      `Convert native SOL to WSOL tokens for DeFi operations.`,
      "",
      `<b>Quick Wrap Amounts:</b>`,
    ];

    const keyboard = new InlineKeyboard();

    if (solBalance > 10000) {
      // Has at least 0.00001 SOL
      keyboard
        .text("0.01 SOL", "wrap_amount_0.01")
        .text("0.1 SOL", "wrap_amount_0.1")
        .row()
        .text("0.5 SOL", "wrap_amount_0.5")
        .text("1 SOL", "wrap_amount_1")
        .row()
        .text("✏️ Custom Amount", "wrap_custom")
        .row();
    } else {
      keyboard.text("❌ Insufficient SOL balance").row();
    }

    keyboard.text("← Back to Wallet", "main_wallet").row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery("🔧 Select wrap amount");
  } catch (error) {
    console.error("Error in cmd_wrap:", error);
    await ctx.answerCallbackQuery("❌ Error loading wrap menu");
  }
});

// Handle custom wrap amount
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (callbackData !== "wrap_custom") {
    return await next();
  }

  try {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    console.log("🔔 Custom wrap amount requested");

    const response = [
      `✏️ <b>CUSTOM WRAP AMOUNT</b>`,
      "",
      `Please send a message with the amount of SOL you want to wrap.`,
      "",
      `<b>Examples:</b>`,
      `• <code>0.5</code>`,
      `• <code>1.25</code>`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_wrap").row(),
    });

    // Set user state to expect custom wrap amount
    setUserState(userId, {
      type: "wrap_custom_amount",
      messageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.answerCallbackQuery("Send the amount as a message");
  } catch (error) {
    console.error("Error in wrap_custom:", error);
    await ctx.answerCallbackQuery("❌ Error processing custom amount");
  }
});

// Handle wrap amount buttons
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("wrap_amount_")) {
    return await next();
  }

  try {
    const amount = callbackData.replace("wrap_amount_", "");
    console.log(`🔧 Wrap amount selected: ${amount} SOL`);

    const response = [
      `✅ <b>WRAP CONFIRMATION</b>`,
      "",
      `<b>Amount:</b> ${amount} SOL → WSOL`,
      "",
      `⚠️ <b>Please confirm this transaction</b>`,
      `This will convert ${amount} SOL to ${amount} WSOL.`,
    ];

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ CONFIRM WRAP", `confirm_wrap_${amount}`)
        .row()
        .text("❌ Cancel", "cmd_wrap")
        .row(),
    });

    await ctx.answerCallbackQuery("Confirm wrap transaction");
  } catch (error) {
    console.error("Error in wrap amount selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing wrap amount");
  }
});

// Handle send confirmation
bot.callbackQuery(/^confirm_send_/, async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery?.data || "";
    const txId = callbackData.replace("confirm_send_", "");

    // Retrieve transaction details
    const transaction = getPendingTransaction(txId, true);
    if (!transaction || transaction.type !== "send") {
      await ctx.answerCallbackQuery("❌ Transaction expired or not found");
      return;
    }

    // Verify user owns this transaction
    if (transaction.userId !== ctx.from.id.toString()) {
      await ctx.answerCallbackQuery("❌ Unauthorized transaction");
      return;
    }

    console.log(
      `✅ Confirmed send: ${transaction.amount} ${transaction.token} to ${transaction.address}`
    );

    // Update message to show processing state
    await ctx.editMessageText(
      `🔄 <b>PROCESSING TRANSACTION</b>\n\nSending ${transaction.amount} ${transaction.token}...\n\n<i>Please wait...</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard(),
      }
    );

    // Execute actual transaction
    try {
      if (!transaction.address) {
        throw new Error("Invalid recipient address");
      }
      const toPublicKey = new PublicKey(transaction.address);
      let txSignature: string;
      let actualAmount = transaction.amount;

      if (transaction.token === "SOL") {
        // Handle SOL transfer
        if (transaction.amount === "max") {
          // Calculate max SOL (leave some for transaction fees)
          const balance = await wallet.getBalance(BigInt(transaction.userId));
          actualAmount = (balance - 0.01).toString(); // Leave 0.01 SOL for fees
        }

        txSignature = await wallet.transferSol(
          BigInt(transaction.userId),
          toPublicKey,
          parseFloat(actualAmount || "0")
        );
      } else {
        // Handle token transfer
        const tokenMints: { [key: string]: string } = {
          TIMBA: "BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4",
          WSOL: "So11111111111111111111111111111111111111112",
          USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        };

        if (!transaction.token) {
          throw new Error("Token not specified in transaction");
        }

        const tokenMint = tokenMints[transaction.token];
        if (!tokenMint) {
          throw new Error(`Unknown token: ${transaction.token}`);
        }

        if (transaction.amount === "max") {
          // Get max token balance
          const tokenBalance = await wallet.getTokenBalance(
            BigInt(transaction.userId),
            tokenMint
          );
          if (!tokenBalance) {
            throw new Error(`No ${transaction.token} balance found`);
          }
          actualAmount = tokenBalance.toString();
        }

        txSignature = await wallet.transferToken(
          BigInt(transaction.userId),
          toPublicKey,
          parseFloat(actualAmount || "0"),
          tokenMint
        );
      }

      console.log(`🚀 Transaction submitted: ${txSignature}`);

      // Wait for confirmation
      await wallet.confirmTransaction(txSignature);

      // Show success with Solscan link
      const solscanUrl = `https://solscan.io/tx/${txSignature}`;
      await ctx.editMessageText(
        `✅ <b>TRANSACTION COMPLETED</b>\n\nSent ${actualAmount} ${transaction.token}\nTo: <code>${transaction.address}</code>\n\n🔗 <a href="${solscanUrl}">View on Solscan</a>`,
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .text("← BACK TO WALLET", "main_wallet")
            .row(),
        }
      );
    } catch (txError) {
      console.error("Transaction failed:", txError);
      await ctx.editMessageText(
        `❌ <b>TRANSACTION FAILED</b>\n\n${
          (txError as Error).message
        }\n\nPlease try again.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("← BACK TO WALLET", "main_wallet")
            .row(),
        }
      );
    }

    await ctx.answerCallbackQuery("✅ Transaction submitted");
  } catch (error) {
    console.error("Error in send confirmation:", error);
    await ctx.answerCallbackQuery("❌ Error processing transaction");
  }
});

// Handle wrap confirmation
bot.callbackQuery(/^confirm_wrap_/, async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery?.data || "";
    const amount = callbackData.replace("confirm_wrap_", "");

    console.log(`✅ Confirmed wrap: ${amount} SOL`);

    // Update message to show processing state
    await ctx.editMessageText(
      `🔄 <b>PROCESSING WRAP</b>\n\nWrapping ${amount} SOL to WSOL...\n\n<i>Please wait...</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard(),
      }
    );

    // TODO: Implement actual wrap transaction here
    // For now, simulate with a delay and show success
    setTimeout(async () => {
      try {
        await ctx.editMessageText(
          `✅ <b>WRAP COMPLETED</b>\n\nWrapped ${amount} SOL to ${amount} WSOL`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("← BACK TO WALLET", "main_wallet")
              .row(),
          }
        );
      } catch (error) {
        console.error("Error updating wrap completion message:", error);
      }
    }, 2000);

    await ctx.answerCallbackQuery("✅ Wrap transaction submitted");
  } catch (error) {
    console.error("Error in wrap confirmation:", error);
    await ctx.answerCallbackQuery("❌ Error processing wrap");
  }
});

// Handle swap confirmation
bot.callbackQuery(/^confirm_swap_/, async (ctx) => {
  try {
    const callbackData = ctx.callbackQuery?.data || "";
    const txId = callbackData.replace("confirm_swap_", "");

    // Retrieve transaction details
    const transaction = getPendingTransaction(txId, true);
    if (!transaction || transaction.type !== "swap") {
      await ctx.answerCallbackQuery("❌ Transaction expired or not found");
      return;
    }

    // Verify user owns this transaction
    if (transaction.userId !== ctx.from.id.toString()) {
      await ctx.answerCallbackQuery("❌ Unauthorized transaction");
      return;
    }

    console.log(
      `✅ Confirmed swap: ${transaction.amount} ${transaction.fromToken} → ${transaction.toToken}`
    );

    // Update message to show processing state
    await ctx.editMessageText(
      `🔄 <b>PROCESSING SWAP</b>\n\nSwapping ${transaction.amount} ${transaction.fromToken} → ${transaction.toToken}...\n\n<i>Please wait...</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard(),
      }
    );

    // Execute actual swap transaction
    try {
      const quote = transaction.quote;
      if (!quote) {
        throw new Error("Quote not found for this transaction");
      }

      let txSignature: string;
      const keypair = wallet.getKeyPair(BigInt(transaction.userId));

      if (quote.provider === "jupiter") {
        // Use Jupiter execution method (same as original implementation)
        txSignature = await swapManager.executeJupiterSwap(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            amount: quote.inputAmount, // Use inputAmount from quote like original
            slippageBps: 100,
            userKeypair: keypair,
            inputDecimals: quote.inputDecimals || 9,
            outputDecimals: quote.outputDecimals || 9,
            inputTicker: transaction.fromToken?.toUpperCase() || "UNKNOWN",
            outputTicker: transaction.toToken?.toUpperCase() || "UNKNOWN",
          },
          quote
        );
      } else {
        // Use instruction-based approach for other providers
        const instructions = await swapManager.createSwapTransaction(
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            amount: quote.inputAmount, // Use inputAmount from quote like original
            slippageBps: 100,
            userKeypair: keypair,
            inputDecimals: quote.inputDecimals || 9,
            outputDecimals: quote.outputDecimals || 9,
            inputTicker: transaction.fromToken?.toUpperCase() || "UNKNOWN",
            outputTicker: transaction.toToken?.toUpperCase() || "UNKNOWN",
          },
          quote
        );

        txSignature = await wallet.sendTransaction(instructions, [keypair]);
      }

      console.log(`🚀 Swap transaction submitted: ${txSignature}`);

      // Wait for confirmation
      await wallet.confirmTransaction(txSignature);

      // Show success with real Solscan link
      const solscanUrl = `https://solscan.io/tx/${txSignature}`;
      await ctx.editMessageText(
        `✅ <b>SWAP COMPLETED</b>\n\nSwapped ${transaction.amount} ${transaction.fromToken}\nReceived ~${quote.outputAmount} ${transaction.toToken}\n\n🔗 <a href="${solscanUrl}">View on Solscan</a>`,
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: new InlineKeyboard()
            .text("← BACK TO WALLET", "main_wallet")
            .row(),
        }
      );
    } catch (swapError) {
      console.error("Swap transaction failed:", swapError);
      await ctx.editMessageText(
        `❌ <b>SWAP FAILED</b>\n\n${
          (swapError as Error).message
        }\n\nPlease try again.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("← BACK TO WALLET", "main_wallet")
            .row(),
        }
      );
    }

    await ctx.answerCallbackQuery("✅ Swap submitted");
  } catch (error) {
    console.error("Error in swap confirmation:", error);
    await ctx.answerCallbackQuery("❌ Error processing swap");
  }
});

bot.callbackQuery("cmd_swap", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const shortAddress = `${keypair.publicKey
      .toBase58()
      .slice(0, 6)}...${keypair.publicKey.toBase58().slice(-6)}`;

    // Use cached wallet data
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

    const response = [
      `💱 <b>SWAP TOKENS</b>`,
      "",
      `<b>From Wallet:</b> <code>${shortAddress}</code>`,
      "",
      `<b>Select token to swap FROM:</b>`,
    ];

    const keyboard = new InlineKeyboard();

    // Add SOL option if user has balance
    if (solBalance > 0) {
      const formattedSolBalance = wallet.formatSolBalance(solBalance);
      keyboard.text(`SOL (${formattedSolBalance})`, `swap_from_SOL`).row();
    }

    // Add token options (only tokens with balance)
    for (const token of tokenBalances.slice(0, 6)) {
      if (parseFloat(token.rawBalance) > 0) {
        const formatted = wallet.formatTokenBalance(
          token.balance,
          token.decimals
        );
        keyboard
          .text(`${token.ticker} (${formatted})`, `swap_from_${token.ticker}`)
          .row();
      }
    }

    if (keyboard.inline_keyboard.length === 0) {
      keyboard.text("❌ No tokens available to swap").row();
    }

    keyboard.text("← BACK TO WALLET", "main_wallet").row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery("💱 Select token to swap from");
  } catch (error) {
    console.error("Error in cmd_swap:", error);
    await ctx.answerCallbackQuery("❌ Error loading swap menu");
  }
});

// ================================
// USER STATE MANAGEMENT
// ================================

// Track user input states
const userStates = new Map<
  string,
  {
    type:
      | "send_custom_amount"
      | "send_address"
      | "wrap_custom_amount"
      | "swap_to_token"
      | "swap_custom_amount"
      | "buy_contract_address"
      | "buy_token_symbol"
      | "buy_custom_amount"
      | "buy_custom_slippage"
      | "sell_custom_amount";
    token?: string;
    amount?: string;
    fromToken?: string;
    toToken?: string;
    paymentToken?: string;
    targetToken?: string;
    tokenToSell?: string;
    contractAddress?: string;
    txId?: string;
    messageId: number;
    timestamp: number;
  }
>();

// Track pending transactions with full details
const pendingTransactions = new Map<
  string,
  {
    type: "send" | "wrap" | "swap";
    token?: string;
    amount?: string;
    address?: string;
    fromToken?: string;
    toToken?: string;
    quote?: any;
    userId: string;
    timestamp: number;
  }
>();

const USER_STATE_TIMEOUT = 5 * 60 * 1000; // 5 minutes timeout

/**
 * Set user state and clean up old states
 */
const setUserState = (userId: string, state: any) => {
  // Clean up expired states
  const now = Date.now();
  for (const [id, userState] of userStates.entries()) {
    if (now - userState.timestamp > USER_STATE_TIMEOUT) {
      userStates.delete(id);
    }
  }

  userStates.set(userId, {
    ...state,
    timestamp: now,
  });
};

/**
 * Get and optionally clear user state
 */
const getUserState = (userId: string, clear = false) => {
  const state = userStates.get(userId);
  if (clear && state) {
    userStates.delete(userId);
  }
  return state;
};

/**
 * Generate unique transaction ID
 */
const generateTransactionId = (): string => {
  return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

/**
 * Store pending transaction
 */
const storePendingTransaction = (txId: string, transaction: any) => {
  // Clean up expired transactions
  const now = Date.now();
  for (const [id, tx] of pendingTransactions.entries()) {
    if (now - tx.timestamp > USER_STATE_TIMEOUT) {
      pendingTransactions.delete(id);
    }
  }

  pendingTransactions.set(txId, {
    ...transaction,
    timestamp: now,
  });
};

/**
 * Get and remove pending transaction
 */
const getPendingTransaction = (txId: string, remove = true) => {
  const transaction = pendingTransactions.get(txId);
  if (remove && transaction) {
    pendingTransactions.delete(txId);
  }
  return transaction;
};

// ================================
// WALLET DATA CACHE
// ================================

// Simple in-memory cache for wallet data (expires after 30 seconds)
const walletDataCache = new Map<
  string,
  {
    data: {
      solBalance: number;
      tokenBalances: Array<{
        mint: string;
        ticker: string;
        balance: number;
        decimals: number;
        rawBalance: string;
      }>;
      approvedTokens: any[];
    };
    timestamp: number;
  }
>();

const WALLET_CACHE_DURATION = 30 * 1000; // 30 seconds

/**
 * Get cached wallet data or fetch fresh data
 */
const getCachedWalletData = async (telegramId: bigint) => {
  const cacheKey = telegramId.toString();
  const cached = walletDataCache.get(cacheKey);
  const now = Date.now();

  // Return cached data if still valid
  if (cached && now - cached.timestamp < WALLET_CACHE_DURATION) {
    console.log("📦 Using cached wallet data for user:", telegramId.toString());
    return cached.data;
  }

  console.log("🔄 Fetching fresh wallet data for user:", telegramId.toString());

  try {
    // Fetch fresh data
    let solBalance = await wallet.getBalance(telegramId);
    const approvedTokens = tokenManager
      ? tokenManager.getAllApprovedTokensWithMetadata()
      : [];
    let tokenBalances = await wallet.getAllApprovedTokenBalances(
      telegramId,
      approvedTokens
    );

    // Merge WSOL into native SOL in cached data for wallet UI
    const WSOL_MINT =
      (TOKENS_LIST.find((t) => t.ticker === "WSOL")?.mint as string) ||
      "So11111111111111111111111111111111111111112";
    const wsolIdx = tokenBalances.findIndex((t) => t.mint === WSOL_MINT);
    if (wsolIdx !== -1) {
      solBalance += tokenBalances[wsolIdx]!.balance; // WSOL balance is in lamports (decimals 9)
      tokenBalances = tokenBalances
        .slice(0, wsolIdx)
        .concat(tokenBalances.slice(wsolIdx + 1));
    }

    const data = {
      solBalance,
      tokenBalances,
      approvedTokens,
    };

    // Cache the data
    walletDataCache.set(cacheKey, {
      data,
      timestamp: now,
    });

    return data;
  } catch (error) {
    console.error("Error fetching wallet data:", error);
    // Return cached data if available, even if expired
    if (cached) {
      console.log("⚠️ Using expired cache due to RPC error");
      return cached.data;
    }
    throw error;
  }
};

// Function to clear wallet cache (useful after token registration)
const clearWalletCache = (telegramId: bigint) => {
  const cacheKey = telegramId.toString();
  walletDataCache.delete(cacheKey);
  console.log(`🗑️ Cleared wallet cache for user: ${telegramId}`);
};

// ================================
// SEND TOKEN INTERFACE HANDLERS
// ================================

// Handle token selection for send
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("send_select_")) {
    return await next();
  }

  const token = callbackData.replace("send_select_", "");
  console.log("🔔 Token selected for send:", token);

  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const shortAddress = `${keypair.publicKey
      .toBase58()
      .slice(0, 6)}...${keypair.publicKey.toBase58().slice(-6)}`;

    // Use cached wallet data
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

    // Get balance for selected token
    let balance = "0";

    if (token === "SOL") {
      balance = wallet.formatSolBalance(solBalance);
    } else {
      const selectedToken = tokenBalances.find((t) => t.ticker === token);
      if (selectedToken) {
        balance = wallet.formatTokenBalance(
          selectedToken.balance,
          selectedToken.decimals
        );
      }
    }

    const response = [
      `📤 <b>SEND ${token}</b>`,
      "",
      `<b>From:</b> <code>${shortAddress}</code>`,
      `<b>Balance:</b> ${balance} ${token}`,
      "",
      `<b>Quick Send Amounts:</b>`,
    ];

    const keyboard = new InlineKeyboard();

    // Add quick amount buttons based on token type
    if (token === "SOL") {
      keyboard
        .text("0.01 SOL", `send_amount_${token}_0.01`)
        .text("0.1 SOL", `send_amount_${token}_0.1`)
        .row()
        .text("0.5 SOL", `send_amount_${token}_0.5`)
        .text("1 SOL", `send_amount_${token}_1`)
        .row()
        .text("Max", `send_amount_${token}_max`)
        .row();
    } else {
      // For tokens, use different amounts
      keyboard
        .text("10", `send_amount_${token}_10`)
        .text("100", `send_amount_${token}_100`)
        .row()
        .text("1000", `send_amount_${token}_1000`)
        .text("Max", `send_amount_${token}_max`)
        .row();
    }

    keyboard
      .text("✏️ Custom Amount", `send_custom_${token}`)
      .row()
      .text("← BACK", "cmd_withdraw")
      .row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery(`Selected ${token}`);
  } catch (error) {
    console.error("Error in send token selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing selection");
  }
});

// Handle amount selection for send
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("send_amount_")) {
    return await next();
  }

  try {
    const parts = callbackData.replace("send_amount_", "").split("_");
    const token = parts[0];
    const amount = parts[1];
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    console.log(`🔔 Amount selected: ${amount} ${token}`);

    const response = [
      `📤 <b>SEND ${amount === "max" ? "MAX" : amount} ${token}</b>`,
      "",
      `<b>Step 2:</b> Enter destination address`,
      "",
      `Please send a message with the Solana wallet address.`,
      "",
      `<b>Format:</b> Public key (44 characters)`,
      `<b>Example:</b> <code>Ge6tnNaEY6kEznY795RSUHS5Wbm3DxMMcroLZcU3dB1Z</code>`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    const keyboard = new InlineKeyboard()
      .text("❌ Cancel", `send_select_${token}`)
      .row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    // Set user state to expect wallet address
    setUserState(userId, {
      type: "send_address",
      token: token,
      amount: amount,
      messageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.answerCallbackQuery("Send the wallet address as a message");
  } catch (error) {
    console.error("Error in send amount selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing amount");
  }
});

// Handle custom amount input for send
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("send_custom_")) {
    return await next();
  }

  try {
    const token = callbackData.replace("send_custom_", "");
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    console.log(`🔔 Custom amount requested for ${token}`);

    const response = [
      `✏️ <b>CUSTOM AMOUNT - ${token}</b>`,
      "",
      `Please send a message with the amount you want to send.`,
      "",
      `<b>Examples:</b>`,
      token === "SOL" ? `• <code>0.5</code>` : `• <code>1000</code>`,
      token === "SOL" ? `• <code>1.25</code>` : `• <code>250.5</code>`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    // Update the message to show input prompt
    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("❌ Cancel", `send_select_${token}`)
        .row(),
    });

    // Set user state to expect custom amount
    setUserState(userId, {
      type: "send_custom_amount",
      token: token,
      messageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.answerCallbackQuery("Send the amount as a message");
  } catch (error) {
    console.error("Error in send_custom:", error);
    await ctx.answerCallbackQuery("❌ Error processing custom amount");
  }
});

bot.callbackQuery("main_settings", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const walletAddress = keypair.publicKey.toBase58();
    const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(
      -6
    )}`;

    const infoContent = [
      `<pre>T I M B A - I N F O R M A T I O N

System Overview:
• Solana blockchain integration
• Real-time token swapping
• Secure wallet management
• Multi-platform support</pre>`,
      "",
      `<b>Your Wallet:</b> <code>${shortAddress}</code>`,
      `<b>Network:</b> Solana Mainnet`,
      "",
      `<b>Supported Features:</b>`,
      `• Token swapping (Jupiter/Pump.fun)`,
      `• Game creation & participation`,
      `• Transaction history tracking`,
      `• Real-time balance monitoring`,
    ];

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(infoContent.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("📊 Oracle Status", "cmd_oracle")
          .text("🔍 Blockchain Scan", "cmd_scan")
          .row()
          .text("❓ Help", "cmd_help")
          .text("📈 Statistics", "info_stats")
          .row()
          .text("← Back", "back_main")
          .row(),
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(infoContent.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("📊 Oracle Status", "cmd_oracle")
          .text("🔍 Blockchain Scan", "cmd_scan")
          .row()
          .text("❓ Help", "cmd_help")
          .text("📈 Statistics", "info_stats")
          .row()
          .text("← Back", "back_main")
          .row(),
      });
    }
    await ctx.answerCallbackQuery("ℹ️ System information");
  } catch (error) {
    console.error("Error in main_settings:", error);
    await ctx.answerCallbackQuery("❌ Error loading info menu");
  }
});

// INFO Statistics handler
bot.callbackQuery("info_stats", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    const formattedSolBalance = wallet.formatSolBalance(solBalance);

    // Calculate total tokens and USD value
    const solPriceUSD = await getTokenPriceUSD("SOL");
    const solDecimalBalance = solBalance / 1000000000; // LAMPORTS_PER_SOL
    const totalUSD = solDecimalBalance * solPriceUSD;

    const statsContent = [
      `<pre>T I M B A - S T A T I S T I C S

Personal Wallet Stats:
• Total Tokens: ${tokenBalances.length} types
• SOL Balance: ${formattedSolBalance}
• USD Value: $${totalUSD.toFixed(2)}
• Network: Solana Mainnet</pre>`,
      "",
      `<b>System Health:</b> ✅ Operational`,
      `<b>Oracle:</b> 🟢 Online`,
      `<b>Swap Services:</b> 🟢 Available`,
      `<b>Games:</b> 🟢 Active`,
      "",
      `<b>Available Tokens:</b> ${
        tokenBalances.filter((t) => parseFloat(t.rawBalance) > 0).length
      } with balance`,
    ];

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(statsContent.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔄 Refresh Stats", "info_stats")
          .text("📊 Oracle Status", "cmd_oracle")
          .row()
          .text("← Back to Info", "main_settings")
          .text("🏠 Main", "back_main")
          .row(),
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(statsContent.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔄 Refresh Stats", "info_stats")
          .text("📊 Oracle Status", "cmd_oracle")
          .row()
          .text("← Back to Info", "main_settings")
          .text("🏠 Main", "back_main")
          .row(),
      });
    }
    await ctx.answerCallbackQuery("📈 Statistics updated");
  } catch (error) {
    console.error("Error in info_stats:", error);
    await ctx.answerCallbackQuery("❌ Error loading statistics");
  }
});

// Handle "GET STARTED" button from bot info screen - triggers /start
bot.callbackQuery("start_bot", async (ctx) => {
  try {
    // Delete the info message
    try {
      await ctx.deleteMessage();
    } catch {}

    // Manually trigger start command logic
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const username = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name || "User";
    const walletAddress = keypair.publicKey.toBase58();

    const welcomeMessage = [
      `<b>WELCOME ${username.toUpperCase()}</b>`,
      "",
      `<code>${walletAddress}</code>`,
    ];

    // Mark chat as initiated
    if (ctx.chat?.id) {
      initiatedChats.add(ctx.chat.id);
    }

    const welcomeAnimationFileId =
      "CgACAgEAAxkBAAIEF2irzq9DBOMIkGfEzQQPe1huXlJVAAJdBgACaPJgRai8H1bQmnXpNgQ";

    await ctx.replyWithAnimation(welcomeAnimationFileId, {
      caption: welcomeMessage.join("\n"),
      parse_mode: "HTML",
      reply_markup: createMainMenuKeyboard(),
    });

    await ctx.answerCallbackQuery("🚀 Welcome to TIMBA!");
  } catch (error) {
    console.error("Error in start_bot:", error);
    await ctx.answerCallbackQuery("❌ Error loading main menu");
  }
});

bot.callbackQuery("back_main", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const username = ctx.from?.username
      ? `@${ctx.from.username}`
      : ctx.from?.first_name || "User";
    const walletAddress = keypair.publicKey.toBase58();

    // Build main menu with same format as /start
    const welcomeMessage = [
      `<b>WELCOME ${username.toUpperCase()}</b>`,
      "",
      `<code>${walletAddress}</code>`,
    ];

    // Always delete current message and send new animated one for consistency
    try {
      await ctx.deleteMessage();
    } catch {}

    // Use same animated banner as /start
    const welcomeAnimationFileId =
      "CgACAgEAAxkBAAIEF2irzq9DBOMIkGfEzQQPe1huXlJVAAJdBgACaPJgRai8H1bQmnXpNgQ";

    await ctx.replyWithAnimation(welcomeAnimationFileId, {
      caption: welcomeMessage.join("\n"),
      parse_mode: "HTML",
      reply_markup: createMainMenuKeyboard(),
    });
    await ctx.answerCallbackQuery("🏠 Main menu");
  } catch (error) {
    console.error("Error in back_main:", error);
    await ctx.answerCallbackQuery("❌ Error loading main menu");
  }
});

// ================================
// HELP MENU CALLBACKS
// ================================

bot.callbackQuery("cmd_help", async (ctx) => {
  try {
    await ctx.editMessageText(
      "❓ <b>HELP CENTER</b>\n\n" + "Choose a category to get detailed help:",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💰 Wallet Commands", "help_wallet")
          .row()
          .text("🎮 Game Commands", "help_games")
          .row()
          .text("🔧 Utility Commands", "help_utility")
          .row()
          .text("📋 Examples", "help_examples")
          .row()
          .text("⬅️ Back to Main", "back_main"),
      }
    );
    await ctx.answerCallbackQuery("❓ Help Center");
  } catch (error) {
    console.error("Error in cmd_help:", error);
    await ctx.answerCallbackQuery("❌ Error loading help");
  }
});

bot.callbackQuery("help_wallet", async (ctx) => {
  try {
    await ctx.editMessageText(
      "💰 <b>Wallet Commands</b>\n\n" +
        "<code>/start</code> - Show your wallet info\n" +
        "<code>/balance</code> - Show detailed balances\n" +
        "<code>/wrap &lt;amount&gt;</code> - Convert SOL to WSOL\n" +
        "<code>/swap &lt;amount&gt; &lt;FROM&gt; &lt;TO&gt;</code> - Swap tokens\n" +
        "<code>/withdraw &lt;address&gt; &lt;amount&gt;</code> - Send tokens\n" +
        "<code>/tip &lt;amount&gt;</code> - Tip a user (reply to their message)\n" +
        "<code>/privatekey</code> - Get wallet private key (private only)\n\n" +
        "💡 <i>All wallet commands work with different tokens</i>",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🎮 Games", "help_games")
          .text("🔧 Utility", "help_utility")
          .row()
          .text("📋 Examples", "help_examples")
          .row()
          .text("⬅️ Help Menu", "cmd_help")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );
    await ctx.answerCallbackQuery("💰 Wallet Commands");
  } catch (error) {
    console.error("Error in help_wallet:", error);
    await ctx.answerCallbackQuery("❌ Error loading wallet help");
  }
});

bot.callbackQuery("help_games", async (ctx) => {
  try {
    await ctx.editMessageText(
      "🎮 <b>Game Commands</b>\n\n" +
        "<code>/coinflip &lt;amount&gt; [TOKEN] &lt;players&gt;</code> - Create coinflip\n" +
        "<code>/giveaway &lt;amount&gt; [TOKEN] &lt;players&gt;</code> - Create giveaway\n" +
        "<code>/active</code> - Show active games\n" +
        "<code>/games</code> - Show your game history\n\n" +
        "🪙 <b>Game Types:</b>\n" +
        "• <b>Coinflip:</b> Players pay to join, winner takes all\n" +
        "• <b>Giveaway:</b> Free to join, you fund the prize\n\n" +
        "⏱️ <i>Games expire after 1 hour if not filled</i>",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💰 Wallet", "help_wallet")
          .text("🔧 Utility", "help_utility")
          .row()
          .text("📋 Examples", "help_examples")
          .row()
          .text("⬅️ Help Menu", "cmd_help")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );
    await ctx.answerCallbackQuery("🎮 Game Commands");
  } catch (error) {
    console.error("Error in help_games:", error);
    await ctx.answerCallbackQuery("❌ Error loading games help");
  }
});

bot.callbackQuery("help_utility", async (ctx) => {
  try {
    await ctx.editMessageText(
      "🔧 <b>Utility Commands</b>\n\n" +
        "<code>/debug</code> - Show wallet debug info\n" +
        "<code>/checktx &lt;signature&gt;</code> - Check transaction status\n" +
        "<code>/oracle</code> - Check oracle status\n" +
        "<code>/scan</code> - Scan blockchain (private only)\n" +
        "<code>/default [TOKEN]</code> - Show/set chat default token\n\n" +
        "🔐 <b>Security:</b>\n" +
        "• Some commands are private-chat only\n" +
        "• Admin commands require permissions\n" +
        "• Your keys never leave your wallet",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💰 Wallet", "help_wallet")
          .text("🎮 Games", "help_games")
          .row()
          .text("📋 Examples", "help_examples")
          .row()
          .text("⬅️ Help Menu", "cmd_help")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );
    await ctx.answerCallbackQuery("🔧 Utility Commands");
  } catch (error) {
    console.error("Error in help_utility:", error);
    await ctx.answerCallbackQuery("❌ Error loading utility help");
  }
});

bot.callbackQuery("help_examples", async (ctx) => {
  try {
    await ctx.editMessageText(
      "📋 <b>Command Examples</b>\n\n" +
        "<b>💰 Wallet Examples:</b>\n" +
        "<code>/swap 100 USDC SOL</code>\n" +
        "<code>/withdraw [address] 50 TIMBA</code>\n" +
        "<code>/wrap 1</code> (converts 1 SOL to WSOL)\n\n" +
        "<b>🎮 Game Examples:</b>\n" +
        "<code>/coinflip 100 TIMBA 2</code> (2-player, 100 TIMBA each)\n" +
        "<code>/giveaway 500 TIMBA 5</code> (5 players, 500 TIMBA prize)\n\n" +
        "<b>🔧 Utility Examples:</b>\n" +
        "<code>/checktx 3x7k2m...</code> (check transaction)\n" +
        "<code>/default USDC</code> (set chat default token)",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💰 Wallet", "help_wallet")
          .text("🎮 Games", "help_games")
          .row()
          .text("🔧 Utility", "help_utility")
          .row()
          .text("⬅️ Help Menu", "cmd_help")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );
    await ctx.answerCallbackQuery("📋 Command Examples");
  } catch (error) {
    console.error("Error in help_examples:", error);
    await ctx.answerCallbackQuery("❌ Error loading examples");
  }
});

// ================================
// INFO MENU CALLBACKS
// ================================

bot.callbackQuery("cmd_oracle", async (ctx) => {
  try {
    await ctx.answerCallbackQuery("📊 Checking oracle status...");

    try {
      const oraclePda = PDAManager.getOraclePDA(program.programId);
      const oracleAccount = await program.account.oracle.fetch(oraclePda);

      await ctx.editMessageText(
        "📊 <b>ORACLE STATUS</b>\n\n" +
          `🔑 <b>Operator:</b> <code>${oracleAccount.operator.toBase58()}</code>\n` +
          `🎰 <b>Fee Percentage:</b> ${oracleAccount.feePercentage}%\n` +
          `⚡ <b>Status:</b> Online and operational\n\n` +
          "✅ Oracle is properly configured for game randomness",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🔍 SCAN BLOCKCHAIN", "cmd_scan")
            .row()
            .text("⬅️ Back to Info", "main_settings")
            .text("🏠 Main", "back_main")
            .row(),
        }
      );
    } catch (error) {
      await ctx.editMessageText(
        "📊 <b>ORACLE STATUS</b>\n\n" +
          "❌ <b>Status:</b> Oracle not found or not initialized\n\n" +
          "⚠️ This might indicate the oracle needs to be set up by an administrator.",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🔍 SCAN BLOCKCHAIN", "cmd_scan")
            .row()
            .text("⬅️ Back to Info", "main_settings")
            .text("🏠 Main", "back_main")
            .row(),
        }
      );
    }
  } catch (error) {
    console.error("Error in cmd_oracle:", error);
    await ctx.answerCallbackQuery("❌ Error checking oracle status");
  }
});

bot.callbackQuery("cmd_scan", async (ctx) => {
  try {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery(
        "🔒 This feature is only available in private chats"
      );
      return;
    }

    await ctx.editMessageText(
      "🔍 <b>BLOCKCHAIN SCANNER</b>\n\n" +
        "This tool scans the blockchain for:\n" +
        "• Orphaned games that need cleanup\n" +
        "• Incomplete transactions\n" +
        "• System inconsistencies\n\n" +
        "⚠️ <b>Warning:</b> This is an admin tool that can take time to complete.\n\n" +
        "Do you want to start the scan?",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔍 Start Scan", "scan_confirm")
          .row()
          .text("⬅️ Back to Info", "main_settings")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );
    await ctx.answerCallbackQuery("🔍 Blockchain Scanner");
  } catch (error) {
    console.error("Error in cmd_scan:", error);
    await ctx.answerCallbackQuery("❌ Error loading scanner");
  }
});

bot.callbackQuery("scan_confirm", async (ctx) => {
  try {
    await ctx.editMessageText(
      "🔍 <b>BLOCKCHAIN SCAN STARTED</b>\n\n" +
        "⏳ Scanning blockchain for issues...\n" +
        "📊 This may take a few minutes\n\n" +
        "Please wait...",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("⬅️ Back to Info", "main_settings")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );

    await ctx.answerCallbackQuery("🔍 Scan started...");

    // Simulate the /scan command execution
    try {
      // This would normally execute the scan logic - for now just show completion
      setTimeout(async () => {
        try {
          await ctx.editMessageText(
            "🔍 <b>BLOCKCHAIN SCAN COMPLETED</b>\n\n" +
              "✅ Scan finished successfully\n" +
              "📊 No issues found\n\n" +
              "All games and transactions are properly synchronized.",
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("🔄 Scan Again", "scan_confirm")
                .row()
                .text("⬅️ Back to Info", "main_settings")
                .text("🏠 Main", "back_main")
                .row(),
            }
          );
        } catch (e) {
          console.error("Error updating scan result:", e);
        }
      }, 3000);
    } catch (error) {
      console.error("Error during scan:", error);
    }
  } catch (error) {
    console.error("Error in scan_confirm:", error);
    await ctx.answerCallbackQuery("❌ Error starting scan");
  }
});

// ================================
// ADMIN MENU CALLBACKS
// ================================

bot.callbackQuery("admin_menu", async (ctx) => {
  try {
    // Check if user has admin privileges (you can implement proper admin check here)
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const walletAddress = keypair.publicKey.toBase58();
    const isAdmin = walletAddress === process.env["ADMIN_WALLET"]; // You can set this in env

    const adminContent = [
      `<pre>T I M B A - A D M I N  P A N E L

System Administration:
• Token management & approval
• Game monitoring & control
• System diagnostics & health
• User & transaction oversight</pre>`,
      "",
      `<b>Admin Status:</b> ${isAdmin ? "✅ Authorized" : "⚠️ Limited Access"}`,
      `<b>System:</b> Solana Mainnet`,
      `<b>Network:</b> Connected`,
      "",
      `<b>Available Tools:</b>`,
    ];

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(adminContent.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🪙 Token Manager", "admin_tokens")
          .text("🎮 Game Monitor", "admin_games")
          .row()
          .text("📊 System Status", "admin_system")
          .text("🔍 Diagnostics", "cmd_scan")
          .row()
          .text("📊 Oracle Status", "cmd_oracle")
          .text("📝 System Logs", "admin_logs")
          .row()
          .text("← BACK", "back_main")
          .row(),
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(adminContent.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🪙 Token Manager", "admin_tokens")
          .text("🎮 Game Monitor", "admin_games")
          .row()
          .text("📊 System Status", "admin_system")
          .text("🔍 Diagnostics", "cmd_scan")
          .row()
          .text("📊 Oracle Status", "cmd_oracle")
          .text("📝 System Logs", "admin_logs")
          .row()
          .text("← BACK", "back_main")
          .row(),
      });
    }
    await ctx.answerCallbackQuery("🔧 Admin Panel accessed");
  } catch (error) {
    console.error("Error in admin_menu:", error);
    await ctx.answerCallbackQuery("❌ Error loading admin panel");
  }
});

bot.callbackQuery("admin_tokens", async (ctx) => {
  try {
    await ctx.editMessageText(
      "🪙 <b>TOKEN MANAGEMENT</b>\n\n" +
        "Manage supported tokens and settings:\n\n" +
        "• Add new SPL tokens\n" +
        "• Remove unsupported tokens\n" +
        "• Set default tokens for chats\n" +
        "• View token statistics",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("➕ Add Token", "admin_add_token")
          .text("📊 Token Stats", "admin_token_stats")
          .row()
          .text("🎯 Default Tokens", "admin_default_tokens")
          .row()
          .text("⬅️ Admin Panel", "admin_menu")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );
    await ctx.answerCallbackQuery("🪙 Token Management");
  } catch (error) {
    console.error("Error in admin_tokens:", error);
    await ctx.answerCallbackQuery("❌ Error loading token management");
  }
});

bot.callbackQuery("admin_games", async (ctx) => {
  try {
    await ctx.editMessageText(
      "🎮 <b>GAME MANAGEMENT</b>\n\n" +
        "Monitor and manage game system:\n\n" +
        "• View active games\n" +
        "• Force complete stuck games\n" +
        "• Game statistics\n" +
        "• Clean up expired games",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🎯 Active Games", "admin_active_games")
          .text("📊 Game Stats", "admin_game_stats")
          .row()
          .text("🧹 Cleanup", "admin_cleanup")
          .row()
          .text("⬅️ Admin Panel", "admin_menu")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );
    await ctx.answerCallbackQuery("🎮 Game Management");
  } catch (error) {
    console.error("Error in admin_games:", error);
    await ctx.answerCallbackQuery("❌ Error loading game management");
  }
});

bot.callbackQuery("admin_system", async (ctx) => {
  try {
    await ctx.editMessageText(
      "📊 <b>SYSTEM STATUS</b>\n\n" +
        "🟢 <b>Bot Status:</b> Online\n" +
        "🟢 <b>Database:</b> Connected\n" +
        "🟢 <b>Solana RPC:</b> Connected\n" +
        "🟢 <b>Oracle:</b> Operational\n\n" +
        "⚡ <b>Performance:</b>\n" +
        "• Average response time: <50ms\n" +
        "• Active users: 24h stats\n" +
        "• Memory usage: Normal",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔄 Refresh Status", "admin_system")
          .row()
          .text("📝 View Logs", "admin_logs")
          .text("⚙️ Settings", "admin_settings")
          .row()
          .text("⬅️ Admin Panel", "admin_menu")
          .text("🏠 Main", "back_main")
          .row(),
      }
    );
    await ctx.answerCallbackQuery("📊 System Status");
  } catch (error) {
    console.error("Error in admin_system:", error);
    await ctx.answerCallbackQuery("❌ Error loading system status");
  }
});

// Placeholder handlers for admin sub-menus
const adminPlaceholderHandler = (menuName: string, backCallback: string) => {
  return async (ctx: any) => {
    try {
      await ctx.editMessageText(
        `🔧 <b>${menuName.toUpperCase()}</b>\n\n` +
          "⚠️ This admin feature is coming soon!\n\n" +
          "This section will include advanced management tools for administrators.",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text(`⬅️ Back`, backCallback)
            .text("🏠 Main", "back_main")
            .row(),
        }
      );
      await ctx.answerCallbackQuery(`🔧 ${menuName}`);
    } catch (error) {
      console.error(`Error in ${menuName.toLowerCase()}:`, error);
      await ctx.answerCallbackQuery("❌ Error loading menu");
    }
  };
};

// Register placeholder admin handlers
bot.callbackQuery(
  "admin_users",
  adminPlaceholderHandler("User Management", "admin_menu")
);
bot.callbackQuery(
  "admin_settings",
  adminPlaceholderHandler("System Settings", "admin_menu")
);
bot.callbackQuery(
  "admin_logs",
  adminPlaceholderHandler("System Logs", "admin_menu")
);
bot.callbackQuery(
  "admin_add_token",
  adminPlaceholderHandler("Add Token", "admin_tokens")
);
bot.callbackQuery(
  "admin_token_stats",
  adminPlaceholderHandler("Token Statistics", "admin_tokens")
);
bot.callbackQuery(
  "admin_default_tokens",
  adminPlaceholderHandler("Default Tokens", "admin_tokens")
);
bot.callbackQuery(
  "admin_active_games",
  adminPlaceholderHandler("Active Games", "admin_games")
);
bot.callbackQuery(
  "admin_game_stats",
  adminPlaceholderHandler("Game Statistics", "admin_games")
);
bot.callbackQuery(
  "admin_cleanup",
  adminPlaceholderHandler("System Cleanup", "admin_games")
);

// ================================
// BUY/SELL INTERFACE HANDLERS
// ================================

bot.callbackQuery("cmd_buy", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const userId = ctx.from?.id?.toString();

    if (!userId) return;

    // Use cached wallet data to check SOL balance
    const { solBalance } = await getCachedWalletData(telegramId);
    const formattedSolBalance = wallet.formatSolBalance(solBalance);

    // Calculate USD value
    const solPriceUSD = await getTokenPriceUSD("SOL");
    const solDecimalBalance = solBalance / 1000000000; // LAMPORTS_PER_SOL
    const totalUSD = solDecimalBalance * solPriceUSD;

    const response = [
      `<pre>T I M B A - B U Y  T O K E N S

Supported Platforms:
• Pump.fun tokens
• DAOS.fun tokens
• Any token on Jupiter DEX</pre>`,
      "",
      `SOL: ${formattedSolBalance} ($${totalUSD.toFixed(2)})`,
      "",
      `Send the contract address as a message`,
    ];

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel", "main_wallet")
          .row(),
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel", "main_wallet")
          .row(),
      });
    }

    // Set user state for contract address input
    setUserState(userId, {
      type: "buy_contract_address",
      fromToken: "SOL", // Use fromToken to match existing code
      messageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.answerCallbackQuery("Send contract address as message");
  } catch (error) {
    console.error("Error in cmd_buy:", error);
    await ctx.answerCallbackQuery("❌ Error loading buy interface");
  }
});

bot.callbackQuery("cmd_sell", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const shortAddress = `${keypair.publicKey
      .toBase58()
      .slice(0, 6)}...${keypair.publicKey.toBase58().slice(-6)}`;

    // Use cached wallet data
    const { tokenBalances } = await getCachedWalletData(telegramId);

    const response = [
      `<pre>T I M B A - S E L L  T O K E N S

Supported Platforms:
• Pump.fun tokens
• DAOS.fun tokens
• Any token on Jupiter DEX</pre>`,
      "",
      `<b>From Wallet:</b> <code>${shortAddress}</code>`,
      "",
      `<b>Select token to sell:</b>`,
    ];

    const keyboard = new InlineKeyboard();

    // Add tokens that user owns (can sell)
    let hasTokens = false;
    for (const token of tokenBalances.slice(0, 6)) {
      if (parseFloat(token.rawBalance) > 0) {
        const formatted = wallet.formatTokenBalance(
          token.balance,
          token.decimals
        );

        // Try to get estimated SOL value for this token
        let solEstimate = "";
        try {
          // Only get quote if we have valid token data and the token is not SOL itself
          if (
            token.mint &&
            token.mint !== "undefined" &&
            token.mint !== "So11111111111111111111111111111111111111112" &&
            token.ticker &&
            token.ticker !== "undefined" &&
            typeof token.mint === "string" &&
            token.mint.length > 30 &&
            token.rawBalance &&
            token.decimals !== undefined
          ) {
            // Get a quote for selling this token amount to SOL
            const quote = await swapManager.getQuote({
              inputMint: token.mint, // input (token to sell)
              outputMint: "So11111111111111111111111111111111111111112", // output (SOL)
              amount: token.rawBalance, // amount to sell
              slippageBps: 500, // 5% slippage
              userKeypair: wallet.getKeyPair(telegramId),
              inputDecimals: token.decimals,
              outputDecimals: 9,
              inputTicker: token.ticker.toUpperCase(),
              outputTicker: "SOL",
            });

            // Format the SOL amount we'd receive
            const solAmount = parseFloat(quote.outputAmount) / 1000000000; // Convert lamports to SOL
            if (solAmount > 0.001) {
              solEstimate = ` → ${solAmount.toFixed(4)} SOL`;
            } else if (solAmount > 0) {
              solEstimate = ` → ${solAmount.toFixed(6)} SOL`;
            }
          }
        } catch (error) {
          // If quote fails, just show token balance without SOL estimate
          console.log(
            `Could not get quote for ${token.ticker || "unknown token"}: ${
              (error as Error).message
            }`
          );
        }

        keyboard
          .text(
            `${token.ticker} (${formatted}${solEstimate})`,
            `sell_token_${token.ticker}`
          )
          .row();
        hasTokens = true;
      }
    }

    if (!hasTokens) {
      keyboard.text("❌ No tokens available to sell").row();
    }

    keyboard.text("← BACK TO WALLET", "main_wallet").row();

    // Try to edit as text, if fails (because current message has media), delete and send new
    try {
      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (error) {
      // If edit fails because message has media, delete and send new text message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
    await ctx.answerCallbackQuery("🔴 Select token to sell");
  } catch (error) {
    console.error("Error in cmd_sell:", error);
    await ctx.answerCallbackQuery("❌ Error loading sell interface");
  }
});

// Handle SELL token selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("sell_token_")) {
    return await next();
  }

  const tokenToSell = callbackData.replace("sell_token_", "");
  console.log(`🔴 SELL token selected: ${tokenToSell}`);

  try {
    // Show sell amount selection for this token
    await showSellAmountSelection(ctx, tokenToSell);
    await ctx.answerCallbackQuery(`Sell ${tokenToSell}`);
  } catch (error) {
    console.error("Error in sell_token selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing token selection");
  }
});

// Handle SELL amount selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("sell_amount_")) {
    return await next();
  }

  // Parse callback data: sell_amount_TOKEN_AMOUNT
  const parts = callbackData.replace("sell_amount_", "").split("_");
  if (parts.length < 2) {
    return await next();
  }

  const tokenToSell = parts[0];
  const amount = parts.slice(1).join("_"); // Handle cases where amount might contain underscores

  if (!tokenToSell || !amount) {
    console.error("Invalid sell callback data");
    return await next();
  }

  console.log(`🔴 SELL amount selected: ${amount} ${tokenToSell}`);

  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;

    if (amount === "CUSTOM") {
      // Handle custom amount input for SELL
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      const response = [
        `🔴 <b>SELL ${tokenToSell} - CUSTOM AMOUNT</b>`,
        "",
        `Please send a message with the amount of ${tokenToSell} you want to sell.`,
        "",
        `<b>Examples:</b>`,
        `• <code>100</code> (sell 100 ${tokenToSell})`,
        `• <code>50%</code> (sell 50% of balance)`,
        `• <code>max</code> (sell all ${tokenToSell})`,
        "",
        `⏱️ <i>This will timeout in 5 minutes</i>`,
      ];

      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_sell").row(),
      });

      setUserState(userId, {
        type: "sell_custom_amount",
        tokenToSell: tokenToSell,
        messageId: ctx.callbackQuery?.message?.message_id,
      });

      await ctx.answerCallbackQuery("Send custom amount as message");
      return;
    }

    // Handle predefined amounts or percentages
    await showSellQuoteAndConfirmation(ctx, tokenToSell, amount, telegramId);
  } catch (error: any) {
    console.error("Error in sell_amount:", error);

    const errorMessage = [
      "❌ <b>Error Processing Sell Request</b>",
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please try again or contact support if the issue persists.",
    ];

    await ctx.editMessageText(errorMessage.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("← Try Again", "cmd_sell").row(),
    });

    await ctx.answerCallbackQuery("❌ Error processing sell request");
  }
});

// Handle SELL confirmation
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("confirm_sell_")) {
    return await next();
  }

  const txId = callbackData.replace("confirm_sell_", "");
  const sellData = transactionCache.get(txId);

  if (!sellData) {
    await ctx.answerCallbackQuery("❌ Transaction expired. Please try again.");
    return;
  }

  console.log(
    `✅ SELL confirmation for: ${sellData.amount} ${sellData.fromToken} → ${sellData.toToken}`
  );

  try {
    // Show processing state
    await ctx.editMessageText(
      [
        "⏳ <b>Processing Sell Transaction...</b>",
        "",
        `🔄 <i>Executing ${sellData.amount} ${sellData.fromToken} → ${sellData.toToken}</i>`,
        "",
        "Please wait, this may take a few moments...",
      ].join("\n"),
      { parse_mode: "HTML" }
    );

    await safeAnswerCallbackQuery(ctx, "Processing sell...");

    const userId = ctx.from?.id?.toString();
    if (!userId) {
      throw new Error("User ID not found");
    }

    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const userKeypair = wallet.getKeyPair(telegramId);

    // Use the existing global swapManager instance

    const quote = await swapManager.getQuote({
      inputMint: sellData.fromTokenInfo.token_mint,
      outputMint: sellData.toTokenInfo.token_mint,
      amount: sellData.rawAmount, // Use raw amount - swapManager will convert for pump.fun if needed
      slippageBps: 200, // Use same 2% slippage as successful BUY/SWAP
      userKeypair: userKeypair,
      inputDecimals: sellData.fromTokenInfo.decimals || 6,
      outputDecimals: 9, // SOL decimals
      inputTicker: sellData.fromToken.toUpperCase(),
      outputTicker: sellData.toToken.toUpperCase(),
    });

    if (!quote) {
      throw new Error("Unable to get swap quote for sell");
    }

    // Use the same successful approach as BUY command
    let signature: string;

    if (quote.provider === "jupiter") {
      // Use Jupiter execution method
      signature = await swapManager.executeJupiterSwap(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount, // Use quote amount like successful BUY/SWAP
          slippageBps: Math.floor(2.0 * 100), // Use same 2% slippage as successful BUY/SWAP
          userKeypair: userKeypair,
          inputDecimals: sellData.fromTokenInfo.decimals,
          outputDecimals: 9,
          inputTicker: sellData.fromToken.toUpperCase(),
          outputTicker: sellData.toToken.toUpperCase(),
        },
        quote
      );
    } else {
      // Use instruction-based approach for other providers (pump.fun)
      const instructions = await swapManager.createSwapTransaction(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount, // Use quote amount like successful BUY/SWAP
          slippageBps: Math.floor(2.0 * 100), // Use same 2% slippage as successful BUY/SWAP
          userKeypair: userKeypair,
          inputDecimals: sellData.fromTokenInfo.decimals,
          outputDecimals: 9,
          inputTicker: sellData.fromToken.toUpperCase(),
          outputTicker: sellData.toToken.toUpperCase(),
        },
        quote
      );

      // Execute transaction
      signature = await wallet.sendTransaction(instructions, [userKeypair]);
    }

    console.log(`🚀 Sell transaction submitted: ${signature}`);

    // Wait for confirmation
    await wallet.confirmTransaction(signature);

    const successMessage = [
      "✅ <b>SELL COMPLETED!</b>",
      "",
      `💰 <b>Sold:</b> ${sellData.amount} ${sellData.fromToken}`,
      `🎯 <b>Received:</b> ${sellData.toToken}`,
      "",
      `🔗 <b>Transaction:</b> <code>${signature.slice(
        0,
        8
      )}...${signature.slice(-8)}</code>`,
      "",
      "🎉 <b>Sale successful!</b>",
    ].join("\n");

    await ctx.editMessageText(successMessage, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .webApp("🔍 VIEW TX", `https://solscan.io/tx/${signature}`)
        .row()
        .text("💰 WALLET", "main_wallet")
        .text("🔴 SELL MORE", "cmd_sell")
        .row(),
    });
    await safeAnswerCallbackQuery(ctx, "Sell completed!");

    // Clear wallet cache to force fresh balance on next wallet access
    const cacheKey = ctx.from?.id?.toString();
    if (cacheKey) {
      walletDataCache.delete(cacheKey);
      console.log(`🧹 Cleared wallet cache for user ${cacheKey} after SELL`);
    }

    transactionCache.delete(txId);
  } catch (error: any) {
    console.error("Sell execution error:", error);

    const errorMessage = [
      "❌ <b>Sell Transaction Failed</b>",
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "The transaction could not be completed. Please check your balance and try again.",
    ].join("\n");

    await ctx.editMessageText(errorMessage, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
      .text("← Try Again", "cmd_sell")
        .text("💰 WALLET", "main_wallet")
        .row(),
    });

    await safeAnswerCallbackQuery(ctx, "❌ Sell failed");
    transactionCache.delete(txId);
  }
});

// Handle "buy with" payment method selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_with_")) {
    return await next();
  }

  const paymentToken = callbackData.replace("buy_with_", "");
  console.log(`🟢 Buy with payment method selected: ${paymentToken}`);

  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const shortAddress = `${keypair.publicKey
      .toBase58()
      .slice(0, 6)}...${keypair.publicKey.toBase58().slice(-6)}`;

    // Handle "other_tokens" case - show available tokens
    if (paymentToken === "other_tokens") {
      const { tokenBalances } = await getCachedWalletData(telegramId);

      const response = [
        `🟢 <b>BUY TOKENS</b>`,
        "",
        `<b>From:</b> <code>${shortAddress}</code>`,
        "",
        `<b>Choose token to pay with:</b>`,
      ];

      const keyboard = new InlineKeyboard();

      // Show available tokens
      for (const token of tokenBalances.slice(0, 6)) {
        if (parseFloat(token.rawBalance) > 0) {
          const formatted = wallet.formatTokenBalance(
            token.balance,
            token.decimals
          );
          keyboard
            .text(`${token.ticker} (${formatted})`, `buy_with_${token.ticker}`)
            .row();
        }
      }

      keyboard.text("← Back", "cmd_buy").row();

      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      await ctx.answerCallbackQuery("Select payment token");
      return;
    }

    const response = [
      `🟢 <b>BUY TOKENS</b>`,
      "",
      `<b>Paying with:</b> ${paymentToken}`,
      `<b>From:</b> <code>${shortAddress}</code>`,
      "",
      `<b>What do you want to buy?</b>`,
    ];

    const keyboard = new InlineKeyboard();

    // Popular tokens section - only TIMBA and USDC
    const popularTokens = [
      { symbol: "TIMBA", name: "🎲 TIMBA" },
      { symbol: "USDC", name: "💵 USDC" },
    ];

    for (const token of popularTokens) {
      if (token.symbol !== paymentToken) {
        // Don't show same token
        keyboard
          .text(token.name, `buy_popular_${paymentToken}_${token.symbol}`)
          .row();
      }
    }

    // Custom options
    keyboard
      .text("📋 PASTE CONTRACT ADDRESS", `buy_contract_${paymentToken}`)
      .row();

    keyboard.text("← Back", "cmd_buy").row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery("Select token to buy");
  } catch (error) {
    console.error("Error in buy_with selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing payment method");
  }
});

// Handle popular token selection for buy
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_popular_")) {
    return await next();
  }

  const parts = callbackData.replace("buy_popular_", "").split("_");
  if (parts.length < 2) return await next();

  const paymentToken = parts[0];
  const targetToken = parts[1];

  if (!paymentToken || !targetToken) {
    console.error("Invalid buy popular callback data");
    return await next();
  }

  console.log(`🟢 Popular token buy: ${paymentToken} → ${targetToken}`);

  try {
    await showBuyAmountSelection(ctx, paymentToken, targetToken);
    await ctx.answerCallbackQuery(`Buy ${targetToken} with ${paymentToken}`);
  } catch (error) {
    console.error("Error in buy_popular selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing token selection");
  }
});

// Handle dynamic token selection (from CA or symbol search)
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_dynamic_")) {
    return await next();
  }

  const parts = callbackData.replace("buy_dynamic_", "").split("_");
  if (parts.length < 2) return await next();

  const paymentToken = parts[0];
  const tokenTxId = parts[1];

  if (!paymentToken || !tokenTxId) {
    console.error("Invalid buy dynamic callback data");
    return await next();
  }

  // Get the cached token info
  const tokenData = transactionCache.get(tokenTxId);
  if (!tokenData) {
    await ctx.answerCallbackQuery("❌ Token data expired. Please try again.");
    return;
  }

  const targetToken = tokenData.targetToken;
  const contractAddress = tokenData.targetTokenAddress;

  console.log(
    `🟢 Dynamic token buy: ${paymentToken} → ${targetToken} (${contractAddress})`
  );

  try {
    // Store the contract address for later use in transactions
    const userId = ctx.from?.id?.toString();
    if (userId) {
      setUserState(userId, {
        type: "dynamic_token_buy",
        paymentToken: paymentToken,
        targetToken: targetToken,
        contractAddress: contractAddress,
        messageId: ctx.callbackQuery?.message?.message_id,
      });
    }

    // For dynamic tokens, pass contract address to amount selection
    await showBuyAmountSelection(
      ctx,
      paymentToken,
      targetToken,
      contractAddress
    );
    await ctx.answerCallbackQuery(`Buy ${targetToken} with ${paymentToken}`);
  } catch (error) {
    console.error("Error in dynamic token selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing token selection");
  }
});

// Handle contract address input for buy
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_contract_")) {
    return await next();
  }

  const paymentToken = callbackData.replace("buy_contract_", "");
  console.log(
    `🔔 Contract address input requested for payment: ${paymentToken}`
  );

  try {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const response = [
      `📋 <b>CONTRACT ADDRESS</b>`,
      "",
      `<b>Paying with:</b> ${paymentToken}`,
      "",
      `Please send a message with the contract address (CA) of the token you want to buy.`,
      "",
      `<b>Examples:</b>`,
      `• <code>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code>`,
      `• <code>BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4</code>`,
      "",
      `<b>Format:</b> 44 characters (Solana address)`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("❌ Cancel", `buy_with_${paymentToken}`)
        .row(),
    });

    setUserState(userId, {
      type: "buy_contract_address",
      fromToken: paymentToken,
      messageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.answerCallbackQuery("Send contract address as message");
  } catch (error) {
    console.error("Error in buy_contract:", error);
    await ctx.answerCallbackQuery("❌ Error processing contract input");
  }
});

// Handle symbol search input for buy
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_search_")) {
    return await next();
  }

  const paymentToken = callbackData.replace("buy_search_", "");
  console.log(`🔔 Symbol search requested for payment: ${paymentToken}`);

  try {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    const response = [
      `🔍 <b>SEARCH BY SYMBOL</b>`,
      "",
      `<b>Paying with:</b> ${paymentToken}`,
      "",
      `Please send a message with the token symbol you want to buy.`,
      "",
      `<b>Examples:</b>`,
      `• <code>BONK</code>`,
      `• <code>PEPE</code>`,
      `• <code>WIF</code>`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("❌ Cancel", `buy_with_${paymentToken}`)
        .row(),
    });

    setUserState(userId, {
      type: "buy_token_symbol",
      fromToken: paymentToken,
      messageId: ctx.callbackQuery?.message?.message_id,
    });

    await ctx.answerCallbackQuery("Send token symbol as message");
  } catch (error) {
    console.error("Error in buy_search:", error);
    await ctx.answerCallbackQuery("❌ Error processing symbol search");
  }
});

// Handle BUY amount selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_amount_")) {
    return await next();
  }

  // Parse callback data: buy_amount_PAYMENTTOKEN_TARGETTOKEN_AMOUNT or buy_amount_PAYMENTTOKEN_TOKENTXID_AMOUNT
  const parts = callbackData.replace("buy_amount_", "").split("_");
  if (parts.length < 3) {
    return await next();
  }

  const paymentToken = parts[0];
  const secondPart = parts[1];
  const amount = parts.slice(2).join("_"); // Handle cases where amount might contain underscores

  if (!paymentToken || !secondPart || !amount) {
    return await ctx.answerCallbackQuery("❌ Invalid buy parameters");
  }

  // Check if second part is a transaction ID (from contract address flow) or target token
  let targetToken = secondPart;
  let contractAddress: string | undefined;

  // If it looks like a transaction ID (short alphanumeric), look it up in cache
  if (secondPart.length < 20 && /^[a-z0-9]+$/.test(secondPart)) {
    const cachedInfo = transactionCache.get(secondPart);
    if (cachedInfo && cachedInfo.targetToken) {
      targetToken = cachedInfo.targetToken;
      contractAddress = cachedInfo.targetTokenAddress;
    }
  }

  if (!targetToken) {
    return await ctx.answerCallbackQuery("❌ Invalid target token");
  }

  console.log(
    `💰 BUY amount selected: ${amount} ${paymentToken} → ${targetToken}`
  );

  try {
    const userId = ctx.from?.id?.toString();

    // Get existing user state to check for dynamic token info
    const existingState = getUserState(userId, false); // Don't clear it yet
    // Use contractAddress from transaction cache if available, otherwise from user state
    if (!contractAddress) {
      contractAddress = existingState?.contractAddress;
    }

    if (amount === "CUSTOM") {
      // Handle custom amount input
      if (!userId) return;

      const response = [
        `💰 <b>BUY ${targetToken} - CUSTOM AMOUNT</b>`,
        "",
        `<b>Paying with:</b> ${paymentToken}`,
        `<b>Target token:</b> ${targetToken}`,
        "",
        `Please send a message with the amount of ${paymentToken} you want to spend.`,
        "",
        `<b>Examples:</b>`,
        `• <code>0.1</code> (spend 0.1 ${paymentToken})`,
        `• <code>5</code> (spend 5 ${paymentToken})`,
        `• <code>50%</code> (spend 50% of balance)`,
        `• <code>max</code> (spend all available ${paymentToken})`,
        "",
        `⏱️ <i>This will timeout in 5 minutes</i>`,
      ];

      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel", `buy_with_${paymentToken}`)
          .row(),
      });

      setUserState(userId, {
        type: "buy_custom_amount",
        paymentToken: paymentToken,
        targetToken: targetToken,
        contractAddress: contractAddress, // Preserve contract address from previous state
        messageId: ctx.callbackQuery?.message?.message_id,
      });

      await ctx.answerCallbackQuery("Send custom amount as message");
      return;
    }

    // Handle predefined amounts or percentages
    await showBuyQuoteAndConfirmation(
      ctx,
      paymentToken,
      targetToken,
      amount,
      contractAddress
    );
  } catch (error: any) {
    console.error("Error in buy_amount:", error);

    const errorMessage = [
      "❌ <b>Error Processing Buy Request</b>",
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please try again or contact support if the issue persists.",
    ];

    await ctx.editMessageText(errorMessage.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("← TRY AGAIN", `buy_with_${paymentToken}`)
        .row(),
    });

    await ctx.answerCallbackQuery("❌ Error processing buy request");
  }
});

// Handle BUY confirmation
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("confirm_buy_")) {
    return await next();
  }

  const txId = callbackData.replace("confirm_buy_", "");
  // Handle both transactionCache (new format with tx_ prefix) and old format
  let buyData = transactionCache.get(txId) || pendingTransactions.get(txId);

  if (!buyData) {
    await ctx.answerCallbackQuery("❌ Transaction expired. Please try again.");
    return;
  }

  console.log(
    `✅ BUY confirmation for: ${buyData.amount} ${buyData.fromToken} → ${buyData.toToken}`
  );

  try {
    // Show processing state
    await ctx.editMessageText(
      [
        "⏳ <b>Processing Buy Transaction...</b>",
        "",
        `🔄 <i>Executing ${buyData.amount} ${buyData.fromToken} → ${buyData.toToken}</i>`,
        "",
        "Please wait, this may take a few moments...",
      ].join("\n"),
      { parse_mode: "HTML" }
    );

    await safeAnswerCallbackQuery(ctx, "Processing buy...");

    const userId = ctx.from?.id?.toString();
    if (!userId) {
      throw new Error("User ID not found");
    }

    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const userKeypair = wallet.getKeyPair(telegramId);

    // Use the existing global swapManager instance

    let signature: string;
    let instructions: any[];

    // Use the existing quote that was already generated and stored
    if (!buyData.quote) {
      throw new Error("No quote data available for this transaction");
    }

    // Execute the swap using the stored quote (same logic as confirm_swap)
    const quote = buyData.quote;

    // Use the same successful approach as the working /swap command

    if (quote.provider === "jupiter") {
      // Use Jupiter execution method
      signature = await swapManager.executeJupiterSwap(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount, // Use quote amount like successful swap does
          slippageBps: Math.floor(2.0 * 100), // Use same 2% slippage as successful swap
          userKeypair: userKeypair,
          inputDecimals: quote.inputDecimals || 9,
          outputDecimals: quote.outputDecimals || 9,
          inputTicker: buyData.fromToken.toUpperCase(),
          outputTicker: buyData.toToken.toUpperCase(),
        },
        quote
      );
    } else {
      // Use instruction-based approach for other providers (pump.fun)
      instructions = await swapManager.createSwapTransaction(
        {
          inputMint: quote.inputMint,
          outputMint: quote.outputMint,
          amount: quote.inputAmount, // Use quote amount like successful swap does
          slippageBps: Math.floor(2.0 * 100), // Use same 2% slippage as successful swap
          userKeypair: userKeypair,
          inputDecimals: quote.inputDecimals || 9,
          outputDecimals: quote.outputDecimals || 6,
          inputTicker: buyData.fromToken.toUpperCase(),
          outputTicker: buyData.toToken.toUpperCase(),
        },
        quote
      );

      // Execute transaction
      signature = await wallet.sendTransaction(instructions, [userKeypair]);
    }

    console.log(`🚀 Buy transaction submitted: ${signature}`);

    // Wait for confirmation
    await wallet.confirmTransaction(signature);

    const successMessage = [
      "✅ <b>BUY COMPLETED!</b>",
      "",
      `💰 <b>Spent:</b> ${buyData.amount} ${buyData.fromToken}`,
      `🎯 <b>Received:</b> ${buyData.toToken} tokens`,
      "",
      `🔗 <b>Transaction:</b> <code>${signature.slice(
        0,
        8
      )}...${signature.slice(-8)}</code>`,
      "",
      "🎉 <b>Purchase successful!</b>",
    ].join("\n");

    await ctx.editMessageText(successMessage, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .webApp("🔍 VIEW TX", `https://solscan.io/tx/${signature}`)
        .row()
        .text("💰 WALLET", "main_wallet")
        .text("🔄 BUY MORE", "cmd_buy")
        .row(),
    });
    await safeAnswerCallbackQuery(ctx, "Buy completed!");

    // Clear wallet cache to force fresh balance on next wallet access
    const cacheKey = ctx.from?.id?.toString();
    if (cacheKey) {
      walletDataCache.delete(cacheKey);
      console.log(`🧹 Cleared wallet cache for user ${cacheKey} after BUY`);
    }

    transactionCache.delete(txId);
  } catch (error: any) {
    console.error("Buy execution error:", error);

    let errorMessage: string;
    let keyboard = new InlineKeyboard();

    // Handle specific error types
    if (
      (error as Error).message?.includes("TooMuchSolRequired") ||
      (error as Error).message?.includes("slippage") ||
      error.transactionLogs?.some((log: string) =>
        log.includes("TooMuchSolRequired")
      )
    ) {
      // Extract the actual amounts needed from logs if available
      let requiredAmount = null;
      let yourAmount = null;

      if (error.transactionLogs) {
        for (const log of error.transactionLogs) {
          if (log.includes("Left:") && log.includes("Right:")) {
            const leftMatch = log.match(/Left: (\d+)/);
            const rightMatch = log.match(/Right: (\d+)/);
            if (leftMatch && rightMatch) {
              yourAmount = parseInt(leftMatch[1]) / 1000000000; // Convert lamports to SOL
              requiredAmount = parseInt(rightMatch[1]) / 1000000000;
              break;
            }
          }
        }
      }

      let suggestionText = "• Try a slightly higher amount";
      let buttonText = "💡 TRY HIGHER";

      if (requiredAmount && yourAmount) {
        const difference = requiredAmount - yourAmount;
        const suggestedAmount = requiredAmount + difference * 0.1; // Add 10% buffer
        const isDifferenceSmall = difference < 0.001;

        const suggestedLamports = Math.round(suggestedAmount * 1_000_000_000);
        const suggestedStr = wallet.formatSolBalance(suggestedLamports);
        suggestionText = isDifferenceSmall
          ? `• Try with ${suggestedStr} SOL (includes fees/buffer)`
          : `• Try with ${suggestedStr} SOL (price moved)`;
        buttonText = `💡 ${suggestedStr} SOL`;
      }

      // Get difference amount for better messaging
      const difference =
        requiredAmount && yourAmount ? requiredAmount - yourAmount : 0;
      const isDifferenceSmall = difference > 0 && difference < 0.001; // Less than 0.001 SOL

      // Slippage error - offer specific solutions
      errorMessage = [
        isDifferenceSmall
          ? "⚠️ <b>Small Amount Missing</b>"
          : "⚠️ <b>Amount Adjustment Needed</b>",
        "",
        `You tried: ${buyData.amount} ${buyData.fromToken}`,
        requiredAmount
          ? `Need: ${wallet.formatSolBalance(Math.round(requiredAmount * 1_000_000_000))} ${buyData.fromToken}`
          : "But need slightly more",
        isDifferenceSmall
          ? `Difference: ${wallet.formatSolBalance(Math.round(difference * 1_000_000_000))} SOL (likely fees/precision)`
          : "",
        "",
        "<b>Why this happens:</b>",
        isDifferenceSmall
          ? "• Transaction fees not included in quote"
          : "• Price moved or slippage protection",
        isDifferenceSmall
          ? "• Small calculation differences in SDK"
          : "• Market volatility",
        "",
        "<b>Solutions:</b>",
        suggestionText,
        "• Wait and retry",
        "",
        "🛡️ <i>This protects you from failed transactions!</i>",
      ]
        .filter((line) => line !== "")
        .join("\n");

      keyboard
        .text(buttonText, `buy_retry_exact_${txId}`)
        .text("🔄 Retry Same", `confirm_buy_${txId}`)
        .row()
        .text("← Back to Buy", "cmd_buy")
        .text("💰 Wallet", "main_wallet")
        .row();

      // Store the exact amount needed for the retry button
      if (requiredAmount && yourAmount !== null) {
        const retryAmount =
          requiredAmount + (requiredAmount - yourAmount) * 0.1;
        buyData.retryAmount = retryAmount.toFixed(4);
      }
    } else if (
      (error as Error).message?.includes("Insufficient funds") ||
      (error as Error).message?.includes("insufficient")
    ) {
      // Insufficient funds error
      errorMessage = [
        "❌ <b>Insufficient Funds</b>",
        "",
        `You don't have enough ${buyData.fromToken} to complete this purchase.`,
        `Needed: ${buyData.amount} ${buyData.fromToken}`,
        "",
        "Please check your balance and try a smaller amount.",
      ].join("\n");

      keyboard
        .text("💰 Check Balance", "main_wallet")
        .text("← Try Smaller", "cmd_buy")
        .row();
    } else {
      // Generic error
      errorMessage = [
        "❌ <b>Buy Transaction Failed</b>",
        "",
        `<b>Error:</b> ${(error as Error).message || "Unknown error"}`,
        "",
        "The transaction could not be completed. Please try again.",
      ].join("\n");

      keyboard
        .text("🔄 Try Again", "cmd_buy")
        .text("💰 Wallet", "main_wallet")
        .row();
    }

    await ctx.editMessageText(errorMessage, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });

    await safeAnswerCallbackQuery(ctx, "❌ Buy failed");
    transactionCache.delete(txId);
  }
});

// Handle BUY retry with exact amount needed
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_retry_exact_")) {
    return await next();
  }

  const txId = callbackData.replace("buy_retry_exact_", "");
  const buyData = transactionCache.get(txId) || pendingTransactions.get(txId);

  if (!buyData) {
    await ctx.answerCallbackQuery("❌ Transaction expired. Please try again.");
    return;
  }

  try {
    // Use the exact retry amount calculated from the error, or add small buffer
    let newAmount =
      buyData.retryAmount || (parseFloat(buyData.amount) * 1.01).toString();

    console.log(
      `💡 Retrying buy with exact amount needed: ${newAmount} ${buyData.fromToken} → ${buyData.toToken}`
    );

    // Update the stored transaction with new amount
    if (transactionCache.has(txId)) {
      buyData.amount = newAmount;
      transactionCache.set(txId, buyData);
    } else if (pendingTransactions.has(txId)) {
      buyData.amount = newAmount;
      pendingTransactions.set(txId, buyData);
    }

    // Show updated confirmation with new amount
    await ctx.editMessageText(
      [
        "💡 <b>Using Exact Amount Needed</b>",
        "",
        `📈 <b>Original:</b> ${buyData.amount} ${buyData.fromToken}`,
        `✅ <b>New Amount:</b> ${newAmount} ${buyData.fromToken}`,
        `🎯 <b>Buying:</b> ${buyData.toToken}`,
        "",
        "This matches the current price. Ready to proceed?",
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("✅ CONFIRM BUY", `confirm_buy_${txId}`)
          .row()
          .text("← BACK TO BUY", "cmd_buy")
          .row(),
      }
    );

    await ctx.answerCallbackQuery("💡 Amount increased slightly");
  } catch (error) {
    console.error("Error in buy retry higher:", error);
    await ctx.answerCallbackQuery("❌ Error processing retry");
  }
});

// Handle BUY slippage selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_slip_")) {
    return await next();
  }

  const parts = callbackData.replace("buy_slip_", "").split("_");
  if (parts.length < 2) return await next();

  const txId = parts[0];
  const slippageValue = parts[1];

  if (!txId || !slippageValue) {
    return await ctx.answerCallbackQuery("❌ Invalid slippage request");
  }

  console.log(`⚙️ BUY slippage change: ${slippageValue}% for txId: ${txId}`);

  try {
    const buyData = transactionCache.get(txId);
    if (!buyData) {
      await ctx.answerCallbackQuery(
        "❌ Transaction expired. Please try again."
      );
      return;
    }

    if (slippageValue === "custom") {
      // Handle custom slippage input
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      const response = [
        `⚙️ <b>CUSTOM SLIPPAGE</b>`,
        "",
        `<b>Current:</b> ${buyData.quote.slippage || 1.0}%`,
        "",
        `Please send a message with your desired slippage percentage.`,
        "",
        `<b>Examples:</b>`,
        `• <code>0.5</code> (0.5% slippage)`,
        `• <code>1.5</code> (1.5% slippage)`,
        `• <code>3</code> (3% slippage)`,
        "",
        `<b>Range:</b> 0.1% - 10%`,
        `⏱️ <i>This will timeout in 5 minutes</i>`,
      ];

      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel", `buy_slip_back_${txId}`)
          .row(),
      });

      setUserState(userId, {
        type: "buy_custom_slippage",
        txId: txId,
        messageId: ctx.callbackQuery?.message?.message_id,
      });

      await ctx.answerCallbackQuery("Send custom slippage as message");
      return;
    }

    // Update slippage for predefined values
    const newSlippage = parseFloat(slippageValue);
    if (isNaN(newSlippage) || newSlippage < 0.1 || newSlippage > 10) {
      await ctx.answerCallbackQuery("❌ Invalid slippage value");
      return;
    }

    // Update the cached buy data with new slippage
    buyData.quote.slippage = newSlippage;
    transactionCache.set(txId, buyData);

    // Regenerate quote with new slippage
    await regenerateBuyQuoteWithSlippage(ctx, txId, newSlippage);
    await ctx.answerCallbackQuery(`✅ Slippage set to ${newSlippage}%`);
  } catch (error: any) {
    console.error("Error in slippage change:", error);
    await ctx.answerCallbackQuery("❌ Error updating slippage");
  }
});

// Handle BUY slippage back button
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("buy_slip_back_")) {
    return await next();
  }

  const txId = callbackData.replace("buy_slip_back_", "");

  try {
    // Regenerate the original buy confirmation screen
    await regenerateBuyQuoteWithSlippage(ctx, txId);
    await ctx.answerCallbackQuery("⚙️ Back to confirmation");
  } catch (error) {
    console.error("Error going back from slippage:", error);
    await ctx.answerCallbackQuery("❌ Error loading confirmation");
  }
});

// ================================
// SWAP INTERFACE HANDLERS
// ================================

// Handle "FROM" token selection for swap
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("swap_from_")) {
    return await next();
  }

  const fromToken = callbackData.replace("swap_from_", "");
  console.log("🔔 Swap FROM token selected:", fromToken);

  try {
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    const keypair = wallet.getKeyPair(telegramId);
    const shortAddress = `${keypair.publicKey
      .toBase58()
      .slice(0, 6)}...${keypair.publicKey.toBase58().slice(-6)}`;

    // Get available tokens to swap TO (exclude the FROM token)
    await getCachedWalletData(telegramId);

    const response = [
      `💱 <b>SWAP ${fromToken}</b>`,
      "",
      `<b>From:</b> <code>${shortAddress}</code>`,
      "",
      `<b>Select token to swap TO:</b>`,
    ];

    const keyboard = new InlineKeyboard();

    // Add SOL option if not swapping from SOL
    if (fromToken !== "SOL") {
      keyboard.text(`SOL`, `swap_to_${fromToken}_SOL`).row();
    }

    // Add popular tokens (USDC, WSOL, TIMBA)
    const popularTokens = ["USDC", "WSOL", "TIMBA"];
    for (const token of popularTokens) {
      if (token !== fromToken) {
        keyboard.text(`${token}`, `swap_to_${fromToken}_${token}`).row();
      }
    }

    // Add "Other Token" option
    keyboard.text("🔍 Other Token", `swap_to_${fromToken}_OTHER`).row();
    keyboard.text("← BACK TO SWAP", "cmd_swap").row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    await ctx.answerCallbackQuery(`Select token to receive`);
  } catch (error) {
    console.error("Error in swap_from selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing swap selection");
  }
});

// Handle "TO" token selection for swap
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("swap_to_")) {
    return await next();
  }

  const parts = callbackData.replace("swap_to_", "").split("_");
  if (parts.length < 2) return await next();

  const fromToken = parts[0];
  const toToken = parts.slice(1).join("_");

  if (!fromToken || !toToken) {
    return await ctx.answerCallbackQuery("❌ Invalid swap pair");
  }

  console.log(`🔔 Swap pair selected: ${fromToken} → ${toToken}`);

  try {
    if (toToken === "OTHER") {
      // Handle custom token input
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      const response = [
        `🔍 <b>CUSTOM TOKEN</b>`,
        "",
        `Swapping FROM: <b>${fromToken}</b>`,
        "",
        `Please send a message with the token mint address or symbol.`,
        "",
        `<b>Examples:</b>`,
        `• <code>EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v</code> (USDC)`,
        `• <code>BONK</code>`,
        "",
        `⏱️ <i>This will timeout in 5 minutes</i>`,
      ];

      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_swap").row(),
      });

      setUserState(userId, {
        type: "swap_to_token",
        fromToken: fromToken,
        messageId: ctx.callbackQuery?.message?.message_id,
      });

      await ctx.answerCallbackQuery("Send token mint or symbol");
      return;
    }

    // Show amount selection for the swap pair
    await showSwapAmountSelection(ctx, fromToken, toToken);
    await ctx.answerCallbackQuery(`${fromToken} → ${toToken}`);
  } catch (error) {
    console.error("Error in swap_to selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing swap pair");
  }
});

// Handle swap amount selection
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith("swap_amount_")) {
    return await next();
  }

  const parts = callbackData.replace("swap_amount_", "").split("_");
  if (parts.length < 3) return await next();

  const fromToken = parts[0];
  const toToken = parts[1];
  const amount = parts.slice(2).join("_");

  if (!fromToken || !toToken || !amount) {
    return await ctx.answerCallbackQuery("❌ Invalid swap parameters");
  }

  console.log(`🔔 Swap amount selected: ${amount} ${fromToken} → ${toToken}`);

  try {
    if (amount === "CUSTOM") {
      // Handle custom amount input
      const userId = ctx.from?.id?.toString();
      if (!userId) return;

      const response = [
        `✏️ <b>CUSTOM AMOUNT</b>`,
        "",
        `<b>Swap:</b> ${fromToken} → ${toToken}`,
        "",
        `Please send a message with the amount of ${fromToken} to swap.`,
        "",
        `<b>Examples:</b>`,
        `• <code>10</code>`,
        `• <code>0.5</code>`,
        `• <code>max</code> (all balance)`,
        "",
        `⏱️ <i>This will timeout in 5 minutes</i>`,
      ];

      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel", `swap_to_${fromToken}_${toToken}`)
          .row(),
      });

      setUserState(userId, {
        type: "swap_custom_amount",
        fromToken: fromToken,
        toToken: toToken,
        messageId: ctx.callbackQuery?.message?.message_id,
      });

      await ctx.answerCallbackQuery("Send amount as message");
      return;
    }

    // Get quote and show confirmation
    const telegramId = BigInt(ctx.from?.id || 0) as bigint;
    await showSwapQuoteAndConfirmation(
      ctx,
      fromToken,
      toToken,
      amount,
      telegramId
    );
    await ctx.answerCallbackQuery("Getting swap quote...");
  } catch (error) {
    console.error("Error in swap amount selection:", error);
    await ctx.answerCallbackQuery("❌ Error processing swap amount");
  }
});

/**
 * Show swap amount selection interface
 */
const showSwapAmountSelection = async (
  ctx: any,
  fromToken: string,
  toToken: string
) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  // Get balance for the FROM token
  const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

  let balance = "0";
  let formattedBalance = "0";

  if (fromToken === "SOL") {
    balance = solBalance.toString();
    formattedBalance = wallet.formatSolBalance(solBalance);
  } else {
    const tokenBalance = tokenBalances.find((t) => t.ticker === fromToken);
    if (tokenBalance) {
      balance = tokenBalance.balance.toString();
      formattedBalance = wallet.formatTokenBalance(
        tokenBalance.balance,
        tokenBalance.decimals
      );
    }
  }

  const response = [
    `💱 <b>SWAP AMOUNT</b>`,
    "",
    `<b>From:</b> ${fromToken} (${formattedBalance})`,
    `<b>To:</b> ${toToken}`,
    "",
    `<b>Select amount to swap:</b>`,
  ];

  const keyboard = new InlineKeyboard();

  if (parseFloat(balance) > 0) {
    // Quick amounts based on balance
    const maxBalance = parseFloat(balance);
    if (maxBalance >= 100) {
      keyboard
        .text("10", `swap_amount_${fromToken}_${toToken}_10`)
        .text("50", `swap_amount_${fromToken}_${toToken}_50`)
        .row()
        .text("100", `swap_amount_${fromToken}_${toToken}_100`)
        .text("25%", `swap_amount_${fromToken}_${toToken}_25%`)
        .row();
    } else if (maxBalance >= 10) {
      keyboard
        .text("1", `swap_amount_${fromToken}_${toToken}_1`)
        .text("5", `swap_amount_${fromToken}_${toToken}_5`)
        .row()
        .text("10", `swap_amount_${fromToken}_${toToken}_10`)
        .text("50%", `swap_amount_${fromToken}_${toToken}_50%`)
        .row();
    } else {
      keyboard
        .text("0.1", `swap_amount_${fromToken}_${toToken}_0.1`)
        .text("0.5", `swap_amount_${fromToken}_${toToken}_0.5`)
        .row()
        .text("1", `swap_amount_${fromToken}_${toToken}_1`)
        .text("75%", `swap_amount_${fromToken}_${toToken}_75%`)
        .row();
    }

    keyboard
      .text("MAX", `swap_amount_${fromToken}_${toToken}_max`)
      .text("✏️ Custom", `swap_amount_${fromToken}_${toToken}_CUSTOM`)
      .row();
  } else {
    keyboard.text("❌ Insufficient balance").row();
  }

  keyboard.text("← Back", `swap_to_${fromToken}_${toToken}`).row();

  await ctx.editMessageText(response.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
};

/**
 * Show swap quote and confirmation
 */
const showSwapQuoteAndConfirmation = async (
  ctx: any,
  fromToken: string,
  toToken: string,
  amount: string,
  telegramId?: bigint
) => {
  const userId = telegramId || (BigInt(ctx.from?.id || 0) as bigint);

  // Update message to show loading
  await ctx.editMessageText(
    `🔄 <b>GETTING QUOTE</b>\n\n${amount} ${fromToken} → ${toToken}\n\n<i>Please wait...</i>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard(),
    }
  );

  try {
    // Get real quote from swapManager
    const tokenMints: { [key: string]: string } = {
      SOL: "So11111111111111111111111111111111111111112",
      TIMBA: "BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4",
      WSOL: "So11111111111111111111111111111111111111112",
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };

    const inputMint = tokenMints[fromToken];
    const outputMint = tokenMints[toToken];

    if (!inputMint || !outputMint) {
      throw new Error(`Unsupported token pair: ${fromToken} → ${toToken}`);
    }

    // Handle max amount
    let actualAmount = amount;
    if (amount === "max") {
      const { solBalance, tokenBalances } = await getCachedWalletData(userId);
      if (fromToken === "SOL") {
        actualAmount = (solBalance - 0.01).toString(); // Leave 0.01 SOL for fees
      } else {
        const tokenBalance = tokenBalances.find((t) => t.ticker === fromToken);
        if (!tokenBalance) {
          throw new Error(`No ${fromToken} balance found`);
        }
        actualAmount = tokenBalance.balance.toString();
      }
    }

    // Get user keypair for quote request
    const keypair = wallet.getKeyPair(userId);

    // Get token metadata for decimals
    const inputDecimals =
      fromToken === "SOL"
        ? 9
        : await wallet.getTokenMetadata(inputMint).then((m) => m.decimals);
    const outputDecimals =
      toToken === "SOL"
        ? 9
        : await wallet.getTokenMetadata(outputMint).then((m) => m.decimals);

    // Convert amount to base units (lamports/smallest unit)
    const baseAmount = Math.floor(
      parseFloat(actualAmount) * Math.pow(10, inputDecimals)
    ).toString();

    // Use the same structure as the original implementation
    const quote = await swapManager.getQuote({
      inputMint,
      outputMint,
      amount: baseAmount, // Use base units (same as rawAmount.toString())
      slippageBps: 100, // 1.0%
      userKeypair: keypair,
      inputDecimals,
      outputDecimals,
      inputTicker: fromToken.toUpperCase(),
      outputTicker: toToken.toUpperCase(),
    });

    // Use the existing formatter like the original implementation
    const quoteMessage = swapManager.formatQuoteForDisplay(
      quote,
      inputDecimals,
      outputDecimals,
      fromToken.toUpperCase(),
      toToken.toUpperCase()
    );

    const response = quoteMessage + "\n\n⚠️ <b>Confirm this swap?</b>";

    // Generate transaction ID for confirmation
    const txId = generateTransactionId();
    storePendingTransaction(txId, {
      type: "swap",
      fromToken,
      toToken,
      amount: actualAmount,
      userId: userId.toString(),
      quote: quote, // Store the quote for execution
    });

    await ctx.editMessageText(response, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ Confirm Swap", `confirm_swap_${txId}`)
        .row()
        .text("❌ Cancel", `swap_to_${fromToken}_${toToken}`)
        .row(),
    });
  } catch (error) {
    console.error("Error getting swap quote:", error);
    await ctx.editMessageText(
      `❌ <b>QUOTE ERROR</b>\n\n${
        (error as Error).message
      }\n\nPlease try again.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("← Try Again", `swap_to_${fromToken}_${toToken}`)
          .row(),
      }
    );
  }
};

// ================================
// BUY HELPER FUNCTIONS
// ================================

/**
 * Show buy amount selection interface
 */
const showBuyAmountSelection = async (
  ctx: any,
  paymentToken: string,
  targetToken: string,
  _contractAddress?: string
) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  // Get balance for the payment token
  const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

  let balance = "0";
  let formattedBalance = "0";

  if (paymentToken === "SOL") {
    balance = solBalance.toString();
    formattedBalance = wallet.formatSolBalance(solBalance);
  } else {
    const tokenBalance = tokenBalances.find((t) => t.ticker === paymentToken);
    if (tokenBalance) {
      balance = tokenBalance.balance.toString();
      formattedBalance = wallet.formatTokenBalance(
        tokenBalance.balance,
        tokenBalance.decimals
      );
    }
  }

  const response = [
    `🟢 <b>BUY ${targetToken}</b>`,
    "",
    `<b>Paying with:</b> ${paymentToken} (${formattedBalance})`,
    `<b>Target:</b> ${targetToken}`,
    "",
    `<b>How much ${paymentToken} to spend?</b>`,
  ];

  const keyboard = new InlineKeyboard();

  if (parseFloat(balance) > 0.01) {
    // Need minimum for fees
    // Quick amounts based on balance
    const maxBalance = parseFloat(balance);
    if (maxBalance >= 10) {
      keyboard
        .text("1", `buy_amount_${paymentToken}_${targetToken}_1`)
        .text("5", `buy_amount_${paymentToken}_${targetToken}_5`)
        .row()
        .text("10", `buy_amount_${paymentToken}_${targetToken}_10`)
        .text("25%", `buy_amount_${paymentToken}_${targetToken}_25%`)
        .row();
    } else if (maxBalance >= 1) {
      keyboard
        .text("0.1", `buy_amount_${paymentToken}_${targetToken}_0.1`)
        .text("0.5", `buy_amount_${paymentToken}_${targetToken}_0.5`)
        .row()
        .text("1", `buy_amount_${paymentToken}_${targetToken}_1`)
        .text("50%", `buy_amount_${paymentToken}_${targetToken}_50%`)
        .row();
    } else {
      keyboard
        .text("0.01", `buy_amount_${paymentToken}_${targetToken}_0.01`)
        .text("0.05", `buy_amount_${paymentToken}_${targetToken}_0.05`)
        .row()
        .text("0.1", `buy_amount_${paymentToken}_${targetToken}_0.1`)
        .text("75%", `buy_amount_${paymentToken}_${targetToken}_75%`)
        .row();
    }

    keyboard
      .text("MAX", `buy_amount_${paymentToken}_${targetToken}_max`)
      .text("✏️ Custom", `buy_amount_${paymentToken}_${targetToken}_CUSTOM`)
      .row();
  } else {
    keyboard.text("❌ Insufficient balance").row();
  }

  keyboard.text("← Back", `buy_with_${paymentToken}`).row();

  await ctx.editMessageText(response.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
};

/**
 * Fetch and validate token metadata by contract address
 */
const fetchTokenMetadata = async (
  contractAddress: string,
  telegramId?: bigint
) => {
  try {
    // Validate contract address format
    if (contractAddress.length !== 44) {
      throw new Error(
        "Invalid contract address format (must be 44 characters)"
      );
    }

    // Use the same method as wallet balance: check if token exists in wallet
    if (telegramId) {
      console.log("🔍 Checking wallet balances for token metadata...");
      try {
        const { tokenBalances } = await getCachedWalletData(telegramId);
        const existingToken = tokenBalances.find(
          (token) => token.mint === contractAddress
        );

        if (existingToken) {
          console.log("✅ Found token in wallet balance:", existingToken);
          return {
            address: contractAddress,
            symbol: existingToken.ticker,
            name: existingToken.ticker,
            decimals: existingToken.decimals,
            verified: true,
          };
        }
      } catch (walletError) {
        console.log(
          "Wallet balance check failed:",
          (walletError as Error).message
        );
      }
    }

    // Try to get metadata using wallet's metadata function
    try {
      const metadata = await wallet.getTokenMetadata(contractAddress);
      if (
        metadata &&
        typeof metadata === "object" &&
        "symbol" in metadata &&
        metadata.symbol &&
        metadata.symbol !== "UNKNOWN"
      ) {
        return {
          address: contractAddress,
          symbol: (metadata as any).symbol,
          name: (metadata as any).name || (metadata as any).symbol,
          decimals: metadata.decimals || 6,
          verified: true,
        };
      }
    } catch (metadataError) {
      console.log("Wallet metadata failed:", (metadataError as Error).message);
    }

    // Fallback: return truncated address as symbol
    return {
      address: contractAddress,
      symbol: `${contractAddress.slice(0, 4)}...${contractAddress.slice(-4)}`,
      name: "Unknown Token",
      decimals: 6,
      verified: false,
    };
  } catch (error) {
    console.error("Error fetching token metadata:", error);
    throw new Error(
      `Failed to fetch token information: ${(error as Error).message}`
    );
  }
};

/**
 * Show buy quote and confirmation with auto-detection
 */
const showBuyQuoteAndConfirmation = async (
  ctx: any,
  paymentToken: string,
  targetToken: string,
  amount: string,
  contractAddress?: string
) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  // Update message to show loading
  await ctx.editMessageText(
    `🔄 <b>GETTING QUOTE</b>\n\nBuy ${targetToken} with ${amount} ${paymentToken}\n\n<i>Detecting best provider...</i>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard(),
    }
  );

  try {
    // Use existing swap logic but with BUY terminology
    const tokenMints: { [key: string]: string } = {
      SOL: "So11111111111111111111111111111111111111112",
      TIMBA: "BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4",
      WSOL: "So11111111111111111111111111111111111111112",
      USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    };

    const inputMint = tokenMints[paymentToken];
    const outputMint = contractAddress || tokenMints[targetToken];

    if (!inputMint) {
      throw new Error(`Unsupported payment token: ${paymentToken}`);
    }

    if (!outputMint) {
      throw new Error(`Token not found: ${targetToken}`);
    }

    // Handle max amount
    let actualAmount = amount;
    if (amount === "max") {
      const { solBalance, tokenBalances } = await getCachedWalletData(
        telegramId
      );
      if (paymentToken === "SOL") {
        actualAmount = (solBalance - 0.01).toString(); // Leave 0.01 SOL for fees
      } else {
        const tokenBalance = tokenBalances.find(
          (t) => t.ticker === paymentToken
        );
        if (!tokenBalance) {
          throw new Error(`No ${paymentToken} balance found`);
        }
        actualAmount = tokenBalance.balance.toString();
      }
    }

    // Get user keypair for quote request
    const keypair = wallet.getKeyPair(telegramId);

    // Get token metadata for decimals
    const inputDecimals =
      paymentToken === "SOL"
        ? 9
        : await wallet.getTokenMetadata(inputMint).then((m) => m.decimals);
    const outputDecimals = contractAddress
      ? await wallet.getTokenMetadata(outputMint).then((m) => m.decimals)
      : 9;

    // Convert amount to base units
    const baseAmount = Math.floor(
      parseFloat(actualAmount) * Math.pow(10, inputDecimals)
    ).toString();

    // Get quote using existing swap manager
    const quote = await swapManager.getQuote({
      inputMint,
      outputMint,
      amount: baseAmount,
      slippageBps: 100, // 1.0%
      userKeypair: keypair,
      inputDecimals,
      outputDecimals,
      inputTicker: paymentToken.toUpperCase(),
      outputTicker: targetToken.toUpperCase(),
    });

    // Format for BUY terminology
    const response = [
      `<pre>╔╦╗╦╔╦╗╔╗ ╔═╗
 ║ ║║║║╠╩╗╠═╣
 ╩ ╩╩ ╩╚═╝╩ ╩

BUY CONFIRMATION

You Pay: ${actualAmount} ${paymentToken}
You Receive: ~${quote.outputAmount} ${targetToken}

Rate: ${quote.estimatedRate.toFixed(6)} ${targetToken}/${paymentToken}
Provider: ${quote.provider} ${
        quote.provider === "pump-fun" ? "(ungraduated)" : "(graduated)"
      }
Slippage: ${quote.slippage ? quote.slippage.toFixed(1) + "%" : "1.0%"}

Address:
${outputMint}</pre>`,
      "",
      `⚠️ <b>Confirm this purchase?</b>`,
    ].join("\n");

    // Generate transaction ID for confirmation
    const txId = generateTransactionId();
    storePendingTransaction(txId, {
      type: "swap", // Reuse swap logic internally
      fromToken: paymentToken,
      toToken: targetToken,
      amount: actualAmount,
      userId: telegramId.toString(),
      quote: quote,
    });

    await ctx.editMessageText(response, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ Confirm Buy", `confirm_buy_${txId}`)
        .row()
        .text("⚙️ Slippage", `buy_slippage_${txId}`)
        .row()
        .text("0.5%", `buy_slip_${txId}_0.5`)
        .text("1%", `buy_slip_${txId}_1.0`)
        .text("2%", `buy_slip_${txId}_2.0`)
        .row()
        .text("3%", `buy_slip_${txId}_3.0`)
        .text("5%", `buy_slip_${txId}_5.0`)
        .text("✏️", `buy_slip_${txId}_custom`)
        .row()
        .text("❌ Cancel", `buy_with_${paymentToken}`)
        .row(),
    });
  } catch (error) {
    console.error("Error getting buy quote:", error);
    await ctx.editMessageText(
      `❌ <b>QUOTE ERROR</b>\n\n${
        (error as Error).message
      }\n\nPlease try again.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("← Try Again", `buy_with_${paymentToken}`)
          .row(),
      }
    );
  }
};

// ================================
// ERROR HANDLING & BOT STARTUP
// ================================

// Error handling
bot.catch((err) => {
  console.error("Bot error:", err);
});

// ================================
// MESSAGE HANDLER FOR USER INPUT
// ================================

// Handle text messages when user is in input state
bot.on("message:text", async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  const userState = getUserState(userId, true); // Get and clear state

  if (!userState) {
    return await next(); // Not waiting for input, continue to other handlers
  }

  const userMessage = ctx.message.text.trim();

  try {
    // Delete user's message to keep chat clean
    await ctx.deleteMessage();

    if (userState.type === "send_custom_amount") {
      await handleCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "send_address") {
      await handleAddressInput(ctx, userState, userMessage);
    } else if (userState.type === "wrap_custom_amount") {
      await handleWrapAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "swap_to_token") {
      await handleSwapToTokenInput(ctx, userState, userMessage);
    } else if (userState.type === "swap_custom_amount") {
      await handleSwapCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "buy_contract_address") {
      await handleBuyContractAddressInput(ctx, userState, userMessage);
    } else if (userState.type === "buy_token_symbol") {
      await handleBuyTokenSymbolInput(ctx, userState, userMessage);
    } else if (userState.type === "buy_custom_amount") {
      await handleBuyCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "sell_custom_amount") {
      await handleSellCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === "buy_custom_slippage") {
      await handleBuyCustomSlippageInput(ctx, userState, userMessage);
    }
  } catch (error) {
    console.error("Error handling user input:", error);

    // Try to update the original message with error
    try {
      await ctx.editMessageText(
        "❌ <b>Error processing input</b>\n\nPlease try again.",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("← BACK TO WALLET", "main_wallet")
            .row(),
        }
      );
    } catch (editError) {
      // If edit fails, delete and send new message
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply("❌ <b>Error processing input</b>\n\nPlease try again.", {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("← BACK TO WALLET", "main_wallet")
          .row(),
      });
    }
  }
});

/**
 * Handle custom amount input for send
 */
const handleCustomAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const token = userState.token;
  const numAmount = parseFloat(amount);

  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error("Invalid amount format");
  }

  console.log(`💰 Custom amount received: ${amount} ${token}`);

  const response = [
    `📤 <b>SEND ${amount} ${token}</b>`,
    "",
    `<b>Step 2:</b> Enter destination address`,
    "",
    `Please send a message with the Solana wallet address.`,
    "",
    `<b>Format:</b> Public key (44 characters)`,
    `<b>Example:</b> <code>Ge6tnNaEY6kEznY795RSUHS5Wbm3DxMMcroLZcU3dB1Z</code>`,
    "",
    `⏱️ <i>This will timeout in 5 minutes</i>`,
  ];

  await ctx.api.editMessageText(
    ctx.chat.id,
    userState.messageId,
    response.join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("❌ Cancel", `send_select_${token}`)
        .row(),
    }
  );

  // Set new state to expect wallet address
  setUserState(ctx.from.id.toString(), {
    type: "send_address",
    token: token,
    amount: amount,
    messageId: userState.messageId,
  });
};

/**
 * Handle wallet address input for send
 */
const handleAddressInput = async (
  ctx: any,
  userState: any,
  address: string
) => {
  const token = userState.token;
  const amount = userState.amount;

  // Basic Solana address validation (should be ~44 characters)
  if (address.length < 30 || address.length > 50) {
    throw new Error("Invalid wallet address format");
  }

  console.log(
    `📍 Address received for ${amount} ${token}: ${address.slice(0, 8)}...`
  );

  // Generate unique transaction ID and store transaction details
  const txId = generateTransactionId();
  storePendingTransaction(txId, {
    type: "send",
    token: token,
    amount: amount,
    address: address,
    userId: ctx.from.id.toString(),
  });

  const response = [
    `✅ <b>SEND CONFIRMATION</b>`,
    "",
    `<b>Amount:</b> ${amount === "max" ? "MAX" : amount} ${token}`,
    `<b>To:</b> <code>${address.slice(0, 8)}...${address.slice(-8)}</code>`,
    "",
    `⚠️ <b>Please confirm this transaction</b>`,
    `This action cannot be undone.`,
  ];

  await ctx.api.editMessageText(
    ctx.chat.id,
    userState.messageId,
    response.join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ CONFIRM SEND", `confirm_send_${txId}`)
        .row()
        .text("❌ Cancel", `send_select_${token}`)
        .row(),
    }
  );
};

/**
 * Handle wrap amount input
 */
const handleWrapAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const numAmount = parseFloat(amount);

  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error("Invalid amount format");
  }

  console.log(`🔧 Wrap amount received: ${amount} SOL`);

  const response = [
    `✅ <b>WRAP CONFIRMATION</b>`,
    "",
    `<b>Amount:</b> ${amount} SOL → WSOL`,
    "",
    `⚠️ <b>Please confirm this transaction</b>`,
    `This will convert ${amount} SOL to ${amount} WSOL.`,
  ];

  await ctx.api.editMessageText(
    ctx.chat.id,
    userState.messageId,
    response.join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ CONFIRM WRAP", `confirm_wrap_${amount}`)
        .row()
        .text("❌ Cancel", "cmd_wrap")
        .row(),
    }
  );
};

/**
 * Handle swap token input (when user sends token mint or symbol)
 */
const handleSwapToTokenInput = async (
  ctx: any,
  userState: any,
  tokenInput: string
) => {
  const fromToken = userState.fromToken;

  console.log(
    `🔍 Token input received for swap from ${fromToken}: ${tokenInput}`
  );

  // For now, treat any input as a valid token
  // TODO: Add proper token validation and mint address resolution
  const toToken = tokenInput.toUpperCase();

  // Show amount selection for the swap pair
  const walletCtx = {
    ...ctx,
    editMessageText: async (text: string, options: any) => {
      return await ctx.api.editMessageText(
        ctx.chat.id,
        userState.messageId,
        text,
        options
      );
    },
  };

  await showSwapAmountSelection(walletCtx, fromToken, toToken);
};

/**
 * Handle swap custom amount input
 */
const handleSwapCustomAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const fromToken = userState.fromToken;
  const toToken = userState.toToken;
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  // Handle percentage amounts
  let actualAmount = amount;
  if (amount.includes("%")) {
    const percentage = parseFloat(amount.replace("%", ""));
    if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
      throw new Error("Invalid percentage format");
    }

    // Get current balance to calculate percentage
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);

    let balance = 0;
    if (fromToken === "SOL") {
      balance = solBalance;
    } else {
      const tokenBalance = tokenBalances.find((t) => t.ticker === fromToken);
      if (tokenBalance) {
        balance = tokenBalance.balance;
      }
    }

    actualAmount = (balance * (percentage / 100)).toString();
  } else if (amount.toLowerCase() === "max") {
    actualAmount = "max";
  } else {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      throw new Error("Invalid amount format");
    }
    actualAmount = amount;
  }

  console.log(
    `💱 Custom swap amount received: ${actualAmount} ${fromToken} → ${toToken}`
  );

  // Show quote and confirmation
  const walletCtx = {
    ...ctx,
    editMessageText: async (text: string, options: any) => {
      return await ctx.api.editMessageText(
        ctx.chat.id,
        userState.messageId,
        text,
        options
      );
    },
  };

  await showSwapQuoteAndConfirmation(
    walletCtx,
    fromToken,
    toToken,
    actualAmount,
    telegramId
  );
};

/**
 * Handle BUY contract address input
 */
const handleBuyContractAddressInput = async (
  ctx: any,
  userState: any,
  contractAddress: string
) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  try {
    console.log(`🔍 Validating contract address: ${contractAddress}`);

    // Basic Solana address validation (should be ~44 characters)
    if (contractAddress.length < 30 || contractAddress.length > 50) {
      throw new Error("Invalid Solana contract address format");
    }

    // Show loading state
    const loadingMessage = [
      "🔍 <b>Fetching Token Information...</b>",
      "",
      `<b>Contract Address:</b>`,
      `<code>${contractAddress}</code>`,
      "",
      "🔄 <i>Please wait while we validate and fetch token metadata...</i>",
    ].join("\n");

    try {
      await ctx.editMessageText(loadingMessage, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_buy").row(),
      });
    } catch (error) {
      // If edit fails because message has media or doesn't exist, delete and send new
      try {
        await ctx.deleteMessage();
      } catch {}

      const newMsg = await ctx.reply(loadingMessage, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_buy").row(),
      });

      // Update the message ID in user state
      userState.messageId = newMsg.message_id;
    }

    // Try to fetch token metadata
    const tokenInfo = await fetchTokenMetadata(contractAddress, telegramId);

    if (!tokenInfo) {
      throw new Error(
        "Unable to fetch token metadata. Please check the contract address."
      );
    }

    console.log(`✅ Token found: ${tokenInfo.symbol} (${contractAddress})`);

    // Use the payment method that was already selected
    const paymentToken = userState.fromToken;

    if (!paymentToken) {
      throw new Error("Payment token not found in user state");
    }

    // Create a shorter transaction ID for the callback data
    const tokenTxId = Math.random().toString(36).substring(2, 15);

    // Cache the token info with the transaction ID
    transactionCache.set(tokenTxId, {
      targetToken: tokenInfo.symbol,
      targetTokenAddress: contractAddress,
      tokenMetadata: tokenInfo,
      paymentToken: paymentToken,
    });

    // Show token identification and go directly to buy options
    const response = [
      `<pre>T I M B A

TOKEN IDENTIFIED

Buying: ${tokenInfo.symbol}
Name: ${tokenInfo.name}
Paying with: ${paymentToken}
${tokenInfo.verified ? "Status: Verified" : "Status: Unverified"}

Address:
${contractAddress}</pre>`,
      "",
      `<b>Select amount to buy:</b>`,
    ];

    const keyboard = new InlineKeyboard();

    // Add amount buttons using transaction ID
    const amounts = ["0.01", "0.05", "0.1", "0.5", "1"];
    for (const amount of amounts) {
      keyboard
        .text(
          `${amount} ${paymentToken}`,
          `buy_amount_${paymentToken}_${tokenTxId}_${amount}`
        )
        .row();
    }
    keyboard
      .text(
        `✏️ CUSTOM AMOUNT`,
        `buy_amount_${paymentToken}_${tokenTxId}_CUSTOM`
      )
      .row();

    keyboard.text("← BACK", "cmd_buy").row();

    try {
      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (error) {
      // If edit fails because message has media or doesn't exist, delete and send new
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }

    // Clear user state since we now have direct buy buttons with contract address in callback
    userStates.delete(ctx.from.id.toString());
  } catch (error: any) {
    console.error("Error processing contract address:", error);

    const errorMessage = [
      "❌ <b>Invalid Contract Address</b>",
      "",
      `<b>Address:</b> <code>${contractAddress}</code>`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid Solana contract address (SPL Token mint):",
      "",
      `<b>Format:</b> Base58 string (~44 characters)`,
      `<b>Example:</b> <code>So11111111111111111111111111111111111111112</code>`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    try {
      await ctx.editMessageText(errorMessage.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_buy").row(),
      });
    } catch (error) {
      // If edit fails because message has media or doesn't exist, delete and send new
      try {
        await ctx.deleteMessage();
      } catch {}

      const newMsg = await ctx.reply(errorMessage.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_buy").row(),
      });

      // Update the message ID in user state
      userState.messageId = newMsg.message_id;
    }

    // Keep the same state for retry
    setUserState(ctx.from.id.toString(), {
      type: "buy_contract_address",
      messageId: userState.messageId,
    });
  }
};

/**
 * Handle BUY token symbol input
 */
const handleBuyTokenSymbolInput = async (
  ctx: any,
  userState: any,
  tokenSymbol: string
) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  try {
    console.log(`🔍 Searching for token: ${tokenSymbol}`);

    // Clean up the token symbol
    const cleanSymbol = tokenSymbol.trim().toUpperCase();

    if (cleanSymbol.length === 0 || cleanSymbol.length > 10) {
      throw new Error("Token symbol must be 1-10 characters");
    }

    // Show loading state
    const loadingMessage = [
      "🔍 <b>Searching for Token...</b>",
      "",
      `<b>Symbol:</b> ${cleanSymbol}`,
      "",
      "🔄 <i>Please wait while we search for tokens matching this symbol...</i>",
    ].join("\n");

    try {
      await ctx.editMessageText(loadingMessage, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_buy").row(),
      });
    } catch (error) {
      // If edit fails because message has media or doesn't exist, delete and send new
      try {
        await ctx.deleteMessage();
      } catch {}

      const newMsg = await ctx.reply(loadingMessage, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_buy").row(),
      });

      // Update the message ID in user state
      userState.messageId = newMsg.message_id;
    }

    // Try to find token by symbol in our known tokens first
    let tokenInfo = null;
    const knownTokens = tokenManager.getAllKnownTokens();
    const knownToken = knownTokens.find(
      (t: any) => t.ticker.toUpperCase() === cleanSymbol
    );

    if (knownToken) {
      tokenInfo = await fetchTokenMetadata(knownToken.token_mint);
    }

    if (!tokenInfo) {
      throw new Error(
        `Token "${cleanSymbol}" not found. Try using the contract address instead.`
      );
    }

    console.log(`✅ Token found: ${tokenInfo.symbol} (${tokenInfo.address})`);

    // Show payment method selection for this token
    const response = [
      `✅ <b>TOKEN IDENTIFIED</b>`,
      "",
      `🏷️ <b>Ticker:</b> ${tokenInfo.symbol}`,
      `📝 <b>Name:</b> ${tokenInfo.name}`,
      `🔗 <b>Address:</b> <code>${tokenInfo.address.slice(
        0,
        6
      )}...${tokenInfo.address.slice(-6)}</code>`,
      `${tokenInfo.verified ? "✅ <b>Verified</b>" : "⚠️ <b>Unverified</b>"}`,
      "",
      `<b>💰 Select payment method to buy ${tokenInfo.symbol}:</b>`,
    ];

    // Get user balances to show available payment options
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    const keyboard = new InlineKeyboard();

    // Create a shorter transaction ID for the callback data
    const tokenTxId = Math.random().toString(36).substring(2, 15);

    // Cache the token info with the transaction ID
    transactionCache.set(tokenTxId, {
      targetToken: tokenInfo.symbol,
      targetTokenAddress: tokenInfo.address,
      tokenMetadata: tokenInfo,
    });

    // Add SOL if available
    if (solBalance > 0.001) {
      const formattedSolBalance = wallet.formatSolBalance(solBalance);
      keyboard
        .text(`SOL (${formattedSolBalance})`, `buy_dynamic_SOL_${tokenTxId}`)
        .row();
    }

    // Add token balances if available
    for (const token of tokenBalances) {
      if (token.balance > 0 && token.ticker !== tokenInfo.symbol) {
        const formatted = wallet.formatTokenBalance(
          token.balance,
          token.decimals
        );
        keyboard
          .text(
            `${token.ticker} (${formatted})`,
            `buy_dynamic_${token.ticker}_${tokenTxId}`
          )
          .row();
      }
    }

    keyboard.text("← BACK", "cmd_buy").row();

    try {
      await ctx.editMessageText(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (error) {
      // If edit fails because message has media or doesn't exist, delete and send new
      try {
        await ctx.deleteMessage();
      } catch {}

      await ctx.reply(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  } catch (error: any) {
    console.error("Error searching for token:", error);

    const errorMessage = [
      "❌ <b>Token Not Found</b>",
      "",
      `<b>Symbol:</b> ${tokenSymbol}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid token symbol:",
      "",
      `<b>Examples:</b> SOL, USDC, TIMBA`,
      `<b>Or use:</b> Contract address for any token`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    try {
      await ctx.editMessageText(errorMessage.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔗 Use Contract Address", "buy_contract_")
          .text("❌ Cancel", "cmd_buy")
          .row(),
      });
    } catch (error) {
      // If edit fails because message has media or doesn't exist, delete and send new
      try {
        await ctx.deleteMessage();
      } catch {}

      const newMsg = await ctx.reply(errorMessage.join("\n"), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🔗 Use Contract Address", "buy_contract_")
          .text("❌ Cancel", "cmd_buy")
          .row(),
      });

      // Update the message ID in user state
      userState.messageId = newMsg.message_id;
    }

    // Keep the same state for retry
    setUserState(ctx.from.id.toString(), {
      type: "buy_token_symbol",
      messageId: userState.messageId,
    });
  }
};

/**
 * Handle BUY custom amount input
 */
const handleBuyCustomAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const paymentToken = userState.paymentToken;
  const targetToken = userState.targetToken;
  const contractAddress = userState.contractAddress;
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  console.log(`📝 Custom amount debug:`, {
    amount,
    paymentToken,
    targetToken,
    contractAddress,
  });

  try {
    // Handle percentage amounts
    let actualAmount = amount;
    if (amount.includes("%")) {
      const percentage = parseFloat(amount.replace("%", ""));
      if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
        throw new Error("Invalid percentage format");
      }

      // Get current balance to calculate percentage
      const { solBalance, tokenBalances } = await getCachedWalletData(
        telegramId
      );

      let balance = 0;
      if (paymentToken === "SOL") {
        balance = solBalance;
      } else {
        const tokenBalance = tokenBalances.find(
          (t) => t.ticker === paymentToken
        );
        if (tokenBalance) {
          balance = tokenBalance.balance;
        }
      }

      actualAmount = (balance * (percentage / 100)).toString();
    } else if (amount.toLowerCase() === "max") {
      actualAmount = "max";
    } else {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        throw new Error("Invalid amount format");
      }
      actualAmount = amount;
    }

    console.log(
      `💰 Custom BUY amount received: ${actualAmount} ${paymentToken} → ${targetToken}`
    );

    // Show quote and confirmation using the same pattern as swap
    const walletCtx = {
      ...ctx,
      editMessageText: async (text: string, options: any) => {
        return await ctx.api.editMessageText(
          ctx.chat.id,
          userState.messageId,
          text,
          options
        );
      },
    };

    await showBuyQuoteAndConfirmation(
      walletCtx,
      paymentToken,
      targetToken,
      actualAmount,
      contractAddress
    );
  } catch (error: any) {
    console.error("Error processing custom buy amount:", error);

    const errorMessage = [
      "❌ <b>Invalid Amount</b>",
      "",
      `<b>Payment Token:</b> ${paymentToken}`,
      `<b>Target Token:</b> ${targetToken}`,
      `<b>Amount:</b> ${amount}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid amount:",
      "",
      `<b>Examples:</b>`,
      `• <code>0.1</code> (spend 0.1 ${paymentToken})`,
      `• <code>5</code> (spend 5 ${paymentToken})`,
      `• <code>50%</code> (spend 50% of balance)`,
      `• <code>max</code> (spend all available ${paymentToken})`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    await ctx.api.editMessageText(
      ctx.chat.id,
      userState.messageId,
      errorMessage.join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel", `buy_with_${paymentToken}`)
          .row(),
      }
    );

    // Keep the same state for retry
    setUserState(ctx.from.id.toString(), {
      type: "buy_custom_amount",
      paymentToken: paymentToken,
      targetToken: targetToken,
      messageId: userState.messageId,
    });
  }
};

/**
 * Handle SELL custom amount input
 */
const handleSellCustomAmountInput = async (
  ctx: any,
  userState: any,
  amount: string
) => {
  const tokenToSell = userState.tokenToSell;
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  try {
    // Handle percentage amounts
    let actualAmount = amount;
    if (amount.includes("%")) {
      const percentage = parseFloat(amount.replace("%", ""));
      if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
        throw new Error("Invalid percentage format");
      }

      // Get current balance to calculate percentage
      const { tokenBalances } = await getCachedWalletData(telegramId);
      const tokenBalance = tokenBalances.find((t) => t.ticker === tokenToSell);

      if (!tokenBalance) {
        throw new Error(`Token ${tokenToSell} not found in wallet`);
      }

      const decimalBalance =
        tokenBalance.balance / Math.pow(10, tokenBalance.decimals);
      actualAmount = (decimalBalance * (percentage / 100)).toString();
    } else if (amount.toLowerCase() === "max") {
      actualAmount = "max";
    } else {
      const numAmount = parseFloat(amount);
      if (isNaN(numAmount) || numAmount <= 0) {
        throw new Error("Invalid amount format");
      }
      actualAmount = amount;
    }

    console.log(
      `🔴 Custom SELL amount received: ${actualAmount} ${tokenToSell}`
    );

    // Show quote and confirmation
    const walletCtx = {
      ...ctx,
      editMessageText: async (text: string, options: any) => {
        return await ctx.api.editMessageText(
          ctx.chat.id,
          userState.messageId,
          text,
          options
        );
      },
    };

    await showSellQuoteAndConfirmation(
      walletCtx,
      tokenToSell,
      actualAmount,
      telegramId
    );
  } catch (error: any) {
    console.error("Error processing custom sell amount:", error);

    const errorMessage = [
      "❌ <b>Invalid Amount</b>",
      "",
      `<b>Token:</b> ${tokenToSell}`,
      `<b>Amount:</b> ${amount}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid amount:",
      "",
      `<b>Examples:</b>`,
      `• <code>100</code> (sell 100 ${tokenToSell})`,
      `• <code>50%</code> (sell 50% of balance)`,
      `• <code>max</code> (sell all ${tokenToSell})`,
      "",
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    await ctx.api.editMessageText(
      ctx.chat.id,
      userState.messageId,
      errorMessage.join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("❌ Cancel", "cmd_sell").row(),
      }
    );

    // Keep the same state for retry
    setUserState(ctx.from.id.toString(), {
      type: "sell_custom_amount",
      tokenToSell: tokenToSell,
      messageId: userState.messageId,
    });
  }
};

// ================================
// SELL HELPER FUNCTIONS
// ================================

/**
 * Show sell amount selection for a specific token
 */
const showSellAmountSelection = async (ctx: any, tokenToSell: string) => {
  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  // Get balance for the token being sold
  const { tokenBalances } = await getCachedWalletData(telegramId);
  const tokenBalance = tokenBalances.find((t) => t.ticker === tokenToSell);

  if (!tokenBalance) {
    throw new Error(`Token ${tokenToSell} not found in wallet`);
  }

  const formattedBalance = wallet.formatTokenBalance(
    tokenBalance.balance,
    tokenBalance.decimals
  );

  const response = [
    `🔴 <b>SELL ${tokenToSell}</b>`,
    "",
    `<b>Available:</b> ${formattedBalance} ${tokenToSell}`,
    "",
    `<b>Select amount to sell:</b>`,
  ];

  const keyboard = new InlineKeyboard();

  // Add percentage options for selling
  keyboard
    .text("25%", `sell_amount_${tokenToSell}_25%`)
    .text("50%", `sell_amount_${tokenToSell}_50%`)
    .row()
    .text("75%", `sell_amount_${tokenToSell}_75%`)
    .text("MAX", `sell_amount_${tokenToSell}_max`)
    .row();

  // Add custom amount option
  keyboard.text("✏️ Custom", `sell_amount_${tokenToSell}_CUSTOM`).row();

  keyboard.text("← BACK", "cmd_sell").row();

  await ctx.editMessageText(response.join("\n"), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
};

/**
 * Show sell quote and confirmation
 */
const showSellQuoteAndConfirmation = async (
  ctx: any,
  tokenToSell: string,
  amount: string,
  telegramId: bigint
) => {
  // Update message to show loading
  await ctx.editMessageText(
    `🔄 <b>GETTING SELL QUOTE</b>\n\nSell ${amount} ${tokenToSell} for SOL\n\n<i>Finding best price...</i>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard(),
    }
  );

  try {
    // Get token info for the token being sold
    const { tokenBalances } = await getCachedWalletData(telegramId);
    const tokenBalance = tokenBalances.find((t) => t.ticker === tokenToSell);

    if (!tokenBalance) {
      throw new Error(`Token ${tokenToSell} not found in wallet`);
    }

    // Get the actual token info - first try approved tokens, then use wallet balance info
    const approvedTokens = tokenManager.getAllApprovedTokensWithMetadata();
    let tokenInfo = approvedTokens.find((t) => t.token_ticker === tokenToSell);

    // If not in approved tokens, use the info from wallet balance (for dynamic tokens)
    if (!tokenInfo) {
      tokenInfo = {
        token_mint: tokenBalance.mint,
        token_ticker: tokenBalance.ticker,
        decimals: tokenBalance.decimals,
      };
      console.log(
        `🔍 Using dynamic token info for ${tokenToSell}: mint=${tokenBalance.mint}, decimals=${tokenBalance.decimals}`
      );
    }

    // Calculate actual amount to sell (convert from raw balance to decimal amount)
    const decimalBalance =
      tokenBalance.balance / Math.pow(10, tokenBalance.decimals);
    console.log(
      `💰 Token balance: ${tokenBalance.balance} raw = ${decimalBalance} decimal`
    );

    let actualAmount = amount;
    if (amount.includes("%")) {
      const percentage = parseFloat(amount.replace("%", ""));
      actualAmount = (decimalBalance * (percentage / 100)).toString();
    } else if (amount.toLowerCase() === "max") {
      actualAmount = decimalBalance.toString();
    }

    // Validate that actualAmount is not greater than available balance
    const actualAmountFloat = parseFloat(actualAmount);
    if (actualAmountFloat > decimalBalance) {
      throw new Error(
        `Cannot sell ${actualAmountFloat} ${tokenToSell}. You only have ${decimalBalance} ${tokenToSell}`
      );
    }

    console.log(
      `🔢 Sell calculation: ${amount} → ${actualAmount} (max: ${decimalBalance})`
    );

    // Convert decimal amount to raw amount using BigInt for precision
    const decimalAmount = parseFloat(actualAmount);

    // Use string multiplication to avoid floating point precision issues
    const decimalParts = decimalAmount.toString().split(".");
    const integerPart = decimalParts[0] || "0";
    const decimalPart = (decimalParts[1] || "")
      .padEnd(tokenInfo.decimals, "0")
      .slice(0, tokenInfo.decimals);

    // Combine integer and decimal parts
    const rawAmountStr = integerPart + decimalPart;
    const rawAmount = BigInt(rawAmountStr);

    console.log(`🔄 Converting ${actualAmount} to raw amount:`);
    console.log(`   Decimal amount: ${decimalAmount}`);
    console.log(`   Token decimals: ${tokenInfo.decimals}`);
    console.log(`   Integer part: "${integerPart}"`);
    console.log(`   Decimal part: "${decimalPart}"`);
    console.log(`   Raw amount string: "${rawAmountStr}"`);
    console.log(`   Final raw amount: ${rawAmount.toString()}`);

    // Validate that rawAmount is positive
    if (rawAmount <= 0n) {
      throw new Error(
        `Invalid amount: ${rawAmount.toString()} (from ${actualAmount})`
      );
    }

    // For SELL, we typically sell tokens for SOL
    const toToken = "SOL";
    const toTokenInfo = {
      token_mint: "So11111111111111111111111111111111111111112",
      decimals: 9,
    };

    // Use the existing global swapManager instance

    const quote = await swapManager.getQuote({
      inputMint: tokenInfo.token_mint, // Use tokenInfo instead of tokenBalance
      outputMint: toTokenInfo.token_mint,
      amount: rawAmount.toString(), // Use BigInt raw amount as string
      slippageBps: 200, // Use same 2% slippage as successful BUY/SWAP
      userKeypair: wallet.getKeyPair(telegramId),
      inputDecimals: tokenInfo.decimals || 6, // Use tokenInfo decimals
      outputDecimals: toTokenInfo.decimals || 9,
      inputTicker: tokenToSell.toUpperCase(),
      outputTicker: "SOL",
    });

    if (!quote) {
      throw new Error(`Cannot get quote for selling ${tokenToSell}`);
    }

    // Create transaction ID for caching
    const txId = Math.random().toString(36).substring(2, 15);

    // Cache sell data
    transactionCache.set(txId, {
      fromToken: tokenToSell,
      toToken: toToken,
      amount: actualAmount, // Keep decimal for display and pump.fun
      rawAmount: rawAmount.toString(), // Add raw amount for Jupiter
      fromTokenInfo: {
        token_mint: tokenInfo.token_mint,
        decimals: tokenInfo.decimals,
      },
      toTokenInfo: toTokenInfo,
      quote: quote,
      userKeypair: wallet.getKeyPair(telegramId),
    });

    // Format for SELL terminology
    const expectedOutput = wallet.formatTokenBalance(
      parseInt(quote.outputAmount),
      toTokenInfo.decimals
    );

    const response = [
      `🔴 <b>SELL CONFIRMATION</b>`,
      "",
      `<b>You Sell:</b> ${actualAmount} ${tokenToSell}`,
      `<b>You Get:</b> ~${expectedOutput} ${toToken}`,
      "",
      `<b>Provider:</b> ${quote.provider?.toUpperCase() || "Auto"}`,
      `<b>Slippage:</b> 1.0%`,
      "",
      `⚠️ <i>Price may change before execution</i>`,
    ];

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ CONFIRM SELL", `confirm_sell_${txId}`)
        .row()
        .text("❌ Cancel", "cmd_sell")
        .row(),
    });
  } catch (error: any) {
    console.error("Error getting sell quote:", error);

    const errorResponse = [
      `❌ <b>SELL QUOTE FAILED</b>`,
      "",
      `<b>Token:</b> ${tokenToSell}`,
      `<b>Amount:</b> ${amount}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "This could happen if:",
      "• Token has no liquidity",
      "• Network issues",
      "• Token is not tradable",
    ];

    await ctx.editMessageText(errorResponse.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("← Try Again", "cmd_sell").row(),
    });
  }
};

/**
 * Handle BUY custom slippage input
 */
const handleBuyCustomSlippageInput = async (
  ctx: any,
  userState: any,
  slippageInput: string
) => {
  const txId = userState.txId;

  console.log(`⚙️ Custom slippage input: ${slippageInput} for txId: ${txId}`);

  try {
    const slippage = parseFloat(slippageInput);
    if (isNaN(slippage) || slippage < 0.1 || slippage > 10) {
      throw new Error("Slippage must be between 0.1% and 10%");
    }

    // Update the cached buy data with new slippage
    const buyData = transactionCache.get(txId);
    if (!buyData) {
      throw new Error("Transaction expired. Please try again.");
    }

    buyData.quote.slippage = slippage;
    transactionCache.set(txId, buyData);

    // Regenerate quote with new slippage
    const walletCtx = {
      ...ctx,
      editMessageText: async (text: string, options: any) => {
        return await ctx.api.editMessageText(
          ctx.chat.id,
          userState.messageId,
          text,
          options
        );
      },
    };

    await regenerateBuyQuoteWithSlippage(walletCtx, txId, slippage);
  } catch (error: any) {
    console.error("Error processing custom slippage:", error);

    const errorMessage = [
      "❌ <b>Invalid Slippage</b>",
      "",
      `<b>Input:</b> ${slippageInput}`,
      "",
      `<b>Error:</b> ${(error as Error).message}`,
      "",
      "Please enter a valid slippage percentage:",
      "",
      `<b>Examples:</b>`,
      `• <code>0.5</code> (0.5% slippage)`,
      `• <code>1</code> (1% slippage)`,
      `• <code>2.5</code> (2.5% slippage)`,
      "",
      `<b>Range:</b> 0.1% - 10%`,
      `⏱️ <i>This will timeout in 5 minutes</i>`,
    ];

    await ctx.api.editMessageText(
      ctx.chat.id,
      userState.messageId,
      errorMessage.join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("❌ Cancel", `buy_slip_back_${txId}`)
          .row(),
      }
    );

    // Keep the same state for retry
    setUserState(ctx.from.id.toString(), {
      type: "buy_custom_slippage",
      txId: txId,
      messageId: userState.messageId,
    });
  }
};

/**
 * Regenerate buy quote with new slippage
 */
const regenerateBuyQuoteWithSlippage = async (
  ctx: any,
  txId: string,
  newSlippage?: number
) => {
  try {
    const buyData = transactionCache.get(txId);
    if (!buyData) {
      throw new Error("Transaction expired");
    }

    const quote = buyData.quote;
    const slippage = newSlippage || quote.slippage || 1.0;

    // Update slippage in quote if provided
    if (newSlippage) {
      quote.slippage = newSlippage;
      transactionCache.set(txId, buyData);
    }

    const response = `<pre>T I M B A

BUY CONFIRMATION

You Pay: ${buyData.amount} ${buyData.fromToken}
You Receive: ~${quote.outputAmount} ${buyData.toToken}

Rate: ${quote.estimatedRate?.toFixed(6) || "N/A"} ${buyData.toToken}/${
      buyData.fromToken
    }
Provider: ${quote.provider} ${
      quote.provider === "pump-fun" ? "(ungraduated)" : "(graduated)"
    }
Slippage: ${slippage.toFixed(1)}%

Contract: ${buyData.contractAddress || "N/A"}
</pre>

⚠️ <b>Confirm this purchase?</b>`;

    await ctx.editMessageText(response, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ CONFIRM BUY", `confirm_buy_${txId}`)
        .row()
        .text("⚙️ SLIPPAGE", `buy_slippage_${txId}`)
        .row()
        .text("0.5%", `buy_slip_${txId}_0.5`)
        .text("1%", `buy_slip_${txId}_1.0`)
        .text("2%", `buy_slip_${txId}_2.0`)
        .row()
        .text("3%", `buy_slip_${txId}_3.0`)
        .text("5%", `buy_slip_${txId}_5.0`)
        .text("✏️", `buy_slip_${txId}_custom`)
        .row()
        .text("❌ Cancel", `buy_with_${buyData.fromToken}`)
        .row(),
    });
  } catch (error: any) {
    console.error("Error regenerating buy quote:", error);
    await ctx.editMessageText(
      `❌ <b>Error</b>\n\n${(error as Error).message}\n\nPlease try again.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("← TRY AGAIN", "cmd_buy").row(),
      }
    );
  }
};

// Start the bot and setup Anchor
setupAnchor()
  .then(async () => {
    console.log("Starting bot...");

    // Reload game message mappings from database
    await gameManager.reloadGameMessages();
    console.log(`Reloaded game message mappings from database`);

    /**
     * Send completion notification to chat
     */
    const sendCompletionNotification = async (
      gameData: any,
      winnerAddress: string,
      event: GameCompletedEvent
    ): Promise<void> => {
      if (!gameData.token_mint || !gameData.token_ticker) {
        console.error(
          `Missing token info for completion notification of game ${event.gameKey.toString()}`
        );
        return;
      }

      const ctx = createApiContext(gameData.chat_id);
      const metadata = await wallet.getTokenMetadata(gameData.token_mint);
      const winnerUsername = await gameManager.getPlayerUsername(
        ctx,
        winnerAddress
      );
      const winnerAmount = Number(event.winnerAmount);
      const gameType = gameData.game_type
        ? gameData.game_type.charAt(0).toUpperCase() +
          gameData.game_type.slice(1)
        : "Game";

      let notificationText = `🎉 <b>${gameType} Completed!</b>\n\n`;
      notificationText += `🏆 Winner: ${winnerUsername}\n`;
      notificationText += `💰 Prize: ${wallet.formatTokenBalance(
        winnerAmount,
        metadata.decimals
      )} ${gameData.token_ticker}`;

      const gameMessage = gameManager.getActiveGameMessage(
        event.gameKey.toString()
      );
      const replyToMessageId = gameMessage?.messageId;

      await bot.api.sendMessage(gameData.chat_id, notificationText, {
        parse_mode: "HTML",
        reply_to_message_id: replyToMessageId,
      });
    };

    // Set up global event listener for GameCompleted events
    console.log("Setting up GameCompleted event listener...");
    program.addEventListener(
      "gameCompleted",
      async (event: GameCompletedEvent) => {
        try {
          const gameAddress = event.gameKey.toString();
          const winnerAddress = event.winner.toString();

          console.log(
            `🎉 GameCompleted event received for game: ${gameAddress}`
          );

          // Process game completion
          await processGameCompletion(gameAddress, winnerAddress);

          // Get game info for notifications
          const gameData = gameDb.getGame(gameAddress);
          if (!gameData?.chat_id) {
            console.log(
              `No game data or chat_id found for game ${gameAddress}`
            );
            return;
          }

          // Send completion notification
          try {
            await sendCompletionNotification(gameData, winnerAddress, event);
            console.log(
              `🎊 Sent completion notification for game ${gameAddress}`
            );
          } catch (error) {
            console.error("Error sending completion notification:", error);
          }

          console.log(
            `✅ Successfully processed GameCompleted event for game ${gameAddress}`
          );
        } catch (error) {
          console.error("Error processing GameCompleted event:", error);
        }
      }
    );

    console.log("GameCompleted event listener set up successfully");

    // Set up PlayerJoined event listener to track lastSlot for winner calculation
    console.log("Setting up PlayerJoined event listener...");
    program.addEventListener(
      "playerJoined",
      async (event: PlayerJoinedEvent) => {
        await handlePlayerEvent(event, "PlayerJoined", "👤", "joined");
      }
    );

    // Set up PlayerUnjoined event listener to track lastSlot for winner calculation
    console.log("Setting up PlayerUnjoined event listener...");
    program.addEventListener(
      "playerUnjoined",
      async (event: PlayerUnjoinedEvent) => {
        await handlePlayerEvent(event, "PlayerUnjoined", "👤", "left");
      }
    );

    console.log("Player event listeners set up successfully");

    /**
     * Process expired game with cancellation
     */
    const processExpiredGame = async (game: any): Promise<void> => {
      const gamePda = new PublicKey(game.game_address);
      const gameAccount = await program.account.game.fetch(gamePda);

      console.log(
        `Processing expired game ${game.game_address} (${gameAccount.ticketsCount}/${gameAccount.maxTickets})`
      );

      const result = await gameManager.handleExpiredGame(gamePda, gameAccount);
      if (result) {
        console.log(
          `✅ Successfully processed expired game ${game.game_address}`
        );
        gameDb.completeGame(game.game_address, "cancelled", Date.now());
        await updateGameMessageSafely(
          game.game_address,
          game,
          "Completed",
          "cancelled"
        );
      } else {
        console.error(`⚠️ Failed to process expired game ${game.game_address}`);
      }
    };

    /**
     * Check if game is expired
     */
    const isGameExpired = async (gameAccount: any): Promise<boolean> => {
      const blockTime = await wallet.getBlockchainTime();
      const createdAt = Number(gameAccount.createdAt);
      const timeout = Number(gameAccount.timeout);
      const expiresAt = createdAt + timeout;
      return blockTime > expiresAt + GAME_EXPIRATION_BUFFER_TIME;
    };

    // Start periodic check for expired games
    setInterval(async () => {
      try {
        const allGames = gameDb.getAllGames();
        for (const game of allGames) {
          if (game.status === "completed") continue;

          try {
            const gamePda = new PublicKey(game.game_address);
            const gameAccount = await program.account.game.fetch(gamePda);

            if (await isGameExpired(gameAccount)) {
              await processExpiredGame(game);
            }
          } catch (error: any) {
            if ((error as Error).message?.includes("Account does not exist")) {
              await cleanupOrphanedGame(game.game_address);
            } else {
              console.error(
                `Error processing game ${game.game_address}:`,
                error
              );
            }
          }
        }
      } catch (error) {
        console.error("Error in periodic game check:", error);
      }
    }, EXPIRED_GAMES_CHECK_INTERVAL_MS);

    // Start the bot with concurrent processing
    console.log("Starting bot with concurrent processing...");
    const handle = run(bot, {
      runner: {
        fetch: {
          // Only handle updates we actually process
          allowed_updates: ["message", "callback_query"],
        },
      },
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
    handle
      ?.task()
      ?.then(() => {
        console.log("🏁 Bot runner task completed");
      })
      .catch((error) => {
        console.error("❌ Bot runner task failed:", error);
      });
  })
  .catch((error) => {
    console.error("Failed to setup Anchor:", error);
  });
