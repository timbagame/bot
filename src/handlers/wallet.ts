import type { InlineKeyboard } from "grammy";
import { escapeHtml } from "../utils/format-amount";
import {
  buildWalletTokenLines,
  type TokenDisplayLine,
  type WalletCaptionOptions,
} from "../utils/wallet-ui";
import type { WalletPagination } from "../utils/keyboards";
import type { HoldMarkStore } from "../services/hold-marks";
import { sendMediaWithFallback } from "../utils/media";
import { respondWithMenu } from "../utils/menu-response";
import {
  getTelegramId,
  getRequiredTelegramIdForContext,
  safeAnswerCallbackQuery,
} from "../utils/context-helpers";
import { RateLimitExceededError } from "../utils/rate-limiter";
import { isBotInitiationForbidden } from "../utils/telegram-errors";

export type ShowWalletUIDeps = {
  wallet: {
    getKeyPair: (id: bigint) => any;
    formatSolBalance: (lamports: number) => string;
    formatTokenBalance?: (n: number, d: number) => string;
  };
  getCachedWalletData: (telegramId: bigint) => Promise<{
    solBalance: number;
    tokenBalances: Array<{
      mint: string;
      ticker: string;
      balance: number;
      decimals: number;
      decimalBalance?: number;
      rawBalance?: string;
    }>;
  }>;
  getWalletPageData?: (
    telegramId: bigint,
    page: number,
    pageSize: number,
  ) => Promise<{
    solBalance: number;
    tokenBalances: Array<{
      mint: string;
      ticker: string;
      balance: number;
      decimals: number;
      decimalBalance?: number;
      rawBalance?: string;
    }>;
    page: number;
    pageCount: number;
  }>;
  fetchPricesUSD?: (references: string[]) => Promise<Record<string, number>>;
  buildWalletCaption: (
    walletAddress: string,
    tokenLines: TokenDisplayLine[],
    options?: WalletCaptionOptions,
  ) => string;
  createWalletKeyboard: (pagination?: WalletPagination) => InlineKeyboard;
  WINNER_VIDEO_ID?: string | null;
  holdMarks?: HoldMarkStore;
};

