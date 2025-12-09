import {
  InlineKeyboard,
  type Bot,
  type Context,
  type MiddlewareFn,
} from "grammy";
import type { NextFunction } from "grammy";
import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";

import {
  DEFAULT_GAME_TIMEOUT,
  DEFAULT_TOKEN_MINT,
  DEFAULT_TOKEN_TICKER,
} from "../utils/constants";
import {
  clampMinPlayers,
  clampTimeoutSeconds,
  getMinPlayersFloor,
  resolveAdvancedOptions,
} from "../utils/game-settings";
import {
  createAmountSelectionKeyboard,
  createPlayerSelectionKeyboard,
  getFeeWarningMessage,
  getSuggestedStakeAmounts,
} from "../utils/keyboards";
import {
  buildPlayerSelectionMessage,
  buildGameConfirmationMessage,
  buildGameConfirmMenuConfig,
  presentAdvancedMenu,
  presentConfirmMenu,
  presentCustomAmountPrompt,
  determineFractionDigits,
  toTitleCase,
} from "./game-callbacks/ui-builders";
import { respondWithMenu } from "../utils/menu-response";
import {
  getRequiredTelegramIdForContext,
  getTelegramId,
  handleCallbackErrorSafe,
  safeAnswerCallbackQuery,
  containsBalanceInfo,
} from "../utils/context-helpers";
import { formatTokenDisplay, formatUsdValue } from "../utils/format-amount";
import {
  clearGameSetupSession,
  getGameSetupSession,
  upsertGameSetupSession,
  type GameSetupSessionState,
} from "../utils/user-state";
import type { ChatGameSettings } from "../types";
import { isMessageMissing } from "../utils/telegram-errors";
import type { WalletManager } from "../utils/wallet";
import type { GameManager } from "../utils/game";
import type { GameDatabase } from "../utils/game-database";
import type { WrapCallbackHandler } from "../utils/callback-registry";
import type { GameSetupCopy, GameSetupModule } from "./game-setup";
import type { Timba } from "../../idl/idlType";

export type GameCallbacksModuleDeps = {
  bot: Bot;
  wallet: WalletManager;
  getGameManager: () => GameManager;
  gameDb: GameDatabase;
  wrapCallbackHandler: WrapCallbackHandler;
  withCreatorContext: GameSetupModule["withCreatorContext"];
  pendingGameCreations: Set<string>;
  getOracleMaxPlayers: () => number;
  getDefaultTokenMetadata: () => Promise<{ decimals: number }>;
  getContractMinimumAmount: (
    tokenMint?: string,
    decimalsHint?: number
  ) => Promise<{ formatted: number; raw: number; decimals: number }>;
  fetchTokenPriceUSD: (input: {
    tokenMint: string;
    tokenTicker: string;
  }) => Promise<number | null>;
  getProgram: () => Program<Timba>;
  validateGameTokenData: (gameData: any) => {
    isValid: boolean;
    error?: string;
  };
  gameSetupCopy: Record<"coinflip" | "giveaway", GameSetupCopy>;
  getChatGameSettings?: (chatId: number) => ChatGameSettings | null;
};

type HandleJoinGameFn = (
  ctx: Context,
  gamePda: PublicKey,
  telegramId: bigint,
  game: any
) => Promise<void>;

export type GameCallbacksModule = {
  registerHandlers: () => void;
  createTextInputMiddleware: () => MiddlewareFn<Context>;
  __test_handleGameSetupTextInput: (
    ctx: Context,
    next: NextFunction
  ) => Promise<void>;
  __test_shouldSkipGenericGameCallback: (callbackData: string) => boolean;
  __test_handleJoinGame: HandleJoinGameFn;
};

const NON_GAME_CALLBACK_NAMES = [
  "main_wallet",
  "wallet_refresh",
  "wallet_settings",
  "cmd_help",
  "cmd_balance",
  "cmd_withdraw",
  "cmd_swap",
  "cmd_wrap",
  "cmd_unwrap",
  "cmd_privatekey",
  "unwrap_confirm",
  "help_wallet",
  "help_games",
  "help_utility",
  "help_examples",
] as const;

const NON_GAME_CALLBACK_PREFIXES = [
  "send_",
  "swap_",
  "wrap_",
  "confirm_",
  "amount_",
  "players_",
  "cancel_game_",
  "custom_amount_",
  "custom_players_",
  "slider_",
  "back_to_amounts_",
  "back_to_confirm_",
  "type_amount_",
  "admin_",
  "info_",
  "advanced_",
  "active_list",
] as const;

const shouldSkipGenericGameCallback = (callbackData: string): boolean => {
  if (!callbackData) return false;
  if (callbackData === "noop") return true;

  if (
    NON_GAME_CALLBACK_NAMES.includes(
      callbackData as (typeof NON_GAME_CALLBACK_NAMES)[number]
    )
  ) {
    return true;
  }

  return NON_GAME_CALLBACK_PREFIXES.some((prefix) =>
    callbackData.startsWith(prefix)
  );
};

