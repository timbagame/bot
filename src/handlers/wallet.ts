import type { InlineKeyboard } from "grammy";

export type ShowWalletUIDeps = {
  wallet: {
    getKeyPair: (id: bigint) => any;
    formatSolBalance: (lamports: number) => string;
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

    const caption = buildWalletCaption(formattedSolBalance, tokenLines, totalUSD, walletAddress);

    try {
      await ctx.editMessageMedia({ type: "video", media: walletVideoFileId, caption, parse_mode: "HTML" }, { reply_markup: createWalletKeyboard() });
    } catch {
      await ctx.replyWithVideo(walletVideoFileId, { caption, parse_mode: "HTML", reply_markup: createWalletKeyboard(), reply_to_message_id: ctx.message?.message_id });
    }
  } catch (error) {
    console.error("Error loading balances:", error);
    const errorResponse = [
      `💳 <b>Wallet</b>`,
      "",
      `<code>${shortAddress}</code>`,
      "",
      "❌ <i>Error loading balances</i>",
      "<i>Tap Refresh to try again</i>",
    ];
    try {
      await ctx.editMessageMedia({ type: "video", media: walletVideoFileId, caption: errorResponse.join("\n"), parse_mode: "HTML" }, { reply_markup: createWalletKeyboard() });
    } catch {
      await ctx.replyWithVideo(walletVideoFileId, { caption: errorResponse.join("\n"), parse_mode: "HTML", reply_markup: createWalletKeyboard(), reply_to_message_id: ctx.message?.message_id });
    }
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
