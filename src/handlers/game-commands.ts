import type { Context, Bot } from "grammy";
import { formatParseAmountError } from "../utils/token-manager";
import { WSOL_MINT } from "../utils/constants";
import type { GameManager } from "../utils/game";
import type { ParseAmountResult } from "../types";
import { type CoinflipDeps, type GameTokenOverride, handleCoinflipCommand } from "./game";
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

import {
  buildEmptyLeaderboardMessage,
  buildLeaderboardMessage,
  type LeaderboardPlayerDisplay,
} from "../utils/leaderboard-ui";
import type { GameDatabase, LeaderboardStatsRecord } from "../utils/game-database";

export type GameCommandsModuleDeps = {
  parseAmount: CreateGameViaCommandDeps["parseAmount"];
  inferMaxPlayers: CreateGameViaCommandDeps["inferMaxPlayers"];
  wallet: CreateGameViaCommandDeps["wallet"];
  getContractMinimumAmount: CreateGameViaCommandDeps["getContractMinimumAmount"];
  gameManager: {
    createGame: (
      ...args: Parameters<GameManager["createGame"]>
    ) => ReturnType<GameManager["createGame"]>;
    createGameMessage: (
      ...args: Parameters<GameManager["createGameMessage"]>
    ) => ReturnType<GameManager["createGameMessage"]>;
    getUserGames: (
      ...args: Parameters<GameManager["getUserGames"]>
    ) => ReturnType<GameManager["getUserGames"]>;
    getUsernameFromTelegramId: (
      ...args: Parameters<GameManager["getUsernameFromTelegramId"]>
    ) => ReturnType<GameManager["getUsernameFromTelegramId"]>;
  };
  gameDb: GameDatabase;
  handleCommandError: (ctx: any, error: any, name: string) => Promise<void>;
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
        const shortageMessage =
          `❌ Not enough ${parsedAmount.tokenTicker}. Add more ${parsedAmount.tokenTicker} or try a smaller amount.`;
        await ctx.reply(shortageMessage, { parse_mode: "HTML" });
        return;
      }

      if (needsNativeSolCheck) {
        const totalLamports = userBalance + nativeSolBalance;
        if (totalLamports < parsedAmount.amount) {
          const wrappedLabel =
            parsedAmount.tokenMint === WSOL_MINT
              ? "wrapped SOL"
              : parsedAmount.tokenTicker;
          const shortageMessage =
            `❌ Not enough SOL or ${wrappedLabel}. Add more SOL or ${wrappedLabel} and try again.`;
          await ctx.reply(shortageMessage, { parse_mode: "HTML" });
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
        const hasBalanceInfo = containsBalanceInfo(finalError);
        const displayText = hasBalanceInfo
          ? "❌ Failed to create game: insufficient funds. Please add more funds and try again."
          : `❌ ${finalError}`;
        await ctx.reply(displayText, { parse_mode: "HTML" });
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

  const LEADERBOARD_PLAYER_LIMIT = 5;

  const resolveLeaderboardDisplayName = async (
    ctx: Context,
    telegramId: string
  ): Promise<string> => {
    try {
      const username = await deps.gameManager.getUsernameFromTelegramId(
        ctx,
        telegramId
      );
      if (username) {
        return username.startsWith("@") ? username : `@${username}`;
      }
    } catch (error) {
      console.warn(`Could not get username for ${telegramId}:`, error);
    }

    return `Player ${telegramId}`;
  };

  const resolveLeaderboardPlayers = async (
    ctx: Context,
    stats: LeaderboardStatsRecord[]
  ): Promise<LeaderboardPlayerDisplay[]> => {
    const players = await Promise.all(
      stats.map(async (row) => {
        const displayName = await resolveLeaderboardDisplayName(
          ctx,
          row.telegramId
        );
        const wins = Math.max(0, row.gamesWon);
        const totalGames = Math.max(0, row.totalGames);
        const losses = Math.max(totalGames - wins, 0);

        return {
          telegramId: row.telegramId,
          displayName,
          totalGames,
          wins,
          losses,
          winRate: Math.max(0, row.winRate),
          gamesCreated: Math.max(0, row.gamesCreated),
          gamesJoined: Math.max(0, row.gamesJoined),
          totalVolume: Math.max(0, row.totalVolume),
        } satisfies LeaderboardPlayerDisplay;
      })
    );

    return players.filter((player) => player.totalGames > 0);
  };

  return {
    COINFLIP_COMMAND_OPTIONS,
    GIVEAWAY_COMMAND_OPTIONS,
    createGameViaCommand,
    createCoinflipDeps,
    handleGiveawayCommand,
    registerHandlers: (bot: Bot) => {
      bot.command(["coinflip", "cf"], async (ctx) => {
        try {
          await handleCoinflipCommand(
            ctx as Context & { message?: any },
            createCoinflipDeps()
          );
        } catch (error) {
          console.error("Error in coinflip command:", error);
          await ctx.reply("❌ Error setting up coinflip game. Please try again.");
        }
      });

      bot.command(["giveaway", "ga"], async (ctx) => {
        await handleGiveawayCommand(ctx as Context & { message?: any });
      });

      bot.command("active", async (ctx: Context) => {
        const telegramId = await deps.getRequiredTelegramIdForContext(
          ctx,
          "active command"
        );
        if (telegramId == null) return;

        try {
          const { activeGames } = await deps.gameManager.getUserGames(ctx, telegramId);
          let response = activeGames || "You don't have any active games.";
          await ctx.reply(response, {
            parse_mode: "HTML",
            reply_to_message_id: ctx.message?.message_id,
          });
        } catch (error) {
          await deps.handleCommandError(ctx, error, "active");
        }
      });

      bot.command("games", async (ctx: Context) => {
        const telegramId = await deps.getRequiredTelegramIdForContext(
          ctx,
          "games command"
        );
        if (telegramId == null) return;

        try {
          const { recentGames } = await deps.gameManager.getUserGames(ctx, telegramId);
          const response = recentGames || "You don't have any recent games.";
          await ctx.reply(response, {
            parse_mode: "HTML",
            reply_to_message_id: ctx.message?.message_id,
          });
        } catch (error) {
          await deps.handleCommandError(ctx, error, "games");
        }
      });

      bot.command(["leaderboard", "lb"], async (ctx: Context) => {
        if (!deps.isGroupChat(ctx)) {
          return ctx.reply("❌ Leaderboard is only available in group chats.");
        }

        const chatId = ctx.chat?.id;
        if (!chatId) {
          return ctx.reply("❌ Could not load chat information.");
        }

        try {
          console.log(`🏆 Generating leaderboard for chat ${chatId}`);

          const leaderboardStats = deps.gameDb.getLeaderboardStats(
            chatId,
            LEADERBOARD_PLAYER_LIMIT
          );

          if (leaderboardStats.length === 0) {
            return ctx.reply(buildEmptyLeaderboardMessage(), {
              parse_mode: "HTML",
              reply_to_message_id: ctx.message?.message_id,
            });
          }

          const players = await resolveLeaderboardPlayers(ctx, leaderboardStats);

          if (players.length === 0) {
            return ctx.reply(buildEmptyLeaderboardMessage(), {
              parse_mode: "HTML",
              reply_to_message_id: ctx.message?.message_id,
            });
          }

          const leaderboardText = buildLeaderboardMessage({
            chatTitle: ctx.chat?.title ?? null,
            players,
          });

          await ctx.reply(leaderboardText, {
            parse_mode: "HTML",
            reply_to_message_id: ctx.message?.message_id,
          });
        } catch (error) {
          console.error("Error generating leaderboard:", error);
          await ctx.reply("❌ Error generating leaderboard.");
        }
      });
    },
    __test_createGameViaCommand: createGameViaCommand,
  };
};
