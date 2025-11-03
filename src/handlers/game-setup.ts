import type { Context } from "grammy";
import type { WalletManager } from "../utils/wallet";
import type { TokenManager } from "../utils/token-manager";
import { DEFAULT_TOKEN_MINT, DEFAULT_TOKEN_TICKER } from "../utils/constants";
import { formatTokenDisplay, formatUsdValue } from "../utils/format-amount";
import type { GameTokenOverride } from "./game";
import type { GameSetupSessionState } from "../utils/user-state";

const NUMERIC_TOKEN_CANDIDATE = /^[0-9]+(?:\.[0-9]+)?$/;

export type GameSetupCopy = {
  gameType: "coinflip" | "giveaway";
  heading: string;
  amountPrompt: string;
  suggestionLabel?: string;
  lowBalanceCopy?: {
    object: string;
  };
  logPrefix: string;
};

export const GAME_SETUP_COPY: Record<"coinflip" | "giveaway", GameSetupCopy> = {
  coinflip: {
    gameType: "coinflip",
    heading: "🪙 <b>Create Coinflip</b>",
    amountPrompt: "Select stake per player:",
    lowBalanceCopy: {
      object: "stake per player",
    },
    logPrefix: "🪙",
  },
  giveaway: {
    gameType: "giveaway",
    heading: "🎁 <b>Create Giveaway</b>",
    amountPrompt: "Select prize amount:",
    lowBalanceCopy: {
      object: "prize amount",
    },
    logPrefix: "🎁",
  },
};

type GameSetupSession = GameSetupSessionState;

type TokenContext = {
  tokenMint: string;
  tokenTicker: string;
  tokenDecimals: number;
  contractMinimum?: number;
};

type ChatTokenInfo = {
  tokenMint: string;
  tokenTicker: string;
  decimals: number;
};

type CreateAmountSelectionKeyboard = typeof import("../utils/keyboards").createAmountSelectionKeyboard;
type GetSuggestedStakeAmounts = typeof import("../utils/keyboards").getSuggestedStakeAmounts;
type SafeAnswerCallbackQuery = typeof import("../utils/context-helpers").safeAnswerCallbackQuery;
type GetTelegramId = typeof import("../utils/context-helpers").getTelegramId;

type UpsertGameSetupSession = typeof import("../utils/user-state").upsertGameSetupSession;
type GetGameSetupSession = typeof import("../utils/user-state").getGameSetupSession;
type ClearGameSetupSession = typeof import("../utils/user-state").clearGameSetupSession;

type DefaultTokenMetadata = Awaited<ReturnType<WalletManager["getTokenMetadata"]>>;

type GetContractMinimumAmount = (
  tokenMint: string,
  decimalsHint?: number
) => Promise<{ formatted: number; raw: number; decimals: number }>;

type FetchTokenPriceUSD = (input: {
  tokenMint: string;
  tokenTicker: string;
}) => Promise<number | null>;

type GetDefaultTokenMetadata = () => Promise<DefaultTokenMetadata>;

type CreatorCallbackHandler = (
  ctx: Context,
  creatorCtx: CreatorCallbackContext
) => Promise<void> | void;

type CreatorResolver = (ctx: Context) => string | undefined;

type GameSetupModuleDeps = {
  wallet: WalletManager;
  getTokenManager: () => TokenManager | undefined;
  getDefaultTokenMetadata: GetDefaultTokenMetadata;
  getContractMinimumAmount: GetContractMinimumAmount;
  fetchTokenPriceUSD: FetchTokenPriceUSD;
  createAmountSelectionKeyboard: CreateAmountSelectionKeyboard;
  getSuggestedStakeAmounts: GetSuggestedStakeAmounts;
  getGameSetupSession: GetGameSetupSession;
  upsertGameSetupSession: UpsertGameSetupSession;
  clearGameSetupSession: ClearGameSetupSession;
  safeAnswerCallbackQuery: SafeAnswerCallbackQuery;
  getTelegramId: GetTelegramId;
  getTelegramIdString: (ctx: Context) => string | undefined;
};

export type CreatorCallbackOptions = {
  name: string;
  resolveCreatorId: CreatorResolver;
  failureText?: string;
};

export type CreatorCallbackContext = {
  creatorId: string;
  userId: number;
  session?: GameSetupSession;
  tokenContext: TokenContext;
  updateSession: (updates: Partial<GameSetupSession>) => GameSetupSession;
  clearSession: () => void;
};

export type GameSetupModule = {
  startInteractiveGameSetup: (
    ctx: Context & { message?: any },
    telegramId: bigint,
    copy: GameSetupCopy,
    tokenOverride?: GameTokenOverride
  ) => Promise<void>;
  resolveCommandTokenOverride: (
    tokenInput: string
  ) => Promise<GameTokenOverride | null>;
  buildTokenContext: (
    session: GameSetupSession | undefined,
    chatId?: number
  ) => Promise<TokenContext>;
  withCreatorContext: (
    options: CreatorCallbackOptions,
    handler: CreatorCallbackHandler
  ) => (ctx: Context) => Promise<void>;
  __test_startInteractiveGameSetup: (
    ctx: Context & { message?: any },
    telegramId: bigint,
    copy: GameSetupCopy,
    tokenOverride?: GameTokenOverride
  ) => Promise<void>;
};

