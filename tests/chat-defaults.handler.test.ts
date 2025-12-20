import { beforeEach, describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import { createChatDefaultsModule, __test_buildSettingsSummary } from "../src/handlers/chat-defaults";
import { ChatDatabase } from "../src/utils/chat-database";
import { GameDatabase } from "../src/utils/game-database";
import { resetTestDatabase } from "./helpers/database";
import type { InputSessionState } from "../src/utils/user-state";

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
      setBy: string
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
      getGameManager: () => ({
        getUsernameFromTelegramId: async () => "alice",
      }) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
      getOracleMaxPlayers: () => 50,
      isUserGroupAdmin: async () => true,
      replyToMessage: async () => {},
    });

    expect(summary).toContain("AAA");
    expect(summary).toContain("7 (chat default)");
    expect(summary).toContain("20 (chat default)");
    expect(summary).toContain("30m");
  });

  test("updates settings via text input handler", async () => {
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();

    const module = createChatDefaultsModule({
      bot,
      chatDb,
      gameDb,
      getTokenManager: () => tokenManager,
      getGameManager: () => ({
        getUsernameFromTelegramId: async () => null,
      }) as any,
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
    expect(errorReply).toContain("SOL");
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
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
    expect(
      replies.some((text) => text.includes("prompt is no longer active"))
    ).toBe(true);
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
      wrapCallbackHandler: (handler) => async (ctx, next) =>
        await handler(ctx, next),
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
    expect(
      replies.some((text) => text.includes("Only group administrators"))
    ).toBe(true);
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
      options: any
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
    expect(JSON.stringify(lastMenu.options)).toContain(
      "chat_defaults_set_privacy_coinflip_public"
    );

    // 2. Click "Public" for Coinflip
    ctx.callbackQuery.data = "chat_defaults_set_privacy_coinflip_public";
    await mockBot.dispatch("chat_defaults_set_privacy_coinflip_public", ctx);

    const settingsPublic = chatDb.getChatGameSettings(99);
    expect(settingsPublic?.coinflip_default_privacy).toBe("public");

    expect(lastMenu.text).toContain("Chat defaults");
    expect(lastMenu.text).toContain("Coinflip privacy: Public 🌍 (chat default)");

    // 3. Click "Private" for Coinflip
    ctx.callbackQuery.data = "chat_defaults_set_privacy_coinflip_private";
    await mockBot.dispatch("chat_defaults_set_privacy_coinflip_private", ctx);

    const settingsPrivate = chatDb.getChatGameSettings(99);
    expect(settingsPrivate?.coinflip_default_privacy).toBe("private");
    expect(lastMenu.text).toContain("Coinflip privacy: Private 🔒 (chat default)");

    // 4. Click "Clear" for Coinflip
    ctx.callbackQuery.data = "chat_defaults_set_privacy_coinflip_clear";
    await mockBot.dispatch("chat_defaults_set_privacy_coinflip_clear", ctx);

    const settingsClear = chatDb.getChatGameSettings(99);
    expect(settingsClear?.coinflip_default_privacy).toBeNull();
    // Default is Private (bot default)
    expect(lastMenu.text).toContain("Coinflip privacy: Private 🔒 (bot default)");

    // 5. Test Giveaway Privacy (briefly)
    ctx.callbackQuery.data = "chat_defaults_privacy_giveaway";
    await mockBot.dispatch("chat_defaults_privacy_giveaway", ctx);

    expect(lastMenu.text).toContain("Choose the default privacy setting for new Giveaway games");

    ctx.callbackQuery.data = "chat_defaults_set_privacy_giveaway_public";
    await mockBot.dispatch("chat_defaults_set_privacy_giveaway_public", ctx);

    const settingsGiveaway = chatDb.getChatGameSettings(99);
    expect(settingsGiveaway?.giveaway_default_privacy).toBe("public");
    expect(lastMenu.text).toContain("Giveaway privacy: Public 🌍 (chat default)");

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
});
