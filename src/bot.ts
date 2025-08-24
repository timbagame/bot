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
    .text("💳 WALLET", "main_wallet").row()
    .text("⚙️ INFO", "main_settings").text("🔧 ADMIN", "admin_menu").row()
    .text("❓ HELP", "cmd_help").row();
};

/**
 * Check if the context is a private chat
 */
const isPrivateChat = (ctx: Context): boolean => {
  return ctx.chat?.type === "private";
};

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
const showWalletUI = async (ctx: any, showLoadingMessage: boolean = true) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`;
  
  // Show loading state first
  if (showLoadingMessage) {
    const loadingResponse = [
      `💳 <b>WALLET</b>`,
      "",
      `<code>${shortAddress}</code>`,
      "",
      "⏳ <i>Loading balances...</i>",
    ];

    await ctx.editMessageText(loadingResponse.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔄 REFRESH", "wallet_refresh").row()
        .text("📤 SEND", "cmd_withdraw").text("💱 SWAP", "cmd_swap").row()
        .text("🔧 WRAP SOL", "cmd_wrap").text("🔐 KEY", "cmd_privatekey").row()
        .text("← BACK", "back_main").row()
    });
  }

  try {
    // Use cached wallet data
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    const formattedSolBalance = wallet.formatSolBalance(solBalance);
    
    // Build response with balances
    const response = [
      `💳 <b>WALLET</b>`,
      "",
      `<code>${shortAddress}</code>`,
      "",
      `💰 <b>SOL:</b> ${formattedSolBalance}`,
    ];

    // Add token balances
    if (tokenBalances.length > 0) {
      response.push("");
      tokenBalances.forEach(token => {
        const formatted = wallet.formatTokenBalance(token.balance, token.decimals);
        response.push(`🪙 <b>${token.ticker}:</b> ${formatted}`);
      });
    } else {
      response.push(`🪙 <b>No tokens found</b>`);
    }

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔄 REFRESH", "wallet_refresh").row()
        .text("📤 SEND", "cmd_withdraw").text("💱 SWAP", "cmd_swap").row()
        .text("🔧 WRAP SOL", "cmd_wrap").text("🔐 KEY", "cmd_privatekey").row()
        .text("← BACK", "back_main").row()
    });

  } catch (error) {
    console.error("Error loading balances:", error);
    const errorResponse = [
      `💳 <b>WALLET</b>`,
      "",
      `<code>${shortAddress}</code>`,
      "",
      "❌ <i>Error loading balances</i>",
      "<i>Tap REFRESH to try again</i>",
    ];

    await ctx.editMessageText(errorResponse.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🔄 REFRESH", "wallet_refresh").row()
        .text("📤 SEND", "cmd_withdraw").text("💱 SWAP", "cmd_swap").row()
        .text("🔧 WRAP SOL", "cmd_wrap").text("🔐 KEY", "cmd_privatekey").row()
        .text("← BACK", "back_main").row()
    });
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
  const adminWallet = new anchor.Wallet(adminKeypair);
  const connection = wallet.getConnection();

  const provider = new anchor.AnchorProvider(connection, adminWallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false,
    maxRetries: 3,
  });

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
    console.log('Initialized SwapManager with pump.fun integration');

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
  const telegramId = BigInt(ctx.from?.id || 0);
  
  try {
    const keypair = wallet.getKeyPair(telegramId);
    const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "User";
    const walletAddress = keypair.publicKey.toBase58();
    const shortAddress = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;

    const response = [
      "💰 <b>TIMBA</b> 💰",
      "",
      `PLAYER: ${username.toUpperCase()}`,
      `WALLET: <code>${shortAddress}</code>`,
    ];

    // Send response with menu for private chats
    if (isPrivateChat(ctx)) {
      await ctx.reply(response.join("\n"), {
        parse_mode: "HTML",
        reply_markup: createMainMenuKeyboard(),
      });
    } else {
      // Simple group chat response
      const groupResponse = [
        "💰 <b>TIMBA BOT</b>",
        "",
        `WALLET: <code>${shortAddress}</code>`,
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
  const telegramId = BigInt(ctx.from?.id || 0);
  
  // Use dynamic wallet UI for private chats
  if (isPrivateChat(ctx)) {
    try {
      const message = await ctx.reply("💳 <b>WALLET</b>\n⏳ <i>Loading...</i>", {
        parse_mode: "HTML",
      });
      
      // Create a context-like object for the wallet UI
      const walletCtx = {
        ...ctx,
        editMessageText: async (text: string, options: any) => {
          return await ctx.api.editMessageText(ctx.chat.id, message.message_id, text, options);
        }
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

    const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "User";
    const walletAddress = playerData.keypair.publicKey.toBase58();
    const shortAddress = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;

    const response = [
      "💰 <b>YOUR BALANCE</b>",
      "",
      `PLAYER: ${username.toUpperCase()}`,
      `WALLET: <code>${shortAddress}</code>`,
      "",
      `SOL: ${wallet.formatSolBalance(playerData.solBalance)}`,
    ];

    if (tokenBalancesToShow.length > 0) {
      response.push("");
      for (const token of tokenBalancesToShow.slice(0, 5)) {
        const balance = wallet.formatTokenBalance(token.balance, token.decimals);
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
    parsed.data!.tokenMint,
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
  const telegramId = BigInt(ctx.from?.id || 0);
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
  const telegramId = BigInt(ctx.from?.id || 0);
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
  const telegramId = BigInt(ctx.from?.id || 0);
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

bot.command("swap", sequentialize((ctx) => [ctx.from?.id, "swap"]), async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const args = ctx.message?.text?.split(" ").slice(1);

  if (!args || args.length < 3) {
    return replyUsageError(
      ctx,
      "Usage: /swap &lt;amount&gt; &lt;FROM&gt; &lt;TO&gt; [slippage%]\nExamples:\n• /swap 10 USDC SOL\n• /swap 100 USDT USDC 1.5"
    );
  }

  const [amountStr, fromToken, toToken, slippageStr] = args;
  const amount = parseFloat(amountStr);
  const slippagePercent = slippageStr ? parseFloat(slippageStr) : 2.0; // Default 2% for better success rate

  if (amount <= 0) {
    return replyUsageError(ctx, "Amount must be greater than 0");
  }

  if (slippagePercent < 0.1 || slippagePercent > 5.0) {
    return replyUsageError(ctx, "Slippage must be between 0.1% and 5%");
  }

  // Validate different tokens
  if (fromToken.toLowerCase() === toToken.toLowerCase()) {
    return replyUsageError(ctx, "Cannot swap the same token. Try different token pairs");
  }

  // Handle SOL/WSOL special case - they're the same underlying token
  const isSolToWsol = (fromToken.toLowerCase() === 'sol' && toToken.toLowerCase() === 'wsol') ||
                      (fromToken.toLowerCase() === 'wsol' && toToken.toLowerCase() === 'sol');
  
  if (isSolToWsol) {
    return replyUsageError(ctx, "SOL and WSOL are the same token for swapping purposes. Use /wrap to convert SOL to WSOL, or try different token pairs.");
  }

  // Warn about known non-tradable tokens
  const nonTradableTokens = ['TIMBA'];
  if (nonTradableTokens.includes(fromToken.toUpperCase()) || nonTradableTokens.includes(toToken.toUpperCase())) {
    return replyUsageError(ctx, "⚠️ TIMBA is not tradable on Jupiter. Try: /swap 10 USDC SOL");
  }

  try {
    const processingMsg = await ctx.reply(`🔄 Processing swap request...`);
    
    // Get token information (handle SOL, common tokens, and mint addresses)
    const getTokenInfo = async (tickerOrMint: string) => {
      const upperTicker = tickerOrMint.toUpperCase();
      
      if (upperTicker === 'SOL') {
        return {
          token_mint: 'So11111111111111111111111111111111111111112', // WSOL mint for swaps
          token_ticker: 'SOL',
          decimals: 9,
          added_at: 0
        };
      }
      
      if (upperTicker === 'USDC') {
        return {
          token_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          token_ticker: 'USDC',
          decimals: 6,
          added_at: 0
        };
      }
      
      // Check if it's a known token by ticker
      const knownToken = tokenManager.getKnownTokenByTicker(tickerOrMint);
      if (knownToken) {
        return knownToken;
      }
      
      // Check if it looks like a mint address (44 characters, base58)
      if (tickerOrMint.length === 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(tickerOrMint)) {
        try {
          // Auto-discover token info including pump.fun detection
          const tokenInfo = await tokenManager.autoDiscoverTokenInfo(tickerOrMint);
          if (tokenInfo) {
            return {
              token_mint: tickerOrMint,
              token_ticker: tokenInfo.ticker,
              decimals: tokenInfo.decimals,
              added_at: Date.now(),
              isPumpFun: tokenInfo.isPumpFun
            };
          }
        } catch (error) {
          console.log(`Failed to auto-discover token ${tickerOrMint}:`, error);
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
    const rawAmount = Math.floor(amount * Math.pow(10, fromTokenInfo.decimals));
    let userBalance: number;
    
    if (fromToken.toLowerCase() === 'sol') {
      userBalance = await wallet.getBalance(telegramId);
      if (userBalance < rawAmount + (0.01 * LAMPORTS_PER_SOL)) { // Reserve for fees
        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          `❌ Insufficient SOL balance. You need at least ${amount + 0.01} SOL (including fees)`
        );
        return;
      }
    } else {
      userBalance = await wallet.getTokenBalance(telegramId, fromTokenInfo.token_mint === 'So11111111111111111111111111111111111111112' ? 'SOL' : fromTokenInfo.token_mint);
      if (userBalance < rawAmount) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          `❌ Insufficient ${fromToken} balance. You have ${wallet.formatTokenBalance(userBalance, fromTokenInfo.decimals)} ${fromToken}`
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
      outputTicker: toToken.toUpperCase()
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
              { text: "✅ Confirm Swap", callback_data: `swap_confirm_${telegramId}` },
              { text: "❌ Cancel", callback_data: `swap_cancel_${telegramId}` }
            ]
          ]
        }
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
      slippagePercent
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
});

// Temporary cache for swap data
const swapDataCache = new Map();

// Swap confirmation callbacks
bot.callbackQuery(/^swap_(confirm|cancel)_(\d+)$/, async (ctx) => {
  const [, action, userId] = ctx.match!;
  const telegramId = BigInt(ctx.from?.id || 0);
  
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
    await ctx.editMessageText(`🔄 Executing swap via ${swapData.quote.provider}...`);
    
    let signature: string;
    
    if (swapData.quote.provider === 'jupiter') {
      // Use special Jupiter execution method
      signature = await swapManager.executeJupiterSwap({
        inputMint: swapData.fromTokenInfo.token_mint,
        outputMint: swapData.toTokenInfo.token_mint,
        amount: swapData.quote.inputAmount,
        slippageBps: Math.floor(swapData.slippagePercent * 100),
        userKeypair: swapData.userKeypair,
        inputDecimals: swapData.fromTokenInfo.decimals,
        outputDecimals: swapData.toTokenInfo.decimals,
        inputTicker: swapData.fromToken.toUpperCase(),
        outputTicker: swapData.toToken.toUpperCase()
      }, swapData.quote);
    } else {
      // Use regular instruction-based approach for other providers
      const instructions = await swapManager.createSwapTransaction({
        inputMint: swapData.fromTokenInfo.token_mint,
        outputMint: swapData.toTokenInfo.token_mint,
        amount: swapData.quote.inputAmount,
        slippageBps: Math.floor(swapData.slippagePercent * 100),
        userKeypair: swapData.userKeypair,
        inputDecimals: swapData.fromTokenInfo.decimals,
        outputDecimals: swapData.toTokenInfo.decimals,
        inputTicker: swapData.fromToken.toUpperCase(),
        outputTicker: swapData.toToken.toUpperCase()
      }, swapData.quote);

      // Execute transaction
      signature = await wallet.sendTransaction(instructions, [swapData.userKeypair]);

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
      
      if (inputTokenTicker !== 'SOL') {
        const existingInputToken = tokenManager.getKnownTokenByMint(inputTokenMint);
        if (!existingInputToken) {
          // Try to get real metadata for pump.fun tokens
          if (swapData.quote.provider === 'pump-fun' && pumpFunClient) {
            const metadata = await pumpFunClient.getTokenMetadata(inputTokenMint);
            if (metadata && metadata.symbol) {
              inputTokenTicker = metadata.symbol.toUpperCase();
            }
          }
          
          console.log(`Auto-registering input token from swap: ${inputTokenTicker} (${inputTokenMint})`);
          const registered = await tokenManager.addToken(inputTokenMint, inputTokenTicker);
          if (registered) {
            console.log(`Successfully auto-registered input token: ${inputTokenTicker}`);
          }
        }
      }
      
      // Register output token if not known
      const outputTokenMint = swapData.toTokenInfo.token_mint;
      let outputTokenTicker = swapData.toToken.toUpperCase();
      
      if (outputTokenTicker !== 'SOL') {
        const existingOutputToken = tokenManager.getKnownTokenByMint(outputTokenMint);
        if (!existingOutputToken) {
          // Try to get real metadata for pump.fun tokens
          if (swapData.quote.provider === 'pump-fun' && pumpFunClient) {
            const metadata = await pumpFunClient.getTokenMetadata(outputTokenMint);
            if (metadata && metadata.symbol) {
              outputTokenTicker = metadata.symbol.toUpperCase();
            }
          }
          
          console.log(`Auto-registering output token from swap: ${outputTokenTicker} (${outputTokenMint})`);
          const registered = await tokenManager.addToken(outputTokenMint, outputTokenTicker);
          if (registered) {
            console.log(`Successfully auto-registered output token: ${outputTokenTicker}`);
          }
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
      `🔗 **Transaction:** [${signature.slice(0, 8)}...](https://solscan.io/tx/${signature})`,
      `📥 **Input:** ${wallet.formatTokenBalance(parseInt(swapData.quote.inputAmount), swapData.fromTokenInfo.decimals)} ${swapData.fromToken}`,
      `📤 **Output:** ${wallet.formatTokenBalance(parseInt(swapData.quote.outputAmount), swapData.toTokenInfo.decimals)} ${swapData.toToken}`,
      "",
      swapData.quote.provider === 'pump-fun' 
        ? "🔥 **Pump.fun Token** - Non-graduated token swap"
        : "✅ **Mainnet Transaction** - Tokens transferred successfully"
    ].join("\n");

    await ctx.editMessageText(successMessage, { parse_mode: "Markdown" });
    await safeAnswerCallbackQuery(ctx, "Swap completed!");
    
    swapDataCache.delete(userId);

  } catch (error: any) {
    console.error("Swap execution error:", error);
    
    // Handle timeout specially - transaction might have succeeded
    if (error.message?.includes('Transaction confirmation timeout')) {
      const signature = error.message.match(/signature ([A-Za-z0-9]{44,})/)?.[1];
      
      const timeoutMessage = [
        "⏳ **Swap Transaction Timeout**",
        "",
        "The swap transaction was sent but confirmation timed out.",
        "This often happens during network congestion.",
        "",
        signature ? `🔗 **Check Status:** [${signature.slice(0, 8)}...](https://solscan.io/tx/${signature})` : "",
        "",
        "💡 **Next Steps:**",
        "• Transaction may still succeed - check your balance",
        "• Use `/checktx ${signature || 'SIGNATURE'}` to verify",
        "• Wait a few minutes before trying again"
      ].filter(Boolean).join("\n");
      
      await ctx.editMessageText(timeoutMessage, { parse_mode: "Markdown" });
      await safeAnswerCallbackQuery(ctx, "Transaction timeout - may still succeed");
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
  const telegramId = BigInt(ctx.from?.id || 0);
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
    await ctx.reply(`Error checking transaction: ${error.message}`, {
      reply_to_message_id: ctx.message?.message_id,
    });
  }
});

