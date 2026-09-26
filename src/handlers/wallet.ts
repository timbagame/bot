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
  answerCallbackWithGrace,
} from "../utils/context-helpers";
import { RateLimitExceededError } from "../utils/rate-limiter";
import {
  isBotInitiationForbidden,
  isMessageNotModified,
  isMissingEditableContent,
  isRateLimited,
} from "../utils/telegram-errors";

type WalletPageView = {
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
  fetchedAt?: number;
};

const WALLET_PAGE_SIZE = 8;
/** Cached balances younger than this are shown without a background refresh. */
export const WALLET_BACKGROUND_REFRESH_MIN_AGE_MS = 5_000;
/** A refresh re-renders unchanged balances once the shown age reaches this. */
export const WALLET_STALE_LABEL_REFRESH_MS = 30_000;

const walletBalancesFingerprint = (data: WalletPageView): string =>
  JSON.stringify([
    data.solBalance,
    data.page,
    data.pageCount,
    data.tokenBalances.map((token) => [token.mint, token.rawBalance ?? token.balance]),
  ]);

type WalletMessageTarget = { chatId: number; messageId: number; preferCaption: boolean };

const messageHasCaption = (message: any): boolean =>
  Boolean(
    message?.photo ||
    message?.video ||
    message?.animation ||
    message?.document ||
    message?.caption !== undefined,
  );

/** Works out which message the wallet was just rendered into. */
const resolveWalletMessageTarget = (ctx: any, sent: any): WalletMessageTarget | null => {
  const result = sent?.result;
  if (result && typeof result.messageId === "number" && typeof result.chatId === "number") {
    const callbackMessage = ctx?.callbackQuery?.message;
    const editedCallbackMessage =
      !result.respondedWithReply && callbackMessage?.message_id === result.messageId;
    return {
      chatId: result.chatId,
      messageId: result.messageId,
      preferCaption: editedCallbackMessage && messageHasCaption(callbackMessage),
    };
  }
  if (result && typeof result.message_id === "number" && typeof result.chat?.id === "number") {
    return {
      chatId: result.chat.id,
      messageId: result.message_id,
      preferCaption: Boolean(sent?.usedVideo) || messageHasCaption(result),
    };
  }
  const callbackMessage = ctx?.callbackQuery?.message;
  if (
    callbackMessage &&
    typeof callbackMessage.message_id === "number" &&
    typeof callbackMessage.chat?.id === "number"
  ) {
    return {
      chatId: callbackMessage.chat.id,
      messageId: callbackMessage.message_id,
      preferCaption: Boolean(sent?.usedVideo) || messageHasCaption(callbackMessage),
    };
  }
  return null;
};

/**
 * Edits the wallet message in place. Never replies: a background refresh must
 * not add messages. "Not modified" and rate limits are expected and ignored.
 */
