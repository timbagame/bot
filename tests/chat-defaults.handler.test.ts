import { beforeEach, describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import {
  createChatDefaultsModule,
  isChatDefaultsMediaSetting,
  __test_buildMenuKeyboard,
  __test_buildSettingsSummary,
} from "../src/handlers/chat-defaults";
import { ChatDatabase } from "../src/utils/chat-database";
import { GameDatabase } from "../src/utils/game-database";
import { resetTestDatabase } from "./helpers/database";
import {
  clearAllInputSessions,
  findInputSession,
  type InputSessionState,
} from "../src/utils/user-state";

const bot = new Bot("test-token");

const createMockBot = () => {
  const listeners: Array<{ trigger: RegExp | string; handler: any }> = [];
  return {
    callbackQuery: (trigger: RegExp | string, handler: any) => {
      listeners.push({ trigger, handler });
    },
    dispatch: async (callbackData: string, ctx: any) => {
      for (const listener of listeners) {
        if (listener.trigger instanceof RegExp) {
          const match = callbackData.match(listener.trigger);
          if (match) {
            ctx.match = match;
            await listener.handler(ctx);
            return true;
          }
        } else if (listener.trigger === callbackData) {
          await listener.handler(ctx);
          return true;
        }
      }
      return false;
    },
  };
};

const baseTokenManager = () => {
  let chatDefault: any = null;
  return {
    getChatDefaultToken: () => chatDefault,
    setChatDefaultToken: (
      chatId: number,
      tokenMint: string,
      tokenTicker: string,
      setBy: string,
    ) => {
      chatDefault = {
        chat_id: chatId,
        token_mint: tokenMint,
        token_ticker: tokenTicker,
        set_by_telegram_id: setBy,
        set_at: Date.now(),
      };
    },
    removeChatDefaultToken: () => {
      chatDefault = null;
    },
    getDefaultToken: () => ({ tokenTicker: "DEF", tokenMint: "mint" }),
    getKnownTokenByTicker: (ticker: string) =>
      ticker.toUpperCase() === "AAA"
        ? { token_mint: "mint", token_ticker: "AAA", decimals: 6 }
        : ticker.toUpperCase() === "TIMBA"
          ? {
              token_mint: "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump",
              token_ticker: "TIMBA",
              decimals: 6,
            }
          : null,
    getKnownTokenByMint: (mint: string) =>
      mint === "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump"
        ? {
            token_mint: mint,
            token_ticker: "TIMBA",
            decimals: 6,
          }
        : null,
    getAllKnownTokens: () => [],
  } as any;
};

const buildMockContext = () => {
  const replies: string[] = [];
  const ctx: any = {
    chat: { id: 99, type: "supergroup" },
    from: { id: 123 },
    message: { message_id: 11, text: "" },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 12, chat: { id: 99 } } as any;
    },
    api: {
      editMessageText: async () => ({}),
    },
  };

  return { ctx, replies };
};

