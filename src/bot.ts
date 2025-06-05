import { Bot, Context } from "grammy";
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
import {
  LAMPORTS_PER_SOL,
  GAME_TIMEOUT,
  COINFLIP_MAX_PLAYERS,
  GIVEAWAY_MAX_PLAYERS,
  EXPIRED_GAMES_CHECK_INTERVAL_MS,
  TOKEN_METADATA_CACHE_DURATION,
  DEFAULT_TOKEN_MINT,
  DEFAULT_TOKEN_TICKER,
  TOKENS_LIST
} from "./utils/constants";
import type { PlayerData, GameCompletedEvent } from "./types";
import { TokenDatabase } from "./utils/token-database";

// ================================
// GLOBAL INSTANCES
// ================================

const bot = new Bot(process.env.TELEGRAM_TOKEN!);
const wallet = WalletManager.getInstance(process.env.MNEMONIC!);
const gameDb = GameDatabase.getInstance();
const tokenDb = TokenDatabase.getInstance();

let program: anchor.Program<Coinflip>;
let gameManager: GameManager;
let tokenManager: TokenManager;

// Token metadata cache
let tokenMetadata: { decimals: number } | null = null;
let tokenMetadataLastFetch: number = 0;

// ================================
// BOT SEQUENTIALIZATION
// ================================

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

bot.use(sequentialize(getSequentializationKey));

// ================================
// UTILITY FUNCTIONS
// ================================

const getTokenMetadata = async () => {
  const now = Date.now();
  if (!tokenMetadata || now - tokenMetadataLastFetch > TOKEN_METADATA_CACHE_DURATION) {
    tokenMetadata = await wallet.getTokenMetadata(DEFAULT_TOKEN_MINT);
    tokenMetadataLastFetch = now;
  }
  return tokenMetadata;
};

const getPlayerData = async (telegramId: bigint, tokenMint?: string): Promise<PlayerData> => {
  const keypair = wallet.getKeyPair(telegramId);

  const effectiveTokenMint = tokenMint || DEFAULT_TOKEN_MINT;
  const [tokenBalance, solBalance] = await Promise.all([
    wallet.getTokenBalance(telegramId, effectiveTokenMint),
    wallet.getBalance(telegramId)
  ]);

  let gameBalance = 0;
  try {
    const playerBalancePda = PDAManager.getPlayerBalancePDA(
      keypair.publicKey,
      new PublicKey(effectiveTokenMint),
      program.programId
    );
    const playerBalanceAccount = await program.account.playerBalance.fetch(playerBalancePda);
    gameBalance = Number(playerBalanceAccount.amount);
  } catch (error) {
    // Player balance account doesn't exist yet
  }

  return { keypair, tokenBalance, solBalance, gameBalance };
};

