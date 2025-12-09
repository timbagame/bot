
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GameDatabase } from "../src/utils/game-database";

describe("GameDatabase: getActiveGamesByChat", () => {
  let gameDb: GameDatabase;

  beforeEach(() => {
    GameDatabase.resetForTesting();
    gameDb = GameDatabase.getInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should show games where games.chat_id is null BUT game_messages has the chat_id", () => {
    const chatId = -100123456789;
    const creatorId = "123456789";
    const gameAddress = "GameWithNullChatId";

    // 1. Create a game with chat_id = null (simulating a game created elsewhere or public)
    gameDb.saveGame(
      gameAddress,
      creatorId,
      100,
      "coinflip",
      "So11111111111111111111111111111111111111112",
      "SOL",
      2,
      2,
      undefined, // chatId is undefined/null
      3600,
      Date.now() + 3600000
    );

    // Verify it is saved with null chat_id
    const savedGame = gameDb.getGame(gameAddress);
    expect(savedGame).toBeDefined();
    expect(savedGame?.chat_id).toBeNull();

    // 2. Simulate createGameMessage saving the message in the correct chat
    // This happens when a game message is posted to a group
    gameDb.saveGameMessage(gameAddress, 12345, chatId);

    // 3. Call getActiveGamesByChat
    const activeGames = gameDb.getActiveGamesByChat(chatId);

    // 4. Expect the game to be in the list because we query via game_messages
    expect(activeGames.length).toBe(1);
    expect(activeGames[0].game_address).toBe(gameAddress);
  });

  it("should ignore games that are NOT in the current chat", () => {
    const currentChatId = -100111111;
    const otherChatId = -100222222;
    const gameAddress = "OtherChatGame";

    gameDb.saveGame(
      gameAddress,
      "123",
      100,
      "coinflip",
      "SOL",
      "SOL",
      2,
      2,
      otherChatId,
      3600,
      Date.now() + 3600000
    );

    // Message only in other chat
    gameDb.saveGameMessage(gameAddress, 999, otherChatId);

    const activeGames = gameDb.getActiveGamesByChat(currentChatId);
    expect(activeGames.length).toBe(0);
  });

  it("should return distinct games even if multiple messages exist in the same chat", () => {
    const chatId = -100333333;
    const gameAddress = "MultiMessageGame";

    gameDb.saveGame(
      gameAddress,
      "123",
      50,
      "coinflip",
      "SOL",
      "SOL",
      2,
      2,
      chatId,
      3600,
      Date.now() + 3600000
    );

    // Simulate multiple messages for same game (e.g. initial + updated)
    gameDb.saveGameMessage(gameAddress, 101, chatId);

    const activeGames = gameDb.getActiveGamesByChat(chatId);
    expect(activeGames.length).toBe(1);
    expect(activeGames[0].game_address).toBe(gameAddress);
  });
});
