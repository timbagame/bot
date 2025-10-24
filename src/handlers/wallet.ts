import type { InlineKeyboard } from "grammy";
import { escapeHtml } from "../utils/format-amount";
import { buildWalletTokenLines, type TokenDisplayLine } from "../utils/wallet-ui";
import { editMediaWithFallback, trySendVideoWithFallback } from "../utils/media";
import { respondWithMenu } from "../utils/menu-response";
import { getTelegramId } from "../utils/context-helpers";

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

export type SendWalletMediaWithFallbackOptions = {
  videoFileId?: string | null;
  sendText: () => Promise<void>;
  sendVideo?: () => Promise<void>;
  editMessage?: () => Promise<void>;
  logLabel?: string;
};

export const sendWalletMediaWithFallback = async ({
  videoFileId,
  sendText,
  sendVideo,
  editMessage,
  logLabel = "wallet media",
}: SendWalletMediaWithFallbackOptions): Promise<void> => {
  if (!videoFileId) {
    await sendText();
    return;
  }

  if (editMessage) {
    try {
      const { skipped, usedFallback } = await editMediaWithFallback({
        edit: () => editMessage(),
        fallback: sendText,
        logLabel: `${logLabel} edit`,
      });

      if (skipped || usedFallback) {
        return;
      }

      return;
    } catch (error) {
      console.warn(`${logLabel} edit failed, sending new video`, error);
    }
  }

  if (!sendVideo) {
    await sendText();
    return;
  }

  await trySendVideoWithFallback(
    () => sendVideo(),
    () => sendText(),
    { logLabel: `${logLabel} send` }
  );
};

export async function showWalletUI(ctx: any, deps: ShowWalletUIDeps) {
  const { wallet, getCachedWalletData, getPriceUSD, buildWalletCaption, createWalletKeyboard, WINNER_VIDEO_ID } = deps;

  const telegramId = getTelegramId(ctx);
  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const walletVideoFileId = WINNER_VIDEO_ID ?? null;
  const getWalletKeyboard = () => createWalletKeyboard();
  const callbackMessage = ctx?.callbackQuery?.message;
  const botId = ctx?.me?.id;
  const messageAuthorId = callbackMessage?.from?.id;
  const authoredByBot = Boolean(
    callbackMessage?.from?.is_bot ||
      (botId != null && messageAuthorId != null && String(messageAuthorId) === String(botId))
  );
  const canEditBotMessage = Boolean(
    typeof ctx?.editMessageMedia === "function" && callbackMessage && authoredByBot
  );

  const sendWalletContent = (caption: string) =>
    sendWalletMediaWithFallback({
      videoFileId: walletVideoFileId,
      logLabel: "wallet media",
      sendText: () =>
        respondWithMenu(ctx, {
          text: caption,
          keyboard: getWalletKeyboard(),
        }),
      sendVideo: walletVideoFileId
        ? () =>
            ctx.replyWithVideo(walletVideoFileId, {
              caption,
              parse_mode: "HTML",
              reply_markup: getWalletKeyboard(),
              reply_to_message_id: ctx.message?.message_id,
            })
        : undefined,
      editMessage:
        canEditBotMessage && walletVideoFileId
          ? () =>
              ctx.editMessageMedia(
                { type: "video", media: walletVideoFileId, caption, parse_mode: "HTML" },
                { reply_markup: getWalletKeyboard() }
              )
          : undefined,
    });

  try {
    const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
    const tokenLines = await buildWalletTokenLines({
      solBalanceLamports: solBalance,
      tokenBalances,
      formatSolBalance: (value) => wallet.formatSolBalance(value),
      formatTokenBalance: wallet.formatTokenBalance
        ? (amount, decimals) => (wallet as any).formatTokenBalance(amount, decimals)
        : undefined,
      getPriceUSD,
    });

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
    const id = getTelegramId(ctx);
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

  const telegramId = getTelegramId(ctx);

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
    const tokenLines = await buildWalletTokenLines({
      solBalanceLamports: solDisplayLamports,
      tokenBalances: tokenBalancesToShow,
      formatSolBalance: (value) => wallet.formatSolBalance(value),
      formatTokenBalance: (amount, decimals) => wallet.formatTokenBalance(amount, decimals),
      getPriceUSD,
    });

    const caption = buildWalletCaption(walletAddress, tokenLines);

    // Send privately to the user with video support
    await sendWalletMediaWithFallback({
      videoFileId: WINNER_VIDEO_ID,
      logLabel: "wallet dm media",
      sendText: () =>
        ctx.api.sendMessage(ctx.from!.id, caption, {
          parse_mode: "HTML",
          reply_markup: createWalletKeyboard(),
          link_preview_options: { is_disabled: true },
        }),
      sendVideo: WINNER_VIDEO_ID
        ? () =>
            ctx.api.sendVideo(ctx.from!.id, WINNER_VIDEO_ID, {
              caption,
              parse_mode: "HTML",
              reply_markup: createWalletKeyboard(),
            })
        : undefined,
    });

  } catch (error) {
    await handleCommandError(ctx, error, "balance");
  }
}