describe("chat defaults module", () => {
  let chatDb: ChatDatabase;
  let gameDb: GameDatabase;

  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    resetTestDatabase("games.sqlite");
    ChatDatabase.resetForTesting();
    GameDatabase.resetForTesting();
    chatDb = ChatDatabase.getInstance();
    gameDb = GameDatabase.getInstance();
  });

  test("accepts buy-alert media as a chat-defaults media setting", () => {
    expect(isChatDefaultsMediaSetting("video_buy_alerts")).toBe(true);
    expect(isChatDefaultsMediaSetting("video_coinflip")).toBe(true);
    expect(isChatDefaultsMediaSetting("token")).toBe(false);
  });

  test("uses a compact main keyboard with buy alerts", () => {
    const keyboard = __test_buildMenuKeyboard();
    expect(keyboard.inline_keyboard).toHaveLength(4);
    expect(keyboard.inline_keyboard.slice(0, 3).every((row) => row.length === 2)).toBe(true);
    expect(keyboard.inline_keyboard[3]).toHaveLength(1);
    const buttons = keyboard.inline_keyboard.flat() as Array<{
      text?: string;
      callback_data?: string;
    }>;
    const callbacks = buttons.map((button) => button.callback_data);
    expect(buttons.map((button) => button.text)).toContain("🚨 Buy alerts");
    expect(callbacks).toContain("chat_defaults_game_coinflip");
    expect(callbacks).toContain("chat_defaults_game_giveaway");
    expect(callbacks).toContain("chat_defaults_buy_alerts");
  });

  test("builds summary with chat overrides", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.setChatDefaultToken(99, "mint", "AAA", "1");
    chatDb.upsertChatGameSettings(99, {
      coinflip_max_players: 7,
      giveaway_max_players: 20,
      timeout_seconds: 1800,
    });

    const summary = await __test_buildSettingsSummary(99, {
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () =>
        ({
          getUsernameFromTelegramId: async () => "alice",
        }) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
    });

    expect(summary).toContain("AAA");
    expect(summary).toContain("Coinflip: 7 players");
    expect(summary).toContain("Giveaway: 20 players");
    expect(summary).toContain("30m");
    expect(summary).toContain("🚨 Buy alerts: Off");
  });

  test("buy alerts summary shows the chat token and min buy when enabled", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.setChatDefaultToken(99, "mint", "AAA", "1");
    chatDb.upsertChatBuyAlerts(99, {
      enabled: true,
      min_sol_lamports: 50_000_000,
      media_file_id: "AgAD-gif",
      set_by_telegram_id: "1",
    });

    const summary = await __test_buildSettingsSummary(99, {
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
    });

    expect(summary).toContain("🚨 Buy alerts: On, AAA, min 0.05 SOL, media Custom");
  });

  test("updates settings via text input handler", async () => {
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();

    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () =>
        ({
          getUsernameFromTelegramId: async () => null,
        }) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 25,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "coinflip",
    } as any;

    await module.handleSettingsInput(ctx as any, session, "8");

    const settings = chatDb.getChatGameSettings(99)!;
    expect(settings.coinflip_max_players).toBe(8);

    await module.handleSettingsInput(ctx as any, { ...session, setting: "timeout" }, "7200");
    const updated = chatDb.getChatGameSettings(99)!;
    expect(updated.timeout_seconds).toBe(7200);
    expect(replies.some((text) => text.includes("Default game timeout"))).toBe(true);
  });

  test("displays username from gameDb when available", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.setChatDefaultToken(99, "mint", "AAA", "12345");

    // Save player mapping with display name
    gameDb.savePlayerMapping("pubkey123", "12345", "@alice");

    const summary = await __test_buildSettingsSummary(99, {
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
    });

    expect(summary).toContain("set by @alice");
    expect(summary).not.toContain("User 12345");
  });

  test("displays username with @ prefix when display name lacks it", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.setChatDefaultToken(99, "mint", "AAA", "12345");

    // Save player mapping with display name without @ prefix
    gameDb.savePlayerMapping("pubkey123", "12345", "bob");

    const summary = await __test_buildSettingsSummary(99, {
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
    });

    expect(summary).toContain("set by @bob");
  });

  test("falls back to telegram ID when no display name in gameDb", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.setChatDefaultToken(99, "mint", "AAA", "999888");
    // No player mapping saved for this telegram ID

    const summary = await __test_buildSettingsSummary(99, {
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
    });

    expect(summary).toContain("set by User 999888");
    expect(summary).not.toContain("Unknown user");
  });

  test("handleSettingsInput clears token when input is 'clear'", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.setChatDefaultToken(99, "mint", "AAA", "123");
    const { ctx, replies } = buildMockContext();

    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 25,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "token",
    } as any;

    await module.handleSettingsInput(ctx as any, session, "clear");

    expect(tokenManager.getChatDefaultToken()).toBeNull();
    expect(replies.some((text) => text.includes("Default token cleared"))).toBe(true);
  });

  test("handleSettingsInput clears token when input is 'REMOVE' (case insensitive)", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.setChatDefaultToken(99, "mint", "AAA", "123");
    const { ctx, replies } = buildMockContext();

    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 25,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "token",
    } as any;

    await module.handleSettingsInput(ctx as any, session, "REMOVE");

    expect(tokenManager.getChatDefaultToken()).toBeNull();
    expect(replies.some((text) => text.includes("Default token cleared"))).toBe(true);
  });

  test("handleSettingsInput shows supported tokens list for unknown token", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.getSupportedGameTokens = () => [
      { mint: "m1", ticker: "TIMBA" },
      { mint: "m2", ticker: "SOL" },
    ];
    const { ctx, replies } = buildMockContext();

    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 25,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "token",
    } as any;

    await module.handleSettingsInput(ctx as any, session, "UNKNOWN");

    const errorReply = replies.find((text) => text.includes("not found"));
    expect(errorReply).toBeDefined();
    expect(errorReply).toContain("Supported tokens");
    expect(errorReply).toContain("TIMBA");
  });

  test("handleSettingsInput accepts a newly discovered mint as the chat default", async () => {
    const tokenManager = baseTokenManager();
    const pumpMint = "NewPumpMint111111111111111111111111111pump";
    (tokenManager as any).resolveSwapToken = async (input: string) =>
      input === pumpMint ? { token_mint: pumpMint, token_ticker: "NEWP", decimals: 6 } : null;
    const { ctx, replies } = buildMockContext();

    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 25,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "token",
    } as any;

    await module.handleSettingsInput(ctx as any, session, pumpMint);

    expect(tokenManager.getChatDefaultToken()?.token_mint).toBe(pumpMint);
    expect(tokenManager.getChatDefaultToken()?.token_ticker).toBe("NEWP");
    expect(replies.some((text) => text.includes("NEWP"))).toBe(true);
  });

  test("handleSettingsInput rejects replies from non-initiators", async () => {
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();
    ctx.from.id = 222;

    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 25,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "token",
      initiatorId: "111",
    } as any;

    await module.handleSettingsInput(ctx as any, session, "AAA");

    expect(tokenManager.getChatDefaultToken()).toBeNull();
    expect(replies.some((text) => text.includes("prompt is no longer active"))).toBe(true);
  });

  test("handleSettingsInput requires initiator to be admin", async () => {
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();

    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) => await handler(ctx, next),
      getOracleMaxPlayers: () => 25,
      isUserGroupAdmin: async () => false,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "token",
      initiatorId: String(ctx.from.id),
    } as any;

    await module.handleSettingsInput(ctx as any, session, "AAA");

    expect(tokenManager.getChatDefaultToken()).toBeNull();
    expect(replies.some((text) => text.includes("Only group administrators"))).toBe(true);
  });

  test("privacy setting flow updates database and UI", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();
    ctx.callbackQuery = {
      data: "chat_defaults_privacy_coinflip",
      message: { message_id: 11, chat: { id: 99 } },
    };
    ctx.chat = { id: 99 };

    let lastMenu: any = null;
    ctx.api.editMessageText = async (
      _chatId: number,
      _msgId: number,
      text: string,
      options: any,
    ) => {
      lastMenu = { text, options };
    };
    ctx.reply = async (text: string, options: any) => {
      lastMenu = { text, options };
    };

    createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    // 1. Click "Coinflip privacy"
    await mockBot.dispatch("chat_defaults_privacy_coinflip", ctx);

    expect(lastMenu.text).toContain("Choose the default privacy setting for new Coinflip games");
    expect(JSON.stringify(lastMenu.options)).toContain("chat_defaults_set_privacy_coinflip_public");

    // 2. Click "Public" for Coinflip
    ctx.callbackQuery.data = "chat_defaults_set_privacy_coinflip_public";
    await mockBot.dispatch("chat_defaults_set_privacy_coinflip_public", ctx);

    const settingsPublic = chatDb.getChatGameSettings(99);
    expect(settingsPublic?.coinflip_default_privacy).toBe("public");

    expect(lastMenu.text).toContain("⚙️ Chat settings");
    expect(lastMenu.text).toContain("Coinflip: 2 players, Public 🌍");

    // 3. Click "Private" for Coinflip
    ctx.callbackQuery.data = "chat_defaults_set_privacy_coinflip_private";
    await mockBot.dispatch("chat_defaults_set_privacy_coinflip_private", ctx);

    const settingsPrivate = chatDb.getChatGameSettings(99);
    expect(settingsPrivate?.coinflip_default_privacy).toBe("private");
    expect(lastMenu.text).toContain("Coinflip: 2 players, Private 🔒");

    // 4. Click "Clear" for Coinflip
    ctx.callbackQuery.data = "chat_defaults_set_privacy_coinflip_clear";
    await mockBot.dispatch("chat_defaults_set_privacy_coinflip_clear", ctx);

    const settingsClear = chatDb.getChatGameSettings(99);
    expect(settingsClear?.coinflip_default_privacy).toBeNull();
    // Default is Public (bot default)
    expect(lastMenu.text).toContain("Coinflip: 2 players, Public 🌍");

    // 5. Test Giveaway Privacy (briefly)
    ctx.callbackQuery.data = "chat_defaults_privacy_giveaway";
    await mockBot.dispatch("chat_defaults_privacy_giveaway", ctx);

    expect(lastMenu.text).toContain("Choose the default privacy setting for new Giveaway games");

    ctx.callbackQuery.data = "chat_defaults_set_privacy_giveaway_public";
    await mockBot.dispatch("chat_defaults_set_privacy_giveaway_public", ctx);

    const settingsGiveaway = chatDb.getChatGameSettings(99);
    expect(settingsGiveaway?.giveaway_default_privacy).toBe("public");
    expect(lastMenu.text).toContain("Giveaway: 10 players, Public 🌍");

    // 6. Verify distinct settings persistence (Regression Test)
    // Set Coinflip to Public
    ctx.callbackQuery.data = "chat_defaults_set_privacy_coinflip_public";
    await mockBot.dispatch("chat_defaults_set_privacy_coinflip_public", ctx);

    // Set Giveaway to Private
    ctx.callbackQuery.data = "chat_defaults_set_privacy_giveaway_private";
    await mockBot.dispatch("chat_defaults_set_privacy_giveaway_private", ctx);

    const settingsDual = chatDb.getChatGameSettings(99);
    expect(settingsDual?.coinflip_default_privacy).toBe("public");
    expect(settingsDual?.giveaway_default_privacy).toBe("private");
  });

  test("non-admin callback shows toast only, no message sent", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const messagesReplied: string[] = [];
    const callbackAnswers: string[] = [];

    const ctx: any = {
      chat: { id: 99, type: "supergroup" },
      from: { id: 456 },
      callbackQuery: {
        id: "cb123",
        data: "chat_defaults_token",
        message: { message_id: 11, chat: { id: 99 } },
      },
      answerCallbackQuery: async (text?: string) => {
        if (text) callbackAnswers.push(text);
      },
      reply: async (text: string) => {
        messagesReplied.push(text);
        return { message_id: 12 };
      },
      api: {
        editMessageText: async () => ({}),
      },
    };

    createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => false, // NOT admin
      replyToMessage: async (_ctx, text) => {
        messagesReplied.push(text);
      },
    });

    // Try to change a setting as non-admin
    await mockBot.dispatch("chat_defaults_token", ctx);

    // Should only get toast notification
    expect(callbackAnswers).toContain("Only admins can change chat defaults");
    // Should NOT send any message to the chat
    expect(messagesReplied).toHaveLength(0);
  });

  test("non-admin privacy callback shows toast only", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const messagesReplied: string[] = [];
    const callbackAnswers: string[] = [];

    const ctx: any = {
      chat: { id: 99, type: "supergroup" },
      from: { id: 456 },
      callbackQuery: {
        id: "cb123",
        data: "chat_defaults_set_privacy_coinflip_public",
        message: { message_id: 11, chat: { id: 99 } },
      },
      answerCallbackQuery: async (text?: string) => {
        if (text) callbackAnswers.push(text);
      },
      reply: async (text: string) => {
        messagesReplied.push(text);
        return { message_id: 12 };
      },
      api: {
        editMessageText: async () => ({}),
      },
    };

    createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => false, // NOT admin
      replyToMessage: async (_ctx, text) => {
        messagesReplied.push(text);
      },
    });

    // Try to set privacy as non-admin
    await mockBot.dispatch("chat_defaults_set_privacy_coinflip_public", ctx);

    // Should only get toast notification
    expect(callbackAnswers).toContain("Only admins can change chat defaults");
    // Should NOT send any message to the chat
    expect(messagesReplied).toHaveLength(0);
    // Privacy should NOT be changed
    const settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_default_privacy).toBeUndefined();
  });

  test("non-admin cancel callback shows toast only", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const messagesReplied: string[] = [];
    const callbackAnswers: string[] = [];

    const ctx: any = {
      chat: { id: 99, type: "supergroup" },
      from: { id: 456 },
      callbackQuery: {
        id: "cb123",
        data: "chat_defaults_cancel",
        message: { message_id: 11, chat: { id: 99 } },
      },
      answerCallbackQuery: async (text?: string) => {
        if (text) callbackAnswers.push(text);
      },
      reply: async (text: string) => {
        messagesReplied.push(text);
        return { message_id: 12 };
      },
      api: {
        editMessageText: async () => ({}),
      },
    };

    createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => false, // NOT admin
      replyToMessage: async (_ctx, text) => {
        messagesReplied.push(text);
      },
    });

    // Try to cancel as non-admin
    await mockBot.dispatch("chat_defaults_cancel", ctx);

    // Should only get toast notification
    expect(callbackAnswers).toContain("Only admins can change chat defaults");
    // Should NOT re-render menu or anything else visible
    expect(messagesReplied).toHaveLength(0);
  });
  test("join notification settings flow updates database and UI", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();
    ctx.callbackQuery = {
      data: "chat_defaults_join_notifications",
      message: { message_id: 11, chat: { id: 99 } },
    };
    ctx.chat = { id: 99 };

    let lastMenu: any = null;
    ctx.api.editMessageText = async (
      _chatId: number,
      _msgId: number,
      text: string,
      options: any,
    ) => {
      lastMenu = { text, options };
    };
    ctx.reply = async (text: string, options: any) => {
      lastMenu = { text, options };
    };

    const module = createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    // 1. Open Join Notifications Menu
    await mockBot.dispatch("chat_defaults_join_notifications", ctx);
    expect(lastMenu.text).toContain("📢 Join notifications");
    expect(lastMenu.text).toContain("<b>Games from other groups:</b> Off"); // Default
    expect(lastMenu.text).toContain("<b>Limit:</b> Off"); // Default

    // 2. Enable External Notifications
    ctx.callbackQuery.data = "chat_defaults_set_join_external_on";
    await mockBot.dispatch("chat_defaults_set_join_external_on", ctx);

    const settingsExt = chatDb.getChatGameSettings(99);
    expect(settingsExt?.join_notifications_external).toBeTruthy();
    // Actually chat-db.ts usually returns number for boolean columns if not mapped.
    // But let's assume the getter does what it says. If strictly mapped:
    // checking functionality directly via re-render check:
    expect(lastMenu.text).toContain("other groups On");

    // 3. Set Rate Limit to 5
    ctx.callbackQuery.data = "chat_defaults_set_join_rate_5";
    await mockBot.dispatch("chat_defaults_set_join_rate_5", ctx);

    const settingsRate = chatDb.getChatGameSettings(99);
    expect(settingsRate?.join_notifications_per_minute).toBe(5);
    expect(lastMenu.text).toContain("5/min");

    // 4. Custom Rate Limit Input Flow
    ctx.callbackQuery.data = "chat_defaults_set_join_rate_custom";
    await mockBot.dispatch("chat_defaults_set_join_rate_custom", ctx);
    expect(lastMenu.text).toContain("Enter a custom rate limit");

    // User sends "25"
    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      target: "join_rate_custom",
      initiatorId: "123", // matches ctx.from.id
    } as any;

    await module.handleSettingsInput(ctx, session, "25");

    const settingsCustom = chatDb.getChatGameSettings(99);
    expect(settingsCustom?.join_notifications_per_minute).toBe(25);
    expect(replies.some((text) => text.includes("Rate limit set to 25/min"))).toBe(true);

    // 5. Clear/Restore Defaults
    ctx.callbackQuery.data = "chat_defaults_clear_join_notifications";
    await mockBot.dispatch("chat_defaults_clear_join_notifications", ctx);

    const settingsClear = chatDb.getChatGameSettings(99);
    expect(settingsClear?.join_notifications_external).toBeNull();
    expect(settingsClear?.join_notifications_per_minute).toBeNull();
    expect(lastMenu.text).toContain("other groups Off"); // back to default
    expect(lastMenu.text).toContain("Join notifications: Off"); // back to default
  });

  test("video settings flow updates database and UI", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();
    ctx.chat = { id: 99 };
    // Start with Coinflip Video menu
    ctx.callbackQuery = {
      data: "chat_defaults_video_coinflip",
      message: { message_id: 11, chat: { id: 99 } },
      from: { id: 123 },
    };
    ctx.answerCallbackQuery = async () => {};

    let lastMenu: any = null;
    ctx.api.editMessageText = async (
      _chatId: number,
      _msgId: number,
      text: string,
      options: any,
    ) => {
      lastMenu = { text, options };
    };
    ctx.reply = async (text: string, options: any) => {
      lastMenu = { text, options };
    };

    const module = createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    // 1. Open Video Menu
    await mockBot.dispatch("chat_defaults_video_coinflip", ctx);
    expect(lastMenu.text).toContain("Choose an option for the coinflip game media");

    // 2. Disable Media
    ctx.callbackQuery.data = "chat_defaults_disable_video_coinflip";
    await mockBot.dispatch("chat_defaults_disable_video_coinflip", ctx);

    let settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_video_id).toBe("__DISABLED__");
    expect(lastMenu.text).toContain("Text only");

    // 3. Clear/Restore Defaults
    ctx.callbackQuery.data = "chat_defaults_clear_video_coinflip";
    await mockBot.dispatch("chat_defaults_clear_video_coinflip", ctx);

    settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_video_id).toBe(""); // empty string means "use bot default" as per logic? Or null?
    // Logic says: Clear means use bot default -> set to empty string on db upsert
    expect(lastMenu.text).toContain("Default media");

    // 4. Set Custom Media (Input)
    // Simulate flow: User clicks "Set custom", then sends a file
    ctx.callbackQuery.data = "chat_defaults_set_video_coinflip";
    await mockBot.dispatch("chat_defaults_set_video_coinflip", ctx);
    expect(lastMenu.text).toContain("Send a video, image, or GIF");

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "video_coinflip",
      initiatorId: "123",
    } as any;

    // Simulate sending a video message
    ctx.message = {
      video: { file_id: "VIDEO_123" },
    };
    await module.handleSettingsInput(ctx, session, ""); // text is empty, has attachment

    settings = chatDb.getChatGameSettings(99);
    expect(settings?.coinflip_video_id).toBe("VIDEO_123");
    expect(settings?.coinflip_media_type).toBe("video");
    expect(replies.some((text) => text.includes("Default coinflip video set"))).toBe(true);
  });

  test("non-admin cannot access new settings", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const headers: string[] = [];

    const ctx: any = {
      chat: { id: 99, type: "supergroup" },
      from: { id: 456 },
      callbackQuery: {
        id: "cb123",
        data: "",
        message: { message_id: 11, chat: { id: 99 } },
      },
      answerCallbackQuery: async (text?: string) => {
        if (text) headers.push(text);
      },
      reply: async () => ({ message_id: 12 }),
      api: { editMessageText: async () => ({}) },
    };

    createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => false, // NOT admin
      replyToMessage: async () => {},
    });

    // List of restricted actions
    const restrictedActions = [
      "chat_defaults_join_notifications",
      "chat_defaults_set_join_external_on",
      "chat_defaults_set_join_rate_5",
      "chat_defaults_clear_join_notifications",
      "chat_defaults_video_coinflip",
      "chat_defaults_disable_video_coinflip",
      "chat_defaults_clear_video_coinflip",
      "chat_defaults_clear_timeout",
      "chat_defaults_clear_coinflip",
      "chat_defaults_public_game_feed",
      "chat_defaults_set_public_game_feed_on",
      "chat_defaults_buy_alerts",
      "chat_defaults_set_buy_alerts_on",
      "chat_defaults_buy_alerts_media",
      "chat_defaults_set_buy_alerts_min_custom",
    ];

    for (const action of restrictedActions) {
      ctx.callbackQuery.data = action;
      await mockBot.dispatch(action, ctx);
      expect(headers).toContain("Only admins can change chat defaults");
      // Reset for next
      while (headers.length > 0) headers.pop();
    }
  });

  test("global public game feed setting is admin-controlled and disabled by default", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const { ctx } = buildMockContext();
    ctx.callbackQuery = {
      id: "cb-feed",
      data: "chat_defaults_public_game_feed",
      message: { message_id: 11, chat: { id: 99 } },
    };

    let lastText = "";
    ctx.editMessageText = async (text: string) => {
      lastText = text;
      return {};
    };
    ctx.answerCallbackQuery = async () => {};

    createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (callbackCtx) =>
        await handler(callbackCtx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
    });

    await mockBot.dispatch("chat_defaults_public_game_feed", ctx);
    expect(lastText).toContain("Global Public Game Feed");
    expect(lastText).toContain("Disabled");

    ctx.callbackQuery.data = "chat_defaults_set_public_game_feed_on";
    await mockBot.dispatch("chat_defaults_set_public_game_feed_on", ctx);
    expect(Boolean(chatDb.getChatGameSettings(99)?.global_public_game_feed)).toBe(true);
    expect(lastText).toContain("🌐 Public game feed: On");
  });

  test("buy alerts can be enabled by an admin and stay off by default", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const { ctx } = buildMockContext();
    ctx.callbackQuery = {
      id: "cb-buy",
      data: "chat_defaults_buy_alerts",
      message: { message_id: 11, chat: { id: 99 } },
    };

    let lastText = "";
    ctx.editMessageText = async (text: string) => {
      lastText = text;
      return {};
    };
    ctx.answerCallbackQuery = async () => {};

    let refreshed = 0;
    createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (callbackCtx) =>
        await handler(callbackCtx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
      buyAlerts: {
        refresh: () => {
          refreshed += 1;
        },
      },
    });

    await mockBot.dispatch("chat_defaults_buy_alerts", ctx);
    expect(lastText).toContain("🚨 Buy alerts");
    expect(lastText).not.toContain("Post Pump.fun");
    expect(lastText).toContain("Disabled");
    expect(lastText).toContain("(chat default)");
    expect(lastText).toContain("Media: None");
    expect(lastText).toContain("Min buy: Off");
    expect(chatDb.getChatBuyAlerts(99)).toBeNull();

    ctx.callbackQuery.data = "chat_defaults_set_buy_alerts_on";
    await mockBot.dispatch("chat_defaults_set_buy_alerts_on", ctx);
    expect(chatDb.getChatBuyAlerts(99)?.enabled).toBe(true);
    expect(lastText).toContain("Enabled");
    expect(refreshed).toBe(1);

    ctx.callbackQuery.data = "chat_defaults_set_buy_alerts_min_05";
    await mockBot.dispatch("chat_defaults_set_buy_alerts_min_05", ctx);
    expect(chatDb.getChatBuyAlerts(99)?.min_sol_lamports).toBe(500_000_000);
    expect(lastText).toContain("0.5 SOL");
    expect(lastText).toContain("Media: None");
  });

  test("buy alerts accept a custom min buy amount", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();
    ctx.callbackQuery = {
      id: "cb-buy-min",
      data: "chat_defaults_set_buy_alerts_min_custom",
      message: { message_id: 11, chat: { id: 99 } },
    };

    let lastText = "";
    ctx.editMessageText = async (text: string) => {
      lastText = text;
      return {};
    };
    ctx.answerCallbackQuery = async () => {};

    const module = createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (callbackCtx) =>
        await handler(callbackCtx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    await mockBot.dispatch("chat_defaults_set_buy_alerts_min_custom", ctx);
    expect(lastText).toContain("minimum buy in SOL");

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      target: "buy_alerts_min_custom",
      initiatorId: "123",
    };

    await module.handleSettingsInput(ctx as any, session, "0.05");
    expect(chatDb.getChatBuyAlerts(99)?.min_sol_lamports).toBe(50_000_000);
    expect(replies.some((text) => text.includes("0.05 SOL"))).toBe(true);

    await module.handleSettingsInput(ctx as any, session, "off");
    expect(chatDb.getChatBuyAlerts(99)?.min_sol_lamports).toBeNull();
    expect(replies.some((text) => text.includes("Min buy set to Off"))).toBe(true);

    await module.handleSettingsInput(ctx as any, session, "nope");
    expect(chatDb.getChatBuyAlerts(99)?.min_sol_lamports).toBeNull();
    expect(replies.some((text) => text.includes("Invalid amount"))).toBe(true);
  });

  test("buy alert media can be set from the defaults menu", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();
    ctx.callbackQuery = {
      id: "cb-buy-media",
      data: "chat_defaults_buy_alerts_media",
      message: { message_id: 11, chat: { id: 99 } },
    };

    let lastText = "";
    ctx.editMessageText = async (text: string) => {
      lastText = text;
      return {};
    };
    ctx.answerCallbackQuery = async () => {};

    const module = createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (callbackCtx) =>
        await handler(callbackCtx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });

    await mockBot.dispatch("chat_defaults_buy_alerts_media", ctx);
    expect(lastText).toContain("buy alert media");

    ctx.callbackQuery.data = "chat_defaults_set_video_buy_alerts";
    await mockBot.dispatch("chat_defaults_set_video_buy_alerts", ctx);
    expect(lastText).toContain("Send a video, image, or GIF for buy alerts");

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "video_buy_alerts",
      initiatorId: "123",
    };

    ctx.message = { animation: { file_id: "GIF_BUY_1" } };
    await module.handleSettingsInput(ctx as any, session, "");

    expect(chatDb.getChatBuyAlerts(99)?.media_file_id).toBe("GIF_BUY_1");
    expect(chatDb.getChatBuyAlerts(99)?.media_type).toBe("animation");
    expect(replies.some((text) => text.includes("Buy alert GIF set"))).toBe(true);
  });

  test("changing or clearing the default token refreshes buy-alert feeds", async () => {
    const tokenManager = baseTokenManager();
    tokenManager.getSupportedGameTokens = () => [];
    const { ctx } = buildMockContext();
    let refreshed = 0;
    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({}) as any,
      wrapCallbackHandler: (handler) => async (callbackCtx, next) =>
        await handler(callbackCtx, next),
      getOracleMaxPlayers: () => 25,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
      buyAlerts: {
        refresh: () => {
          refreshed += 1;
        },
      },
    });

    const session: InputSessionState = {
      type: "chat_defaults",
      chatId: 99,
      messageId: 11,
      setting: "token",
    } as any;

    await module.handleSettingsInput(ctx as any, session, "UNKNOWN");
    expect(refreshed).toBe(0);

    await module.handleSettingsInput(ctx as any, session, "AAA");
    expect(tokenManager.getChatDefaultToken()?.token_ticker).toBe("AAA");
    expect(refreshed).toBe(1);

    await module.handleDefaultCommand(ctx as any, ["/default", "CLEAR"]);
    expect(tokenManager.getChatDefaultToken()).toBeNull();
    expect(refreshed).toBe(2);
  });
});