const isUserGroupAdmin = async (ctx: Context, userId: number): Promise<boolean> => {
  try {
    if (!ctx.chat || ctx.chat.type === "private") return false;

    const member = await ctx.api.getChatMember(ctx.chat.id, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch (error) {
    console.warn(`Error checking admin status for user ${userId}:`, error);
    return false;
  }
};

const claimWinnings = async (playerKp: anchor.web3.Keypair): Promise<number> => {
  const playerBalancePda = PDAManager.getPlayerBalancePDA(
    playerKp.publicKey,
    new PublicKey(DEFAULT_TOKEN_MINT),
    program.programId
  );

  try {
    const playerBalance = await program.account.playerBalance.fetch(playerBalancePda);
    const claimableAmount = Number(playerBalance.amount);

    if (claimableAmount <= 0) return 0;

    const tx = await program.methods
      .withdrawPlayerBalance()
      .accounts({
        player: playerKp.publicKey,
        tokenMint: new PublicKey(DEFAULT_TOKEN_MINT),
      })
      .signers([playerKp])
      .rpc();

    await wallet.confirmTransaction(tx);
    return claimableAmount;
  } catch (error: any) {
    if (error.message?.includes('Account does not exist')) return 0;
    throw error;
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
      : `${wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${DEFAULT_TOKEN_TICKER}`;
    const needStr = isSol
      ? `${wallet.formatSolBalance(amount)} SOL`
      : `${wallet.formatTokenBalance(amount, metadata.decimals)} ${DEFAULT_TOKEN_TICKER}`;

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

// ================================
// RESPONSE HELPERS
// ================================

const handleCommandError = async (ctx: Context, error: any, commandName: string): Promise<void> => {
  console.error(`Error in ${commandName} command:`, error);
  const userFriendlyError = formatUserFriendlyError(error, wallet);
  await ctx.reply(userFriendlyError, {
    reply_to_message_id: ctx.message?.message_id
  });
};

const replyToMessage = async (ctx: Context, text: string, parseMode: "HTML" | "MarkdownV2" = "HTML"): Promise<void> => {
  await ctx.reply(text, {
    parse_mode: parseMode,
    reply_to_message_id: ctx.message?.message_id
  });
};

const replyUsageError = async (ctx: Context, message: string): Promise<void> => {
  return replyToMessage(ctx, message);
};

// ================================
// ANCHOR SETUP
// ================================

const initializeAnchorProvider = async () => {
  const adminKeypair = wallet.getAdminKeypair();
  const adminWallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(
    wallet.getConnection(),
    adminWallet,
    { commitment: "confirmed" }
  );

  anchor.setProvider(provider);
  return new anchor.Program(idl as Coinflip, provider) as anchor.Program<Coinflip>;
};

const setupAnchor = async () => {
  try {
    program = await initializeAnchorProvider();
    console.log(`Initialized Anchor program: ${program.programId}`);

    // Initialize TokenManager
    tokenManager = TokenManager.getInstance(wallet, DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER);
    console.log(`Initialized TokenManager with default token: ${DEFAULT_TOKEN_TICKER}`);

    // Add common tokens to the database
    await initializeCommonTokens();

    gameManager = GameManager.getInstance(program, wallet, gameDb);

    // Check Oracle initialization
    await checkOracleStatus();
    await checkGameTokenStatus();
  } catch (error) {
    console.error("Error initializing Anchor program:", error);
    console.error("Make sure admin-keypair.json exists in the project root directory.");
    throw error;
  }
};

const initializeCommonTokens = async () => {
  try {
    console.log("Initializing common tokens...");

    // Add the default token first
    await tokenManager.addToken(DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER);
    console.log(`Added default token: ${DEFAULT_TOKEN_TICKER}`);

    // Add approved tokens
    for (const token of TOKENS_LIST) {
      try {
        const success = await tokenManager.addToken(token.mint, token.ticker);
        if (success) {
          console.log(`Added common token: ${token.ticker}`);
        }
      } catch (error) {
        console.warn(`Could not add common token ${token.ticker}:`, error);
      }
    }

    console.log(`Initialized token database with ${tokenDb.getTokenCount()} tokens`);
  } catch (error) {
    console.warn("Error initializing common tokens:", error);
  }
};

const checkOracleStatus = async () => {
  try {
    const oraclePda = PDAManager.getOraclePDA(program.programId);
    const oracleAccount = await program.account.oracle.fetch(oraclePda);
    console.log(`Oracle found, authority: ${oracleAccount.authority.toString()}`);
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
    const gameTokenAccount = await program.account.gameToken.fetch(gameTokenPda);

    // Get token metadata to format the amount properly
    const metadata = await getTokenMetadata();
    const formattedMinAmount = wallet.formatTokenBalance(
      Number(gameTokenAccount.minAmount),
      metadata.decimals
    );

    console.log(`Game token found with min amount: ${formattedMinAmount} ${DEFAULT_TOKEN_TICKER} (${gameTokenAccount.minAmount.toString()} raw units)`);
  } catch (error) {
    console.log("Game token not found, it might need to be initialized");
  }
};

// ================================
// BOT COMMANDS
// ================================

bot.command(["start", "balance"], async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  try {
    const playerData = await getPlayerData(telegramId);

    // Get all approved tokens with metadata
    const approvedTokens = tokenManager.getAllApprovedTokensWithMetadata();

    // Efficiently get all token balances in a single RPC call
    const allTokenBalances = await wallet.getAllApprovedTokenBalances(telegramId, approvedTokens);

    // Build token list with game balance included for ALL tokens
    const tokenBalancesToShow = await Promise.all(
      allTokenBalances.map(async (token) => {
        try {
          const tokenPlayerData = await getPlayerData(telegramId, token.mint);
          return {
            ...token,
            balance: token.balance + tokenPlayerData.gameBalance
          };
        } catch (error) {
          // If error getting game balance, just show wallet balance
          return token;
        }
      })
    );

    // If any approved token has game balance but no wallet balance, add it
    for (const approvedToken of approvedTokens) {
      const hasToken = allTokenBalances.some(t => t.mint === approvedToken.token_mint);
      if (!hasToken) {
        try {
          const tokenPlayerData = await getPlayerData(telegramId, approvedToken.token_mint);
          if (tokenPlayerData.gameBalance > 0) {
            tokenBalancesToShow.push({
              mint: approvedToken.token_mint,
              ticker: approvedToken.token_ticker,
              balance: tokenPlayerData.gameBalance,
              decimals: approvedToken.decimals,
              rawBalance: tokenPlayerData.gameBalance.toString()
            });
          }
        } catch (error) {
          // Ignore if can't get game balance
        }
      }
    }

    // Build the response
    const response = [
      "💰 <b>Your Balance</b>",
      "",
      `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>`,
      "",
      `💎 SOL Balance: ${wallet.formatSolBalance(playerData.solBalance)} SOL`
    ];

    // Add token balances section
    if (tokenBalancesToShow.length > 0) {
      response.push("", "🪙 <b>Token Balances:</b>");

      for (const token of tokenBalancesToShow) {
        const balanceText = `${wallet.formatTokenBalance(token.balance, token.decimals)} ${token.ticker}`;
        response.push(`• ${balanceText}`);
      }
    }

    await ctx.reply(response.join("\n"), {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "balance");
  }
});

bot.command(["coinflip", "cf"], async (ctx) => {
  if (!ctx.from) return;

  // Check if this is a private chat
  if (ctx.chat?.type === "private") {
    return replyToMessage(ctx, "🚫 Coinflip games cannot be created in private chats since other players can't join. Please use this command in a group or channel where other players can participate!");
  }

  const args = ctx.message?.text?.split(" ");
  if (!args) return;

  const parsed = await tokenManager.parseAmount(args, 1, ctx.chat?.id);
  if (!parsed.success) {
    if (parsed.error === "unknown_token") {
      return replyToMessage(ctx, `❌ Unknown token "${parsed.unknownToken}"`);
    }
    return replyUsageError(ctx, "Usage: /coinflip &lt;amount&gt; [TOKEN] &lt;maxPlayers&gt;\nExample: /coinflip 10 2 or /coinflip 10 TIMBA 2");
  }

  // Check if token was specified to adjust maxPlayers index
  const tokenSpecified = parsed.data!.tokenWasSpecified;
  const maxPlayersIndex = tokenSpecified ? 3 : 2;
  const maxPlayers = parseInt(args?.[maxPlayersIndex] || COINFLIP_MAX_PLAYERS.toString()) || COINFLIP_MAX_PLAYERS;

  await gameManager.createGame(ctx, "coinflip", parsed.data!, maxPlayers, 2, GAME_TIMEOUT);
});

bot.command(["giveaway", "ga"], async (ctx) => {
  if (!ctx.from) return;

  // Check if this is a private chat
  if (ctx.chat?.type === "private") {
    return replyToMessage(ctx, "🚫 Giveaway games cannot be created in private chats since other players can't join. Please use this command in a group or channel where other players can participate!");
  }

  const args = ctx.message?.text?.split(" ");
  if (!args) return;

  const parsed = await tokenManager.parseAmount(args, 1, ctx.chat?.id);
  if (!parsed.success) {
    if (parsed.error === "unknown_token") {
      return replyToMessage(ctx, `❌ Unknown token "${parsed.unknownToken}"`);
    }
    return replyUsageError(ctx, "Usage: /giveaway &lt;amount&gt; [TOKEN] &lt;maxPlayers&gt;\nExample: /giveaway 100 5 or /giveaway 100 TIMBA 5");
  }

  // Check if token was specified to adjust maxPlayers index
  const tokenSpecified = parsed.data!.tokenWasSpecified;
  const maxPlayersIndex = tokenSpecified ? 3 : 2;
  const maxPlayers = parseInt(args?.[maxPlayersIndex] || GIVEAWAY_MAX_PLAYERS.toString()) || GIVEAWAY_MAX_PLAYERS;

  await gameManager.createGame(ctx, "giveaway", parsed.data!, maxPlayers, 1, GAME_TIMEOUT);
});

// ================================
// WALLET COMMANDS
// ================================

bot.command(["withdraw", "wh"], async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 3) {
    return replyUsageError(ctx, "Usage: /withdraw &lt;address&gt; &lt;amount&gt; [TOKEN] or /withdraw &lt;address&gt; &lt;amount&gt; SOL");
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
          return await wallet.signAndSend([transferSolIx], [playerData.keypair]);
        } else {
          return await wallet.transferToken(telegramId, toAddress, parsed.data!.amount, parsed.data!.tokenMint);
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
    return replyUsageError(ctx, "Usage: Reply to a user's message with /tip &lt;amount&gt; [TOKEN] or /tip &lt;amount&gt; SOL");
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
          return await wallet.signAndSend([transferSolIx], [playerData.keypair]);
        } else {
          return await wallet.transferToken(telegramId, recipientPubKey, parsed.data!.amount, parsed.data!.tokenMint);
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
    return replyUsageError(ctx, "Usage: /wrap &lt;amount&gt;\nExample: /wrap 0.1");
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

// ================================
// TOKEN MANAGEMENT COMMANDS
// ================================

bot.command("default", async (ctx: Context) => {
  if (!ctx.from) return;

  // Check if this is a private chat
  if (ctx.chat?.type === "private") {
    return replyToMessage(ctx, "🚫 Default tokens can only be set in groups or channels.");
  }

  const args = ctx.message?.text?.split(" ");

  if (!args || args.length < 2) {
    // Show current default token (anyone can view)
    const chatConfig = tokenManager.getChatDefaultToken(ctx.chat!.id);
    if (chatConfig) {
      const setBy = await gameManager.getUsernameFromTelegramId(ctx, chatConfig.set_by_telegram_id);
      return replyToMessage(ctx,
        `📄 Current default token: ${chatConfig.token_ticker}\n` +
        `🏷️ Token mint: <code>${chatConfig.token_mint}</code>\n` +
        `👤 Set by: @${setBy}\n` +
        `📅 Set at: ${new Date(chatConfig.set_at).toLocaleString()}\n\n` +
        `Use /default &lt;TOKEN_TICKER&gt; to change or /default clear to remove.`
      );
    } else {
      const defaultToken = tokenManager.getDefaultToken();
      return replyToMessage(ctx,
        `📄 No default token set for this chat.\n` +
        `🔄 Using bot default: ${defaultToken.tokenTicker}\n\n` +
        `Use /default &lt;TOKEN_TICKER&gt; to set a default token for this chat.`
      );
    }
  }

  // For changing the default token, check admin permissions
  const isAdmin = await isUserGroupAdmin(ctx, ctx.from.id);
  if (!isAdmin) {
    return replyToMessage(ctx,
      "🔒 Only group administrators can change the default token.\n\n" +
      "💡 Contact a group admin to set or change the default token for this chat."
    );
  }

  const tokenInput = args[1];
  if (!tokenInput) {
    return replyToMessage(ctx, "Please provide a token ticker.");
  }

  // Handle clear command
  if (tokenInput.toUpperCase() === "CLEAR" || tokenInput.toUpperCase() === "REMOVE") {
    tokenManager.removeChatDefaultToken(ctx.chat!.id);
    return replyToMessage(ctx, "✅ Default token cleared for this chat. Using bot default token now.");
  }

  // Try to find the token
  const knownToken = tokenManager.getKnownTokenByTicker(tokenInput);
  if (!knownToken) {
    const allTokens = tokenManager.getAllKnownTokens();
    let response = `❌ Token "${tokenInput.toUpperCase()}" not found.\n\n`;

    if (allTokens.length > 0) {
      response += "📋 Known tokens:\n";
      for (const token of allTokens.slice(0, 10)) { // Show max 10 tokens
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
  tokenManager.setChatDefaultToken(ctx.chat!.id, knownToken.token_mint, knownToken.token_ticker, ctx.from.id.toString());

  return replyToMessage(ctx,
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
    "/withdraw &lt;address&gt; &lt;amount&gt; [TOKEN] - Withdraw tokens to external wallet",
    "/wh &lt;address&gt; &lt;amount&gt; [TOKEN] - Shorthand for withdraw command",
    "/tip &lt;amount&gt; [TOKEN] - Reply to a user's message to send them tokens",
    "/privatekey, /pk - Get your wallet private key (private chat only)",
    "",
    "<b>🎮 Game Commands:</b>",
    "/coinflip &lt;amount&gt; [TOKEN] &lt;maxPlayers&gt; - Create a new coinflip game",
    "/cf &lt;amount&gt; [TOKEN] &lt;maxPlayers&gt; - Shorthand for coinflip command",
    "/giveaway &lt;amount&gt; [TOKEN] &lt;maxPlayers&gt; - Create a new giveaway",
    "/ga &lt;amount&gt; [TOKEN] &lt;maxPlayers&gt; - Shorthand for giveaway command",
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
    "• Group admins can set default tokens with /default &lt;TOKEN&gt;",
    "• Contact bot administrator to add support for new SPL tokens"
  ];

  await ctx.reply(helpSections.join("\n"), {
    parse_mode: "HTML",
    reply_to_message_id: ctx.message?.message_id
  });
});

bot.command("debug", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);
  const replyToMessage = ctx.message?.reply_to_message;

  try {
    const debugInfo = await buildDebugInfo(telegramId, ctx.from?.first_name || 'You');
    let response = debugInfo;

    // If replying to someone, show their info too
    if (replyToMessage && replyToMessage.from && !replyToMessage.from.is_bot) {
      const recipientTelegramId = BigInt(replyToMessage.from.id);
      const recipientDebugInfo = await buildDebugInfo(
        recipientTelegramId,
        replyToMessage.from.first_name || 'User',
        true
      );
      response += "\n\n" + recipientDebugInfo;
    }

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "debug");
  }
});

const buildDebugInfo = async (telegramId: bigint, name: string, isReplyTarget: boolean = false): Promise<string> => {
  const playerData = await getPlayerData(telegramId);
  const metadata = await getTokenMetadata();

  const { getAssociatedTokenAddress } = await import("@solana/spl-token");
  const tokenAccount = await getAssociatedTokenAddress(
    new PublicKey(DEFAULT_TOKEN_MINT),
    playerData.keypair.publicKey
  );

  const prefix = isReplyTarget ? `<b>Reply Target: ${name}</b>` : `🔍 <b>Debug Info for ${name}</b>`;

  return [
    prefix,
    "",
    `Telegram ID: <code>${telegramId}</code>`,
    `Wallet Address: <code>${playerData.keypair.publicKey.toBase58()}</code>`,
    `SOL Balance: ${wallet.formatSolBalance(playerData.solBalance)} SOL`,
    `Token Balance: ${wallet.formatTokenBalance(playerData.tokenBalance, metadata.decimals)} ${DEFAULT_TOKEN_TICKER}`,
    `Game Balance: ${wallet.formatTokenBalance(playerData.gameBalance, metadata.decimals)} ${DEFAULT_TOKEN_TICKER}`,
    `Token Account: <code>${tokenAccount.toBase58()}</code>`
  ].join("\n");
};

bot.command("checktx", async (ctx: Context) => {
  const args = ctx.message?.text?.split(" ");
  const signature = args?.[1];

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

    const response = [
      "🔍 <b>Transaction Details</b>",
      "",
      `Signature: <code>${signature}</code>`,
      `Slot: ${txDetails.slot}`,
      `Block Time: ${txDetails.blockTime ? new Date(txDetails.blockTime * 1000).toISOString() : 'Unknown'}`,
      `Fee: ${txDetails.meta?.fee || 0} lamports`,
      `Status: ${txDetails.meta?.err ? '❌ Failed' : '✅ Success'}`
    ];

    if (txDetails.meta?.err) {
      response.push(`Error: <code>${JSON.stringify(txDetails.meta.err)}</code>`);
    }

    await ctx.reply(response.join("\n"), {
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

bot.command("active", async (ctx: Context) => {
  const telegramId = BigInt(ctx.from?.id || 0);

  try {
    const { activeGames } = await gameManager.getUserGames(ctx, telegramId);

    let response = activeGames || "You don't have any active games.";

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
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
      reply_to_message_id: ctx.message?.message_id
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
    return ctx.reply("🔒 This command can only be used in private messages for security reasons. Please message me directly.", {
      reply_to_message_id: ctx.message?.message_id
    });
  }

  const telegramId = BigInt(ctx.from?.id || 0);

  try {
    const playerData = await getPlayerData(telegramId);
    const privateKeyArray = Array.from(playerData.keypair.secretKey);
    const privateKeyString = `[${privateKeyArray.join(',')}]`;

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
      `Private Key (Base58 Format):\n<code>${Buffer.from(playerData.keypair.secretKey).toString('base64')}</code>`,
      "",
      "💡 You can import this key into Phantom, Solflare, or other Solana wallets."
    ].join("\n");

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
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
      `Authority: <code>${oracleAccount.authority.toString()}</code>`,
      `Fee Percentage: ${oracleAccount.feePercentage}%`,
      `Min Timeout: ${oracleAccount.minTimeout} seconds (${oracleAccount.minTimeout / 60} minutes)`,
      `Max Timeout: ${oracleAccount.maxTimeout} seconds (${oracleAccount.maxTimeout / 60} minutes)`,
      `Max Players: ${oracleAccount.maxPlayers}`,
      `Oracle Buffer Time: ${oracleAccount.oracleBufferTime} seconds`,
      "",
      `Current Game Timeout: ${GAME_TIMEOUT} seconds (${GAME_TIMEOUT / 60} minutes)`
    ].join("\n");

    await ctx.reply(response, {
      parse_mode: "HTML",
      reply_to_message_id: ctx.message?.message_id
    });
  } catch (error) {
    await handleCommandError(ctx, error, "oracle");
  }
});

bot.command("scan", async (ctx: Context) => {
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

    const response = [
      "✅ Blockchain scan completed successfully!",
      "",
      "Check console logs for detailed information."
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
    await handleCompletedGameCallback(ctx, game);
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
      await ctx.answerCallbackQuery("This game is no longer active!");
    } else {
      const userFriendlyError = formatUserFriendlyError(error, wallet);
      await ctx.answerCallbackQuery(userFriendlyError.substring(0, 180));
    }
  }
});

const handleCompletedGameCallback = async (ctx: any, game: any) => {
  try {
    const creatorUsername = await gameManager.getGameCreatorUsername(ctx, game.game_address);
    const gameData = gameDb.getGame(game.game_address);

    if (gameData) {
      // Ensure token info exists
      if (!gameData.token_mint || !gameData.token_ticker) {
        console.error(`Missing token info for game ${game.game_address}`);
        await ctx.answerCallbackQuery("Game data incomplete - please contact support");
        return;
      }

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
        gameData.token_mint,
        gameData.token_ticker,
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
};

const handleJoinGame = async (ctx: any, gamePda: PublicKey, playerKp: any, telegramId: bigint, game: any) => {
  if (game.status !== "active") {
    await ctx.answerCallbackQuery("This game is no longer active!");
    return;
  }

  try {
    const gameAccount = await program.account.game.fetch(gamePda);

    // Check if player already joined by checking PlayerParticipation account
    const playerParticipationPda = PDAManager.getPlayerParticipationPDA(
      gamePda,
      playerKp.publicKey,
      program.programId
    );

    let isAlreadyInGame = false;
    try {
      await program.account.playerParticipation.fetch(playerParticipationPda);
      isAlreadyInGame = true;
    } catch (error) {
      // PlayerParticipation account doesn't exist, so player is not in game
      isAlreadyInGame = false;
    }

    if (isAlreadyInGame) {
      await ctx.answerCallbackQuery("You have already joined this game!");
      return;
    }

    if (gameAccount.playerCount >= gameAccount.maxPlayers) {
      await ctx.answerCallbackQuery("This game is already full!");
      return;
    }

    // Check balance
    const gameData = gameDb.getGame(game.game_address);
    if (!gameData) {
      await ctx.answerCallbackQuery("Game not found!");
      return;
    }

    // Ensure token info exists
    if (!gameData.token_mint || !gameData.token_ticker) {
      console.error(`Missing token info for game ${game.game_address}`);
      await ctx.answerCallbackQuery("Game data incomplete - please contact support");
      return;
    }

    const tokenMint = gameData.token_mint;
    const [tokenBalance, gameBalance] = await Promise.all([
      wallet.getTokenBalance(telegramId, tokenMint),
      (async () => {
        try {
          const playerBalancePda = PDAManager.getPlayerBalancePDA(
            playerKp.publicKey,
            new PublicKey(tokenMint),
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
      const metadata = await wallet.getTokenMetadata(tokenMint);
      const tokenTicker = gameData.token_ticker;
      await ctx.answerCallbackQuery(`Insufficient balance. You have ${wallet.formatTokenBalance(totalBalance, metadata.decimals)} ${tokenTicker} but need ${wallet.formatTokenBalance(gameAmount, metadata.decimals)} ${tokenTicker}`);
      return;
    }

    // Ensure player balance and join
    await gameManager.ensurePlayerBalance(playerKp, tokenMint);

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
    const tokenTicker = gameData.token_ticker;
    await gameManager.updateGameMessage(ctx, game.game_address, gameType, Number(game.amount), creatorUsername, "Active", tokenMint, tokenTicker);

    // Send join notification
    const joinerUsername = ctx.from?.username || ctx.from?.first_name || "Player";
    const updatedGameAccount = await program.account.game.fetch(gamePda);
    const playerCount = updatedGameAccount.playerCount;
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

    // Note: Game completion is now handled automatically by the external oracle service
    // when the game is full or expires with enough players

  } catch (error: any) {
    // Handle specific case where account doesn't exist (game was completed/cancelled)
    if (error.message?.includes('Account does not exist')) {
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

  // Ensure token info exists
  if (!gameData.token_mint || !gameData.token_ticker) {
    console.error(`Missing token info for game ${game.game_address}`);
    await ctx.answerCallbackQuery("Game data incomplete - please contact support");
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
      "Active",
      gameData.token_mint,
      gameData.token_ticker
    );

    await ctx.answerCallbackQuery("Game status refreshed!");
  } catch (error: any) {
    // Handle the case where the account doesn't exist (game was completed/cancelled)
    if (error.message?.includes('Account does not exist')) {
      await ctx.answerCallbackQuery("This game is no longer active!");
    } else {
      console.error(`Error refreshing game ${game.game_address}:`, error);
      await ctx.answerCallbackQuery("Error refreshing game status!");
    }
  }
};

// ================================
// ERROR HANDLING & BOT STARTUP
// ================================

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
        const gameTypeKeys = Object.keys(event.gameType);
        const gameType = gameTypeKeys[0] ? gameTypeKeys[0].charAt(0).toUpperCase() + gameTypeKeys[0].slice(1) : "Game";

        // Ensure token info exists
        if (!gameData.token_mint || !gameData.token_ticker) {
          console.error(`Missing token info for completed game ${gameAddress}`);
          return;
        }

        await gameManager.updateGameMessage(
          dummyCtx,
          gameAddress,
          gameType,
          Number(event.amount),
          creatorUsername,
          "Completed",
          gameData.token_mint,
          gameData.token_ticker,
          winnerAddress
        );
        console.log(`📝 Updated game message for completed game ${gameAddress}`);
      }

      // Send simplified completion notification
      try {
        // Use the game's actual token instead of default
        if (!gameData.token_mint || !gameData.token_ticker) {
          console.error(`Missing token info for completion notification of game ${gameAddress}`);
          return;
        }

        const metadata = await wallet.getTokenMetadata(gameData.token_mint);
        const winnerUsername = await gameManager.getPlayerUsername(dummyCtx, winnerAddress);
        const winnerAmount = Number(event.winnerAmount);
        const gameTypeKeys = Object.keys(event.gameType);
        const gameType = gameTypeKeys[0] ? gameTypeKeys[0].charAt(0).toUpperCase() + gameTypeKeys[0].slice(1) : "Game";

        let notificationText = `🎉 <b>${gameType} Completed!</b>\n\n`;
        notificationText += `🏆 Winner: @${winnerUsername}\n`;
        notificationText += `💰 Prize: ${wallet.formatTokenBalance(winnerAmount, metadata.decimals)} ${gameData.token_ticker}`;

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
              console.log(`Game ${game.game_address} account not found but not marked as completed in DB`);
              // Don't automatically mark as cancelled - it might have been completed by the oracle
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
}).catch(error => {
  console.error("Failed to setup Anchor:", error);
});
