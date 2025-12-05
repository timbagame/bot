import { beforeEach, describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import { createChatDefaultsModule, __test_buildSettingsSummary } from "../src/handlers/chat-defaults";
import { ChatDatabase } from "../src/utils/chat-database";
import { resetTestDatabase } from "./helpers/database";
import type { InputSessionState } from "../src/utils/user-state";

const bot = new Bot("test-token");

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

  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    ChatDatabase.resetForTesting();
    chatDb = ChatDatabase.getInstance();
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
    expect(summary).toContain("1800s");
  });

  test("updates settings via text input handler", async () => {
    const tokenManager = baseTokenManager();
    const { ctx, replies } = buildMockContext();

    const module = createChatDefaultsModule({
      bot,
      chatDb,
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
});
