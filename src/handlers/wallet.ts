import type { InlineKeyboard } from "grammy";
import { escapeHtml } from "../utils/format-amount";
import { LAMPORTS_PER_SOL } from "../utils/constants";
import type { TokenDisplayLine } from "../utils/wallet-ui";
import { isRecoverableMediaError, trySendVideoWithFallback } from "../utils/media";
import { respondWithMenu } from "../utils/menu-response";



export type ShowWalletUIDeps = {
  wallet: {
    getKeyPair: (id: bigint) => any;
    formatSolBalance: (lamports: number) => string;
    formatTokenBalance?: (n: number, d: number) => string;
  };
  getCachedWalletData: (telegramId: bigint) => Promise<{ solBalance: number; tokenBalances: Array<{ mint: string; ticker: string; balance: number; decimals: number }> }>;
  getPriceUSD: (mint: string) => Promise<number>;
  buildWalletCaption: (walletAddress: string, tokenLines: TokenDisplayLine[]) => string;
  createWalletKeyboard: () => InlineKeyboard;
  WINNER_VIDEO_ID?: string | null;
};

export async function showWalletUI(ctx: any, deps: ShowWalletUIDeps) {
  const { wallet, getCachedWalletData, getPriceUSD, buildWalletCaption, createWalletKeyboard, WINNER_VIDEO_ID } = deps;

  const telegramId = BigInt(ctx.from?.id || 0) as bigint;
  const formatUsdValue = (value: number) =>
    Number.isFinite(value) ? value.toFixed(2) : "0.00";
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const walletVideoFileId = WINNER_VIDEO_ID ?? null;
  const getWalletKeyboard = () => createWalletKeyboard();

  const sendWalletContent = async (caption: string) => {
    const respondWithText = async () => {
      await respondWithMenu(ctx, {
        text: caption,
        keyboard: getWalletKeyboard(),
      });
    };

    if (!walletVideoFileId) {
      await respondWithText();
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
        await respondWithText();
        return;
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
      () => respondWithText()
    );
  };

  try {
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    const solPriceUSD = await getPriceUSD("SOL");
    const solDecimalBalance = solBalance / LAMPORTS_PER_SOL;
    const solFormattedBalance = wallet.formatSolBalance(solBalance);
    const tokenLines: TokenDisplayLine[] = [
      {
        ticker: "SOL",
        amount: solFormattedBalance,
        usdValue: formatUsdValue(solDecimalBalance * solPriceUSD),
        unit: "SOL",
      },
    ];

    for (const token of tokenBalances) {
      if (token.ticker === "SOL") {
        continue; // Already represented via SOL entry above
      }

      if (token.balance <= 0) {
        continue;
      }

      const formatted = wallet.formatTokenBalance
        ? (wallet as any).formatTokenBalance(token.balance, token.decimals)
        : String(token.balance / Math.pow(10, token.decimals));

      // Use the same robust logic as coinflip for price fetching
      const reference = token.mint || token.ticker;
      const tokenPriceUSD = await getPriceUSD(reference);
      const tokenDecimalBalance = token.balance / Math.pow(10, token.decimals);
      tokenLines.push({
        ticker: token.ticker,
        amount: formatted,
        usdValue: formatUsdValue(tokenDecimalBalance * tokenPriceUSD),
      });
    }

    const caption = buildWalletCaption(walletAddress, tokenLines);

    await sendWalletContent(caption);
  } catch (error) {
    console.error("Error loading balances:", error);
    const errorResponse = [
      `💳 <b>Wallet</b>`,
      "",
      `<code>${escapeHtml(walletAddress)}</code>`,
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
    const settingsContent = `⚙️ Settings\n\nChoose an option:`;
    const response = [settingsContent];
    const keyboard = deps.createSettingsKeyboard();
    await respondWithMenu(ctx, {
      text: response.join("\n"),
      keyboard,
    });
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
  buildWalletCaption: (walletAddress: string, tokenLines: TokenDisplayLine[]) => string;
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
    const formatUsdValue = (value: number) =>
      Number.isFinite(value) ? value.toFixed(2) : "0.00";
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
    const solPriceUSD = await getPriceUSD("SOL");
    const solDecimalBalance = solDisplayLamports / LAMPORTS_PER_SOL;

    const tokenLines: TokenDisplayLine[] = [
      {
        ticker: "SOL",
        amount: formattedSolBalance,
        usdValue: formatUsdValue(solDecimalBalance * solPriceUSD),
        unit: "SOL",
      },
    ];

    for (const token of tokenBalancesToShow) {
      if (token.ticker === "SOL" || token.balance <= 0) {
        continue;
      }

      const formattedTokenBalance = wallet.formatTokenBalance(
        token.balance,
        token.decimals
      );
      const tokenPriceUSD = await getPriceUSD(token.mint || token.ticker);
      const tokenDecimalBalance = token.balance / Math.pow(10, token.decimals);

      tokenLines.push({
        ticker: token.ticker,
        amount: formattedTokenBalance,
        usdValue: formatUsdValue(tokenDecimalBalance * tokenPriceUSD),
      });
    }

    const caption = buildWalletCaption(walletAddress, tokenLines);

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
