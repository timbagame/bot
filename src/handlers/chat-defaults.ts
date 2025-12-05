import { InlineKeyboard, type Bot, type Context } from "grammy";

import {
  DEFAULT_COINFLIP_MAX_PLAYERS,
  DEFAULT_GAME_TIMEOUT,
  DEFAULT_GIVEAWAY_MAX_PLAYERS,
  DEFAULT_TOKEN_TICKER,
  INPUT_TIMEOUT_HINT,
  MAX_GAME_TIMEOUT,
  MIN_COINFLIP_PLAYERS,
  MIN_GAME_TIMEOUT,
  MIN_GIVEAWAY_PLAYERS,
} from "../utils/constants";
import {
  clampChatPlayers,
  clampGameTimeout,
  resolveChatDefaultPlayers,
  resolveChatTimeout,
} from "../utils/chat-settings";
import { escapeHtml } from "../utils/format-amount";
import { respondWithMenu } from "../utils/menu-response";
import { createCancelKeyboard } from "../utils/keyboards";
import {
  getTelegramId,
  getTelegramIdString,
  safeAnswerCallbackQuery,
} from "../utils/context-helpers";
import {
  clearInputSession,
  setInputSession,
  type InputSessionState,
} from "../utils/user-state";
import type { ChatDatabase } from "../utils/chat-database";
import type { TokenManager } from "../utils/token-manager";
import type { GameManager } from "../utils/game";
import type { WrapCallbackHandler } from "../utils/callback-registry";

const formatDefaultTokenSetMessage = (tokenTicker: string, tokenMint: string) => {
  const safeTicker = escapeHtml(tokenTicker);
  const safeMint = escapeHtml(tokenMint);
  return (
    `✅ Default token set to ${safeTicker}\n` +
    `🏷️ Token mint: <code>${safeMint}</code>\n\n` +
    `All games and transactions will now use ${safeTicker} by default unless specified otherwise.`
  );
};

const formatPlayersLine = (
  label: string,
  value: number | null,
  fallback: number
): string => {
  const displayValue = value ?? fallback;
  const suffix = value == null ? "(bot default)" : "(chat default)";
  return `${label}: ${displayValue} ${suffix}`;
};

const formatTimeoutLine = (timeoutSeconds: number, isDefault: boolean): string => {
  const minutes = Math.round(timeoutSeconds / 60);
  const suffix = isDefault ? "(bot default)" : "(chat default)";
  return `⏱️ Game timeout: ${timeoutSeconds}s (${minutes}m) ${suffix}`;
};

type SettingsTarget = "token" | "coinflip" | "giveaway" | "timeout";

type ChatDefaultsModuleDeps = {
  bot: Bot;
  chatDb: ChatDatabase;
  getTokenManager: () => TokenManager;
  getGameManager: () => GameManager;
  wrapCallbackHandler: WrapCallbackHandler;
  getOracleMaxPlayers: () => number;
  isUserGroupAdmin: (ctx: Context, userId: number) => Promise<boolean>;
  replyToMessage: (ctx: Context, text: string) => Promise<void>;
};

export type ChatDefaultsModule = {
  handleDefaultCommand: (ctx: Context, args?: string[]) => Promise<void>;
  handleSettingsInput: (
    ctx: Context,
    session: InputSessionState,
    userMessage: string
  ) => Promise<boolean>;
};

const buildMenuKeyboard = (): InlineKeyboard => {
  return new InlineKeyboard()
    .text("🪙 Default token", "chat_defaults_token")
    .row()
    .text("👥 Coinflip max players", "chat_defaults_coinflip")
    .row()
    .text("🎁 Giveaway max players", "chat_defaults_giveaway")
    .row()
    .text("⏱️ Game timeout", "chat_defaults_timeout")
    .row();
};

