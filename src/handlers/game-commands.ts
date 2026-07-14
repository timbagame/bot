import type { Context } from "grammy";
import { formatParseAmountError } from "../utils/token-manager";
import {
  DEFAULT_COINFLIP_MAX_PLAYERS,
  DEFAULT_GAME_TIMEOUT,
  DEFAULT_GIVEAWAY_MAX_PLAYERS,
  GAME_CREATION_RATE_LIMIT_WINDOW_MS,
  WSOL_MINT,
} from "../utils/constants";
import { resolveChatDefaultPlayers, resolveChatTimeout } from "../utils/chat-settings";
import { resolveGamePrivacy } from "../utils/game-settings";
import type { GameManager } from "../utils/game";
import type { ChatGameSettings, ParseAmountResult } from "../types";
import type { CoinflipDeps, GameTokenOverride } from "./game";
import type { GameSetupCopy } from "./game-setup";
import { containsBalanceInfo } from "../utils/context-helpers";

export type CreateGameViaCommandOptions = {
  gameType: "coinflip" | "giveaway";
  usageMessage: string;
  defaultMaxPlayers: number;
  minPlayers: number;
  getMaxPlayers: () => number;
  timeoutSeconds: number;
  gameLabel: string;
  inferErrorLabel: string;
  logPrefix: string;
  errorMessage: string;
};

type CreateGameViaCommandDeps = {
  parseAmount: (
    args: string[],
    amountArgIndex: number,
    chatId?: number,
  ) => Promise<ParseAmountResult>;
  inferMaxPlayers: typeof import("../utils/arg-parsing").inferMaxPlayers;
  wallet: {
    getTokenBalance: (
      telegramId: bigint,
      mint: string,
      options?: { createIfMissing?: boolean },
    ) => Promise<number>;
    getTokenMetadata: (mint: string) => Promise<{ decimals: number }>;
    formatTokenBalance: (amount: number, decimals: number) => string;
    getBalance: (telegramId: bigint) => Promise<number>;
    formatSolBalance: (lamports: number) => string;
  };
  getContractMinimumAmount: (
    tokenMint?: string,
    decimalsHint?: number,
  ) => Promise<{ formatted: number; raw: number; decimals: number }>;
  gameManager: {
    createGame: (
      ...args: Parameters<GameManager["createGame"]>
    ) => ReturnType<GameManager["createGame"]>;
    createGameMessage: (
      ...args: Parameters<GameManager["createGameMessage"]>
    ) => ReturnType<GameManager["createGameMessage"]>;
  };
};

export type GameCommandsModuleDeps = {
  parseAmount: CreateGameViaCommandDeps["parseAmount"];
  inferMaxPlayers: CreateGameViaCommandDeps["inferMaxPlayers"];
  wallet: CreateGameViaCommandDeps["wallet"];
  getContractMinimumAmount: CreateGameViaCommandDeps["getContractMinimumAmount"];
  gameManager: CreateGameViaCommandDeps["gameManager"];
  getOracleMaxPlayers: () => number;
  isGroupChat: (ctx: Context) => boolean;
  startInteractiveGameSetup: (
    ctx: Context & { message?: any },
    telegramId: bigint,
    copy: GameSetupCopy,
    tokenOverride?: GameTokenOverride,
  ) => Promise<void>;
  resolveCommandTokenOverride: (
    tokenInput: string,
    chatId?: number,
  ) => Promise<GameTokenOverride | null>;
  getRequiredTelegramIdForContext: (ctx: Context, label: string) => Promise<bigint | null>;
  gameSetupCopy: Record<"coinflip" | "giveaway", GameSetupCopy>;
  getChatGameSettings?: (chatId: number) => ChatGameSettings | null;
};

