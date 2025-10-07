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
  buildWalletCaption: (solBalanceStr: string, tokenLines: Array<{ ticker: string; formatted: string }>, totalUSD: number, walletAddress: string) => string;
  createWalletKeyboard: () => InlineKeyboard;
  WINNER_VIDEO_ID: string;
  LAMPORTS_PER_SOL: number;
};

export async function showWalletUI(ctx: any, deps: ShowWalletUIDeps) {
  const { wallet, getCachedWalletData, getPriceUSD, buildWalletCaption, createWalletKeyboard, WINNER_VIDEO_ID, LAMPORTS_PER_SOL } = deps;

  const telegramId = BigInt(ctx.from?.id || 0) as bigint;
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const shortAddress = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-6)}`;
  const walletVideoFileId = WINNER_VIDEO_ID;
  const getWalletKeyboard = () => createWalletKeyboard();

  const sendWalletContent = async (caption: string) => {
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
        try {
          await ctx.editMessageText(caption, {
            parse_mode: "HTML",
            reply_markup: getWalletKeyboard(),
          });
          return;
        } catch (textError: any) {
          const textDesc: string = textError?.description || textError?.message || "";
          if (textDesc.includes("message is not modified")) {
            return;
          }
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
      () =>
        ctx.reply(caption, {
          parse_mode: "HTML",
          reply_markup: getWalletKeyboard(),
          reply_to_message_id: ctx.message?.message_id,
        })
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
    for (const token of tokenBalances) {
      const formatted = wallet.formatTokenBalance
        ? (wallet as any).formatTokenBalance(token.balance, token.decimals)
        : String(token.balance / Math.pow(10, token.decimals));
      tokenLines.push({ ticker: token.ticker, formatted });

      const tokenPriceUSD = await getPriceUSD(token.mint);
      const tokenDecimalBalance = token.balance / Math.pow(10, token.decimals);
      totalUSD += tokenDecimalBalance * tokenPriceUSD;
    }

    const caption = buildWalletCaption(
      formattedSolBalance,
      tokenLines,
      totalUSD,
      walletAddress
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
    const response = [`<pre>${settingsContent}</pre>`];
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

  try {
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

    const displayName = ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "User";
    const walletAddress = playerData.keypair.publicKey.toBase58();

    const safeDisplayName = escapeHtml(displayName);
    const safeWalletAddress = escapeHtml(walletAddress);
    const response = [
      `<b>${safeDisplayName}</b>`,
      `<code>${safeWalletAddress}</code>`,
      "",
      `${escapeHtml(wallet.formatSolBalance(solDisplayLamports))} SOL`,
    ];

    if (tokenBalancesToShow.length > 0) {
      for (const token of tokenBalancesToShow.slice(0, 4)) {
        const balance = wallet.formatTokenBalance(token.balance, token.decimals);
        response.push(
          `${escapeHtml(balance)} ${escapeHtml(token.ticker)}`
        );
      }
      if (tokenBalancesToShow.length > 4) {
        response.push(`<i>+${tokenBalancesToShow.length - 4} more tokens</i>`);
      }
    }

    await ctx.reply(response.join("\n"), { parse_mode: "HTML", reply_to_message_id: ctx.message?.message_id });
  } catch (error) {
    await handleCommandError(ctx, error, "balance");
  }
}