const buildSettingsSummary = async (
  chatId: number,
  deps: ChatDefaultsModuleDeps
): Promise<string> => {
  const tokenManager = deps.getTokenManager();
  const chatToken = tokenManager.getChatDefaultToken(chatId);
  const defaultToken = tokenManager.getDefaultToken();
  const chatSettings = deps.chatDb.getChatGameSettings(chatId);
  const gameManager = deps.getGameManager();

  let tokenLine = `🪙 Default token: ${escapeHtml(DEFAULT_TOKEN_TICKER)} (bot default)`;

  if (chatToken) {
    const setBy = await gameManager.getUsernameFromTelegramId(
      undefined as any,
      chatToken.set_by_telegram_id
    );
    const setByDisplay = setBy ? `@${escapeHtml(setBy)}` : "Unknown user";
    tokenLine =
      `🪙 Default token: ${escapeHtml(chatToken.token_ticker)} (set by ${setByDisplay})` +
      `\n🏷️ Mint: <code>${escapeHtml(chatToken.token_mint)}</code>`;
  } else if (defaultToken) {
    tokenLine =
      `🪙 Default token: ${escapeHtml(defaultToken.tokenTicker)} (bot default)` +
      `\n🏷️ Mint: <code>${escapeHtml(defaultToken.tokenMint)}</code>`;
  }

  const coinflipPlayers = resolveChatDefaultPlayers(
    chatSettings,
    "coinflip",
    DEFAULT_COINFLIP_MAX_PLAYERS,
    deps.getOracleMaxPlayers()
  );
  const giveawayPlayers = resolveChatDefaultPlayers(
    chatSettings,
    "giveaway",
    DEFAULT_GIVEAWAY_MAX_PLAYERS,
    deps.getOracleMaxPlayers()
  );

  const timeoutSeconds = resolveChatTimeout(
    chatSettings,
    DEFAULT_GAME_TIMEOUT
  );

  return [
    "<b>Chat defaults</b>",
    "",
    tokenLine,
    formatPlayersLine(
      "👥 Coinflip players",
      chatSettings?.coinflip_max_players ?? null,
      coinflipPlayers
    ),
    formatPlayersLine(
      "🎁 Giveaway players",
      chatSettings?.giveaway_max_players ?? null,
      giveawayPlayers
    ),
    formatTimeoutLine(timeoutSeconds, chatSettings?.timeout_seconds == null),
    "",
    "Use the buttons below to update chat defaults.",
  ].join("\n");
};

const ensureAdmin = async (ctx: Context, deps: ChatDefaultsModuleDeps) => {
  const telegramId = getTelegramId(ctx);
  if (telegramId === 0n) {
    await deps.replyToMessage(ctx, "🔒 Unable to verify permissions for this user.");
    return false;
  }

  const isAdmin = await deps.isUserGroupAdmin(ctx, Number(telegramId));
  if (!isAdmin) {
    await deps.replyToMessage(
      ctx,
      "🔒 Only group administrators can update chat defaults.\n\n💡 Contact a group admin to change these settings."
    );
    return false;
  }

  return true;
};

const handleTokenChange = async (
  ctx: Context,
  tokenInput: string,
  deps: ChatDefaultsModuleDeps
): Promise<void> => {
  const tokenManager = deps.getTokenManager();
  const knownToken = tokenManager.getKnownTokenByTicker(tokenInput);
  if (!knownToken) {
    const allTokens = tokenManager.getAllKnownTokens();
    const escapedTokenInput = escapeHtml(tokenInput.toUpperCase());
    let response = `❌ Token "${escapedTokenInput}" not found.\n\n`;

    if (allTokens.length > 0) {
      response += "📋 Known tokens:\n";
      for (const token of allTokens.slice(0, 10)) {
        response += `• ${escapeHtml(token.token_ticker)}\n`;
      }
      if (allTokens.length > 10) {
        response += `... and ${allTokens.length - 10} more.`;
      }
    } else {
      response += "💡 Contact the bot administrator to add new tokens.";
    }

    await deps.replyToMessage(ctx, response);
    return;
  }

  tokenManager.setChatDefaultToken(
    ctx.chat!.id,
    knownToken.token_mint,
    knownToken.token_ticker,
    getTelegramId(ctx).toString()
  );

  await deps.replyToMessage(
    ctx,
    formatDefaultTokenSetMessage(knownToken.token_ticker, knownToken.token_mint)
  );
};