export const createGameCommandsModule = (deps: GameCommandsModuleDeps) => {
  const createOptions = (
    options: Omit<CreateGameViaCommandOptions, "getMaxPlayers">,
  ): CreateGameViaCommandOptions => ({
    ...options,
    getMaxPlayers: () => deps.getOracleMaxPlayers(),
  });

  const gameCreationRateLimitNotices = new Map<string, number>();

  const shouldSendGameCreationRateLimitNotice = (
    telegramId: bigint,
    nowMs: number = Date.now(),
  ): boolean => {
    const key = telegramId.toString();
    const lastNotice = gameCreationRateLimitNotices.get(key);

    if (lastNotice != null && nowMs - lastNotice < GAME_CREATION_RATE_LIMIT_WINDOW_MS) {
      return false;
    }

    gameCreationRateLimitNotices.set(key, nowMs);
    return true;
  };

  const COINFLIP_COMMAND_OPTIONS = createOptions({
    gameType: "coinflip",
    usageMessage:
      "❌ Please provide a valid amount greater than 0.\n\nUsage: <code>/cf &lt;amount&gt; [TOKEN]</code>, <code>/cf &lt;amount&gt; USD</code>, or <code>/cf $&lt;usd&gt; [TOKEN]</code>",
    defaultMaxPlayers: DEFAULT_COINFLIP_MAX_PLAYERS,
    minPlayers: 2,
    timeoutSeconds: DEFAULT_GAME_TIMEOUT,
    gameLabel: "Coinflip",
    inferErrorLabel: "Coinflip",
    logPrefix: "🪙",
    errorMessage: "❌ Error creating coinflip game. Please try again.",
  });

  const GIVEAWAY_COMMAND_OPTIONS = createOptions({
    gameType: "giveaway",
    usageMessage:
      "❌ Please provide a valid amount greater than 0.\n\nUsage: <code>/ga &lt;amount&gt; [TOKEN]</code>, <code>/ga &lt;amount&gt; USD</code>, or <code>/ga $&lt;usd&gt; [TOKEN]</code>",
    defaultMaxPlayers: DEFAULT_GIVEAWAY_MAX_PLAYERS,
    minPlayers: 1,
    timeoutSeconds: DEFAULT_GAME_TIMEOUT,
    gameLabel: "Giveaway",
    inferErrorLabel: "Giveaway",
    logPrefix: "🎁",
    errorMessage: "❌ Error creating giveaway game. Please try again.",
  });

  const createGameViaCommand = async (
    ctx: Context & { message?: any },
    args: string[],
    telegramId: bigint,
    options: CreateGameViaCommandOptions,
    createDeps: CreateGameViaCommandDeps = {
      parseAmount: deps.parseAmount,
      inferMaxPlayers: deps.inferMaxPlayers,
      wallet: deps.wallet,
      getContractMinimumAmount: deps.getContractMinimumAmount,
      gameManager: deps.gameManager,
    },
  ): Promise<void> => {
    console.log(`${options.logPrefix} Command-based ${options.gameType} creation:`, args);

    let creationMessageInfo: { chatId: number; messageId: number } | null = null;

    const deleteCreationMessage = async () => {
      if (!creationMessageInfo || !ctx.api?.deleteMessage) {
        return;
      }

      try {
        await ctx.api.deleteMessage(creationMessageInfo.chatId, creationMessageInfo.messageId);
      } catch (deleteError) {
        console.warn("Failed to delete game creation acknowledgement:", deleteError);
      }
    };

    try {
      const creationMessage = await ctx.reply("⏳ Creating game...");
      if (creationMessage?.chat?.id != null && creationMessage?.message_id != null) {
        creationMessageInfo = {
          chatId: creationMessage.chat.id,
          messageId: creationMessage.message_id,
        };
      }

      const parsed = await createDeps.parseAmount(args, 1, ctx.chat?.id);
      if (!parsed.success) {
        await ctx.reply(formatParseAmountError(parsed, options.usageMessage), {
          parse_mode: "HTML",
        });
        return;
      }

      const parsedAmount = parsed.data;
      const chatSettings = ctx.chat?.id ? (deps.getChatGameSettings?.(ctx.chat.id) ?? null) : null;
      const maxPlayersLimit = Math.max(options.minPlayers, options.getMaxPlayers());
      const defaultMaxPlayers = chatSettings
        ? resolveChatDefaultPlayers(
            chatSettings,
            options.gameType,
            options.defaultMaxPlayers,
            maxPlayersLimit,
          )
        : Math.min(options.defaultMaxPlayers, maxPlayersLimit);
      const inferred = createDeps.inferMaxPlayers(
        args,
        1,
        parsedAmount.tokenWasSpecified,
        defaultMaxPlayers,
        options.minPlayers,
        maxPlayersLimit,
      );

      if (!inferred.ok) {
        await ctx.reply(`❌ ${options.inferErrorLabel} ${inferred.error}`);
        return;
      }

      const maxPlayers = inferred.value;
      const tokenMetadata = await createDeps.wallet.getTokenMetadata(parsedAmount.tokenMint);
      const { raw: minAmountRaw } = await createDeps.getContractMinimumAmount(
        parsedAmount.tokenMint,
        tokenMetadata.decimals,
      );

      if (parsedAmount.amount < minAmountRaw) {
        const formattedMinimum = createDeps.wallet.formatTokenBalance(
          minAmountRaw,
          tokenMetadata.decimals,
        );
        await ctx.reply(
          `❌ Amount below contract minimum of ${formattedMinimum} ${parsedAmount.tokenTicker}.`,
        );
        return;
      }

      const needsNativeSolCheck =
        parsedAmount.requestedNativeSol === true || parsedAmount.tokenMint === WSOL_MINT;
      let nativeSolBalance = 0;
      let userBalance: number;

      if (needsNativeSolCheck) {
        const [tokenBalance, solBalance] = await Promise.all([
          createDeps.wallet.getTokenBalance(telegramId, parsedAmount.tokenMint),
          createDeps.wallet.getBalance(telegramId),
        ]);
        userBalance = tokenBalance;
        nativeSolBalance = solBalance;
      } else {
        userBalance = await createDeps.wallet.getTokenBalance(telegramId, parsedAmount.tokenMint);
      }

      if (!needsNativeSolCheck && userBalance < parsedAmount.amount) {
        const shortageMessage = `❌ Not enough ${parsedAmount.tokenTicker}. Add more ${parsedAmount.tokenTicker} or try a smaller amount.`;
        await ctx.reply(shortageMessage, { parse_mode: "HTML" });
        return;
      }

      if (needsNativeSolCheck) {
        const totalLamports = userBalance + nativeSolBalance;
        if (totalLamports < parsedAmount.amount) {
          const wrappedLabel =
            parsedAmount.tokenMint === WSOL_MINT ? "wrapped SOL" : parsedAmount.tokenTicker;
          const shortageMessage = `❌ Not enough SOL or ${wrappedLabel}. Add more SOL or ${wrappedLabel} and try again.`;
          await ctx.reply(shortageMessage, { parse_mode: "HTML" });
          return;
        }
      }

      const tokenTickerForGame =
        parsedAmount.tokenMint === WSOL_MINT ? "WSOL" : parsedAmount.tokenTicker;

      const messageTimestampMs = ctx.message?.date != null ? ctx.message.date * 1_000 : undefined;

      const gameTimeoutSeconds = resolveChatTimeout(
        chatSettings as ChatGameSettings | null,
        options.timeoutSeconds,
      );

      // Force public visibility for DM-created games
      const isFromDM = ctx.chat?.type === "private";
      const isPrivate = isFromDM ? false : resolveGamePrivacy(options.gameType, chatSettings);

      const gameResult = await createDeps.gameManager.createGame(
        options.gameType,
        {
          amount: parsedAmount.amount,
          tokenMint: parsedAmount.tokenMint,
          tokenTicker: tokenTickerForGame,
          isSol: parsedAmount.isSol,
          requestedNativeSol: parsedAmount.requestedNativeSol,
          priceLookup: parsedAmount.priceLookup,
        },
        maxPlayers,
        options.minPlayers,
        gameTimeoutSeconds,
        telegramId,
        { isPrivate },
        ctx.chat?.id || 0,
        messageTimestampMs,
      );

      if (!gameResult.success) {
        const finalError = gameResult.error ?? "Failed to create game";
        const isCreationRateLimit = /game creation rate limit/i.test(finalError);

        if (isCreationRateLimit && !shouldSendGameCreationRateLimitNotice(telegramId)) {
          return;
        }

        const hasBalanceInfo = containsBalanceInfo(finalError);
        const displayText = hasBalanceInfo
          ? "❌ Failed to create game: insufficient funds. Please add more funds and try again."
          : `❌ ${finalError}`;
        await ctx.reply(displayText, { parse_mode: "HTML" });
        return;
      }

      if (gameResult.autoJoinResult && !gameResult.autoJoinResult.success) {
        await ctx.reply(gameResult.autoJoinResult.error || "Failed to auto-join game", {
          parse_mode: "HTML",
        });
      }

      const creatorUsername = ctx.from?.username
        ? `@${ctx.from.username}`
        : ctx.from?.first_name || "Unknown";

      await createDeps.gameManager.createGameMessage(
        ctx,
        gameResult.gameAddress!,
        options.gameLabel,
        parsedAmount.amount,
        creatorUsername,
        tokenTickerForGame,
        "Active",
        undefined,
        { priceHint: parsedAmount.priceLookup },
      );
    } catch (error) {
      console.error(`Error in command-based ${options.gameType}:`, error);
      await ctx.reply(options.errorMessage);
    } finally {
      await deleteCreationMessage();
    }
  };

  const createCoinflipDeps = (): CoinflipDeps => ({
    isGroupChat: deps.isGroupChat,
    showInteractiveSetup: (ctxWithMessage, telegramId, tokenOverride) =>
      deps.startInteractiveGameSetup(
        ctxWithMessage,
        telegramId,
        deps.gameSetupCopy.coinflip,
        tokenOverride,
      ),
    createGameViaCommand: (ctxWithMessage, args, telegramId) =>
      createGameViaCommand(ctxWithMessage, args, telegramId, COINFLIP_COMMAND_OPTIONS),
    resolveTokenOverride: (tokenInput, chatId) =>
      deps.resolveCommandTokenOverride(tokenInput, chatId),
  });

  const handleGiveawayCommand = async (ctx: Context & { message?: any }) => {
    try {
      // DM games are allowed but will be forced to public visibility

      const telegramId = await deps.getRequiredTelegramIdForContext(ctx, "giveaway command");
      if (telegramId == null) {
        return;
      }

      const args = ctx.message?.text?.split(" ");
      const tokenCandidate = args?.[1]?.trim();

      if (!args || args.length < 2) {
        await deps.startInteractiveGameSetup(ctx, telegramId, deps.gameSetupCopy.giveaway);
        return;
      }

      let tokenOverride: GameTokenOverride | null = null;
      if (tokenCandidate) {
        tokenOverride = await deps.resolveCommandTokenOverride(tokenCandidate, ctx.chat?.id);
      }

      if (tokenOverride) {
        await deps.startInteractiveGameSetup(
          ctx,
          telegramId,
          deps.gameSetupCopy.giveaway,
          tokenOverride,
        );
        return;
      }

      await createGameViaCommand(ctx, args, telegramId, GIVEAWAY_COMMAND_OPTIONS);
    } catch (error) {
      console.error("Error in giveaway command:", error);
      await ctx.reply("❌ Error setting up giveaway game. Please try again.");
    }
  };

  return {
    COINFLIP_COMMAND_OPTIONS,
    GIVEAWAY_COMMAND_OPTIONS,
    createGameViaCommand,
    createCoinflipDeps,
    handleGiveawayCommand,
    __test_createGameViaCommand: createGameViaCommand,
  };
};