export const createGameSetupModule = (
  deps: GameSetupModuleDeps
): GameSetupModule => {
  const getDefaultTokenMetadata = deps.getDefaultTokenMetadata;

  const resolveChatTokenInfo = async (
    chatId?: number
  ): Promise<ChatTokenInfo> => {
    const manager = deps.getTokenManager();
    if (!manager) {
      const fallbackMetadata = await getDefaultTokenMetadata();
      return {
        tokenMint: DEFAULT_TOKEN_MINT,
        tokenTicker: DEFAULT_TOKEN_TICKER,
        decimals: fallbackMetadata.decimals,
      };
    }

    try {
      return await manager.resolveTokenForChat(chatId);
    } catch (error) {
      console.warn(
        "⚠️ Could not resolve chat token configuration, using default token",
        error
      );
      const fallbackMetadata = await getDefaultTokenMetadata();
      return {
        tokenMint: DEFAULT_TOKEN_MINT,
        tokenTicker: DEFAULT_TOKEN_TICKER,
        decimals: fallbackMetadata.decimals,
      };
    }
  };

  const startInteractiveGameSetup = async (
    ctx: Context & { message?: any },
    telegramId: bigint,
    copy: GameSetupCopy,
    tokenOverride?: GameTokenOverride
  ): Promise<void> => {
    console.log(`${copy.logPrefix} UI-based ${copy.gameType} creation`);

    const tokenInfo = tokenOverride
      ? {
          tokenMint: tokenOverride.tokenMint,
          tokenTicker: tokenOverride.tokenTicker,
          decimals: tokenOverride.tokenDecimals,
        }
      : await resolveChatTokenInfo(ctx.chat?.id);

    let userBalance = 0;

    try {
      const tokenBalance = await deps.wallet.getTokenBalance(
        telegramId,
        tokenInfo.tokenMint
      );
      userBalance = tokenBalance / Math.pow(10, tokenInfo.decimals);
    } catch (error) {
      console.error("Error getting token balance:", error);
    }

    const { formatted: contractMin } = await deps.getContractMinimumAmount(
      tokenInfo.tokenMint,
      tokenInfo.decimals
    );

    const tokenPriceUSD = await deps.fetchTokenPriceUSD({
      tokenMint: tokenInfo.tokenMint,
      tokenTicker: tokenInfo.tokenTicker,
    });

    const suggestedAmounts = deps.getSuggestedStakeAmounts(
      contractMin,
      userBalance
    );

    let message = `${copy.heading}\n\n`;
    message += `Token: <b>${tokenInfo.tokenTicker}</b>\n`;
    message += "\n";

    if (copy.lowBalanceCopy && userBalance < contractMin) {
      const { object } = copy.lowBalanceCopy;
      const minDisplay = formatTokenDisplay(contractMin, {
        decimals: tokenInfo.decimals,
      });
      message += `⚠️ Minimum ${object}: ${minDisplay} ${tokenInfo.tokenTicker}.\n\n`;
    }

    message += copy.amountPrompt;

    if (copy.suggestionLabel && suggestedAmounts.length > 0) {
      message += `\n\n${copy.suggestionLabel}:\n`;
      for (const amount of suggestedAmounts) {
        const amountDisplay = formatTokenDisplay(amount, {
          decimals: tokenInfo.decimals,
        });
        message += `• ${amountDisplay} ${tokenInfo.tokenTicker}`;
        if (tokenPriceUSD) {
          const usdFormatted = formatUsdValue(amount * tokenPriceUSD, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
            fallback: "0.0",
          });
          message += ` ($${usdFormatted})`;
        }
        message += "\n";
      }
    }

    const setupMessage = await ctx.reply(message, {
      parse_mode: "HTML",
      reply_markup: deps.createAmountSelectionKeyboard(
        copy.gameType,
        userBalance,
        deps.getTelegramIdString(ctx),
        contractMin,
        {
          decimals: tokenInfo.decimals,
          tokenPriceUSD: tokenPriceUSD ?? undefined,
        }
      ),
      reply_to_message_id: ctx.message?.message_id,
    });

    deps.upsertGameSetupSession(`${ctx.chat?.id || 0}_${setupMessage.message_id}`, {
      waitingFor: "setup",
      gameType: copy.gameType,
      userBalance,
      messageId: setupMessage.message_id,
      chatId: ctx.chat?.id || 0,
      creatorId: deps.getTelegramIdString(ctx),
      tokenMint: tokenInfo.tokenMint,
      tokenTicker: tokenInfo.tokenTicker,
      tokenDecimals: tokenInfo.decimals,
      contractMinimum: contractMin,
    });
  };

  const resolveCommandTokenOverride = async (
    tokenInput: string
  ): Promise<GameTokenOverride | null> => {
    const manager = deps.getTokenManager();
    if (!manager) {
      return null;
    }

    const candidate = tokenInput.trim();
    if (!candidate) {
      return null;
    }

    if (NUMERIC_TOKEN_CANDIDATE.test(candidate)) {
      return null;
    }

    try {
      const resolved = await manager.resolveSwapToken(candidate);
      if (!resolved) {
        return null;
      }

      const decimals = resolved.decimals;
      if (!Number.isFinite(decimals) || decimals < 0) {
        console.warn(
          `⚠️ ResolveSwapToken returned invalid decimals for override ${candidate}`
        );
        return null;
      }

      const tokenTicker = resolved.isNativeSol ? "SOL" : resolved.token_ticker;

      return {
        tokenMint: resolved.token_mint,
        tokenTicker,
        tokenDecimals: decimals,
      };
    } catch (error) {
      console.warn(`⚠️ Could not resolve token override ${candidate}`, error);
      return null;
    }
  };

  const buildTokenContext = async (
    session: GameSetupSession | undefined,
    chatId?: number
  ): Promise<TokenContext> => {
    if (session?.tokenMint) {
      const decimals =
        typeof session.tokenDecimals === "number"
          ? session.tokenDecimals
          : (await getDefaultTokenMetadata()).decimals;
      return {
        tokenMint: session.tokenMint,
        tokenTicker: session.tokenTicker ?? DEFAULT_TOKEN_TICKER,
        tokenDecimals: decimals,
        contractMinimum: session.contractMinimum,
      };
    }

    const resolved = await resolveChatTokenInfo(chatId);
    return {
      tokenMint: resolved.tokenMint,
      tokenTicker: resolved.tokenTicker,
      tokenDecimals: resolved.decimals,
    };
  };

  const ensureCreator = (
    ctx: Context,
    creatorId: string,
    failureText = "🚫 Only the game creator can modify this setup!"
  ): boolean => {
    const currentUserId = deps.getTelegramIdString(ctx);

    if (currentUserId !== creatorId) {
      void deps.safeAnswerCallbackQuery(ctx, failureText);
      return false;
    }

    return true;
  };

  const withCreatorContext = (
    options: CreatorCallbackOptions,
    handler: CreatorCallbackHandler
  ) => {
    return async (ctx: Context) => {
      const creatorId = options.resolveCreatorId(ctx);
      const currentUserId = deps.getTelegramIdString(ctx);

      console.log(`🔔 ${options.name} callback triggered:`, ctx.callbackQuery?.data);
      console.log(
        `👤 Creator: ${creatorId ?? "unknown"}, Current user: ${currentUserId ?? "unknown"}`
      );

      if (!creatorId) {
        console.warn(`${options.name}: unable to resolve creator id from callback`);
        await deps.safeAnswerCallbackQuery(ctx, "❌ Unable to process action");
        return;
      }

      if (!ensureCreator(ctx, creatorId, options.failureText)) {
        return;
      }

      const userIdBigInt = deps.getTelegramId(ctx);
      if (userIdBigInt === 0n) {
        await deps.safeAnswerCallbackQuery(ctx, "❌ Unable to identify user");
        return;
      }

      const userId = Number(userIdBigInt);
      const sessionKey = `${ctx.chat?.id ?? 0}_${ctx.callbackQuery?.message?.message_id ?? 0}`;

      let session = deps.getGameSetupSession(sessionKey);
      const tokenContext = await buildTokenContext(session, ctx.chat?.id);

      const creatorContext: CreatorCallbackContext = {
        creatorId,
        userId,
        session,
        tokenContext,
        updateSession: (updates, keyOverride?: string) => {
          const keyToUse = keyOverride ?? sessionKey;
          const contractMinimum =
            updates.contractMinimum ??
            session?.contractMinimum ??
            tokenContext.contractMinimum;

          const next = deps.upsertGameSetupSession(keyToUse, {
            ...updates,
            creatorId,
            tokenMint: tokenContext.tokenMint,
            tokenTicker: tokenContext.tokenTicker,
            tokenDecimals: tokenContext.tokenDecimals,
            contractMinimum,
          });

          session = next;
          creatorContext.session = next;
          return next;
        },
        clearSession: () => {
          deps.clearGameSetupSession(sessionKey);
          session = undefined;
          creatorContext.session = undefined;
        },
      };

      await handler(ctx, creatorContext);
    };
  };

  return {
    startInteractiveGameSetup,
    resolveCommandTokenOverride,
    buildTokenContext,
    withCreatorContext,
    __test_startInteractiveGameSetup: startInteractiveGameSetup,
  };
};