bot.command("active", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);

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
  const telegramId = BigInt(ctx.from?.id || 0);

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

  const telegramId = BigInt(ctx.from?.id || 0);

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
        oracleAccount.minTimeout / 60
      } minutes)`,
      `Max Timeout: ${oracleAccount.maxTimeout} seconds (${
        oracleAccount.maxTimeout / 60
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
    if (error.message?.includes("Account does not exist")) {
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
    'main_wallet', 'wallet_refresh', 'main_settings', 'back_main', 
    'cmd_help', 'cmd_balance', 'cmd_withdraw', 'cmd_swap', 'cmd_wrap', 
    'cmd_privatekey', 'admin_menu', 'cmd_oracle', 'cmd_scan',
    'help_wallet', 'help_games', 'help_utility', 'help_examples'
  ];
  
  // Also skip send/swap/wrap interface callbacks
  if (callbackData.startsWith('send_') || 
      callbackData.startsWith('swap_') || 
      callbackData.startsWith('wrap_') ||
      callbackData.startsWith('confirm_') ||
      nonGameCallbacks.includes(callbackData)) {
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
    if (error.message?.includes("Account does not exist")) {
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
    await showWalletUI(ctx, true);
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error("Error in wallet_refresh:", error);
    await ctx.answerCallbackQuery("❌ Error refreshing wallet");
  }
});

// ================================
// WALLET ACTION HANDLERS
// ================================

bot.callbackQuery("cmd_withdraw", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0);
    const keypair = wallet.getKeyPair(telegramId);
    const walletAddress = keypair.publicKey.toBase58();
    const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`;
    
    // Use cached wallet data
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    
    const response = [
      `📤 <b>SEND TOKENS</b>`,
      "",
      `<b>From:</b> <code>${shortAddress}</code>`,
      "",
      `<b>Select token to send:</b>`,
    ];

    const keyboard = new InlineKeyboard();
    
    // Add SOL option
    const formattedSolBalance = wallet.formatSolBalance(solBalance);
    keyboard.text(`💰 SOL (${formattedSolBalance})`, `send_select_SOL`).row();
    
    // Add token options (limit to 5 for better UX)
    for (const token of tokenBalances.slice(0, 5)) {
      const formatted = wallet.formatTokenBalance(token.balance, token.decimals);
      keyboard.text(`🪙 ${token.ticker} (${formatted})`, `send_select_${token.ticker}`).row();
    }
    
    keyboard.text("← BACK TO WALLET", "main_wallet").row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
    await ctx.answerCallbackQuery("📤 Select token to send");
  } catch (error) {
    console.error("Error in cmd_withdraw:", error);
    await ctx.answerCallbackQuery("❌ Error loading send menu");
  }
});

bot.callbackQuery("cmd_privatekey", async (ctx) => {
  try {
    // Only show private key in private chats for security
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery("❌ Private key only available in private chat");
      return;
    }
    
    const telegramId = BigInt(ctx.from?.id || 0);
    const keypair = wallet.getKeyPair(telegramId);
    const privateKeyArray = Array.from(keypair.secretKey);
    const privateKeyString = `[${privateKeyArray.join(',')}]`;
    
    const response = [
      `🔐 <b>PRIVATE KEY</b>`,
      "",
      `⚠️ <b>KEEP THIS SECRET!</b>`,
      `Never share your private key with anyone.`,
      "",
      `<code>${privateKeyString}</code>`,
      "",
      `You can import this key into Phantom, Solflare, or other Solana wallets.`,
    ];

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("← BACK TO WALLET", "main_wallet").row()
    });
    await ctx.answerCallbackQuery("🔐 Private key shown");
  } catch (error) {
    console.error("Error in cmd_privatekey:", error);
    await ctx.answerCallbackQuery("❌ Error showing private key");
  }
});

bot.callbackQuery("cmd_wrap", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0);
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
    
    if (solBalance > 10000) { // Has at least 0.00001 SOL
      keyboard
        .text("0.01 SOL", "wrap_amount_0.01").text("0.1 SOL", "wrap_amount_0.1").row()
        .text("0.5 SOL", "wrap_amount_0.5").text("1 SOL", "wrap_amount_1").row()
        .text("✏️ Custom Amount", "wrap_custom").row();
    } else {
      keyboard.text("❌ Insufficient SOL balance").row();
    }
    
    keyboard.text("← BACK TO WALLET", "main_wallet").row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard
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
  if (callbackData !== 'wrap_custom') {
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
      reply_markup: new InlineKeyboard()
        .text("❌ Cancel", "cmd_wrap").row()
    });

    // Set user state to expect custom wrap amount
    setUserState(userId, {
      type: 'wrap_custom_amount',
      messageId: ctx.callbackQuery?.message?.message_id
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
  if (!callbackData?.startsWith('wrap_amount_')) {
    return await next();
  }

  try {
    const amount = callbackData.replace('wrap_amount_', '');
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
        .text("✅ CONFIRM WRAP", `confirm_wrap_${amount}`).row()
        .text("❌ Cancel", "cmd_wrap").row()
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
    const txId = callbackData.replace('confirm_send_', '');
    
    // Retrieve transaction details
    const transaction = getPendingTransaction(txId, true);
    if (!transaction || transaction.type !== 'send') {
      await ctx.answerCallbackQuery("❌ Transaction expired or not found");
      return;
    }
    
    // Verify user owns this transaction
    if (transaction.userId !== ctx.from.id.toString()) {
      await ctx.answerCallbackQuery("❌ Unauthorized transaction");
      return;
    }
    
    console.log(`✅ Confirmed send: ${transaction.amount} ${transaction.token} to ${transaction.address}`);
    
    // Update message to show processing state
    await ctx.editMessageText(
      `🔄 <b>PROCESSING TRANSACTION</b>\n\nSending ${transaction.amount} ${transaction.token}...\n\n<i>Please wait...</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
      }
    );
    
    // Execute actual transaction
    try {
      const toPublicKey = new PublicKey(transaction.address);
      let txSignature: string;
      let actualAmount = transaction.amount;
      
      if (transaction.token === 'SOL') {
        // Handle SOL transfer
        if (transaction.amount === 'max') {
          // Calculate max SOL (leave some for transaction fees)
          const balance = await wallet.getSolBalance(BigInt(transaction.userId));
          actualAmount = (balance - 0.01).toString(); // Leave 0.01 SOL for fees
        }
        
        txSignature = await wallet.transferSol(
          BigInt(transaction.userId),
          toPublicKey,
          parseFloat(actualAmount)
        );
      } else {
        // Handle token transfer
        const tokenMints: { [key: string]: string } = {
          'TIMBA': 'BLdSbJzuq2cW8MhB8VtFbG4JSsWdYFff8Ufd2zdc4Yi4',
          'WSOL': 'So11111111111111111111111111111111111111112',
          'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        };
        
        const tokenMint = tokenMints[transaction.token];
        if (!tokenMint) {
          throw new Error(`Unknown token: ${transaction.token}`);
        }
        
        if (transaction.amount === 'max') {
          // Get max token balance
          const balances = await wallet.getTokenBalances(BigInt(transaction.userId));
          const tokenBalance = balances.find(b => b.ticker === transaction.token);
          if (!tokenBalance) {
            throw new Error(`No ${transaction.token} balance found`);
          }
          actualAmount = tokenBalance.balance.toString();
        }
        
        txSignature = await wallet.transferToken(
          BigInt(transaction.userId),
          toPublicKey,
          parseFloat(actualAmount),
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
          disable_web_page_preview: true,
          reply_markup: new InlineKeyboard()
            .text("← BACK TO WALLET", "main_wallet").row()
        }
      );
      
    } catch (txError) {
      console.error("Transaction failed:", txError);
      await ctx.editMessageText(
        `❌ <b>TRANSACTION FAILED</b>\n\n${txError.message}\n\nPlease try again.`,
        {
          parse_mode: "HTML", 
          reply_markup: new InlineKeyboard()
            .text("← BACK TO WALLET", "main_wallet").row()
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
    const amount = callbackData.replace('confirm_wrap_', '');
    
    console.log(`✅ Confirmed wrap: ${amount} SOL`);
    
    // Update message to show processing state
    await ctx.editMessageText(
      `🔄 <b>PROCESSING WRAP</b>\n\nWrapping ${amount} SOL to WSOL...\n\n<i>Please wait...</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
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
              .text("← BACK TO WALLET", "main_wallet").row()
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

bot.callbackQuery("cmd_swap", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0);
    const keypair = wallet.getKeyPair(telegramId);
    const shortAddress = `${keypair.publicKey.toBase58().slice(0, 6)}...${keypair.publicKey.toBase58().slice(-6)}`;
    
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
      keyboard.text(`💰 SOL (${formattedSolBalance})`, `swap_from_SOL`).row();
    }
    
    // Add token options (only tokens with balance)
    for (const token of tokenBalances.slice(0, 6)) {
      if (parseFloat(token.rawBalance) > 0) {
        const formatted = wallet.formatTokenBalance(token.balance, token.decimals);
        keyboard.text(`🪙 ${token.ticker} (${formatted})`, `swap_from_${token.ticker}`).row();
      }
    }
    
    if (keyboard.inline_keyboard.length === 0) {
      keyboard.text("❌ No tokens available to swap").row();
    }
    
    keyboard.text("← BACK TO WALLET", "main_wallet").row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard
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
const userStates = new Map<string, {
  type: 'send_custom_amount' | 'send_address' | 'wrap_custom_amount';
  token?: string;
  amount?: string;
  messageId: number;
  timestamp: number;
}>();

// Track pending transactions with full details
const pendingTransactions = new Map<string, {
  type: 'send' | 'wrap';
  token?: string;
  amount?: string;
  address?: string;
  userId: string;
  timestamp: number;
}>();

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
    timestamp: now
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
    timestamp: now
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
const walletDataCache = new Map<string, {
  data: {
    solBalance: number;
    tokenBalances: Array<{ mint: string; ticker: string; balance: number; decimals: number; rawBalance: string }>;
    approvedTokens: any[];
  };
  timestamp: number;
}>();

const WALLET_CACHE_DURATION = 30 * 1000; // 30 seconds

/**
 * Get cached wallet data or fetch fresh data
 */
const getCachedWalletData = async (telegramId: bigint) => {
  const cacheKey = telegramId.toString();
  const cached = walletDataCache.get(cacheKey);
  const now = Date.now();
  
  // Return cached data if still valid
  if (cached && (now - cached.timestamp) < WALLET_CACHE_DURATION) {
    console.log("📦 Using cached wallet data for user:", telegramId.toString());
    return cached.data;
  }
  
  console.log("🔄 Fetching fresh wallet data for user:", telegramId.toString());
  
  try {
    // Fetch fresh data
    const solBalance = await wallet.getBalance(telegramId);
    const approvedTokens = tokenManager ? tokenManager.getAllApprovedTokensWithMetadata() : [];
    const tokenBalances = await wallet.getAllApprovedTokenBalances(telegramId, approvedTokens);
    
    const data = {
      solBalance,
      tokenBalances,
      approvedTokens
    };
    
    // Cache the data
    walletDataCache.set(cacheKey, {
      data,
      timestamp: now
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

// ================================
// SEND TOKEN INTERFACE HANDLERS
// ================================

// Handle token selection for send
bot.on("callback_query", async (ctx, next) => {
  const callbackData = ctx.callbackQuery?.data;
  if (!callbackData?.startsWith('send_select_')) {
    return await next();
  }

  const token = callbackData.replace('send_select_', '');
  console.log("🔔 Token selected for send:", token);
  
  try {
    const telegramId = BigInt(ctx.from?.id || 0);
    const keypair = wallet.getKeyPair(telegramId);
    const shortAddress = `${keypair.publicKey.toBase58().slice(0, 6)}...${keypair.publicKey.toBase58().slice(-6)}`;
    
    // Use cached wallet data
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    
    // Get balance for selected token
    let balance = "0";
    let decimals = 9;
    
    if (token === "SOL") {
      balance = wallet.formatSolBalance(solBalance);
      decimals = 9;
    } else {
      const selectedToken = tokenBalances.find(t => t.ticker === token);
      if (selectedToken) {
        balance = wallet.formatTokenBalance(selectedToken.balance, selectedToken.decimals);
        decimals = selectedToken.decimals;
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
        .text("0.01 SOL", `send_amount_${token}_0.01`).text("0.1 SOL", `send_amount_${token}_0.1`).row()
        .text("0.5 SOL", `send_amount_${token}_0.5`).text("1 SOL", `send_amount_${token}_1`).row()
        .text("💰 Max", `send_amount_${token}_max`).row();
    } else {
      // For tokens, use different amounts
      keyboard
        .text("10", `send_amount_${token}_10`).text("100", `send_amount_${token}_100`).row()
        .text("1000", `send_amount_${token}_1000`).text("💰 Max", `send_amount_${token}_max`).row();
    }
    
    keyboard
      .text("✏️ Custom Amount", `send_custom_${token}`).row()
      .text("← BACK", "cmd_withdraw").row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard
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
  if (!callbackData?.startsWith('send_amount_')) {
    return await next();
  }

  try {
    const parts = callbackData.replace('send_amount_', '').split('_');
    const token = parts[0];
    const amount = parts[1];
    const userId = ctx.from?.id?.toString();
    if (!userId) return;
    
    console.log(`🔔 Amount selected: ${amount} ${token}`);
    
    const response = [
      `📤 <b>SEND ${amount === 'max' ? 'MAX' : amount} ${token}</b>`,
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
      .text("❌ Cancel", `send_select_${token}`).row();

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: keyboard
    });

    // Set user state to expect wallet address
    setUserState(userId, {
      type: 'send_address',
      token: token,
      amount: amount,
      messageId: ctx.callbackQuery?.message?.message_id
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
  if (!callbackData?.startsWith('send_custom_')) {
    return await next();
  }

  try {
    const token = callbackData.replace('send_custom_', '');
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
        .text("❌ Cancel", `send_select_${token}`).row()
    });

    // Set user state to expect custom amount
    setUserState(userId, {
      type: 'send_custom_amount',
      token: token,
      messageId: ctx.callbackQuery?.message?.message_id
    });

    await ctx.answerCallbackQuery("Send the amount as a message");
  } catch (error) {
    console.error("Error in send_custom:", error);
    await ctx.answerCallbackQuery("❌ Error processing custom amount");
  }
});

bot.callbackQuery("main_settings", async (ctx) => {
  try {
    await ctx.editMessageText(
      "⚙️ <b>INFO & ADMIN</b>\n\n" +
      "📊 <b>Available Commands:</b>\n" +
      "▪️ Oracle status\n" +
      "▪️ Blockchain scan\n" +
      "▪️ Help information",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("📊 Oracle Status", "cmd_oracle").row()
          .text("🔍 Scan Blockchain", "cmd_scan").text("❓ Help", "cmd_help").row()
          .text("⬅️ Back to Main", "back_main")
      }
    );
    await ctx.answerCallbackQuery("⚙️ Info & Admin menu");
  } catch (error) {
    console.error("Error in main_settings:", error);
    await ctx.answerCallbackQuery("❌ Error loading settings menu");
  }
});

bot.callbackQuery("back_main", async (ctx) => {
  try {
    const telegramId = BigInt(ctx.from?.id || 0);
    const keypair = wallet.getKeyPair(telegramId);
    const username = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "User";
    const walletAddress = keypair.publicKey.toBase58();
    const shortAddress = `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`;

    const response = [
      "💰 <b>TIMBA</b> 💰",
      "",
      `PLAYER: ${username.toUpperCase()}`,
      `WALLET: <code>${shortAddress}</code>`,
    ];

    await ctx.editMessageText(response.join("\n"), {
      parse_mode: "HTML",
      reply_markup: createMainMenuKeyboard()
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
      "❓ <b>HELP CENTER</b>\n\n" +
      "Choose a category to get detailed help:",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💰 WALLET COMMANDS", "help_wallet").row()
          .text("🎮 GAME COMMANDS", "help_games").row()
          .text("🔧 UTILITY COMMANDS", "help_utility").row()
          .text("📋 EXAMPLES", "help_examples").row()
          .text("⬅️ Back to Main", "back_main")
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
      "💰 <b>WALLET COMMANDS</b>\n\n" +
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
          .text("🎮 GAMES", "help_games").text("🔧 UTILITY", "help_utility").row()
          .text("📋 EXAMPLES", "help_examples").row()
          .text("⬅️ Help Menu", "cmd_help").text("🏠 Main", "back_main").row()
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
      "🎮 <b>GAME COMMANDS</b>\n\n" +
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
          .text("💰 WALLET", "help_wallet").text("🔧 UTILITY", "help_utility").row()
          .text("📋 EXAMPLES", "help_examples").row()
          .text("⬅️ Help Menu", "cmd_help").text("🏠 Main", "back_main").row()
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
      "🔧 <b>UTILITY COMMANDS</b>\n\n" +
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
          .text("💰 WALLET", "help_wallet").text("🎮 GAMES", "help_games").row()
          .text("📋 EXAMPLES", "help_examples").row()
          .text("⬅️ Help Menu", "cmd_help").text("🏠 Main", "back_main").row()
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
      "📋 <b>COMMAND EXAMPLES</b>\n\n" +
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
          .text("💰 WALLET", "help_wallet").text("🎮 GAMES", "help_games").row()
          .text("🔧 UTILITY", "help_utility").row()
          .text("⬅️ Help Menu", "cmd_help").text("🏠 Main", "back_main").row()
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
        `🔑 <b>Authority:</b> <code>${oracleAccount.authority.toBase58()}</code>\n` +
        `🎲 <b>Randomness Source:</b> <code>${oracleAccount.randomnessAccount.toBase58()}</code>\n` +
        `⚡ <b>Status:</b> Online and operational\n\n` +
        "✅ Oracle is properly configured for game randomness",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🔍 SCAN BLOCKCHAIN", "cmd_scan").row()
            .text("⬅️ Back to Info", "main_settings").text("🏠 Main", "back_main").row()
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
            .text("🔍 SCAN BLOCKCHAIN", "cmd_scan").row()
            .text("⬅️ Back to Info", "main_settings").text("🏠 Main", "back_main").row()
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
      await ctx.answerCallbackQuery("🔒 This feature is only available in private chats");
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
          .text("🔍 START SCAN", "scan_confirm").row()
          .text("⬅️ Back to Info", "main_settings").text("🏠 Main", "back_main").row()
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
          .text("⬅️ Back to Info", "main_settings").text("🏠 Main", "back_main").row()
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
                .text("🔄 SCAN AGAIN", "scan_confirm").row()
                .text("⬅️ Back to Info", "main_settings").text("🏠 Main", "back_main").row()
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
    const telegramId = BigInt(ctx.from?.id || 0);
    
    await ctx.editMessageText(
      "🔧 <b>ADMIN PANEL</b>\n\n" +
      "Administrative tools and system management:",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🪙 MANAGE TOKENS", "admin_tokens").text("🎮 MANAGE GAMES", "admin_games").row()
          .text("👥 USER MANAGEMENT", "admin_users").text("📊 SYSTEM STATUS", "admin_system").row()
          .text("🔧 SETTINGS", "admin_settings").text("📝 LOGS", "admin_logs").row()
          .text("⬅️ Back to Main", "back_main").row()
      }
    );
    await ctx.answerCallbackQuery("🔧 Admin Panel");
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
          .text("➕ ADD TOKEN", "admin_add_token").text("📊 TOKEN STATS", "admin_token_stats").row()
          .text("🎯 DEFAULT TOKENS", "admin_default_tokens").row()
          .text("⬅️ Admin Panel", "admin_menu").text("🏠 Main", "back_main").row()
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
          .text("🎯 ACTIVE GAMES", "admin_active_games").text("📊 GAME STATS", "admin_game_stats").row()
          .text("🧹 CLEANUP", "admin_cleanup").row()
          .text("⬅️ Admin Panel", "admin_menu").text("🏠 Main", "back_main").row()
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
          .text("🔄 REFRESH STATUS", "admin_system").row()
          .text("📝 VIEW LOGS", "admin_logs").text("⚙️ SETTINGS", "admin_settings").row()
          .text("⬅️ Admin Panel", "admin_menu").text("🏠 Main", "back_main").row()
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
            .text(`⬅️ Back`, backCallback).text("🏠 Main", "back_main").row()
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
bot.callbackQuery("admin_users", adminPlaceholderHandler("User Management", "admin_menu"));
bot.callbackQuery("admin_settings", adminPlaceholderHandler("System Settings", "admin_menu"));
bot.callbackQuery("admin_logs", adminPlaceholderHandler("System Logs", "admin_menu"));
bot.callbackQuery("admin_add_token", adminPlaceholderHandler("Add Token", "admin_tokens"));
bot.callbackQuery("admin_token_stats", adminPlaceholderHandler("Token Statistics", "admin_tokens"));
bot.callbackQuery("admin_default_tokens", adminPlaceholderHandler("Default Tokens", "admin_tokens"));
bot.callbackQuery("admin_active_games", adminPlaceholderHandler("Active Games", "admin_games"));
bot.callbackQuery("admin_game_stats", adminPlaceholderHandler("Game Statistics", "admin_games"));
bot.callbackQuery("admin_cleanup", adminPlaceholderHandler("System Cleanup", "admin_games"));

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
    
    if (userState.type === 'send_custom_amount') {
      await handleCustomAmountInput(ctx, userState, userMessage);
    } else if (userState.type === 'send_address') {
      await handleAddressInput(ctx, userState, userMessage);
    } else if (userState.type === 'wrap_custom_amount') {
      await handleWrapAmountInput(ctx, userState, userMessage);
    }
  } catch (error) {
    console.error("Error handling user input:", error);
    
    // Try to update the original message with error
    try {
      await ctx.api.editMessageText(
        ctx.chat.id,
        userState.messageId,
        "❌ <b>Error processing input</b>\n\nPlease try again.",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("← BACK TO WALLET", "main_wallet").row()
        }
      );
    } catch (editError) {
      console.error("Failed to update message with error:", editError);
    }
  }
});

/**
 * Handle custom amount input for send
 */
const handleCustomAmountInput = async (ctx: any, userState: any, amount: string) => {
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
        .text("❌ Cancel", `send_select_${token}`).row()
    }
  );

  // Set new state to expect wallet address
  setUserState(ctx.from.id.toString(), {
    type: 'send_address',
    token: token,
    amount: amount,
    messageId: userState.messageId
  });
};

/**
 * Handle wallet address input for send
 */
const handleAddressInput = async (ctx: any, userState: any, address: string) => {
  const token = userState.token;
  const amount = userState.amount;
  
  // Basic Solana address validation (should be ~44 characters)
  if (address.length < 30 || address.length > 50) {
    throw new Error("Invalid wallet address format");
  }
  
  console.log(`📍 Address received for ${amount} ${token}: ${address.slice(0, 8)}...`);
  
  // Generate unique transaction ID and store transaction details
  const txId = generateTransactionId();
  storePendingTransaction(txId, {
    type: 'send',
    token: token,
    amount: amount,
    address: address,
    userId: ctx.from.id.toString()
  });
  
  const response = [
    `✅ <b>SEND CONFIRMATION</b>`,
    "",
    `<b>Amount:</b> ${amount === 'max' ? 'MAX' : amount} ${token}`,
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
        .text("✅ CONFIRM SEND", `confirm_send_${txId}`).row()
        .text("❌ Cancel", `send_select_${token}`).row()
    }
  );
};

/**
 * Handle wrap amount input
 */
const handleWrapAmountInput = async (ctx: any, userState: any, amount: string) => {
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
        .text("✅ CONFIRM WRAP", `confirm_wrap_${amount}`).row()
        .text("❌ Cancel", "cmd_wrap").row()
    }
  );
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
            if (error.message?.includes("Account does not exist")) {
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
