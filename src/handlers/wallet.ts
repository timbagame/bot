import type { InlineKeyboard } from "grammy";
import { escapeHtml } from "../utils/format-amount";
import { isRecoverableMediaError, trySendVideoWithFallback } from "../utils/media";



export type ShowWalletUIDeps = {
  wallet: {
    getKeyPair: (id: bigint) => any;
    formatSolBalance: (lamports: number) => string;
    formatTokenBalance?: (n: number, d: number) => string;
  };
  getCachedWalletData: (telegramId: bigint) => Promise<{ solBalance: number; tokenBalances: Array<{ mint: string; ticker: string; balance: number; decimals: number }> }>;
  getPriceUSD: (mint: string) => Promise<number>;
  buildWalletCaption: (solBalanceStr: string, tokenLines: Array<{ ticker: string; formatted: string }>, walletAddress: string, solUsdPrice?: number, timbaUsdPrice?: number) => string;
  createWalletKeyboard: () => InlineKeyboard;
  WINNER_VIDEO_ID?: string | null;
  LAMPORTS_PER_SOL: number;
};

export async function showWalletUI(ctx: any, deps: ShowWalletUIDeps) {
  const { wallet, getCachedWalletData, getPriceUSD, buildWalletCaption, createWalletKeyboard, WINNER_VIDEO_ID, LAMPORTS_PER_SOL } = deps;

  const telegramId = BigInt(ctx.from?.id || 0) as bigint;
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`;
  const walletVideoFileId = WINNER_VIDEO_ID ?? null;
  const getWalletKeyboard = () => createWalletKeyboard();

  const sendWalletContent = async (caption: string) => {
    const editAsText = async (): Promise<boolean> => {
      try {
        await ctx.editMessageText(caption, {
          parse_mode: "HTML",
          reply_markup: getWalletKeyboard(),
        });
        return true;
      } catch (textError: any) {
        const textDesc: string =
          textError?.description || textError?.message || "";
        if (textDesc.includes("message is not modified")) {
          return true;
        }
      }
      return false;
    };

    const sendAsText = async () => {
      await ctx.reply(caption, {
        parse_mode: "HTML",
        reply_markup: getWalletKeyboard(),
        reply_to_message_id: ctx.message?.message_id,
      });
    };

    if (!walletVideoFileId) {
      const edited = await editAsText();
      if (!edited) {
        await sendAsText();
      }
      return;
    }

    try {
      await ctx.editMessageMedia(
        { type: "video", media: walletVideoFileId, caption, parse_mode: "HTML" },
        { reply_markup: getWalletKeyboard() }
      );
      return;
    } catch (editError: any) {
      const description: string = editError?.description || editError?.message || "";
      if (description.includes("message is not modified")) {
        return;
      }
      if (isRecoverableMediaError(editError)) {
        console.warn("Falling back to text wallet edit:", editError);
        const edited = await editAsText();
        if (edited) {
          return;
        }
      }
    }

    await trySendVideoWithFallback(
      () =>
        ctx.replyWithVideo(walletVideoFileId, {
          caption,
          parse_mode: "HTML",
          reply_markup: getWalletKeyboard(),
          reply_to_message_id: ctx.message?.message_id,
        }),
      () => sendAsText()
    );
  };

  try {
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    const formattedSolBalance = wallet.formatSolBalance(solBalance);

    let totalUSD = 0;
    const solPriceUSD = await getPriceUSD("SOL");
    const solDecimalBalance = solBalance / LAMPORTS_PER_SOL;
    totalUSD += solDecimalBalance * solPriceUSD;

    const tokenLines: Array<{ ticker: string; formatted: string }> = [];
    let solUsdPrice = 0;
    let timbaUsdPrice = 0;
    
    for (const token of tokenBalances) {
      const formatted = wallet.formatTokenBalance
        ? (wallet as any).formatTokenBalance(token.balance, token.decimals)
        : String(token.balance / Math.pow(10, token.decimals));
      tokenLines.push({ ticker: token.ticker, formatted });

      // Use the same robust logic as coinflip for price fetching
      const reference = token.ticker === "SOL" ? "SOL" : token.mint || token.ticker;
      const tokenPriceUSD = await getPriceUSD(reference);
      const tokenDecimalBalance = token.balance / Math.pow(10, token.decimals);
      totalUSD += tokenDecimalBalance * tokenPriceUSD;
      
      // Store specific prices for display
      if (token.ticker === "TIMBA") {
        timbaUsdPrice = tokenPriceUSD;
      }
    }
    
    // Get SOL price
    solUsdPrice = await getPriceUSD("SOL");

    const caption = buildWalletCaption(
      formattedSolBalance,
      tokenLines,
      walletAddress,
      solUsdPrice,
      timbaUsdPrice
    );

    await sendWalletContent(caption);
  } catch (error) {
    console.error("Error loading balances:", error);
    const errorResponse = [
      `💳 <b>Wallet</b>`,
      "",
      `<code>${escapeHtml(shortAddress)}</code>`,
      "",
      "❌ <i>Error loading balances</i>",
      "<i>Tap Refresh to try again</i>",
    ];
    await sendWalletContent(errorResponse.join("\n"));
  }
}

// ================================
// CALLBACK HANDLERS
// ================================

export type WalletHandlersDeps = {
  showWalletUI: (ctx: any) => Promise<void>;
  clearWalletCache: (telegramId: bigint | string | number) => void;
  createSettingsKeyboard: () => InlineKeyboard;
};

export async function onMainWallet(ctx: any, deps: WalletHandlersDeps) {
  try {
    await deps.showWalletUI(ctx);
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error("❌ Error in main_wallet:", error);
    await ctx.answerCallbackQuery("❌ Error loading wallet menu");
  }
}

export async function onWalletRefresh(ctx: any, deps: WalletHandlersDeps) {
  try {
    const id = BigInt(ctx.from?.id || 0) as bigint;
    deps.clearWalletCache(id);
    await deps.showWalletUI(ctx);
    await ctx.answerCallbackQuery();
  } catch (error) {
    console.error("Error in wallet_refresh:", error);
    await ctx.answerCallbackQuery("❌ Error refreshing wallet");
  }
}

export async function onWalletSettings(ctx: any, deps: WalletHandlersDeps) {
  try {
    const settingsContent = `T I M B A\n\n⚙️ Settings\n\nChoose an option:`;
    const response = [settingsContent];
    const keyboard = deps.createSettingsKeyboard();
    try {
      await ctx.editMessageText(response.join("\n"), { parse_mode: "HTML", reply_markup: keyboard });
    } catch {
      await ctx.reply(response.join("\n"), { parse_mode: "HTML", reply_markup: keyboard });
    }
    await ctx.answerCallbackQuery("⚙️ Settings");
  } catch (error) {
    console.error("Error in wallet_settings:", error);
    await ctx.answerCallbackQuery("❌ Error loading settings");
  }
}

// ================================
// BALANCE COMMAND HANDLER
// ================================

export type BalanceDeps = {
  isPrivateChat: (ctx: any) => boolean;
  clearWalletCache: (telegramId: bigint) => void;
  showWalletUI: (ctx: any) => Promise<void>;
  getPlayerData: (telegramId: bigint) => Promise<{ keypair: any; solBalance: number }>;
  getApprovedTokens: () => Array<{ token_mint: string; token_ticker: string; decimals: number }>;
  buildTokenBalances: (telegramId: bigint, approvedTokens: any[]) => Promise<Array<{ mint: string; ticker: string; balance: number; decimals: number }>>;
  TOKENS_LIST: Array<{ mint: string; ticker: string }>;
  wallet: { formatTokenBalance: (n: number, d: number) => string; formatSolBalance: (n: number) => string };
  handleCommandError: (ctx: any, error: any, name: string) => Promise<void>;
  getPriceUSD: (mint: string) => Promise<number>;
  buildWalletCaption: (solBalanceStr: string, tokenLines: Array<{ ticker: string; formatted: string }>, walletAddress: string, solUsdPrice?: number, timbaUsdPrice?: number) => string;
  createWalletKeyboard: () => InlineKeyboard;
  WINNER_VIDEO_ID?: string | null;
};

export async function onBalance(ctx: any, deps: BalanceDeps) {
  const {
    isPrivateChat,
    clearWalletCache,
    showWalletUI,
    getPlayerData,
    getApprovedTokens,
    buildTokenBalances,
    TOKENS_LIST,
    wallet,
    handleCommandError,
    getPriceUSD,
    buildWalletCaption,
    createWalletKeyboard,
    WINNER_VIDEO_ID,
  } = deps;

  const telegramId = BigInt(ctx.from?.id || 0) as bigint;

  if (isPrivateChat(ctx)) {
    try {
      try { clearWalletCache(telegramId); } catch {}
      await showWalletUI(ctx);
    } catch (error) {
      await handleCommandError(ctx, error, "balance");
    }
    return;
  }

  // If it's not a private chat, send the same wallet UI privately to the user
  try {
    try { clearWalletCache(telegramId); } catch {}
    
    // Get the same data as private chat using the existing logic
    const playerData = await getPlayerData(telegramId);
    const approvedTokens = getApprovedTokens();
    const tokenBalancesToShow = await buildTokenBalances(telegramId, approvedTokens);

    const WSOL_MINT = (TOKENS_LIST.find((t) => t.ticker === "WSOL")?.mint as string) || "So11111111111111111111111111111111111111112";
    let solDisplayLamports = playerData.solBalance;
    const wsolIndex = tokenBalancesToShow.findIndex((t) => t.mint === WSOL_MINT);
    if (wsolIndex !== -1) {
      solDisplayLamports += tokenBalancesToShow[wsolIndex]!.balance;
      tokenBalancesToShow.splice(wsolIndex, 1);
    }

    const walletAddress = playerData.keypair.publicKey.toBase58();
    const formattedSolBalance = wallet.formatSolBalance(solDisplayLamports);

    // Build token lines with prices
    const tokenLines: Array<{ ticker: string; formatted: string }> = [];
    let solUsdPrice = 0;
    let timbaUsdPrice = 0;
    
    for (const token of tokenBalancesToShow) {
      const formatted = wallet.formatTokenBalance(token.balance, token.decimals);
      tokenLines.push({ ticker: token.ticker, formatted });

      // Use the same robust logic as coinflip for price fetching
      const reference = token.ticker === "SOL" ? "SOL" : token.mint || token.ticker;
      const tokenPriceUSD = await getPriceUSD(reference);
      
      // Store specific prices for display
      if (token.ticker === "TIMBA") {
        timbaUsdPrice = tokenPriceUSD;
      }
    }
    
    // Get SOL price
    solUsdPrice = await getPriceUSD("SOL");

    const caption = buildWalletCaption(
      formattedSolBalance,
      tokenLines,
      walletAddress,
      solUsdPrice,
      timbaUsdPrice
    );

    // Send privately to the user with video support
    const sendPrivateWalletContent = async (caption: string) => {
      const sendAsText = async () => {
        await ctx.api.sendMessage(ctx.from!.id, caption, { 
          parse_mode: "HTML",
          reply_markup: createWalletKeyboard(),
          link_preview_options: { is_disabled: true }
        });
      };

      if (!WINNER_VIDEO_ID) {
        await sendAsText();
        return;
      }

      try {
        await ctx.api.sendVideo(ctx.from!.id, WINNER_VIDEO_ID, {
          caption,
          parse_mode: "HTML",
          reply_markup: createWalletKeyboard(),
        });
      } catch (videoError) {
        console.warn("Failed to send video, falling back to text:", videoError);
        await sendAsText();
      }
    };

    await sendPrivateWalletContent(caption);
    
  } catch (error) {
    await handleCommandError(ctx, error, "balance");
  }
}