const editWalletMessage = async (
  ctx: any,
  target: WalletMessageTarget,
  caption: string,
  keyboard: InlineKeyboard,
): Promise<void> => {
  const editCaption = () =>
    ctx.api.editMessageCaption(target.chatId, target.messageId, {
      caption,
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  const editText = () =>
    ctx.api.editMessageText(target.chatId, target.messageId, caption, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  const attempts = target.preferCaption ? [editCaption, editText] : [editText, editCaption];

  for (const attempt of attempts) {
    try {
      await attempt();
      return;
    } catch (error) {
      if (isMessageNotModified(error) || isRateLimited(error)) {
        return;
      }
      if (!isMissingEditableContent(error)) {
        console.warn("Background wallet refresh could not edit the wallet message:", error);
        return;
      }
    }
  }
};

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
  ) => Promise<WalletPageView>;
  /** Last fetched page, shown immediately while a fresh fetch runs in the background. */
  peekWalletPageData?: (
    telegramId: bigint,
    page: number,
    pageSize: number,
  ) => { data: WalletPageView; fetchedAt: number } | undefined;
  /**
   * Returns a check that stays true until another button press lands on the
   * message, so background edits never overwrite a menu the user moved to.
   */
  captureMessageView?: (chatId: number | string, messageId: number) => () => boolean;
  now?: () => number;
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

  const keypair = await wallet.getKeyPair(telegramId);
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

  const now = deps.now ?? Date.now;
  const pageSize = WALLET_PAGE_SIZE;

  const renderWalletCaption = async (pageData: WalletPageView, updatedAt: number) => {
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

    pagination = { page: pageData.page, pageCount: pageData.pageCount };
    return buildWalletCaption(walletAddress, tokenLines, {
      page: 0,
      pageSize: pageSize + 1,
      updatedAt,
      now: now(),
    });
  };

  const fetchWalletPage = async (): Promise<WalletPageView> =>
    getWalletPageData
      ? await getWalletPageData(telegramId, requestedPage, pageSize)
      : await getCachedWalletData(telegramId).then((balances) => ({
          ...balances,
          page: 0,
          pageCount: Math.max(1, Math.ceil(balances.tokenBalances.length / pageSize)),
        }));

  // Stale-while-revalidate: show the last fetched page at once, then refresh it
  // in the background. Refresh and /balance clear this cache, so they always
  // fetch fresh balances.
  const cached = getWalletPageData
    ? deps.peekWalletPageData?.(telegramId, requestedPage, pageSize)
    : undefined;

  try {
    if (cached) {
      const cachedCaption = await renderWalletCaption(cached.data, cached.fetchedAt);
      const sent = await sendWalletContent(cachedCaption);
      if (!sent || (ctx as any).__walletDmForbidden) {
        return;
      }

      if (now() - cached.fetchedAt >= WALLET_BACKGROUND_REFRESH_MIN_AGE_MS) {
        const target = resolveWalletMessageTarget(ctx, sent);
        const isStillCurrent = target
          ? (deps.captureMessageView?.(target.chatId, target.messageId) ?? (() => true))
          : () => false;
        const shownAgeMs = now() - cached.fetchedAt;

        (ctx as any).__walletBackgroundRefresh = (async () => {
          try {
            const fresh = await fetchWalletPage();
            const changed =
              walletBalancesFingerprint(fresh) !== walletBalancesFingerprint(cached.data);
            if (!target || (!changed && shownAgeMs < WALLET_STALE_LABEL_REFRESH_MS)) {
              return;
            }
            const freshCaption = await renderWalletCaption(fresh, fresh.fetchedAt ?? now());
            if (!isStillCurrent()) {
              return;
            }
            await editWalletMessage(ctx, target, freshCaption, getWalletKeyboard());
          } catch (error) {
            if (!(error instanceof RateLimitExceededError)) {
              console.warn(`Background wallet refresh failed for ${telegramId.toString()}:`, error);
            }
          }
        })();
      }
      return;
    }

    const pageData = await fetchWalletPage();
    const caption = await renderWalletCaption(pageData, pageData.fetchedAt ?? now());

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
  clearWalletCache: (telegramId: bigint | string | number) => void | Promise<void>;
  createSettingsKeyboard: () => InlineKeyboard;
};

// Loading the wallet waits on RPC balances, token metadata and prices. Telegram
// keeps the button spinner until the callback is answered, so answer silently if
// the work is still running after a short grace period. Fast results and errors
// still answer normally, so error toasts keep working in the common case; late
// errors are posted as a reply instead of a dropped toast.
async function runWithEarlyCallbackAnswer(
  ctx: any,
  work: () => Promise<void>,
  errorLabel: string,
  errorText: string,
): Promise<void> {
  await answerCallbackWithGrace(
    ctx,
    async () => {
      try {
        await work();
      } catch (error) {
        console.error(errorLabel, error);
        await safeAnswerCallbackQuery(ctx, errorText);
      }
    },
    {
      onLateAnswer: async (text) => {
        try {
          await ctx.reply(text);
        } catch {
          // Nothing else to surface the error on.
        }
      },
    },
  );
}

export async function onMainWallet(ctx: any, deps: WalletHandlersDeps) {
  await runWithEarlyCallbackAnswer(
    ctx,
    () => deps.showWalletUI(ctx),
    "❌ Error in main_wallet:",
    "❌ Error loading wallet menu",
  );
}

export async function onWalletRefresh(ctx: any, deps: WalletHandlersDeps) {
  await runWithEarlyCallbackAnswer(
    ctx,
    async () => {
      const id = getTelegramId(ctx);
      await deps.clearWalletCache(id);
      await deps.showWalletUI(ctx);
    },
    "Error in wallet_refresh:",
    "❌ Error refreshing wallet",
  );
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
  clearWalletCache: (telegramId: bigint) => void | Promise<void>;
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
        await clearWalletCache(telegramId);
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
      await clearWalletCache(telegramId);
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
