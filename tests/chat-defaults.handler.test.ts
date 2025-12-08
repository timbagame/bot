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

  test("privacy setting flow updates database and UI", async () => {
    const mockBot = createMockBot();
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();
    ctx.callbackQuery = {
      data: "chat_defaults_privacy",
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

    // 1. Click "Default privacy"
    await mockBot.dispatch("chat_defaults_privacy", ctx);

    expect(lastMenu.text).toContain("Choose the default privacy");
    expect(JSON.stringify(lastMenu.options)).toContain(
      "chat_defaults_set_privacy_public"
    );

    // 2. Click "Public"
    ctx.callbackQuery.data = "chat_defaults_set_privacy_public";
    await mockBot.dispatch("chat_defaults_set_privacy_public", ctx);

    const settingsPublic = chatDb.getChatGameSettings(99);
    expect(settingsPublic?.default_privacy).toBe("public");

    expect(lastMenu.text).toContain("Chat defaults");
    expect(lastMenu.text).toContain("Public 🌍 (chat default)");

    // 3. Click "Private"
    ctx.callbackQuery.data = "chat_defaults_set_privacy_private";
    await mockBot.dispatch("chat_defaults_set_privacy_private", ctx);

    const settingsPrivate = chatDb.getChatGameSettings(99);
    expect(settingsPrivate?.default_privacy).toBe("private");
    expect(lastMenu.text).toContain("Private 🔒 (chat default)");

    // 4. Click "Clear"
    ctx.callbackQuery.data = "chat_defaults_set_privacy_clear";
    await mockBot.dispatch("chat_defaults_set_privacy_clear", ctx);

    const settingsClear = chatDb.getChatGameSettings(99);
    expect(settingsClear?.default_privacy).toBeNull();
    // Default is Private (bot default)
    expect(lastMenu.text).toContain("Private 🔒 (bot default)");
  });
});