const promptForSetting = async (
  ctx: Context,
  deps: ChatDefaultsModuleDeps,
  target: SettingsTarget
): Promise<void> => {
  const messageLines: string[] = [];
  if (target === "token") {
    messageLines.push(
      "Send the SPL token ticker you want to set as the chat default.",
      "Use 'clear' to remove the chat default token.",
      "",
      INPUT_TIMEOUT_HINT
    );
  } else if (target === "timeout") {
    messageLines.push(
      "Send the default game timeout in seconds.",
      `Must be between ${MIN_GAME_TIMEOUT}-${MAX_GAME_TIMEOUT} seconds.`,
      "",
      INPUT_TIMEOUT_HINT
    );
  } else {
    const minPlayers = target === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;
    messageLines.push(
      "Send the default maximum players for new games.",
      `Must be between ${minPlayers}-${deps.getOracleMaxPlayers()} players.`,
      "Use 'clear' to reset to bot default.",
      "",
      INPUT_TIMEOUT_HINT
    );
  }

  const { messageId, chatId } = await respondWithMenu(ctx, {
    text: messageLines.join("\n"),
    parseMode: "HTML",
    keyboard: createCancelKeyboard("chat_defaults_cancel"),
  });

  if (messageId == null || chatId == null) {
    return;
  }

  setInputSession(`${chatId}_${messageId}`, {
    type: "chat_defaults",
    setting: target,
    messageId,
    chatId,
    initiatorId: getTelegramIdString(ctx),
  });
};

const handlePlayersUpdate = async (
  ctx: Context,
  deps: ChatDefaultsModuleDeps,
  input: string,
  target: Exclude<SettingsTarget, "token" | "timeout">
): Promise<void> => {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const telegramId = getTelegramId(ctx);
  const maxLimit = deps.getOracleMaxPlayers();
  const minValue = target === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;

  if (/^(clear|remove)$/i.test(input.trim())) {
    deps.chatDb.upsertChatGameSettings(chatId, {
      coinflip_max_players: target === "coinflip" ? null : undefined,
      giveaway_max_players: target === "giveaway" ? null : undefined,
      set_by_telegram_id: telegramId.toString(),
    });
    await deps.replyToMessage(ctx, "✅ Reset to bot default.");
    return;
  }

  const parsed = Number.parseInt(input.trim(), 10);
  const clamped = clampChatPlayers(parsed, target, maxLimit);
  if (clamped === null || Number.isNaN(parsed)) {
    await deps.replyToMessage(
      ctx,
      `❌ Invalid number. Please enter a value between ${minValue}-${maxLimit}.`
    );
    return;
  }

  deps.chatDb.upsertChatGameSettings(chatId, {
    coinflip_max_players: target === "coinflip" ? clamped : undefined,
    giveaway_max_players: target === "giveaway" ? clamped : undefined,
    set_by_telegram_id: telegramId.toString(),
  });

  await deps.replyToMessage(
    ctx,
    target === "coinflip"
      ? `✅ Default coinflip players set to ${clamped}.`
      : `✅ Default giveaway players set to ${clamped}.`
  );
};