export const createGameCallbacksModule = (
  deps: GameCallbacksModuleDeps
): GameCallbacksModule => {
  const getGameManager = () => deps.getGameManager();

  const resolveChatSettingsForContext = (
    ctx: Context,
    session?: GameSetupSessionState
  ): ChatGameSettings | null => {
    const chatId = session?.chatId ?? ctx.chat?.id;
    if (typeof chatId !== "number") return null;
    return deps.getChatGameSettings?.(chatId) ?? null;
  };

  const handleCallbackError = async (
    ctx: Context,
    error: unknown,
    action: string
  ): Promise<void> => {
    await handleCallbackErrorSafe(ctx, error, action, { maxLength: 180 });
  };

  const handleCompletedGameCallback = async (ctx: Context, game: any) => {
    try {
      const gameManager = getGameManager();
      const gameData = deps.gameDb.getGame(game.game_address);

      if (gameData) {
        await gameManager.updateGameMessageFromData(
          ctx,
          game.game_address,
          "Completed",
          gameData.winner_address || undefined
        );

        const statusMessage =
          gameData.winner_address === "cancelled" ? "cancelled" : "completed";
        await safeAnswerCallbackQuery(
          ctx,
          `Game ${statusMessage} - message updated!`
        );
      } else {
        console.warn(`Game data not found for ${game.game_address}`);
        await safeAnswerCallbackQuery(
          ctx,
          "Game data not found - game may have been completed"
        );
      }
    } catch (error) {
      console.error("Error updating completed game message:", error);
      await safeAnswerCallbackQuery(ctx, "Failed to update game message");
    }
  };

  const handleJoinGame = async (
    ctx: Context,
    gamePda: PublicKey,
    telegramId: bigint,
    game: any
  ) => {
    const gameManager = getGameManager();
    if (game.status !== "active") {
      await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
      return;
    }

    const telegramIdStr = telegramId.toString();
    const displayNameFromContext = (() => {
      const from = ctx.from;
      if (!from) return null;

      if (
        typeof from.username === "string" &&
        from.username.trim().length > 0
      ) {
        const normalizedHandle = from.username.trim().replace(/^@+/, "");
        return normalizedHandle.length > 0 ? `@${normalizedHandle}` : null;
      }

      const nameParts = [
        typeof from.first_name === "string" ? from.first_name.trim() : "",
        typeof from.last_name === "string" ? from.last_name.trim() : "",
      ].filter((part) => part.length > 0);

      if (nameParts.length === 0) {
        return null;
      }

      return nameParts.join(" ");
    })();

    if (displayNameFromContext) {
      gameManager.primeUsernameCache(
        ctx,
        telegramIdStr,
        displayNameFromContext
      );
    }

    try {
      const playerPubkey = deps.wallet
        .getKeyPair(telegramId)
        .publicKey.toBase58();
      deps.gameDb.savePlayerMapping(
        playerPubkey,
        telegramIdStr,
        displayNameFromContext ?? null
      );
    } catch (error) {
      console.warn(
        "Failed to persist player mapping when joining game:",
        error
      );
    }

    try {
      const result = await gameManager.joinGame(
        game.game_address,
        telegramId,
        ctx.chat?.id,
        displayNameFromContext
      );

      if (!result.success) {
        const errorMessage = result.error || "Failed to join game";

        if (errorMessage.includes("already completed")) {
          try {
            await gameManager.updateGameMessageFromData(
              ctx,
              game.game_address,
              "Completed"
            );
          } catch (updateError) {
            console.error(
              `Error syncing completed game message for ${game.game_address}:`,
              updateError
            );
          }
        }

        await safeAnswerCallbackQuery(ctx, errorMessage);
        return;
      }

      await gameManager.updateGameMessageFromData(
        ctx,
        game.game_address,
        "Active"
      );

      const program = deps.getProgram();
      const updatedGameAccount = await program.account.game.fetch(gamePda);
      const ticketCount = updatedGameAccount.ticketsCount;
      const maxTickets = updatedGameAccount.maxTickets;
      await safeAnswerCallbackQuery(
        ctx,
        `✅ Joined! (${ticketCount}/${maxTickets})`
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Account does not exist")
      ) {
        await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
      } else {
        throw error;
      }
    }
  };

  const handleRefreshGameCallback = async (
    ctx: Context,
    gamePda: PublicKey,
    gameAddress: string
  ): Promise<void> => {
    const gameData = deps.gameDb.getGame(gameAddress);
    const validation = deps.validateGameTokenData(gameData);

    if (!validation.isValid) {
      await safeAnswerCallbackQuery(
        ctx,
        validation.error ?? "Invalid game data"
      );
      return;
    }

    if (gameData?.status === "completed") {
      await safeAnswerCallbackQuery(
        ctx,
        "This game has already been completed!"
      );
      return;
    }

    try {
      const program = deps.getProgram();
      await program.account.game.fetch(gamePda);

      const gameManager = getGameManager();
      await gameManager.updateGameMessageFromData(ctx, gameAddress, "Active");

      await safeAnswerCallbackQuery(ctx, "Game status refreshed!");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Account does not exist")
      ) {
        await safeAnswerCallbackQuery(ctx, "This game is no longer active!");
      } else {
        console.error(`Error refreshing game ${gameAddress}:`, error);
        await safeAnswerCallbackQuery(ctx, "Error refreshing game status!");
      }
    }
  };

  const handleGameSetupTextInput = async (
    ctx: Context,
    next: NextFunction
  ): Promise<void> => {
    try {
      const telegramIdNumeric = Number(getTelegramId(ctx));
      if (telegramIdNumeric === 0) {
        await next();
        return;
      }

      if (ctx.message?.text == null) {
        await next();
        return;
      }

      const replyToMessageId = ctx.message.reply_to_message?.message_id;
      if (!replyToMessageId) {
        await next();
        return;
      }

      const sessionKey = `${ctx.chat?.id || 0}_${replyToMessageId}`;
      const userSession = getGameSetupSession(sessionKey);

      if (
        !userSession ||
        (userSession.waitingFor !== "amount_input" &&
          userSession.waitingFor !== "players_input")
      ) {
        await next();
        return;
      }

      const sessionSnapshot = { ...userSession };
      const restoreSession = (
        overrides: Partial<GameSetupSessionState> = {}
      ) => {
        upsertGameSetupSession(sessionKey, {
          ...sessionSnapshot,
          ...overrides,
        });
      };
      clearGameSetupSession(sessionKey);

      const defaultMetadata = await deps.getDefaultTokenMetadata();
      const tokenTicker = userSession.tokenTicker ?? DEFAULT_TOKEN_TICKER;
      const tokenDecimals =
        userSession.tokenDecimals ?? defaultMetadata.decimals;
      const minAllowed =
        userSession.contractMinimum ??
        (
          await deps.getContractMinimumAmount(
            userSession.tokenMint ?? DEFAULT_TOKEN_MINT,
            tokenDecimals
          )
        ).formatted;

      const inputText = ctx.message.text.trim();

      if (userSession.waitingFor === "players_input") {
        const players = Number.parseInt(inputText, 10);
        const minPlayers = getMinPlayersFloor(
          userSession.gameType as "coinflip" | "giveaway"
        );
        const maxPlayers = Math.max(
          minPlayers,
          userSession.maxPlayersLimit ?? deps.getOracleMaxPlayers()
        );

        console.log(
          `🔍 Custom players input: "${inputText}" -> ${players} (gameType: ${userSession.gameType}, min: ${minPlayers}, max: ${maxPlayers})`
        );

        if (
          Number.isNaN(players) ||
          players < minPlayers ||
          players > maxPlayers
        ) {
          const errorMessage = `❌ Invalid number of players. Please enter a number between ${minPlayers} and ${maxPlayers}.`;
          try {
            await ctx.api.editMessageText(
              userSession.chatId!,
              userSession.messageId!,
              errorMessage,
              { parse_mode: "HTML" }
            );
          } catch (error) {
            await ctx.reply(errorMessage, { parse_mode: "HTML" });
          }
          restoreSession({ waitingFor: "players_input" });
          return;
        }

        const amountValue = userSession.amount ?? "0";
        const chatSettings = resolveChatSettingsForContext(ctx, userSession);
        const advanced = resolveAdvancedOptions(
          userSession.gameType as "coinflip" | "giveaway",
          players,
          userSession,
          userSession.maxPlayersLimit ?? deps.getOracleMaxPlayers(),
          chatSettings
        );
        const confirmMessage = buildGameConfirmationMessage({
          gameType: userSession.gameType as "coinflip" | "giveaway",
          amount: amountValue,
          players,
          tokenTicker,
          tokenDecimals,
          advanced,
        });

        const confirmMenu = buildGameConfirmMenuConfig({
          gameType: userSession.gameType as "coinflip" | "giveaway",
          amount: amountValue,
          players,
          creatorId: userSession.creatorId,
          advanced,
        });

        try {
          await ctx.api.editMessageText(
            userSession.chatId!,
            userSession.messageId!,
            confirmMessage,
            confirmMenu.replyMarkup
          );
        } catch (error) {
          await ctx.reply(confirmMessage, confirmMenu.replyMarkup);
        }

        upsertGameSetupSession(sessionKey, {
          waitingFor: "setup",
          gameType: userSession.gameType,
          userBalance: userSession.userBalance,
          messageId: userSession.messageId,
          chatId: userSession.chatId,
          amount: userSession.amount,
          players,
          creatorId: userSession.creatorId,
          tokenMint: userSession.tokenMint,
          tokenTicker,
          tokenDecimals,
          contractMinimum: minAllowed,
          timeoutSeconds: advanced.timeoutSeconds,
          minPlayers: advanced.minPlayers,
          isPrivate: advanced.isPrivate,
        });
        return;
      }

      const amount = Number.parseFloat(inputText);

      if (Number.isNaN(amount) || amount <= 0) {
        const errorMessage =
          "❌ Invalid amount. Please use /coinflip or /giveaway to try again.";
        try {
          await ctx.api.editMessageText(
            userSession.chatId!,
            userSession.messageId!,
            errorMessage,
            { parse_mode: "HTML" }
          );
        } catch (error) {
          await ctx.reply(errorMessage, { parse_mode: "HTML" });
        }
        restoreSession({ waitingFor: "amount_input" });
        return;
      }

      if (amount > userSession.userBalance) {
        const errorMessage =
          "❌ Amount too high. Please try a lower amount.";
        try {
          await ctx.api.editMessageText(
            userSession.chatId!,
            userSession.messageId!,
            errorMessage,
            { parse_mode: "HTML" }
          );
        } catch (error) {
          await ctx.reply(errorMessage, { parse_mode: "HTML" });
        }
        restoreSession({ waitingFor: "amount_input" });
        return;
      }

      if (amount < minAllowed) {
        const errorMessage = `❌ Amount below contract minimum of ${minAllowed} ${tokenTicker}.`;
        try {
          await ctx.api.editMessageText(
            userSession.chatId!,
            userSession.messageId!,
            errorMessage,
            { parse_mode: "HTML" }
          );
        } catch (error) {
          await ctx.reply(errorMessage, { parse_mode: "HTML" });
        }
        restoreSession({ waitingFor: "amount_input" });
        return;
      }

      const amountFormatted = amount.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: determineFractionDigits(
          inputText,
          tokenDecimals
        ),
      });

      const playerMessage = buildPlayerSelectionMessage(
        userSession.gameType as "coinflip" | "giveaway",
        amountFormatted,
        tokenTicker
      );

      try {
        await ctx.api.editMessageText(
          userSession.chatId!,
          userSession.messageId!,
          playerMessage,
          {
            parse_mode: "HTML",
            reply_markup: createPlayerSelectionKeyboard(
              userSession.gameType,
              amount.toString(),
              userSession.creatorId
            ),
          }
        );
      } catch (error) {
        await ctx.reply(playerMessage, {
          parse_mode: "HTML",
          reply_markup: createPlayerSelectionKeyboard(
            userSession.gameType,
            amount.toString(),
            userSession.creatorId
          ),
        });
      }

      upsertGameSetupSession(sessionKey, {
        waitingFor: "setup",
        gameType: userSession.gameType,
        userBalance: userSession.userBalance,
        messageId: userSession.messageId,
        chatId: userSession.chatId,
        amount: amount.toString(),
        creatorId: userSession.creatorId,
        tokenMint: userSession.tokenMint,
        tokenTicker,
        tokenDecimals,
        contractMinimum: minAllowed,
      });
    } catch (error) {
      console.error("Error in text input handler:", error);
      await next();
    }
  };

  const registerHandlers = () => {
    deps.bot.on(
      "callback_query",
      deps.wrapCallbackHandler(
        async (ctx, next) => {
          const callbackData = ctx.callbackQuery?.data ?? "";
          console.log("📢 Generic callback handler received:", callbackData);

          if (!callbackData || !ctx.from) {
            await next();
            return;
          }

          if (shouldSkipGenericGameCallback(callbackData)) {
            console.log(
              "🔄 Calling next() for non-game callback:",
              callbackData
            );
            await next();
            return;
          }

          const splitData = callbackData.split("_");
          if (splitData.length < 2) {
            await next();
            return;
          }

          const [action, gameAddress] = splitData;
          if (!action || !gameAddress) {
            await next();
            return;
          }

          const game = deps.gameDb.getGame(gameAddress);
          if (!game) {
            await safeAnswerCallbackQuery(ctx, "Game not found!");
            return;
          }

          if (game.status === "completed") {
            await handleCompletedGameCallback(ctx, game);
            return;
          }

          try {
            const telegramId = await getRequiredTelegramIdForContext(
              ctx,
              "game callback"
            );
            if (telegramId == null) {
              await safeAnswerCallbackQuery(
                ctx,
                "Unable to identify user. Please try again."
              );
              return;
            }

            const gamePda = new PublicKey(gameAddress);

            switch (action) {
              case "join":
                await handleJoinGame(ctx, gamePda, telegramId, game);
                break;
              case "refresh":
                await handleRefreshGameCallback(ctx, gamePda, gameAddress);
                break;
              default:
                await next();
                break;
            }
          } catch (error) {
            await handleCallbackError(ctx, error, action);
          }
        },
        { action: "generic game callback" }
      )
    );

    deps.bot.callbackQuery(
      /^amount_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)$/,
      deps.wrapCallbackHandler(
        deps.withCreatorContext(
          {
            name: "amount",
            resolveCreatorId: (ctx) => ctx.match?.[3],
            failureText: "🚫 Only the game creator can modify this game setup!",
          },
          async (ctx, { session, tokenContext, updateSession, creatorId }) => {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = ctx.match![2] as string;

            const amountNumber = Number(amount);
            const formattedAmount = amountNumber.toLocaleString("en-US", {
              minimumFractionDigits: 0,
              maximumFractionDigits: determineFractionDigits(
                amount,
                tokenContext.tokenDecimals
              ),
            });

            const playerMessage = buildPlayerSelectionMessage(
              gameType,
              formattedAmount,
              tokenContext.tokenTicker
            );

            await respondWithMenu(ctx, {
              text: playerMessage,
              parseMode: "HTML",
              keyboard: createPlayerSelectionKeyboard(
                gameType,
                amount,
                creatorId
              ),
            });

            updateSession({
              waitingFor: "setup",
              gameType,
              userBalance: session?.userBalance ?? 0,
              messageId:
                ctx.callbackQuery?.message?.message_id ?? session?.messageId,
              chatId: ctx.chat?.id ?? session?.chatId ?? 0,
              amount,
            });

            await safeAnswerCallbackQuery(ctx);
          }
        ),
        { action: "amount", errorAck: "❌ Error selecting amount" }
      )
    );

    deps.bot.callbackQuery(
      /^players_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)_(\d+)$/,
      deps.wrapCallbackHandler(
        deps.withCreatorContext(
          {
            name: "players",
            resolveCreatorId: (ctx) => ctx.match?.[4],
            failureText: "🚫 Only the game creator can modify this game setup!",
          },
          async (ctx, { session, tokenContext, updateSession, creatorId }) => {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = ctx.match![2] as string;
            const players = Number.parseInt(ctx.match![3] as string, 10);

            const chatSettings = resolveChatSettingsForContext(ctx, session);
            const advanced = resolveAdvancedOptions(
              gameType,
              players,
              session,
              session?.maxPlayersLimit ?? deps.getOracleMaxPlayers(),
              chatSettings
            );

            const confirmMessage = buildGameConfirmationMessage({
              gameType,
              amount,
              players,
              tokenTicker: tokenContext.tokenTicker,
              tokenDecimals: tokenContext.tokenDecimals,
              advanced,
            });

            const confirmMenu = buildGameConfirmMenuConfig({
              gameType,
              amount,
              players,
              creatorId,
              advanced,
            });

            await respondWithMenu(ctx, {
              text: confirmMessage,
              ...confirmMenu.menu,
            });

            updateSession({
              waitingFor: "setup",
              gameType,
              userBalance: session?.userBalance ?? 0,
              messageId:
                ctx.callbackQuery?.message?.message_id ?? session?.messageId,
              chatId: ctx.chat?.id ?? session?.chatId ?? 0,
              amount,
              players,
              timeoutSeconds: advanced.timeoutSeconds,
              minPlayers: advanced.minPlayers,
              isPrivate: advanced.isPrivate,
            });

            await safeAnswerCallbackQuery(ctx);
          }
        ),
        { action: "players", errorAck: "❌ Error selecting players" }
      )
    );

    deps.bot.callbackQuery(
      /^advanced_options_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)_(\d+)$/,
      deps.wrapCallbackHandler(
        deps.withCreatorContext(
          {
            name: "advanced_options",
            resolveCreatorId: (ctx) => ctx.match?.[4],
            failureText:
              "🚫 Only the game creator can adjust advanced options!",
          },
          async (ctx, { session, tokenContext, updateSession, creatorId }) => {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = ctx.match![2] as string;
            const players = Number.parseInt(ctx.match![3] as string, 10);

            const chatSettings = resolveChatSettingsForContext(ctx, session);
            const advanced = resolveAdvancedOptions(
              gameType,
              players,
              session,
              session?.maxPlayersLimit ?? deps.getOracleMaxPlayers(),
              chatSettings
            );

            await presentAdvancedMenu({
              ctx,
              gameType,
              amount,
              players,
              tokenTicker: tokenContext.tokenTicker,
              tokenDecimals: tokenContext.tokenDecimals,
              creatorId,
              advanced,
              logLabel: "advanced_options_open",
            });

            updateSession({
              waitingFor: "setup",
              gameType,
              userBalance: session?.userBalance ?? 0,
              messageId: ctx.callbackQuery?.message?.message_id ?? session?.messageId,
              chatId: ctx.chat?.id ?? session?.chatId ?? 0,
              amount,
              players,
              timeoutSeconds: advanced.timeoutSeconds,
              minPlayers: advanced.minPlayers,
              isPrivate: advanced.isPrivate,
            });

            await safeAnswerCallbackQuery(ctx);
          }
        ),
        { action: "advanced_options", errorAck: "❌ Error opening options" }
      )
    );

    deps.bot.callbackQuery(
      /^advanced_visibility_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)_(public|private)_(\d+)$/,
      deps.wrapCallbackHandler(
        deps.withCreatorContext(
          {
            name: "advanced_visibility",
            resolveCreatorId: (ctx) => ctx.match?.[5],
            failureText:
              "🚫 Only the game creator can adjust visibility!",
          },
          async (ctx, { session, tokenContext, updateSession, creatorId }) => {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = ctx.match![2] as string;
            const players = Number.parseInt(ctx.match![3] as string, 10);
            const visibilityChoice = ctx.match![4] as "public" | "private";

            const isPrivate = visibilityChoice !== "public";
            const advanced = resolveAdvancedOptions(
              gameType,
              players,
              { ...session, isPrivate },
              session?.maxPlayersLimit ?? deps.getOracleMaxPlayers(),
              resolveChatSettingsForContext(ctx, session)
            );

            await presentAdvancedMenu({
              ctx,
              gameType,
              amount,
              players,
              tokenTicker: tokenContext.tokenTicker,
              tokenDecimals: tokenContext.tokenDecimals,
              creatorId,
              advanced,
              logLabel: "advanced_visibility_toggle",
            });

            updateSession({
              waitingFor: "setup",
              gameType,
              userBalance: session?.userBalance ?? 0,
              messageId: ctx.callbackQuery?.message?.message_id ?? session?.messageId,
              chatId: ctx.chat?.id ?? session?.chatId ?? 0,
              amount,
              players,
              timeoutSeconds: advanced.timeoutSeconds,
              minPlayers: advanced.minPlayers,
              isPrivate: advanced.isPrivate,
            });

            await safeAnswerCallbackQuery(ctx);
          }
        ),
        { action: "advanced_visibility", errorAck: "❌ Error updating visibility" }
      )
    );

    deps.bot.callbackQuery(
      /^advanced_timeout_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)_(-?\d+)_([0-9]+)$/,
      deps.wrapCallbackHandler(
        deps.withCreatorContext(
          {
            name: "advanced_timeout",
            resolveCreatorId: (ctx) => ctx.match?.[5],
            failureText:
              "🚫 Only the game creator can set a custom timeout!",
          },
          async (ctx, { session, tokenContext, updateSession, creatorId }) => {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = ctx.match![2] as string;
            const players = Number.parseInt(ctx.match![3] as string, 10);
            const deltaMinutes = Number.parseInt(ctx.match![4] as string, 10);

            const nextTimeoutSeconds = clampTimeoutSeconds(
              (session?.timeoutSeconds ?? DEFAULT_GAME_TIMEOUT) +
                deltaMinutes * 60
            );

            const advanced = resolveAdvancedOptions(
              gameType,
              players,
              { ...session, timeoutSeconds: nextTimeoutSeconds },
              session?.maxPlayersLimit ?? deps.getOracleMaxPlayers(),
              resolveChatSettingsForContext(ctx, session)
            );

            await presentAdvancedMenu({
              ctx,
              gameType,
              amount,
              players,
              tokenTicker: tokenContext.tokenTicker,
              tokenDecimals: tokenContext.tokenDecimals,
              creatorId,
              advanced,
              logLabel: "advanced_timeout_update",
            });

            updateSession({
              ...(session ?? {}),
              waitingFor: "setup",
              gameType,
              userBalance: session?.userBalance ?? 0,
              messageId:
                ctx.callbackQuery?.message?.message_id ?? session?.messageId,
              chatId: ctx.chat?.id ?? session?.chatId ?? 0,
              amount,
              players,
              timeoutSeconds: advanced.timeoutSeconds,
              minPlayers: advanced.minPlayers,
              isPrivate: advanced.isPrivate,
            });

            await safeAnswerCallbackQuery(ctx);
          }
        ),
        { action: "advanced_timeout", errorAck: "❌ Error updating timeout" }
      )
    );

    deps.bot.callbackQuery(
      /^advanced_min_players_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)_(-?\d+)_([0-9]+)$/,
      deps.wrapCallbackHandler(
        deps.withCreatorContext(
          {
            name: "advanced_min_players",
            resolveCreatorId: (ctx) => ctx.match?.[5],
            failureText:
              "🚫 Only the game creator can adjust minimum players!",
          },
          async (ctx, { session, tokenContext, updateSession, creatorId }) => {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = ctx.match![2] as string;
            const players = Number.parseInt(ctx.match![3] as string, 10);
            const delta = Number.parseInt(ctx.match![4] as string, 10);

            const minPlayersFloor = getMinPlayersFloor(gameType);
            const currentMinPlayers = clampMinPlayers(
              gameType,
              session?.minPlayers ?? minPlayersFloor,
              players,
              session?.maxPlayersLimit ?? deps.getOracleMaxPlayers()
            );
            const nextMinPlayers = clampMinPlayers(
              gameType,
              currentMinPlayers + delta,
              players,
              session?.maxPlayersLimit ?? deps.getOracleMaxPlayers()
            );

            const advanced = resolveAdvancedOptions(
              gameType,
              players,
              { ...session, minPlayers: nextMinPlayers },
              session?.maxPlayersLimit ?? deps.getOracleMaxPlayers(),
              resolveChatSettingsForContext(ctx, session)
            );

            await presentAdvancedMenu({
              ctx,
              gameType,
              amount,
              players,
              tokenTicker: tokenContext.tokenTicker,
              tokenDecimals: tokenContext.tokenDecimals,
              creatorId,
              advanced,
              logLabel: "advanced_min_players_update",
            });

            updateSession({
              ...(session ?? {}),
              waitingFor: "setup",
              gameType,
              userBalance: session?.userBalance ?? 0,
              messageId:
                ctx.callbackQuery?.message?.message_id ?? session?.messageId,
              chatId: ctx.chat?.id ?? session?.chatId ?? 0,
              amount,
              players,
              timeoutSeconds: advanced.timeoutSeconds,
              minPlayers: advanced.minPlayers,
              isPrivate: advanced.isPrivate,
            });

            await safeAnswerCallbackQuery(ctx);
          }
        ),
        { action: "advanced_min_players", errorAck: "❌ Error updating minimum players" }
      )
    );

    deps.bot.callbackQuery(
      /^back_to_confirm_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)_(\d+)$/,
      deps.wrapCallbackHandler(
        deps.withCreatorContext(
          {
            name: "back_to_confirm",
            resolveCreatorId: (ctx) => ctx.match?.[4],
            failureText: "🚫 Only the game creator can modify this game setup!",
          },
          async (ctx, { session, tokenContext, updateSession, creatorId }) => {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = ctx.match![2] as string;
            const players = Number.parseInt(ctx.match![3] as string, 10);

            const advanced = resolveAdvancedOptions(
              gameType,
              players,
              session,
              session?.maxPlayersLimit ?? deps.getOracleMaxPlayers(),
              resolveChatSettingsForContext(ctx, session)
            );

            await presentConfirmMenu({
              ctx,
              gameType,
              amount,
              players,
              tokenTicker: tokenContext.tokenTicker,
              tokenDecimals: tokenContext.tokenDecimals,
              creatorId,
              advanced,
              logLabel: "advanced_back_to_confirm",
            });

            updateSession({
              waitingFor: "setup",
              gameType,
              userBalance: session?.userBalance ?? 0,
              messageId: ctx.callbackQuery?.message?.message_id ?? session?.messageId,
              chatId: ctx.chat?.id ?? session?.chatId ?? 0,
              amount,
              players,
              timeoutSeconds: advanced.timeoutSeconds,
              minPlayers: advanced.minPlayers,
              isPrivate: advanced.isPrivate,
            });

            await safeAnswerCallbackQuery(ctx);
          }
        ),
        { action: "back_to_confirm", errorAck: "❌ Error returning" }
      )
    );

    deps.bot.callbackQuery(
      /^confirm_game_(coinflip|giveaway)_([0-9]+(?:\.[0-9]+)?)_(\d+)(?:_(\d+)_(\d+)_(public|private))?_(\d+)$/,
      deps.withCreatorContext(
        {
          name: "confirm_game",
          resolveCreatorId: (ctx) => ctx.match?.[7],
          failureText: "❌ Only the game creator can confirm this setup!",
        },
        async (ctx, { tokenContext, clearSession, creatorId }) => {
          try {
            const gameManager = getGameManager();
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = Number.parseFloat(ctx.match![2]!);
            const players = Number.parseInt(ctx.match![3]!, 10);
            const timeoutSeconds = clampTimeoutSeconds(
              Number.parseInt(ctx.match![4] ?? "", 10)
            );
            const minPlayersSelected = clampMinPlayers(
              gameType,
              ctx.match?.[5] ? Number.parseInt(ctx.match[5]!, 10) : undefined,
              players,
              deps.getOracleMaxPlayers()
            );
            const visibility =
              (ctx.match?.[6] as "public" | "private" | undefined) ??
              "private";
            const isPrivate = visibility !== "public";

            if (Number.isNaN(amount) || Number.isNaN(players)) {
              await safeAnswerCallbackQuery(ctx, "Invalid game configuration");
              return;
            }

            const maxPlayers = Math.max(
              players,
              gameType === "coinflip" ? 2 : 1
            );

            const creationKey = `${creatorId}_${gameType}`;
            if (deps.pendingGameCreations.has(creationKey)) {
              await safeAnswerCallbackQuery(ctx, "Please wait...");
              return;
            }

            const chatId = ctx.chat?.id;
            const messageId = ctx.callbackQuery?.message?.message_id;
            let confirmMessageMissing = false;
            const confirmationFallbackReplyTo =
              ctx.callbackQuery?.message?.reply_to_message?.message_id;

            deps.pendingGameCreations.add(creationKey);

            try {
              if (chatId && messageId && !confirmMessageMissing) {
                try {
                  await ctx.api.editMessageReplyMarkup(chatId, messageId);
                } catch (markError) {
                  console.warn(
                    "Failed to clear confirm keyboard before game creation:",
                    markError
                  );
                  if (isMessageMissing(markError)) {
                    confirmMessageMissing = true;
                  }
                }

                if (!confirmMessageMissing) {
                  try {
                    await ctx.api.editMessageText(
                      chatId,
                      messageId,
                      "⏳ Creating game…",
                      {
                        parse_mode: "HTML",
                      }
                    );
                  } catch (textError) {
                    console.warn(
                      "Failed to set progress text before game creation:",
                      textError
                    );
                    if (isMessageMissing(textError)) {
                      confirmMessageMissing = true;
                    }
                  }
                }
              }

              await safeAnswerCallbackQuery(ctx, "Creating game...");

              const decimals = tokenContext.tokenDecimals;
              const amountRaw = Math.round(amount * Math.pow(10, decimals));
              const gameData = {
                amount: amountRaw,
                isSol: false,
                formattedAmount: amount.toString(),
                tokenMint: tokenContext.tokenMint,
                tokenTicker: tokenContext.tokenTicker,
                tokenWasSpecified:
                  tokenContext.tokenMint !== DEFAULT_TOKEN_MINT,
              };

              const callerTelegramId = getTelegramId(ctx);
              const result = await gameManager.createGame(
                gameType,
                gameData,
                maxPlayers,
                minPlayersSelected,
                timeoutSeconds,
                callerTelegramId,
                { isPrivate },
                ctx.chat?.id,
                ctx.callbackQuery?.message?.date != null
                  ? ctx.callbackQuery.message.date * 1_000
                  : undefined
              );

              if (!result.success) {
                const options = {
                  allowContextEdit: !confirmMessageMissing,
                  skipEdit: confirmMessageMissing,
                  replyToMessageId: confirmMessageMissing
                    ? confirmationFallbackReplyTo
                    : undefined,
                  logLabel: "confirm_game_error",
                } as const;

                const rawError = result.error || "Failed to create game";
                const hasBalanceInfo = containsBalanceInfo(rawError);
                const displayText = hasBalanceInfo
                  ? "❌ Game creation failed (insufficient funds). Please add more funds and try again."
                  : `❌ ${rawError}`;

                await respondWithMenu(
                  ctx,
                  {
                    text: displayText,
                    parseMode: "HTML",
                  },
                  options
                );
                return;
              }

              if (!result.gameAddress) {
                await respondWithMenu(
                  ctx,
                  {
                    text: "❌ Game created but address not returned",
                    parseMode: "HTML",
                  },
                  {
                    allowContextEdit: !confirmMessageMissing,
                    skipEdit: confirmMessageMissing,
                    replyToMessageId: confirmMessageMissing
                      ? confirmationFallbackReplyTo
                      : undefined,
                    logLabel: "confirm_game_missing_address",
                  }
                );
                return;
              }

              const creatorUsername = ctx.from?.username
                ? `@${ctx.from.username}`
                : "Unknown";

              const replyToUserMessageId = ctx.callbackQuery?.message
                ?.reply_to_message?.message_id as number | undefined;

              if (chatId && messageId && !confirmMessageMissing) {
                try {
                  await ctx.api.deleteMessage(chatId, messageId);
                } catch (error) {
                  console.warn("Could not delete confirmation message:", error);
                  if (isMessageMissing(error)) {
                    confirmMessageMissing = true;
                  } else {
                    try {
                      await ctx.api.editMessageText(
                        chatId,
                        messageId,
                        `✅ Game created!\n\n<code>${result.gameAddress}</code>`,
                        { parse_mode: "HTML" }
                      );
                    } catch (fallbackError) {
                      console.warn(
                        "Failed to mark confirmation message as processed:",
                        fallbackError
                      );
                      if (isMessageMissing(fallbackError)) {
                        confirmMessageMissing = true;
                      }
                    }
                  }
                }
              }

              await gameManager.createGameMessage(
                ctx,
                result.gameAddress,
                gameType.charAt(0).toUpperCase() + gameType.slice(1),
                gameData.amount,
                creatorUsername,
                gameData.tokenTicker,
                "Active",
                replyToUserMessageId
              );

              clearSession();

              if (result.autoJoinResult?.success) {
                try {
                  await gameManager.updateGameMessageFromData(
                    ctx,
                    result.gameAddress,
                    "Active"
                  );
                } catch (error) {
                  console.error(
                    "Failed to update game message after auto-join:",
                    error
                  );
                }
              }

              if (result.autoJoinResult && !result.autoJoinResult.success) {
                await ctx.reply(
                  result.autoJoinResult.error || "Failed to auto-join game",
                  {
                    parse_mode: "HTML",
                  }
                );
              }
            } finally {
              deps.pendingGameCreations.delete(creationKey);
            }
          } catch (error) {
            console.error("Error in confirm_game callback:", error);
            try {
              await safeAnswerCallbackQuery(ctx, "❌ Error creating game");
            } catch (answerError) {
              console.error(
                "Failed to answer callback after error:",
                answerError
              );
            }

            try {
              await respondWithMenu(
                ctx,
                {
                  text: "❌ Failed to create game. Please try again.",
                  parseMode: "HTML",
                },
                {
                  allowContextEdit: false,
                  skipEdit: false,
                  replyToMessageId: undefined,
                  logLabel: "confirm_game_failure_notice",
                }
              );
            } catch (notifyError) {
              console.error(
                "Failed to update confirmation message after error:",
                notifyError
              );
            }
          }
        }
      )
    );

    deps.bot.callbackQuery(
      /^custom_amount_(coinflip|giveaway)_(\d+)$/,
      deps.withCreatorContext(
        {
          name: "custom_amount",
          resolveCreatorId: (ctx) => ctx.match?.[2],
          failureText: "❌ Only the game creator can modify this setup!",
        },
        async (ctx, { session, tokenContext, updateSession, creatorId }) => {
          try {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const telegramId = await getRequiredTelegramIdForContext(
              ctx,
              "type amount prompt"
            );
            if (telegramId == null) {
              await safeAnswerCallbackQuery(ctx, "Unable to identify user");
              return;
            }

            let userBalance =
              session?.userBalance && session.userBalance > 0
                ? session.userBalance
                : 0;
            if (userBalance <= 0) {
              try {
                const tokenBalance = await deps.wallet.getTokenBalance(
                  telegramId,
                  tokenContext.tokenMint
                );
                userBalance =
                  tokenBalance / Math.pow(10, tokenContext.tokenDecimals);
              } catch (error) {
                console.error("Error getting balance:", error);
              }
            }

            const { formatted: contractMin } =
              tokenContext.contractMinimum !== undefined
                ? { formatted: tokenContext.contractMinimum }
                : await deps.getContractMinimumAmount(
                    tokenContext.tokenMint,
                    tokenContext.tokenDecimals
                  );

            await presentCustomAmountPrompt({
              ctx,
              gameType,
              tokenTicker: tokenContext.tokenTicker,
              contractMin,
              creatorId,
            });

            await safeAnswerCallbackQuery(ctx, "Type your amount...");

            updateSession({
              waitingFor: "amount_input",
              gameType,
              userBalance,
              messageId: ctx.callbackQuery?.message?.message_id || 0,
              chatId: ctx.chat?.id || 0,
              contractMinimum: contractMin,
              amount: session?.amount,
            });
          } catch (error) {
            console.error(
              "Error in creator-protected custom_amount callback:",
              error
            );
            await safeAnswerCallbackQuery(
              ctx,
              "❌ Error setting up text input"
            );
          }
        }
      )
    );

    deps.bot.callbackQuery(
      /^custom_players_(coinflip|giveaway)_(.+)_(\d+)$/,
      deps.withCreatorContext(
        {
          name: "custom_players",
          resolveCreatorId: (ctx) => ctx.match?.[3],
          failureText: "❌ Only the game creator can modify this setup!",
        },
        async (ctx, { session, tokenContext, updateSession, creatorId }) => {
          try {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const amount = ctx.match![2] as string;

            const amountNumber = Number(amount);
            const formattedAmount = amountNumber.toLocaleString("en-US", {
              minimumFractionDigits: 0,
              maximumFractionDigits: determineFractionDigits(
                amount,
                tokenContext.tokenDecimals
              ),
            });

            const formattedGameType = toTitleCase(gameType);
            const minPlayers = gameType === "coinflip" ? 2 : 1;
            const maxPlayers = Math.max(minPlayers, deps.getOracleMaxPlayers());

            const playersMessage = [
              `👥 <b>Type Custom Players - ${formattedGameType}</b>`,
              "",
              `Amount: <b>${formattedAmount} ${tokenContext.tokenTicker}</b>`,
              "",
              "Please type the number of players for this game.",
              "",
              `Range: ${minPlayers}-${maxPlayers} players`,
            ].join("\n");

            await respondWithMenu(ctx, {
              text: playersMessage,
              parseMode: "HTML",
              keyboard: new InlineKeyboard()
                .text("❌ Cancel", `cancel_game_setup_${creatorId}`)
                .row(),
            });

            await safeAnswerCallbackQuery(ctx, "Type the number of players...");

            updateSession({
              waitingFor: "players_input",
              gameType,
              userBalance: 0,
              amount,
              messageId: ctx.callbackQuery?.message?.message_id || 0,
              chatId: ctx.chat?.id || 0,
              contractMinimum: session?.contractMinimum,
              maxPlayersLimit: maxPlayers,
            });
          } catch (error) {
            console.error(
              "Error in creator-protected custom_players callback:",
              error
            );
            await safeAnswerCallbackQuery(
              ctx,
              "❌ Error setting up players input"
            );
          }
        }
      )
    );

    deps.bot.callbackQuery("noop", async (ctx) => {
      await safeAnswerCallbackQuery(ctx);
    });

    deps.bot.callbackQuery(
      /^cancel_game_setup_(\d+)$/,
      deps.withCreatorContext(
        {
          name: "cancel_game_setup",
          resolveCreatorId: (ctx) => ctx.match?.[1],
          failureText: "❌ Only the game creator can cancel this setup!",
        },
        async (ctx, { clearSession }) => {
          try {
            clearSession();

            await respondWithMenu(ctx, {
              text: "❌ Game creation cancelled.",
              parseMode: "HTML",
            });
            await safeAnswerCallbackQuery(ctx, "Cancelled");
          } catch (error) {
            console.error("Error in creator-protected cancel callback:", error);
            await safeAnswerCallbackQuery(ctx, "❌ Error cancelling");
          }
        }
      )
    );

    deps.bot.callbackQuery(
      /^back_to_amounts_(coinflip|giveaway)_(\d+)$/,
      deps.withCreatorContext(
        {
          name: "back_to_amounts",
          resolveCreatorId: (ctx) => ctx.match?.[2],
          failureText: "❌ Only the game creator can modify this setup!",
        },
        async (ctx, { session, tokenContext, clearSession, creatorId }) => {
          try {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const telegramId = await getRequiredTelegramIdForContext(
              ctx,
              "amount selection"
            );
            if (telegramId == null) {
              await safeAnswerCallbackQuery(ctx, "Unable to identify user");
              return;
            }

            let userBalance =
              session?.userBalance && session.userBalance > 0
                ? session.userBalance
                : 0;
            if (userBalance <= 0) {
              try {
                const tokenBalance = await deps.wallet.getTokenBalance(
                  telegramId,
                  tokenContext.tokenMint
                );
                userBalance =
                  tokenBalance / Math.pow(10, tokenContext.tokenDecimals);
              } catch (error) {
                console.error("Error getting balance:", error);
              }
            }

            const { formatted: contractMin } =
              tokenContext.contractMinimum !== undefined
                ? { formatted: tokenContext.contractMinimum }
                : await deps.getContractMinimumAmount(
                    tokenContext.tokenMint,
                    tokenContext.tokenDecimals
                  );

            const tokenPriceUSD = await deps.fetchTokenPriceUSD({
              tokenMint: tokenContext.tokenMint,
              tokenTicker: tokenContext.tokenTicker,
            });

            const suggestedAmounts = getSuggestedStakeAmounts(
              contractMin,
              userBalance,
              tokenPriceUSD ?? undefined
            );

            clearSession();

            let warningMessage = getFeeWarningMessage(
              gameType,
              userBalance,
              contractMin,
              tokenContext.tokenTicker
            );

            const suggestionLabel =
              deps.gameSetupCopy[gameType]?.suggestionLabel;

            if (suggestionLabel && suggestedAmounts.length > 0) {
              warningMessage += `\n\n${suggestionLabel}:\n`;
              for (const { amount, usdTarget } of suggestedAmounts) {
                const amountDisplay = formatTokenDisplay(amount, {
                  decimals: tokenContext.tokenDecimals,
                });
                warningMessage += `• ${amountDisplay} ${tokenContext.tokenTicker}`;
                if (usdTarget !== undefined) {
                  const usdFormatted = formatUsdValue(usdTarget, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  });
                  warningMessage += ` ($${usdFormatted})`;
                } else if (tokenPriceUSD) {
                  const usdFormatted = formatUsdValue(amount * tokenPriceUSD, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 2,
                  });
                  warningMessage += ` ($${usdFormatted})`;
                }
                warningMessage += "\n";
              }
            }

            await respondWithMenu(ctx, {
              text: warningMessage,
              parseMode: "HTML",
              keyboard: createAmountSelectionKeyboard(
                gameType,
                userBalance,
                creatorId,
                contractMin,
                {
                  decimals: tokenContext.tokenDecimals,
                  tokenPriceUSD: tokenPriceUSD ?? undefined,
                }
              ),
            });

            await safeAnswerCallbackQuery(ctx);
          } catch (error) {
            console.error(
              "Error in creator-protected back_to_amounts callback:",
              error
            );
            await safeAnswerCallbackQuery(ctx, "❌ Error going back");
          }
        }
      )
    );

    deps.bot.callbackQuery(
      /^type_amount_(coinflip|giveaway)_(\d+)$/,
      deps.withCreatorContext(
        {
          name: "type_amount",
          resolveCreatorId: (ctx) => ctx.match?.[2],
          failureText: "❌ Only the game creator can modify this setup!",
        },
        async (ctx, { session, tokenContext, updateSession, creatorId }) => {
          try {
            const gameType = ctx.match![1] as "coinflip" | "giveaway";
            const telegramId = await getRequiredTelegramIdForContext(
              ctx,
              "type amount prompt"
            );
            if (telegramId == null) {
              await safeAnswerCallbackQuery(ctx, "Unable to identify user");
              return;
            }

            let userBalance =
              session?.userBalance && session.userBalance > 0
                ? session.userBalance
                : 0;
            if (userBalance <= 0) {
              try {
                const tokenBalance = await deps.wallet.getTokenBalance(
                  telegramId,
                  tokenContext.tokenMint
                );
                userBalance =
                  tokenBalance / Math.pow(10, tokenContext.tokenDecimals);
              } catch (error) {
                console.error("Error getting balance:", error);
              }
            }

            const { formatted: contractMin } =
              tokenContext.contractMinimum !== undefined
                ? { formatted: tokenContext.contractMinimum }
                : await deps.getContractMinimumAmount(
                    tokenContext.tokenMint,
                    tokenContext.tokenDecimals
                  );

            await presentCustomAmountPrompt({
              ctx,
              gameType,
              tokenTicker: tokenContext.tokenTicker,
              contractMin,
              creatorId,
            });

            await safeAnswerCallbackQuery(ctx, "Type your amount...");

            updateSession({
              waitingFor: "amount_input",
              gameType,
              userBalance,
              messageId: ctx.callbackQuery?.message?.message_id || 0,
              chatId: ctx.chat?.id || 0,
              contractMinimum: contractMin,
              amount: session?.amount,
            });
          } catch (error) {
            console.error(
              "Error in creator-protected type_amount callback:",
              error
            );
            await safeAnswerCallbackQuery(
              ctx,
              "❌ Error setting up text input"
            );
          }
        }
      )
    );
  };

  const createTextInputMiddleware = (): MiddlewareFn<Context> => {
    return async (ctx, next) => {
      if (ctx.message?.text === undefined) {
        await next();
        return;
      }

      await handleGameSetupTextInput(ctx, next);
    };
  };

  return {
    registerHandlers,
    createTextInputMiddleware,
    __test_handleGameSetupTextInput: handleGameSetupTextInput,
    __test_handleJoinGame: handleJoinGame,
    __test_shouldSkipGenericGameCallback: shouldSkipGenericGameCallback,
  };
};
