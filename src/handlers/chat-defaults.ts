import { InlineKeyboard, type Bot, type Context } from "grammy";
import { GameDatabase } from "../utils/game-database";
import { formatDuration } from "../utils/format-time";

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
  CHAT_MEDIA_DISABLED_SENTINEL,
  DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL,
  DEFAULT_JOIN_NOTIFICATIONS_PER_MINUTE,
  MAX_JOIN_NOTIFICATIONS_PER_MINUTE,
} from "../utils/constants";
import {
  clampChatPlayers,
  clampGameTimeout,
  resolveChatDefaultPlayers,
  resolveChatTimeout,
} from "../utils/chat-settings";
import { escapeHtml } from "../utils/format-amount";
import { respondWithMenu } from "../utils/menu-response";
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
  const formatted = formatDuration(timeoutSeconds);
  const suffix = isDefault ? "(bot default)" : "(chat default)";
  return `⏱️ Game timeout: ${formatted} ${suffix}`;
};

type SettingsTarget = "token" | "coinflip" | "giveaway" | "timeout" | "privacy_coinflip" | "privacy_giveaway" | "video_coinflip" | "video_giveaway";

type ChatDefaultsModuleDeps = {
  bot: Bot;
  chatDb: ChatDatabase;
  gameDb: GameDatabase;
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
    .row()
    .text("👁️ Coinflip privacy", "chat_defaults_privacy_coinflip")
    .row()
    .text("👁️ Giveaway privacy", "chat_defaults_privacy_giveaway")
    .row()
    .text("🎬 Coinflip video", "chat_defaults_video_coinflip")
    .row()
    .text("🎬 Giveaway video", "chat_defaults_video_giveaway")
    .row()
    .text("📢 Join notifications", "chat_defaults_join_notifications")
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

  let tokenLine = `🪙 Default token: ${escapeHtml(DEFAULT_TOKEN_TICKER)} (bot default)`;

  if (chatToken) {
    // Look up display name from game database (username mappings)
    const setByDisplayName = deps.gameDb.getPlayerDisplayName(chatToken.set_by_telegram_id);
    const setByDisplay = setByDisplayName
      ? (setByDisplayName.startsWith('@') ? escapeHtml(setByDisplayName) : `@${escapeHtml(setByDisplayName)}`)
      : `User ${chatToken.set_by_telegram_id}`;
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

  const coinflipPrivacy = chatSettings?.coinflip_default_privacy;
  const isCoinflipPrivate = coinflipPrivacy !== "public";
  const coinflipSuffix = coinflipPrivacy ? "(chat default)" : "(bot default)";
  const coinflipPrivacyLine = `👁️ Coinflip privacy: ${isCoinflipPrivate ? "Private 🔒" : "Public 🌍"} ${coinflipSuffix}`;

  const giveawayPrivacy = chatSettings?.giveaway_default_privacy;
  const isGiveawayPrivate = giveawayPrivacy !== "public";
  const giveawaySuffix = giveawayPrivacy ? "(chat default)" : "(bot default)";
  const giveawayPrivacyLine = `👁️ Giveaway privacy: ${isGiveawayPrivate ? "Private 🔒" : "Public 🌍"} ${giveawaySuffix}`;

  let coinflipVideoSuffix = "(bot default)";
  let coinflipVideoDisplay = "Using bot default";
  if (chatSettings) {
    const videoId = chatSettings.coinflip_video_id;
    if (videoId === CHAT_MEDIA_DISABLED_SENTINEL) {
      coinflipVideoSuffix = "(disabled)";
      coinflipVideoDisplay = "Disabled - text only";
    } else if (videoId === "") {
      // Explicitly cleared - use bot default
      coinflipVideoSuffix = "(bot default)";
      coinflipVideoDisplay = "Using bot default";
    } else if (videoId && videoId.length > 0) {
      coinflipVideoSuffix = "(chat default)";
      coinflipVideoDisplay = `${escapeHtml(videoId.substring(0, 20))}...`;
    }
    // If videoId is null, it means not set yet - use bot default (default values already set)
  }
  const coinflipVideoLine = `🎬 Coinflip video: ${coinflipVideoDisplay} ${coinflipVideoSuffix}`;

  let giveawayVideoSuffix = "(bot default)";
  let giveawayVideoDisplay = "Using bot default";
  if (chatSettings) {
    const videoId = chatSettings.giveaway_video_id;
    if (videoId === CHAT_MEDIA_DISABLED_SENTINEL) {
      giveawayVideoSuffix = "(disabled)";
      giveawayVideoDisplay = "Disabled - text only";
    } else if (videoId === "") {
      // Explicitly cleared - use bot default
      giveawayVideoSuffix = "(bot default)";
      giveawayVideoDisplay = "Using bot default";
    } else if (videoId && videoId.length > 0) {
      giveawayVideoSuffix = "(chat default)";
      giveawayVideoDisplay = `${escapeHtml(videoId.substring(0, 20))}...`;
    }
    // If videoId is null, it means not set yet - use bot default (default values already set)
  }
  const giveawayVideoLine = `🎬 Giveaway video: ${giveawayVideoDisplay} ${giveawayVideoSuffix}`;

  // Join notification settings
  const joinNotificationsExternal = chatSettings?.join_notifications_external ?? DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL;
  const joinNotificationsPerMinute = chatSettings?.join_notifications_per_minute ?? DEFAULT_JOIN_NOTIFICATIONS_PER_MINUTE;
  const externalSuffix = chatSettings?.join_notifications_external != null ? "(chat default)" : "(bot default)";
  const rateSuffix = chatSettings?.join_notifications_per_minute != null ? "(chat default)" : "(bot default)";

  const externalDisplay = joinNotificationsExternal ? "✅ On" : "❌ Off";
  const rateDisplay = joinNotificationsPerMinute === 0 ? "Disabled" : `${joinNotificationsPerMinute}/min`;

  const joinNotificationsLine = `📢 Join notifications: External ${externalDisplay} ${externalSuffix} | Rate: ${rateDisplay} ${rateSuffix}`;

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
    coinflipPrivacyLine,
    giveawayPrivacyLine,
    coinflipVideoLine,
    giveawayVideoLine,
    joinNotificationsLine,
    "",
    "Use the buttons below to update chat defaults.",
  ].join("\n");
};