export async function showWalletUI(ctx: any, deps: ShowWalletUIDeps) {
  const {
    wallet,
    getCachedWalletData,
    getWalletPageData,
    fetchPricesUSD,
    buildWalletCaption,
    createWalletKeyboard,
    WINNER_VIDEO_ID,
    holdMarks,
  } = deps;

  const telegramId = await getRequiredTelegramIdForContext(ctx, "wallet display", {
    onMissing: async (message) => {
      await respondWithMenu(ctx, {
        text: message,
        keyboard: createWalletKeyboard(),
      });
    },
  });

  if (telegramId == null) {
    return;
  }

  const keypair = wallet.getKeyPair(telegramId);
  const walletAddress = keypair.publicKey.toBase58();
  const walletVideoFileId = WINNER_VIDEO_ID ?? null;
  const requestedPageMatch = String(ctx?.callbackQuery?.data ?? "").match(/^wallet_page_(\d+)$/);
  const requestedPage = requestedPageMatch ? Number(requestedPageMatch[1]) : 0;
  let pagination: WalletPagination | undefined;
  const getWalletKeyboard = () => createWalletKeyboard(pagination);
  const callbackMessage = ctx?.callbackQuery?.message;
  const botId = ctx?.me?.id;
  const messageAuthorId = callbackMessage?.from?.id;
  const authoredByBot = Boolean(
    callbackMessage?.from?.is_bot ||
    (botId != null && messageAuthorId != null && String(messageAuthorId) === String(botId)),
  );
  const canEditBotMessage = Boolean(
    typeof ctx?.editMessageMedia === "function" && callbackMessage && authoredByBot,
  );

  const resolveOriginChatId = (): number | undefined => {
    if (ctx.chat && ctx.chat.type !== "private" && typeof ctx.chat.id === "number") {
      return ctx.chat.id;
    }
    const fromCtx = (ctx as any).__originChatId;
    if (typeof fromCtx === "number" && !Number.isNaN(fromCtx)) {
      return fromCtx;
    }
    return undefined;
  };

  const notifyDmRequired = async () => {
    const originChatId = resolveOriginChatId();
    if (originChatId === undefined) {
      return;
    }

    const botUsername = ctx?.me?.username;
    const botMention = botUsername ? `@${botUsername}` : "the bot";
    const startInstruction = botUsername
      ? `Tap <a href="https://t.me/${botUsername}">${botMention}</a> and press <b>Start</b>, then run /balance again.`
      : "Open a private chat with the bot, tap <b>Start</b>, then run /balance again.";

    const lines = [
      "❌ <b>I can’t DM you yet</b>",
      "",
      "Start a private chat with the bot so I can share your balances.",
      startInstruction,
    ];

    try {
      await ctx.api.sendMessage(originChatId, lines.join("\n"), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (notifyError) {
      console.warn("Failed to notify user about DM requirement:", notifyError);
    }
  };

  const sendWalletContent = async (caption: string) => {
    try {
      return await sendMediaWithFallback({
        videoFileId: walletVideoFileId,
        logLabel: "wallet media",
        sendText: async () => {
          return await respondWithMenu(ctx, {
            text: caption,
            keyboard: getWalletKeyboard(),
          });
        },
        sendVideo:
          walletVideoFileId && typeof ctx.replyWithVideo === "function"
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
                  { reply_markup: getWalletKeyboard() },
                )
            : undefined,
      });
    } catch (error) {
      if (isBotInitiationForbidden(error)) {
        (ctx as any).__walletDmForbidden = true;
        await notifyDmRequired();
        return null;
      }
      throw error;
    }
  };

  try {
    const pageSize = 8;
    const pageData = getWalletPageData
      ? await getWalletPageData(telegramId, requestedPage, pageSize)
      : await getCachedWalletData(telegramId).then((balances) => ({
          ...balances,
          page: 0,
          pageCount: Math.max(1, Math.ceil(balances.tokenBalances.length / pageSize)),
        }));
    const { solBalance, tokenBalances } = pageData;
    const tokenLines = await buildWalletTokenLines({
      solBalanceLamports: solBalance,
      tokenBalances,
      formatSolBalance: (value) => wallet.formatSolBalance(value),
      formatTokenBalance: wallet.formatTokenBalance
        ? (amount, decimals) => (wallet as any).formatTokenBalance(amount, decimals)
        : undefined,
      fetchPricesUSD,
      walletAddress: holdMarks ? walletAddress : undefined,
      holdMarks,
    });

    const pageCount = pageData.pageCount;
    const page = pageData.page;
    pagination = { page, pageCount };
    const caption = buildWalletCaption(walletAddress, tokenLines, {
      page: 0,
      pageSize: pageSize + 1,
    });

    await sendWalletContent(caption);
    if ((ctx as any).__walletDmForbidden) {
      return;
    }
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      const waitSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      console.warn(
        `Rate limit hit for wallet UI ${telegramId.toString()}: retry in ${waitSeconds}s`,
      );
      const response = [
        `💳 <b>Wallet</b>`,
        "",
        `<code>${escapeHtml(walletAddress)}</code>`,
        "",
        "⏳ <i>Too many refreshes</i>",
        `<i>Try again in ${waitSeconds}s.</i>`,
      ];
      await sendWalletContent(response.join("\n"));
      if ((ctx as any).__walletDmForbidden) {
        return;
      }
      return;
    }

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
    if ((ctx as any).__walletDmForbidden) {
      return;
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
    await safeAnswerCallbackQuery(ctx);
  } catch (error) {
    console.error("❌ Error in main_wallet:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error loading wallet menu");
  }
}

export async function onWalletRefresh(ctx: any, deps: WalletHandlersDeps) {
  try {
    const id = getTelegramId(ctx);
    deps.clearWalletCache(id);
    await deps.showWalletUI(ctx);
    await safeAnswerCallbackQuery(ctx);
  } catch (error) {
    console.error("Error in wallet_refresh:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error refreshing wallet");
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
    await safeAnswerCallbackQuery(ctx, "⚙️ Settings");
  } catch (error) {
    console.error("Error in wallet_settings:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error loading settings");
  }
}

// ================================
// BALANCE COMMAND HANDLER
// ================================

export type BalanceDeps = {
  isPrivateChat: (ctx: any) => boolean;
  clearWalletCache: (telegramId: bigint) => void;
  showWalletUI: (ctx: any) => Promise<void>;
  handleCommandError: (ctx: any, error: any, name: string) => Promise<void>;
};

export async function onBalance(ctx: any, deps: BalanceDeps) {
  const { isPrivateChat, clearWalletCache, showWalletUI, handleCommandError } = deps;

  const telegramId = await getRequiredTelegramIdForContext(ctx, "balance command");

  if (telegramId == null) {
    return;
  }

  if (isPrivateChat(ctx)) {
    try {
      try {
        clearWalletCache(telegramId);
      } catch {}
      await showWalletUI(ctx);
    } catch (error) {
      await handleCommandError(ctx, error, "balance");
    }
    return;
  }

  // If it's not a private chat, send the same wallet UI privately to the user
  try {
    try {
      clearWalletCache(telegramId);
    } catch {}

    const dmTargetBigInt = telegramId;
    if (dmTargetBigInt === 0n) {
      throw new Error("Unable to determine DM recipient");
    }

    const dmTarget = dmTargetBigInt.toString();

    const dmContext = {
      ...ctx,
      from: ctx.from,
      chat: { id: dmTarget, type: "private" } as any,
      message: undefined,
      callbackQuery: undefined,
      __originChatId: ctx.chat?.id,
      reply: (text: string, options: any = {}) =>
        ctx.api.sendMessage(dmTarget, text, {
          reply_to_message_id: undefined,
          link_preview_options: { is_disabled: true },
          ...options,
        }),
      replyWithVideo: (fileId: string, options: any = {}) =>
        ctx.api.sendVideo(dmTarget, fileId, {
          reply_to_message_id: undefined,
          ...options,
        }),
      editMessageMedia: undefined,
      editMessageCaption: undefined,
      editMessageText: undefined,
    } as typeof ctx;

    await showWalletUI(dmContext);
  } catch (error) {
    await handleCommandError(ctx, error, "balance");
  }
}
