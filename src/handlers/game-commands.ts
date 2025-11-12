import type { Context } from "grammy";
import { formatParseAmountError } from "../utils/token-manager";
import { WSOL_MINT } from "../utils/constants";
import type { GameManager } from "../utils/game";
import type { ParseAmountResult } from "../types";
import type { CoinflipDeps, GameTokenOverride } from "./game";
import type { GameSetupCopy } from "./game-setup";
import {
  sendPrivateMessage,
  containsBalanceInfo,
} from "../utils/context-helpers";

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
    chatId?: number
  ) => Promise<ParseAmountResult>;
  inferMaxPlayers: typeof import("../utils/arg-parsing").inferMaxPlayers;
  wallet: {
    getTokenBalance: (
      telegramId: bigint,
      mint: string,
      options?: { createIfMissing?: boolean }
    ) => Promise<number>;
    getTokenMetadata: (mint: string) => Promise<{ decimals: number }>;
    formatTokenBalance: (amount: number, decimals: number) => string;
    getBalance: (telegramId: bigint) => Promise<number>;
    formatSolBalance: (lamports: number) => string;
  };
  getContractMinimumAmount: (
    tokenMint?: string,
    decimalsHint?: number
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
    tokenOverride?: GameTokenOverride
  ) => Promise<void>;
  resolveCommandTokenOverride: (
    tokenInput: string,
    chatId?: number
  ) => Promise<GameTokenOverride | null>;
  getRequiredTelegramIdForContext: (
    ctx: Context,
    label: string
  ) => Promise<bigint | null>;
  gameSetupCopy: Record<"coinflip" | "giveaway", GameSetupCopy>;
};

const sendBalanceAwareReply = async (
  ctx: Context,
  telegramId: bigint,
  privateText: string,
  sanitizedText: string,
  fallbackText: string
): Promise<void> => {
  if (ctx.chat?.type === "private") {
    await ctx.reply(privateText);
    return;
  }

  if (telegramId === 0n) {
    await ctx.reply(fallbackText);
    return;
  }

  const dmSent = await sendPrivateMessage(ctx, telegramId, {
    text: privateText,
    parseMode: "HTML",
  });

  const textToShow = dmSent ? sanitizedText : fallbackText;
  await ctx.reply(textToShow);
};