const ensureAdmin = async (ctx: Context, deps: ChatDefaultsModuleDeps) => {
  const telegramId = getTelegramId(ctx);
  if (telegramId === 0n) return false;

  const isAdmin = await deps.isUserGroupAdmin(ctx, Number(telegramId));
  return isAdmin;
};

const handleTokenChange = async (
  ctx: Context,
  tokenInput: string,
  deps: ChatDefaultsModuleDeps
): Promise<void> => {
  // Handle 'clear' command to remove chat default token
  if (/^(clear|remove)$/i.test(tokenInput.trim())) {
    deps.getTokenManager().removeChatDefaultToken(ctx.chat!.id);
    await deps.replyToMessage(
      ctx,
      "✅ Default token cleared for this chat. Using bot default token now."
    );
    return;
  }

  const tokenManager = deps.getTokenManager();
  const knownToken = tokenManager.getKnownTokenByTicker(tokenInput);
  if (!knownToken) {
    const allTokens = tokenManager.getSupportedGameTokens();
    const escapedTokenInput = escapeHtml(tokenInput.toUpperCase());
    let response = `❌ Token "${escapedTokenInput}" not found.\n\n`;

    if (allTokens.length > 0) {
      response += "📋 Supported tokens:\n";
      for (const token of allTokens.slice(0, 10)) {
        response += `• ${escapeHtml(token.ticker)}\n`;
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
  } else if (target === "video_coinflip" || target === "video_giveaway") {
    const gameType = target === "video_coinflip" ? "coinflip" : "giveaway";
    messageLines.push(
      `Send a video, image, or GIF for the ${gameType} game.`,
      "",
      "Send the media directly (video, photo, or GIF).",
      "",
      INPUT_TIMEOUT_HINT
    );
  } else {
    const minPlayers = target === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;
    messageLines.push(
      "Send the default maximum players for new games.",
      `Must be between ${minPlayers}-${deps.getOracleMaxPlayers()} players.`,
      "",
      INPUT_TIMEOUT_HINT
    );
  }

  const keyboard = new InlineKeyboard()
    .text("❌ Restore defaults", `chat_defaults_clear_${target}`)
    .row()
    .text("🔙 Back", "chat_defaults_cancel");

  const { messageId, chatId } = await respondWithMenu(ctx, {
    text: messageLines.join("\n"),
    parseMode: "HTML",
    keyboard,
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
  target: "coinflip" | "giveaway"
): Promise<void> => {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const telegramId = getTelegramId(ctx);
  const maxLimit = deps.getOracleMaxPlayers();
  const minValue = target === "coinflip" ? MIN_COINFLIP_PLAYERS : MIN_GIVEAWAY_PLAYERS;

  if (/^(clear|remove)$/i.test(input.trim())) {
    // Only update the target field, don't touch the other one
    const updateData: any = {
      set_by_telegram_id: telegramId.toString(),
    };
    if (target === "coinflip") {
      updateData.coinflip_max_players = null;
    } else {
      updateData.giveaway_max_players = null;
    }
    deps.chatDb.upsertChatGameSettings(chatId, updateData);
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

  // Only update the target field, don't touch the other one
  const updateData: any = {
    set_by_telegram_id: telegramId.toString(),
  };
  if (target === "coinflip") {
    updateData.coinflip_max_players = clamped;
  } else {
    updateData.giveaway_max_players = clamped;
  }
  deps.chatDb.upsertChatGameSettings(chatId, updateData);

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
    `✅ Default game timeout set to ${formatDuration(clamped)}.`
  );
};

const handleVideoIdUpdate = async (
  ctx: Context,
  deps: ChatDefaultsModuleDeps,
  input: string,
  target: "video_coinflip" | "video_giveaway"
): Promise<void> => {
  const chatId = ctx.chat?.id;
  if (chatId == null) return;
  const telegramId = getTelegramId(ctx);

  if (/^(clear|remove)$/i.test(input.trim())) {
    // Clear means use bot default - set to empty string to indicate "use default"
    // Only update the target field, don't touch the other one
    const updateData: any = {
      set_by_telegram_id: telegramId.toString(),
    };
    if (target === "video_coinflip") {
      updateData.coinflip_video_id = "";
      updateData.coinflip_media_type = null;
    } else {
      updateData.giveaway_video_id = "";
      updateData.giveaway_media_type = null;
    }
    deps.chatDb.upsertChatGameSettings(chatId, updateData);
    await deps.replyToMessage(ctx, "✅ Reset to bot default.");
    return;
  }

  const videoId = input.trim();
  if (!videoId || videoId.length < 5) {
    await deps.replyToMessage(
      ctx,
      "❌ Invalid file ID. Please send a valid Telegram file ID."
    );
    return;
  }

  // Determine media type from context if available
  const message = (ctx as any).message;
  let mediaType: "photo" | "video" | "animation" = "video"; // default to video

  // Check if media type was stored in context (from media message handler)
  if ((ctx as any).__mediaType) {
    mediaType = (ctx as any).__mediaType;
  } else if (message?.video) {
    mediaType = "video";
  } else if (message?.photo && message.photo.length > 0) {
    mediaType = "photo";
  } else if (message?.animation) {
    mediaType = "animation";
  }

  // Only update the target field, don't touch the other one
  const updateData: any = {
    set_by_telegram_id: telegramId.toString(),
  };
  if (target === "video_coinflip") {
    updateData.coinflip_video_id = videoId;
    updateData.coinflip_media_type = mediaType;
  } else {
    updateData.giveaway_video_id = videoId;
    updateData.giveaway_media_type = mediaType;
  }
  deps.chatDb.upsertChatGameSettings(chatId, updateData);

  const mediaTypeLabel = mediaType === "photo" ? "image" : mediaType === "animation" ? "GIF" : "video";
  await deps.replyToMessage(
    ctx,
    target === "video_coinflip"
      ? `✅ Default coinflip ${mediaTypeLabel} set. New games will use this ${mediaTypeLabel}.`
      : `✅ Default giveaway ${mediaTypeLabel} set. New games will use this ${mediaTypeLabel}.`
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
    /^chat_defaults_clear_(token|coinflip|giveaway|timeout|video_coinflip|video_giveaway)$/,
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;
      const target = ctx.match?.[1] as
        | "token"
        | "coinflip"
        | "giveaway"
        | "timeout"
        | "video_coinflip"
        | "video_giveaway";
      if (!target) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      const chatId = ctx.chat.id;
      const telegramId = getTelegramId(ctx);

      if (target === "token") {
        deps.getTokenManager().removeChatDefaultToken(chatId);
      } else if (target === "timeout") {
        deps.chatDb.upsertChatGameSettings(chatId, {
          timeout_seconds: null,
          set_by_telegram_id: telegramId.toString(),
        });
      } else if (target === "coinflip") {
        deps.chatDb.upsertChatGameSettings(chatId, {
          coinflip_max_players: null,
          set_by_telegram_id: telegramId.toString(),
        });
      } else if (target === "giveaway") {
        deps.chatDb.upsertChatGameSettings(chatId, {
          giveaway_max_players: null,
          set_by_telegram_id: telegramId.toString(),
        });
      } else if (target === "video_coinflip") {
        // Clear means use bot default - set to empty string to indicate "use default"
        deps.chatDb.upsertChatGameSettings(chatId, {
          coinflip_video_id: "",
          coinflip_media_type: null,
          set_by_telegram_id: telegramId.toString(),
        });
      } else if (target === "video_giveaway") {
        // Clear means use bot default - set to empty string to indicate "use default"
        deps.chatDb.upsertChatGameSettings(chatId, {
          giveaway_video_id: "",
          giveaway_media_type: null,
          set_by_telegram_id: telegramId.toString(),
        });
      }

      // Clear input session if any
      clearInputSession(
        `${ctx.chat.id}_${ctx.callbackQuery?.message?.message_id}`
      );

      await renderMenu(ctx);
      await safeAnswerCallbackQuery(ctx, "Setting reset to default");
    })
  );

  deps.bot.callbackQuery(
    /^chat_defaults_(token|coinflip|giveaway|timeout|privacy_coinflip|privacy_giveaway|video_coinflip|video_giveaway|join_notifications)$/,
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;
      const action = ctx.match?.[1] as SettingsTarget | "join_notifications" | undefined;
      if (!action) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      if (action === "privacy_coinflip") {
        await respondWithMenu(ctx, {
          text: "Choose the default privacy setting for new Coinflip games.",
          keyboard: new InlineKeyboard()
            .text("🌍 Public", "chat_defaults_set_privacy_coinflip_public")
            .text("🔒 Private", "chat_defaults_set_privacy_coinflip_private")
            .row()
            .text("❌ Restore defaults", "chat_defaults_set_privacy_coinflip_clear")
            .row()
            .text("🔙 Back", "chat_defaults_cancel"),
        });
      } else if (action === "privacy_giveaway") {
        await respondWithMenu(ctx, {
          text: "Choose the default privacy setting for new Giveaway games.",
          keyboard: new InlineKeyboard()
            .text("🌍 Public", "chat_defaults_set_privacy_giveaway_public")
            .text("🔒 Private", "chat_defaults_set_privacy_giveaway_private")
            .row()
            .text("❌ Restore defaults", "chat_defaults_set_privacy_giveaway_clear")
            .row()
            .text("🔙 Back", "chat_defaults_cancel"),
        });
      } else if (action === "video_coinflip" || action === "video_giveaway") {
        const gameType = action === "video_coinflip" ? "coinflip" : "giveaway";
        await respondWithMenu(ctx, {
          text: `Choose an option for the ${gameType} game media.`,
          keyboard: new InlineKeyboard()
            .text("📤 Set custom media", `chat_defaults_set_${action}`)
            .row()
            .text("🚫 Disable (no media)", `chat_defaults_disable_${action}`)
            .row()
            .text("❌ Restore defaults", `chat_defaults_clear_${action}`)
            .row()
            .text("🔙 Back", "chat_defaults_cancel"),
        });
      } else if (action === "join_notifications") {
        const chatSettings = deps.chatDb.getChatGameSettings(ctx.chat.id);
        const currentExternal = chatSettings?.join_notifications_external ?? DEFAULT_JOIN_NOTIFICATIONS_EXTERNAL;
        const currentRate = chatSettings?.join_notifications_per_minute ?? DEFAULT_JOIN_NOTIFICATIONS_PER_MINUTE;

        const externalLabel = currentExternal ? "✅ External: On" : "❌ External: Off";
        const rateLabel = currentRate === 0 ? "Disabled" : `${currentRate}/min`;

        await respondWithMenu(ctx, {
          text: [
            "<b>Join Notification Settings</b>",
            "",
            "<b>External notifications:</b> Show join messages for games created in other groups",
            `Current: ${externalLabel}`,
            "",
            `<b>Rate limit:</b> Max join notifications per minute (max ${MAX_JOIN_NOTIFICATIONS_PER_MINUTE})`,
            `Current: ${rateLabel}`,
          ].join("\n"),
          parseMode: "HTML",
          keyboard: new InlineKeyboard()
            .text(currentExternal ? "🔕 Disable External" : "🔔 Enable External",
              currentExternal ? "chat_defaults_set_join_external_off" : "chat_defaults_set_join_external_on")
            .row()
            .text("0", "chat_defaults_set_join_rate_0")
            .text("1", "chat_defaults_set_join_rate_1")
            .text("5", "chat_defaults_set_join_rate_5")
            .text("10", "chat_defaults_set_join_rate_10")
            .row()
            .text("✏️ Custom", "chat_defaults_set_join_rate_custom")
            .row()
            .text("❌ Restore defaults", "chat_defaults_clear_join_notifications")
            .row()
            .text("🔙 Back", "chat_defaults_cancel"),
        });
      } else {
        await promptForSetting(ctx, deps, action);
      }
      await safeAnswerCallbackQuery(ctx);
    })
  );

  deps.bot.callbackQuery(
    /^chat_defaults_set_(video_coinflip|video_giveaway)$/,
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;
      const target = ctx.match?.[1] as "video_coinflip" | "video_giveaway";
      if (!target) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      await promptForSetting(ctx, deps, target);
      await safeAnswerCallbackQuery(ctx);
    })
  );

  deps.bot.callbackQuery(
    /^chat_defaults_disable_(video_coinflip|video_giveaway)$/,
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;
      const target = ctx.match?.[1] as "video_coinflip" | "video_giveaway";
      if (!target) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      const chatId = ctx.chat.id;
      const telegramId = getTelegramId(ctx);
      const gameType = target === "video_coinflip" ? "coinflip" : "giveaway";

      // Only update the target field, don't touch the other one
      const updateData: any = {
        set_by_telegram_id: telegramId.toString(),
      };
      if (target === "video_coinflip") {
        updateData.coinflip_video_id = CHAT_MEDIA_DISABLED_SENTINEL;
        updateData.coinflip_media_type = null;
      } else {
        updateData.giveaway_video_id = CHAT_MEDIA_DISABLED_SENTINEL;
        updateData.giveaway_media_type = null;
      }
      deps.chatDb.upsertChatGameSettings(chatId, updateData);

      await renderMenu(ctx);
      await safeAnswerCallbackQuery(
        ctx,
        `${gameType} media disabled - games will send text only`
      );
    })
  );

  deps.bot.callbackQuery(
    /^chat_defaults_set_privacy_(coinflip|giveaway)_(public|private|clear)$/,
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      const target = ctx.match![1] as "coinflip" | "giveaway";
      const value = ctx.match![2];
      const telegramId = getTelegramId(ctx);
      let newPrivacy: "public" | "private" | undefined | null = null;

      if (value === "public") newPrivacy = "public";
      else if (value === "private") newPrivacy = "private";
      else if (value === "clear") newPrivacy = null;

      const updateData: any = {
        set_by_telegram_id: telegramId.toString(),
      };

      if (target === "coinflip") {
        updateData.coinflip_default_privacy = newPrivacy;
      } else if (target === "giveaway") {
        updateData.giveaway_default_privacy = newPrivacy;
      }

      deps.chatDb.upsertChatGameSettings(ctx.chat.id, updateData);

      await renderMenu(ctx);
      await safeAnswerCallbackQuery(
        ctx,
        value === "clear" ? "Privacy setting reset" : "Privacy setting updated"
      );
    })
  );

  // Join notification external toggle handler
  deps.bot.callbackQuery(
    /^chat_defaults_set_join_external_(on|off)$/,
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      const value = ctx.match![1] === "on";
      const telegramId = getTelegramId(ctx);

      deps.chatDb.upsertChatGameSettings(ctx.chat.id, {
        join_notifications_external: value,
        set_by_telegram_id: telegramId.toString(),
      });

      await renderMenu(ctx);
      await safeAnswerCallbackQuery(
        ctx,
        value ? "External notifications enabled" : "External notifications disabled"
      );
    })
  );

  // Join notification rate limit handler (preset values)
  deps.bot.callbackQuery(
    /^chat_defaults_set_join_rate_(0|1|5|10)$/,
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      const rateString = ctx.match?.[1] ?? "5";
      const rate = parseInt(rateString, 10);
      const telegramId = getTelegramId(ctx);

      deps.chatDb.upsertChatGameSettings(ctx.chat.id, {
        join_notifications_per_minute: rate,
        set_by_telegram_id: telegramId.toString(),
      });

      const rateLabel = rate === 0 ? "disabled" : `${rate}/min`;
      await renderMenu(ctx);
      await safeAnswerCallbackQuery(ctx, `Rate limit set to ${rateLabel}`);
    })
  );

  // Join notification custom rate handler - prompt for input
  deps.bot.callbackQuery(
    "chat_defaults_set_join_rate_custom",
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      const keyboard = new InlineKeyboard().text("🔙 Back", "chat_defaults_cancel");
      await respondWithMenu(ctx, {
        text: `Enter a custom rate limit (0-${MAX_JOIN_NOTIFICATIONS_PER_MINUTE} per minute):`,
        keyboard,
      });

      const telegramIdStr = getTelegramIdString(ctx);
      setInputSession(`${ctx.chat.id}_${ctx.callbackQuery?.message?.message_id}`, {
        type: "chat_defaults",
        target: "join_rate_custom",
        chatId: ctx.chat.id,
        messageId: ctx.callbackQuery?.message?.message_id,
        initiatorId: telegramIdStr,
      });
      await safeAnswerCallbackQuery(ctx);
    })
  );

  // Join notification clear/reset handler
  deps.bot.callbackQuery(
    "chat_defaults_clear_join_notifications",
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return;

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      const telegramId = getTelegramId(ctx);

      deps.chatDb.upsertChatGameSettings(ctx.chat.id, {
        join_notifications_external: null,
        join_notifications_per_minute: null,
        set_by_telegram_id: telegramId.toString(),
      });

      await renderMenu(ctx);
      await safeAnswerCallbackQuery(ctx, "Join notifications reset to defaults");
    })
  );

  deps.bot.callbackQuery(
    "chat_defaults_cancel",
    deps.wrapCallbackHandler(async (ctx) => {
      if (!ctx.chat) return; // ensure chat context

      const allowed = await ensureAdmin(ctx, deps);
      if (!allowed) {
        await safeAnswerCallbackQuery(
          ctx,
          "Only admins can change chat defaults"
        );
        return;
      }

      clearInputSession(
        `${ctx.chat?.id || 0}_${ctx.callbackQuery?.message?.message_id}`
      );
      await renderMenu(ctx);
      await safeAnswerCallbackQuery(ctx);
    })
  );

  const handleSettingsInput = async (
    ctx: Context,
    session: InputSessionState,
    userMessage: string
  ): Promise<boolean> => {
    if (session.type !== "chat_defaults") return false;

    const initiatorId = session.initiatorId;
    const currentUserId = getTelegramIdString(ctx);
    if (
      typeof initiatorId === "string" &&
      initiatorId.length > 0 &&
      initiatorId !== currentUserId
    ) {
      await deps.replyToMessage(
        ctx,
        "❌ <b>This prompt is no longer active for you.</b>\n\nOpen the defaults menu again to continue."
      );
      return true;
    }

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
    const target = session["target"] as string | undefined;

    // Handle custom join rate input
    if (target === "join_rate_custom") {
      const chatId = session.chatId;
      if (typeof chatId !== "number") {
        await deps.replyToMessage(ctx, "❌ Session expired. Please try again.");
        return true;
      }

      const rate = parseInt(userMessage.trim(), 10);
      if (isNaN(rate) || rate < 0 || rate > MAX_JOIN_NOTIFICATIONS_PER_MINUTE) {
        await deps.replyToMessage(
          ctx,
          `❌ Invalid rate. Please enter a number between 0 and ${MAX_JOIN_NOTIFICATIONS_PER_MINUTE}.`
        );
        return true;
      }

      deps.chatDb.upsertChatGameSettings(chatId, {
        join_notifications_per_minute: rate,
        set_by_telegram_id: telegramId.toString(),
      });

      const rateLabel = rate === 0 ? "disabled" : `${rate}/min`;
      await deps.replyToMessage(ctx, `✅ Rate limit set to ${rateLabel}`);
      await renderMenu(ctx);
      return true;
    }

    // Check if user sent media for video ID settings
    if (setting === "video_coinflip" || setting === "video_giveaway") {
      const message = (ctx as any).message;
      let fileId: string | undefined;

      // Try to extract file ID from various media types
      // Note: Documents are rejected by the dedicated message:document handler in bot.ts
      if (message?.video) {
        fileId = message.video.file_id;
      } else if (message?.animation) {
        fileId = message.animation.file_id;
      } else if (message?.photo && message.photo.length > 0) {
        // Use the largest photo
        fileId = message.photo[message.photo.length - 1].file_id;
      }

      // Use file ID from media if available, otherwise use text input
      const videoIdInput = fileId || userMessage;
      await handleVideoIdUpdate(ctx, deps, videoIdInput, setting);
    } else if (setting === "token") {
      await handleTokenChange(ctx, userMessage, deps);
    } else if (setting === "timeout") {
      await handleTimeoutUpdate(ctx, deps, userMessage);
    } else if (setting === "coinflip" || setting === "giveaway") {
      await handlePlayersUpdate(ctx, deps, userMessage, setting);
    }

    await renderMenu(ctx);
    return true;
  };

  return { handleDefaultCommand, handleSettingsInput };
};

export const __test_buildSettingsSummary = buildSettingsSummary;