describe("chat defaults menus and inputs", () => {
  let chatDb: ChatDatabase;
  let gameDb: GameDatabase;
  const promptSession = () =>
    findInputSession((_key, session) => session.type === "chat_defaults")?.session;

  beforeEach(() => {
    clearAllInputSessions();
    resetTestDatabase("chat-settings.sqlite");
    resetTestDatabase("games.sqlite");
    ChatDatabase.resetForTesting();
    GameDatabase.resetForTesting();
    chatDb = ChatDatabase.getInstance();
    gameDb = GameDatabase.getInstance();
  });

  const setup = (options: { admin?: boolean; tokenManager?: any } = {}) => {
    const mockBot = createMockBot();
    const tokenManager = options.tokenManager ?? baseTokenManager();
    const replies: string[] = [];
    const menus: Array<{ text: string; options: any }> = [];
    const answers: Array<string | undefined> = [];
    let refreshes = 0;
    const module = createChatDefaultsModule({
      bot: mockBot as any,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({ getUsernameFromTelegramId: async () => null }) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => options.admin !== false,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
      buyAlerts: {
        refresh: () => {
          refreshes += 1;
        },
      } as any,
    });
    const ctxFor = (data?: string, message: Record<string, unknown> = {}) => {
      const ctx: any = {
        chat: { id: 99, type: "supergroup" },
        from: { id: 123 },
        message: { message_id: 11, ...message },
        answerCallbackQuery: async (text?: string) => {
          answers.push(text);
        },
        reply: async (text: string, replyOptions: any) => {
          menus.push({ text, options: replyOptions });
          return { message_id: 50, chat: { id: 99 } };
        },
        api: {
          editMessageText: async (
            _chat: number,
            messageId: number,
            text: string,
            editOptions: any,
          ) => {
            menus.push({ text, options: editOptions });
            return { message_id: messageId, chat: { id: 99 } };
          },
        },
      };
      if (data)
        ctx.callbackQuery = { id: "cb", data, message: { message_id: 11, chat: { id: 99 } } };
      return ctx;
    };
    const press = (data: string) => mockBot.dispatch(data, ctxFor(data));
    const lastMenu = () => menus.at(-1)!;
    const lastCallbacks = () =>
      (lastMenu().options?.reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((button: any) => button.callback_data);
    return {
      module,
      mockBot,
      tokenManager,
      replies,
      menus,
      answers,
      press,
      ctxFor,
      lastMenu,
      lastCallbacks,
      refreshes: () => refreshes,
    };
  };

  test("game submenus summarise players, privacy and media", async () => {
    const h = setup();
    chatDb.upsertChatGameSettings(99, {
      coinflip_max_players: 6,
      giveaway_default_privacy: "public",
      giveaway_video_id: "__DISABLED__",
    });

    await h.press("chat_defaults_game_coinflip");
    expect(h.lastMenu().text).toContain("<b>Coinflip defaults</b>");
    expect(h.lastMenu().text).toContain("👥 Players: 6");
    expect(h.lastMenu().text).toContain("Public 🌍");

    await h.press("chat_defaults_game_giveaway");
    expect(h.lastMenu().text).toContain("<b>Giveaway defaults</b>");
    expect(h.lastMenu().text).toContain("👥 Players: 10");
    expect(h.lastMenu().text).toContain("🎬 Media: Text only");
    expect(h.lastCallbacks()).toContain("chat_defaults_video_giveaway");
  });

  test("restoring each default clears only that setting", async () => {
    const h = setup();
    h.tokenManager.setChatDefaultToken(99, "mint", "AAA", "1");
    chatDb.upsertChatGameSettings(99, {
      coinflip_max_players: 6,
      giveaway_max_players: 12,
      timeout_seconds: 900,
      coinflip_video_id: "coinflip-video",
      giveaway_video_id: "giveaway-video",
    });
    chatDb.upsertChatBuyAlerts(99, { enabled: true, media_file_id: "alert-media" });

    await h.press("chat_defaults_clear_token");
    expect(h.tokenManager.getChatDefaultToken(99)).toBeNull();
    await h.press("chat_defaults_clear_timeout");
    await h.press("chat_defaults_clear_coinflip");
    expect(chatDb.getChatGameSettings(99)).toMatchObject({
      timeout_seconds: null,
      coinflip_max_players: null,
      giveaway_max_players: 12,
    });
    await h.press("chat_defaults_clear_giveaway");
    await h.press("chat_defaults_clear_video_coinflip");
    await h.press("chat_defaults_clear_video_giveaway");
    expect(chatDb.getChatGameSettings(99)).toMatchObject({
      giveaway_max_players: null,
      coinflip_video_id: "",
      giveaway_video_id: "",
    });
    expect(h.lastMenu().text).toContain("⚙️ Chat settings");

    await h.press("chat_defaults_clear_video_buy_alerts");
    expect(chatDb.getChatBuyAlerts(99)).toMatchObject({ enabled: true, media_file_id: "" });
    expect(h.lastCallbacks()).toContain("chat_defaults_buy_alerts_media");
    expect(h.answers.at(-1)).toBe("Setting reset to default");
    expect(h.refreshes()).toBe(2);
  });

  test.each([
    ["token", "Send the SPL token ticker or mint"],
    ["timeout", "Send the default game timeout in seconds."],
    ["giveaway", "Must be between 1-50 players."],
  ])("the %s button asks for a reply and remembers the prompt", async (setting, prompt) => {
    const h = setup();

    await h.press(`chat_defaults_${setting}`);

    expect(h.lastMenu().text).toContain(prompt);
    expect(h.lastCallbacks()).toContain(`chat_defaults_clear_${setting}`);
    expect(promptSession()).toMatchObject({
      type: "chat_defaults",
      setting,
      initiatorId: "123",
    });
  });

  test("media buttons offer custom, disabled and default media", async () => {
    const h = setup();

    await h.press("chat_defaults_video_coinflip");
    expect(h.lastMenu().text).toBe("Choose an option for the coinflip game media.");
    expect(h.lastCallbacks()).toEqual([
      "chat_defaults_set_video_coinflip",
      "chat_defaults_disable_video_coinflip",
      "chat_defaults_clear_video_coinflip",
      "chat_defaults_cancel",
    ]);

    await h.press("chat_defaults_set_video_giveaway");
    expect(h.lastMenu().text).toContain("Send a video, image, or GIF for the giveaway game.");

    await h.press("chat_defaults_buy_alerts_media");
    expect(h.lastMenu().text).toBe("Choose an option for buy alert media.");
    await h.press("chat_defaults_set_video_buy_alerts");
    expect(h.lastMenu().text).toContain("Send a video, image, or GIF for buy alerts.");
  });

  test("disabling media stores the sentinel for each target", async () => {
    const h = setup();

    await h.press("chat_defaults_disable_video_coinflip");
    expect(h.answers.at(-1)).toBe("coinflip media disabled - games will send text only");
    await h.press("chat_defaults_disable_video_giveaway");
    await h.press("chat_defaults_disable_video_buy_alerts");

    expect(chatDb.getChatGameSettings(99)).toMatchObject({
      coinflip_video_id: "__DISABLED__",
      giveaway_video_id: "__DISABLED__",
    });
    expect(chatDb.getChatBuyAlerts(99)?.media_file_id).toBe("__DISABLED__");
    expect(h.answers.at(-1)).toBe("Buy alert media disabled");
  });

  test("non-admins cannot disable media", async () => {
    const h = setup({ admin: false });

    await h.press("chat_defaults_disable_video_coinflip");

    expect(h.answers).toEqual(["Only admins can change chat defaults"]);
    expect(chatDb.getChatGameSettings(99)).toBeNull();
  });

  test("the public game feed can be toggled", async () => {
    const h = setup();

    await h.press("chat_defaults_public_game_feed");
    expect(h.lastMenu().text).toContain("Current: ❌ Disabled");
    expect(h.lastCallbacks()[0]).toBe("chat_defaults_set_public_game_feed_on");

    await h.press("chat_defaults_set_public_game_feed_on");
    expect(chatDb.getChatGameSettings(99)?.global_public_game_feed).toBe(1 as any);
    expect(h.answers.at(-1)).toBe("Global public game feed enabled");

    await h.press("chat_defaults_public_game_feed");
    expect(h.lastMenu().text).toContain("Current: ✅ Enabled");

    await h.press("chat_defaults_set_public_game_feed_off");
    expect(h.answers.at(-1)).toBe("Global public game feed disabled");
  });

  test("buy alerts can be enabled and given a minimum", async () => {
    const h = setup();

    await h.press("chat_defaults_buy_alerts");
    expect(h.lastCallbacks()[0]).toBe("chat_defaults_set_buy_alerts_on");
    await h.press("chat_defaults_set_buy_alerts_on");
    expect(chatDb.getChatBuyAlerts(99)?.enabled).toBe(true);
    expect(h.answers.at(-1)).toBe("Buy alerts enabled");

    for (const [key, lamports] of [
      ["01", 100_000_000],
      ["05", 500_000_000],
      ["1", 1_000_000_000],
      ["off", null],
    ] as const) {
      await h.press(`chat_defaults_set_buy_alerts_min_${key}`);
      expect(chatDb.getChatBuyAlerts(99)?.min_sol_lamports).toBe(lamports);
    }

    await h.press("chat_defaults_set_buy_alerts_off");
    expect(chatDb.getChatBuyAlerts(99)?.enabled).toBe(false);
    expect(h.refreshes()).toBe(6);
  });

  test("a custom minimum buy is entered as a reply", async () => {
    const h = setup();
    await h.press("chat_defaults_set_buy_alerts_min_custom");
    expect(h.lastMenu().text).toContain("Send the minimum buy in SOL.");
    const session = promptSession()!;
    expect(session).toMatchObject({ target: "buy_alerts_min_custom", chatId: 99 });

    await h.module.handleSettingsInput(h.ctxFor(), session, "lots");
    expect(h.replies.at(-1)).toStartWith("❌ Invalid amount.");

    await h.module.handleSettingsInput(h.ctxFor(), session, "0.25");
    expect(chatDb.getChatBuyAlerts(99)?.min_sol_lamports).toBe(250_000_000);
    expect(h.replies.at(-1)).toBe("✅ Min buy set to 0.25 SOL");

    await h.module.handleSettingsInput(h.ctxFor(), { ...session, chatId: undefined } as any, "1");
    expect(h.replies.at(-1)).toBe("❌ Session expired. Please try again.");
  });

  test("join notification settings", async () => {
    const h = setup();

    await h.press("chat_defaults_set_join_external_on");
    expect(h.answers.at(-1)).toBe("External notifications enabled");
    await h.press("chat_defaults_set_join_external_off");
    expect(h.answers.at(-1)).toBe("External notifications disabled");
    await h.press("chat_defaults_set_join_rate_0");
    expect(h.answers.at(-1)).toBe("Rate limit set to disabled");
    await h.press("chat_defaults_set_join_rate_5");
    expect(chatDb.getChatGameSettings(99)).toMatchObject({
      join_notifications_external: 0 as any,
      join_notifications_per_minute: 5,
    });

    await h.press("chat_defaults_set_join_rate_custom");
    expect(h.lastMenu().text).toBe("Enter a custom rate limit (0-30 per minute):");
    const session = promptSession()!;
    await h.module.handleSettingsInput(h.ctxFor(), session, "31");
    expect(h.replies.at(-1)).toBe("❌ Invalid rate. Please enter a number between 0 and 30.");
    await h.module.handleSettingsInput(h.ctxFor(), session, "0");
    expect(h.replies.at(-1)).toBe("✅ Rate limit set to disabled");
    await h.module.handleSettingsInput(h.ctxFor(), session, "12");
    expect(h.replies.at(-1)).toBe("✅ Rate limit set to 12/min");
    await h.module.handleSettingsInput(h.ctxFor(), { ...session, chatId: "x" } as any, "3");
    expect(h.replies.at(-1)).toBe("❌ Session expired. Please try again.");

    await h.press("chat_defaults_clear_join_notifications");
    expect(chatDb.getChatGameSettings(99)).toMatchObject({
      join_notifications_external: null,
      join_notifications_per_minute: null,
    });
  });

  test("cancel closes the prompt and returns to the menu", async () => {
    const h = setup();
    await h.press("chat_defaults_timeout");
    const promptId = promptSession()!.messageId as number;
    const ctx = h.ctxFor("chat_defaults_cancel");
    ctx.callbackQuery.message.message_id = promptId;

    // The Back button lives on the prompt message itself.
    await h.mockBot.dispatch("chat_defaults_cancel", ctx);

    expect(promptSession()).toBeUndefined();
    expect(h.lastMenu().text).toContain("⚙️ Chat settings");
  });

  const session = (setting: string) =>
    ({ type: "chat_defaults", chatId: 99, messageId: 11, setting, initiatorId: "123" }) as any;

  test("media replies store the file id and media type for each target", async () => {
    const h = setup();

    await h.module.handleSettingsInput(
      h.ctxFor(undefined, { video: { file_id: "video-file-1" } }),
      session("video_coinflip"),
      "",
    );
    expect(h.replies.at(-1)).toBe("✅ Default coinflip video set. New games will use this video.");
    await h.module.handleSettingsInput(
      h.ctxFor(undefined, { animation: { file_id: "gif-file-1" } }),
      session("video_giveaway"),
      "",
    );
    expect(h.replies.at(-1)).toBe("✅ Default giveaway GIF set. New games will use this GIF.");
    await h.module.handleSettingsInput(
      h.ctxFor(undefined, { photo: [{ file_id: "small" }, { file_id: "large-photo" }] }),
      session("video_buy_alerts"),
      "",
    );
    expect(h.replies.at(-1)).toBe("✅ Buy alert image set.");

    expect(chatDb.getChatGameSettings(99)).toMatchObject({
      coinflip_video_id: "video-file-1",
      coinflip_media_type: "video",
      giveaway_video_id: "gif-file-1",
      giveaway_media_type: "animation",
    });
    expect(chatDb.getChatBuyAlerts(99)).toMatchObject({
      media_file_id: "large-photo",
      media_type: "photo",
    });
  });

  test("a pasted file id is accepted, with an explicit media type when known", async () => {
    const h = setup();
    const ctx = h.ctxFor();
    ctx.__mediaType = "animation";

    await h.module.handleSettingsInput(ctx, session("video_buy_alerts"), "  file-id-123 ");
    expect(chatDb.getChatBuyAlerts(99)).toMatchObject({
      media_file_id: "file-id-123",
      media_type: "animation",
    });
    expect(h.replies.at(-1)).toBe("✅ Buy alert GIF set.");

    await h.module.handleSettingsInput(h.ctxFor(), session("video_giveaway"), "abc");
    expect(h.replies.at(-1)).toBe("❌ Invalid file ID. Please send a valid Telegram file ID.");
  });

  test("replying clear resets media settings", async () => {
    const h = setup();
    chatDb.upsertChatGameSettings(99, { coinflip_video_id: "a", giveaway_video_id: "b" });
    chatDb.upsertChatBuyAlerts(99, { media_file_id: "c" });

    await h.module.handleSettingsInput(h.ctxFor(), session("video_coinflip"), "clear");
    await h.module.handleSettingsInput(h.ctxFor(), session("video_giveaway"), "remove");
    await h.module.handleSettingsInput(h.ctxFor(), session("video_buy_alerts"), "CLEAR");

    expect(chatDb.getChatGameSettings(99)).toMatchObject({
      coinflip_video_id: "",
      giveaway_video_id: "",
    });
    expect(chatDb.getChatBuyAlerts(99)?.media_file_id).toBe("");
    expect(h.replies).toEqual([
      "✅ Reset to bot default.",
      "✅ Reset to bot default.",
      "✅ Buy alert media cleared.",
    ]);
  });

  test("player and timeout replies validate and can be reset", async () => {
    const h = setup();
    chatDb.upsertChatGameSettings(99, { giveaway_max_players: 7, timeout_seconds: 900 });

    await h.module.handleSettingsInput(h.ctxFor(), session("giveaway"), "many");
    expect(h.replies.at(-1)).toBe("❌ Invalid number. Please enter a value between 1-50.");
    await h.module.handleSettingsInput(h.ctxFor(), session("giveaway"), "15");
    expect(h.replies.at(-1)).toBe("✅ Default giveaway players set to 15.");
    await h.module.handleSettingsInput(h.ctxFor(), session("coinflip"), "clear");
    await h.module.handleSettingsInput(h.ctxFor(), session("giveaway"), "clear");
    expect(chatDb.getChatGameSettings(99)?.giveaway_max_players).toBeNull();

    await h.module.handleSettingsInput(h.ctxFor(), session("timeout"), "soon");
    expect(h.replies.at(-1)).toBe("❌ Please enter a valid number of seconds.");
    await h.module.handleSettingsInput(h.ctxFor(), session("timeout"), "remove");
    expect(h.replies.at(-1)).toBe("✅ Reset timeout to bot default.");
    expect(chatDb.getChatGameSettings(99)?.timeout_seconds).toBeNull();
  });

  test("unknown tokens list at most ten supported tokens", async () => {
    const tokenManager = {
      ...baseTokenManager(),
      getSupportedGameTokens: () =>
        Array.from({ length: 12 }, (_, index) => ({ ticker: `T${index}` })),
    };
    const h = setup({ tokenManager });

    await h.module.handleSettingsInput(h.ctxFor(), session("token"), "nope");

    const reply = h.replies.at(-1)!;
    expect(reply).toContain('❌ Token "NOPE" not found.');
    expect(reply).toContain("• T9\n");
    expect(reply).not.toContain("T10");
    expect(reply).toContain("... and 2 more.");
  });
});

describe("/default command", () => {
  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    ChatDatabase.resetForTesting();
  });

  const run = async (args: string[], options: { chatType?: string; admin?: boolean } = {}) => {
    const replies: string[] = [];
    const tokenManager = baseTokenManager();
    const module = createChatDefaultsModule({
      bot: createMockBot() as any,
      chatDb: ChatDatabase.getInstance(),
      gameDb: GameDatabase.getInstance(),
      getTokenManager: () => tokenManager,
      getGameManager: () => ({ getUsernameFromTelegramId: async () => null }) as any,
      wrapCallbackHandler: (handler) => async (ctx) => await handler(ctx, async () => {}),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => options.admin !== false,
      replyToMessage: async (_ctx, text) => {
        replies.push(text);
      },
    });
    const ctx: any = {
      chat: { id: 77, type: options.chatType ?? "group" },
      from: { id: 5 },
      message: { message_id: 1 },
      reply: async (text: string) => {
        replies.push(text);
        return { message_id: 2, chat: { id: 77 } };
      },
      api: { editMessageText: async () => ({}) },
    };
    await module.handleDefaultCommand(ctx, args);
    return { replies, tokenManager };
  };

  test("is refused in private chats", async () => {
    expect((await run(["/default", "AAA"], { chatType: "private" })).replies).toEqual([
      "🚫 Default tokens can only be set in groups or channels.",
    ]);
  });

  test("shows the settings menu without a token", async () => {
    const { replies } = await run(["/default"]);
    expect(replies[0]).toContain("⚙️ Chat settings");
  });

  test("does nothing for non-admins", async () => {
    const { replies, tokenManager } = await run(["/default", "AAA"], { admin: false });
    expect(replies).toEqual([]);
    expect(tokenManager.getChatDefaultToken(77)).toBeNull();
  });

  test("asks for a ticker when the argument is empty", async () => {
    expect((await run(["/default", ""])).replies).toEqual(["Please provide a token ticker."]);
  });

  test("clears the chat token", async () => {
    expect((await run(["/default", "remove"])).replies).toEqual([
      "✅ Default token cleared for this chat. Using bot default token now.",
    ]);
  });

  test("sets a known token", async () => {
    const { replies, tokenManager } = await run(["/default", "aaa"]);
    expect(tokenManager.getChatDefaultToken(77)).toMatchObject({ token_ticker: "AAA" });
    expect(replies[0]).toContain("AAA");
  });
});
