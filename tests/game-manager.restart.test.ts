import { describe, test, expect, mock } from "bun:test";
import { GameManager } from "../src/utils/game";

function resetGM() {
  GameManager.resetForTest();
}

function programStub() {
  return {
    account: { game: { fetch: async () => ({}) } },
  } as any;
}

function walletStub() {
  return {
    getBlockchainTime: async () => Math.floor(Date.now() / 1000),
    getTokenMetadata: async () => ({ decimals: 9 }),
    formatTokenBalance: (amount: number, d: number) => (amount / Math.pow(10, d)).toFixed(2),
  } as any;
}

describe("GameManager restart fallback", () => {
  test("updateGameMessage restores message targets from database when in-memory map is empty", async () => {
    resetGM();

    const gameAddress = "11111111111111111111111111111111";
    const chatId = 123456;
    const messageId = 7890;

    // 1. Mock Database
    const mockGetGameMessages = mock(() => [{ chatId, messageId }]);
    const mockGetGame = mock(() => ({
      game_address: gameAddress,
      game_type: "coinflip",
      amount: 1_000_000_000,
      token_ticker: "TOK",
      token_mint: "MINT",
      creator_telegram_id: "777",
      status: "active",
    }));

    const db = {
      getGameMessages: mockGetGameMessages,
      getGame: mockGetGame,
      getGameParticipants: () => [],
      saveGameMessage: () => {},
      getPlayerDisplayName: () => "User777",
      getPlayerUsername: () => "user777",
    } as any;

    // 2. Mock Bot Context / API
    const mockEditMessageText = mock(async () => ({}));
    const mockEditMessageCaption = mock(async () => ({}));
    const ctx = {
      chat: { id: chatId },
      api: {
        editMessageText: mockEditMessageText,
        editMessageCaption: mockEditMessageCaption,
        editMessageMedia: mock(async () => ({})),
        getChatMember: async () => ({ user: { username: "user777" } }),
      },
    } as any;

    const gm = GameManager.getInstance(programStub(), walletStub(), db);

    // Ensure in-memory map is empty (it should be since we just got the instance)
    const initialMap = gm.getActiveGameMessages(gameAddress);
    expect(initialMap).toBeUndefined();

    // 3. Call updateGameMessage
    // We use dummy values since we want to see if the fallback happens
    await gm.updateGameMessage(
      ctx,
      gameAddress,
      "Coinflip",
      1_000_000_000,
      "user777",
      "Active",
      "TOK",
    );

    // 4. Verifications
    // Check if database was queried
    expect(mockGetGameMessages).toHaveBeenCalledWith(gameAddress);

    // Check if map was repopulated
    const restoredMap = gm.getActiveGameMessages(gameAddress);
    expect(restoredMap).toBeDefined();
    expect(restoredMap?.get(chatId)).toEqual({
      chatId,
      messageId,
      usesVideo: true,
    });

    // Check if message was edited (it should be caption because of usesVideo: true)
    expect(mockEditMessageCaption).toHaveBeenCalled();
    const calls = mockEditMessageCaption.mock.calls;
    if (calls.length > 0) {
      const [calledChatId, calledMessageId] = calls[0] as any as [number, number, any];
      expect(calledChatId).toBe(chatId);
      expect(calledMessageId).toBe(messageId);
    }
  });

  test("updateGameMessage falls back to editMessageText when caption edit fails", async () => {
    resetGM();

    const gameAddress = "BPFLoader1111111111111111111111111111111111";
    const chatId = 654321;
    const messageId = 9876;

    // Mock Database
    const mockGetGameMessages = mock(() => [{ chatId, messageId }]);
    const mockGetGame = mock(() => ({
      game_address: gameAddress,
      game_type: "coinflip",
      amount: 1_000_000_000,
      token_ticker: "TOK",
      token_mint: "MINT",
      creator_telegram_id: "888",
      status: "active",
    }));

    const db = {
      getGameMessages: mockGetGameMessages,
      getGame: mockGetGame,
      getGameParticipants: () => [],
      saveGameMessage: () => {},
      getPlayerDisplayName: () => "User888",
      getPlayerUsername: () => "user888",
    } as any;

    // Mock Bot Context / API - caption edit fails (simulating text-only message)
    const mockEditMessageText = mock(async () => ({}));
    const mockEditMessageCaption = mock(async () => {
      const error = new Error("Bad Request: there is no caption in the message to edit");
      (error as any).error_code = 400;
      throw error;
    });

    const ctx = {
      chat: { id: chatId },
      api: {
        editMessageText: mockEditMessageText,
        editMessageCaption: mockEditMessageCaption,
        editMessageMedia: mock(async () => ({})),
        getChatMember: async () => ({ user: { username: "user888" } }),
      },
    } as any;

    const gm = GameManager.getInstance(programStub(), walletStub(), db);

    await gm.updateGameMessage(
      ctx,
      gameAddress,
      "Coinflip",
      1_000_000_000,
      "user888",
      "Active",
      "TOK",
    );

    // Caption edit was attempted first
    expect(mockEditMessageCaption).toHaveBeenCalled();

    // Then text edit was called as fallback
    expect(mockEditMessageText).toHaveBeenCalled();

    // After fallback, usesVideo should be set to false
    const restoredMap = gm.getActiveGameMessages(gameAddress);
    expect(restoredMap?.get(chatId)?.usesVideo).toBe(false);
  });

  test("updateGameMessage keeps the media ID when replacement delivery also fails", async () => {
    resetGM();

    const gameAddress = "Config1111111111111111111111111111111111111";
    const chatId = 111222;
    const messageId = 3344;

    // Mock Database
    const mockGetGameMessages = mock(() => [{ chatId, messageId }]);
    const mockGetGame = mock(() => ({
      game_address: gameAddress,
      game_type: "coinflip",
      amount: 1_000_000_000,
      token_ticker: "TOK",
      token_mint: "MINT",
      creator_telegram_id: "999",
      status: "active",
    }));

    const db = {
      getGameMessages: mockGetGameMessages,
      getGame: mockGetGame,
      getGameParticipants: () => [],
      saveGameMessage: () => {},
      getPlayerDisplayName: () => "User999",
      getPlayerUsername: () => "user999",
    } as any;

    // Both editing routes fail and the replacement cannot be delivered.
    const mockEditMessageText = mock(async () => {
      const error = new Error("Bad Request: there is no text in the message to edit");
      (error as any).error_code = 400;
      throw error;
    });
    const mockEditMessageCaption = mock(async () => {
      const error = new Error("Bad Request: there is no caption in the message to edit");
      (error as any).error_code = 400;
      throw error;
    });

    const ctx = {
      chat: { id: chatId },
      api: {
        editMessageReplyMarkup: mock(async () => true),
        sendMessage: mock(async () => {
          throw new Error("synthetic delivery failure");
        }),
        editMessageText: mockEditMessageText,
        editMessageCaption: mockEditMessageCaption,
        editMessageMedia: mock(async () => ({})),
        getChatMember: async () => ({ user: { username: "user999" } }),
      },
    } as any;

    const gm = GameManager.getInstance(programStub(), walletStub(), db);

    // This should NOT throw - it should handle the error gracefully
    await gm.updateGameMessage(
      ctx,
      gameAddress,
      "Coinflip",
      1_000_000_000,
      "user999",
      "Active",
      "TOK",
    );

    // Caption edit was attempted first
    expect(mockEditMessageCaption).toHaveBeenCalled();

    // Then text edit was called as fallback (inside the fallback function)
    expect(mockEditMessageText).toHaveBeenCalled();

    // Failed delivery must not claim that the old media message became text.
    const restoredMap = gm.getActiveGameMessages(gameAddress);
    expect(restoredMap?.get(chatId)?.usesVideo).toBe(true);
    expect(restoredMap?.get(chatId)?.messageId).toBe(messageId);
    expect(ctx.api.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("updateGameMessage falls back from text to caption when message is actually media", async () => {
    resetGM();

    const gameAddress = "Stake11111111111111111111111111111111111111";
    const chatId = 222333;
    const messageId = 4455;

    // Mock Database
    const mockGetGameMessages = mock(() => [{ chatId, messageId }]);
    const mockGetGame = mock(() => ({
      game_address: gameAddress,
      game_type: "coinflip",
      amount: 1_000_000_000,
      token_ticker: "TOK",
      token_mint: "MINT",
      creator_telegram_id: "111",
      status: "active",
    }));

    const db = {
      getGameMessages: mockGetGameMessages,
      getGame: mockGetGame,
      getGameParticipants: () => [],
      saveGameMessage: () => {},
      getPlayerDisplayName: () => "User111",
      getPlayerUsername: () => "user111",
    } as any;

    // Mock Bot Context / API - text edit fails (message has media), caption succeeds
    const mockEditMessageCaption = mock(async () => ({}));
    const mockEditMessageText = mock(async () => {
      const error = new Error("Bad Request: there is no text in the message to edit");
      (error as any).error_code = 400;
      throw error;
    });

    const ctx = {
      chat: { id: chatId },
      api: {
        editMessageText: mockEditMessageText,
        editMessageCaption: mockEditMessageCaption,
        editMessageMedia: mock(async () => ({})),
        getChatMember: async () => ({ user: { username: "user111" } }),
      },
    } as any;

    const gm = GameManager.getInstance(programStub(), walletStub(), db);

    // Since usesVideo defaults to true after restart, caption edit will be tried first
    // This test simulates if somehow usesVideo was set to false but message has media
    // Force usesVideo to false to test the fallback path
    const messageMap = new Map();
    messageMap.set(chatId, { chatId, messageId, usesVideo: false });
    (gm as any).activeGameMessages.set(gameAddress, messageMap);

    await gm.updateGameMessage(
      ctx,
      gameAddress,
      "Coinflip",
      1_000_000_000,
      "user111",
      "Active",
      "TOK",
    );

    // Text edit was attempted first (since usesVideo: false)
    expect(mockEditMessageText).toHaveBeenCalled();

    // Then caption edit was called as fallback
    expect(mockEditMessageCaption).toHaveBeenCalled();

    // After fallback succeeded, usesVideo should be set to true
    const restoredMap = gm.getActiveGameMessages(gameAddress);
    expect(restoredMap?.get(chatId)?.usesVideo).toBe(true);
  });
});