export const createGameCommandsModule = (deps: GameCommandsModuleDeps) => {
  const createOptions = (
    options: Omit<CreateGameViaCommandOptions, "getMaxPlayers">
  ): CreateGameViaCommandOptions => ({
    ...options,
    getMaxPlayers: () => deps.getOracleMaxPlayers(),
  });

  const COINFLIP_COMMAND_OPTIONS = createOptions({
    gameType: "coinflip",
    usageMessage:
      "❌ Please provide a valid amount greater than 0.\n\nUsage: <code>/cf &lt;amount&gt;</code> or <code>/cf &lt;amount&gt; &lt;maxPlayers&gt;</code>",
    defaultMaxPlayers: 2,
    minPlayers: 2,
    timeoutSeconds: 60 * 60,
    gameLabel: "Coinflip",
    inferErrorLabel: "Coinflip",
    logPrefix: "🪙",
    errorMessage: "❌ Error creating coinflip game. Please try again.",
  });

  const GIVEAWAY_COMMAND_OPTIONS = createOptions({
    gameType: "giveaway",
    usageMessage:
      "❌ Please provide a valid amount greater than 0.\n\nUsage: <code>/ga &lt;amount&gt;</code> or <code>/ga &lt;amount&gt; &lt;maxPlayers&gt;</code>",
    defaultMaxPlayers: 10,
    minPlayers: 1,
    timeoutSeconds: 60 * 60,
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
    }
  ): Promise<void> => {
    console.log(
      `${options.logPrefix} Command-based ${options.gameType} creation:`,
      args
    );

    try {
      const parsed = await createDeps.parseAmount(args, 1, ctx.chat?.id);
      if (!parsed.success) {
        await ctx.reply(formatParseAmountError(parsed, options.usageMessage), {
          parse_mode: "HTML",
        });
        return;
      }

      const parsedAmount = parsed.data;
      const maxPlayersLimit = Math.max(
        options.minPlayers,
        options.getMaxPlayers()
      );
      const defaultMaxPlayers = Math.min(
        options.defaultMaxPlayers,
        maxPlayersLimit
      );
      const inferred = createDeps.inferMaxPlayers(
        args,
        1,
        parsedAmount.tokenWasSpecified,
        defaultMaxPlayers,
        options.minPlayers,
        maxPlayersLimit
      );

      if (!inferred.ok) {
        await ctx.reply(`❌ ${options.inferErrorLabel} ${inferred.error}`);
        return;
      }

      const maxPlayers = inferred.value;
      const tokenMetadata = await createDeps.wallet.getTokenMetadata(
        parsedAmount.tokenMint
      );
      const { raw: minAmountRaw } = await createDeps.getContractMinimumAmount(
        parsedAmount.tokenMint,
        tokenMetadata.decimals
      );

      if (parsedAmount.amount < minAmountRaw) {
        const formattedMinimum = createDeps.wallet.formatTokenBalance(
          minAmountRaw,
          tokenMetadata.decimals
        );
        await ctx.reply(
          `❌ Amount below contract minimum of ${formattedMinimum} ${parsedAmount.tokenTicker}.`
        );
        return;
      }

      const needsNativeSolCheck =
        parsedAmount.requestedNativeSol === true ||
        parsedAmount.tokenMint === WSOL_MINT;
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
        userBalance = await createDeps.wallet.getTokenBalance(
          telegramId,
          parsedAmount.tokenMint
        );
      }

      if (!needsNativeSolCheck && userBalance < parsedAmount.amount) {
        const formatted = createDeps.wallet.formatTokenBalance(
          userBalance,
          tokenMetadata.decimals
        );
        const privateText = `❌ Not enough ${parsedAmount.tokenTicker}. You have ${formatted} but need ${parsedAmount.formattedAmount}. Add more tokens or try a smaller amount.`;
        const sanitizedText = `❌ Not enough ${parsedAmount.tokenTicker}. I sent your balance privately—please adjust the amount.`;
        const fallbackText = `❌ Not enough ${parsedAmount.tokenTicker}. Please start a private chat with the bot to view your balance.`;
        await sendBalanceAwareReply(
          ctx,
          telegramId,
          privateText,
          sanitizedText,
          fallbackText
        );
        return;
      }

      if (needsNativeSolCheck) {
        const totalLamports = userBalance + nativeSolBalance;
        if (totalLamports < parsedAmount.amount) {
          const formattedSol =
            createDeps.wallet.formatSolBalance(nativeSolBalance);
          const formattedToken = createDeps.wallet.formatTokenBalance(
            userBalance,
            tokenMetadata.decimals
          );
          const wrappedLabel =
            parsedAmount.tokenMint === WSOL_MINT
              ? "wrapped SOL"
              : parsedAmount.tokenTicker;
          const privateText = `❌ Not enough SOL or ${wrappedLabel}. You have ${formattedSol} SOL plus ${formattedToken} ${wrappedLabel}, but the game needs ${parsedAmount.formattedAmount}. Add more SOL or ${wrappedLabel} and try again.`;
          const sanitizedText = `❌ Not enough SOL or ${wrappedLabel}. I sent your balance privately—please adjust your balance and try again.`;
          const fallbackText = `❌ Not enough SOL or ${wrappedLabel}. Please start a private chat with the bot so I can share your balance.`;
          await sendBalanceAwareReply(
            ctx,
            telegramId,
            privateText,
            sanitizedText,
            fallbackText
          );
          return;
        }
      }

      const tokenTickerForGame =
        parsedAmount.tokenMint === WSOL_MINT
          ? "WSOL"
          : parsedAmount.tokenTicker;

      const messageTimestampMs =
        ctx.message?.date != null ? ctx.message.date * 1_000 : undefined;

      const gameResult = await createDeps.gameManager.createGame(
        options.gameType,
        {
          amount: parsedAmount.amount,
          tokenMint: parsedAmount.tokenMint,
          tokenTicker: tokenTickerForGame,
          isSol: parsedAmount.isSol,
          requestedNativeSol: parsedAmount.requestedNativeSol,
        },
        maxPlayers,
        options.minPlayers,
        options.timeoutSeconds,
        telegramId,
        ctx.chat?.id || 0,
        messageTimestampMs
      );

      if (!gameResult.success) {
        const finalError = gameResult.error ?? "Failed to create game";
        const privateText = `❌ Failed to create game: ${finalError}`;
        const hasBalanceInfo = containsBalanceInfo(finalError);
        if (hasBalanceInfo) {
          const sanitizedText =
            "❌ Failed to create game: insufficient funds. Check your DM for details.";
          const fallbackText =
            "❌ Failed to create game. Start a private chat with the bot to see more info.";
          await sendBalanceAwareReply(
            ctx,
            telegramId,
            privateText,
            sanitizedText,
            fallbackText
          );
        } else {
          await ctx.reply(privateText, { parse_mode: "HTML" });
        }
        return;
      }

      if (gameResult.autoJoinResult && !gameResult.autoJoinResult.success) {
        await ctx.reply(
          gameResult.autoJoinResult.error || "Failed to auto-join game",
          { parse_mode: "HTML" }
        );
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
        "Active"
      );
    } catch (error) {
      console.error(`Error in command-based ${options.gameType}:`, error);
      await ctx.reply(options.errorMessage);
    }
  };

  const createCoinflipDeps = (): CoinflipDeps => ({
    isGroupChat: deps.isGroupChat,
    showInteractiveSetup: (ctxWithMessage, telegramId, tokenOverride) =>
      deps.startInteractiveGameSetup(
        ctxWithMessage,
        telegramId,
        deps.gameSetupCopy.coinflip,
        tokenOverride
      ),
    createGameViaCommand: (ctxWithMessage, args, telegramId) =>
      createGameViaCommand(
        ctxWithMessage,
        args,
        telegramId,
        COINFLIP_COMMAND_OPTIONS
      ),
    resolveTokenOverride: (tokenInput, chatId) =>
      deps.resolveCommandTokenOverride(tokenInput, chatId),
  });

  const handleGiveawayCommand = async (ctx: Context & { message?: any }) => {
    try {
      if (!deps.isGroupChat(ctx)) {
        await ctx.reply("❌ Giveaway games can only be created in groups!");
        return;
      }

      const telegramId = await deps.getRequiredTelegramIdForContext(
        ctx,
        "giveaway command"
      );
      if (telegramId == null) {
        return;
      }

      const args = ctx.message?.text?.split(" ");
      const tokenCandidate = args?.[1]?.trim();

      if (!args || args.length < 2) {
        await deps.startInteractiveGameSetup(
          ctx,
          telegramId,
          deps.gameSetupCopy.giveaway
        );
        return;
      }

      let tokenOverride: GameTokenOverride | null = null;
      if (tokenCandidate) {
        tokenOverride = await deps.resolveCommandTokenOverride(
          tokenCandidate,
          ctx.chat?.id
        );
      }

      if (tokenOverride) {
        await deps.startInteractiveGameSetup(
          ctx,
          telegramId,
          deps.gameSetupCopy.giveaway,
          tokenOverride
        );
        return;
      }

      await createGameViaCommand(
        ctx,
        args,
        telegramId,
        GIVEAWAY_COMMAND_OPTIONS
      );
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