const handleTimeoutUpdate = async (
  ctx: Context,
  deps: ChatDefaultsModuleDeps,
  input: string
): Promise<void> => {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const telegramId = getTelegramId(ctx);

  if (/^(clear|remove)$/i.test(input.trim())) {
    deps.chatDb.upsertChatGameSettings(chatId, {
      timeout_seconds: null,
      set_by_telegram_id: telegramId.toString(),
    });
    await deps.replyToMessage(ctx, "✅ Reset timeout to bot default.");
    return;
  }

  const parsed = Number.parseInt(input.trim(), 10);
  if (!Number.isFinite(parsed)) {
    await deps.replyToMessage(ctx, "❌ Please enter a valid number of seconds.");
    return;
  }

  const clamped = clampGameTimeout(parsed);
  deps.chatDb.upsertChatGameSettings(chatId, {
    timeout_seconds: clamped,
    set_by_telegram_id: telegramId.toString(),
  });

  await deps.replyToMessage(
    ctx,
    `✅ Default game timeout set to ${clamped} seconds.`
  );
};

export const createChatDefaultsModule = (
  deps: ChatDefaultsModuleDeps
): ChatDefaultsModule => {
  const renderMenu = async (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;

    const summary = await buildSettingsSummary(chatId, deps);

    await respondWithMenu(ctx, {
      text: summary,
      parseMode: "HTML",
      keyboard: buildMenuKeyboard(),
    });
  };

  const handleDefaultCommand = async (
    ctx: Context,
    args: string[] = []
  ): Promise<void> => {
    if (ctx.chat?.type === "private") {
      await deps.replyToMessage(
        ctx,
        "🚫 Default tokens can only be set in groups or channels."
      );
      return;
    }

    if (!args || args.length < 2) {
      await renderMenu(ctx);
      return;
    }

    const hasAdmin = await ensureAdmin(ctx, deps);
    if (!hasAdmin) return;

    const tokenInput = args[1];
    if (!tokenInput) {
      await deps.replyToMessage(ctx, "Please provide a token ticker.");
      return;
    }

    if (
      tokenInput.toUpperCase() === "CLEAR" ||
      tokenInput.toUpperCase() === "REMOVE"
    ) {
      deps.getTokenManager().removeChatDefaultToken(ctx.chat!.id);
      await deps.replyToMessage(
        ctx,
        "✅ Default token cleared for this chat. Using bot default token now."
      );
      return;
    }

    await handleTokenChange(ctx, tokenInput, deps);
  };

  deps.bot.callbackQuery(
    /^chat_defaults_(token|coinflip|giveaway|timeout)$/,
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;
      const action = ctx.match?.[1] as SettingsTarget | undefined;
      if (!action) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      await promptForSetting(ctx, deps, action);
      await safeAnswerCallbackQuery(ctx);
    })
  );

  deps.bot.callbackQuery(
    "chat_defaults_cancel",
    deps.wrapCallbackHandler(async (ctx) => {
      clearInputSession(
        `${ctx.chat?.id || 0}_${ctx.callbackQuery?.message?.message_id}`
      );
      await renderMenu(ctx);
      await safeAnswerCallbackQuery(ctx, "Cancelled");
    })
  );

  const handleSettingsInput = async (
    ctx: Context,
    session: InputSessionState,
    userMessage: string
  ): Promise<boolean> => {
    if (session.type !== "chat_defaults") return false;

    const telegramId = getTelegramId(ctx);
    const admin = await deps.isUserGroupAdmin(ctx, Number(telegramId));
    if (!admin) {
      await deps.replyToMessage(
        ctx,
        "🔒 Only group administrators can update chat defaults."
      );
      return true;
    }

    const setting = session["setting"] as SettingsTarget | undefined;

    if (setting === "token") {
      await handleTokenChange(ctx, userMessage, deps);
    } else if (setting === "timeout") {
      await handleTimeoutUpdate(ctx, deps, userMessage);
    } else {
      await handlePlayersUpdate(
        ctx,
        deps,
        userMessage,
        setting as Exclude<SettingsTarget, "token" | "timeout">
      );
    }

    await renderMenu(ctx);
    return true;
  };

  return { handleDefaultCommand, handleSettingsInput };
};

export const __test_buildSettingsSummary = buildSettingsSummary;
