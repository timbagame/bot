import { describe, test, expect, beforeEach } from "bun:test";
import { GameDatabase } from "../src/utils/game-database";

describe("GameDatabase Leaderboard", () => {
  let gameDb: GameDatabase;

  beforeEach(() => {
    gameDb = GameDatabase.getInstance();
  });

  test("should aggregate leaderboard stats across multiple tokens", async () => {
    const chatId = 12345;
    const playerId = "111";
    const playerPk = "PK111";

    // Create player mapping
    gameDb.savePlayerMapping(playerPk, playerId);

    // Game 1: TIMBA game (6 decimals) - 1000 TIMBA
    const game1 = "GAME1";
    gameDb.saveGame(game1, playerId, 1000000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant(game1, "222", "PK222");
    gameDb.completeGame(game1, playerPk);

    // Game 2: WSOL game (9 decimals) - 0.5 WSOL
    const game2 = "GAME2";
    gameDb.saveGame(game2, playerId, 500000000, "coinflip", "WSOL_MINT", "WSOL", 2, 2, chatId);
    gameDb.saveGameParticipant(game2, "333", "PK333");
    gameDb.completeGame(game2, playerPk);

    // Game 3: USDC game (6 decimals) - 50 USDC
    const game3 = "GAME3";
    gameDb.saveGame(game3, playerId, 50000000, "coinflip", "USDC_MINT", "USDC", 2, 2, chatId);
    gameDb.saveGameParticipant(game3, "444", "PK444");
    gameDb.completeGame(game3, playerPk);

    // Get leaderboard stats
    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find(s => s.telegram_id === playerId);

    expect(playerStats).toBeDefined();
    expect(playerStats?.games_won).toBe(3);
    expect(playerStats?.total_games).toBe(3);
    
    const expectedTotalVolume = 1000000 + 500000000 + 50000000;
    expect(playerStats?.total_volume).toBe(expectedTotalVolume);
    expect(playerStats?.token_volumes).toBeUndefined();
  });

  test("should calculate win rate correctly and round to 1 decimal", async () => {
    const chatId = 12347; // Different chat ID
    const playerId = "222"; // Different player ID
    const playerPk = "PK222";

    gameDb.savePlayerMapping(playerPk, playerId);

    // Create 3 games, player wins 1 (33.33% win rate)
    gameDb.saveGame("GAME1_WINRATE", playerId, 1000000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("GAME1_WINRATE", "333", "PK333");
    gameDb.completeGame("GAME1_WINRATE", playerPk); // Player wins

    gameDb.saveGame("GAME2_WINRATE", playerId, 1000000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("GAME2_WINRATE", "444", "PK444");
    gameDb.completeGame("GAME2_WINRATE", "PK444"); // Player loses

    gameDb.saveGame("GAME3_WINRATE", playerId, 1000000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("GAME3_WINRATE", "555", "PK555");
    gameDb.completeGame("GAME3_WINRATE", "PK555"); // Player loses

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find(s => s.telegram_id === playerId);

    expect(playerStats?.games_won).toBe(1);
    expect(playerStats?.total_games).toBe(3);
    expect(playerStats?.win_rate).toBe(33.3); // Should be rounded to 1 decimal
  });

  test("should handle players with no victories", async () => {
    const chatId = 12348; // Different chat ID
    const playerId = "333"; // Different player ID
    const playerPk = "PK333";

    gameDb.savePlayerMapping(playerPk, playerId);

    // Create a game where player participates but doesn't win
    gameDb.saveGame("GAME1_NOVICTORY", playerId, 1000000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("GAME1_NOVICTORY", "444", "PK444");
    gameDb.completeGame("GAME1_NOVICTORY", "PK444"); // Other player wins

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find(s => s.telegram_id === playerId);
    
    expect(playerStats).toBeDefined();
    expect(playerStats?.games_won).toBe(0);
    expect(playerStats?.total_games).toBe(1);
    expect(playerStats?.win_rate).toBe(0);
  });
});
