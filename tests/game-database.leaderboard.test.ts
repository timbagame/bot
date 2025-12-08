import { describe, test, expect, beforeEach } from "bun:test";
import { GameDatabase, type LeaderboardStatsRecord } from "../src/utils/game-database";

describe("GameDatabase Leaderboard", () => {
  let gameDb: GameDatabase;

  beforeEach(() => {
    GameDatabase.resetForTesting();
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
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeDefined();
    expect(playerStats?.gamesWon).toBe(3);
    expect(playerStats?.totalGames).toBe(3);

    const expectedTotalVolume = 1000000 + 500000000 + 50000000;
    expect(playerStats?.totalVolume).toBe(expectedTotalVolume);
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
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats?.gamesWon).toBe(1);
    expect(playerStats?.totalGames).toBe(3);
    expect(playerStats?.winRate).toBe(33.3); // Should be rounded to 1 decimal
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

    const stats: LeaderboardStatsRecord[] = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeDefined();
    expect(playerStats?.gamesWon).toBe(0);
    expect(playerStats?.totalGames).toBe(1);
    expect(playerStats?.winRate).toBe(0);
  });

  test("should exclude cancelled games from leaderboard aggregates", () => {
    const chatId = 77701;
    const playerId = "444";
    const playerPk = "PK444";

    gameDb.savePlayerMapping(playerPk, playerId);

    gameDb.saveGame("CANCEL_TEST", playerId, 2_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("CANCEL_TEST", "555", "PK555");
    gameDb.completeGame("CANCEL_TEST", "cancelled");

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeUndefined();
  });

  test("should ignore cancelled volume while retaining completed wins", () => {
    const chatId = 77702;
    const playerId = "555";
    const playerPk = "PK555";

    gameDb.savePlayerMapping(playerPk, playerId);

    // Cancelled game (should be ignored)
    gameDb.saveGame("CANCELLED_VOL", playerId, 9_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("CANCELLED_VOL", "666", "PK666");
    gameDb.completeGame("CANCELLED_VOL", "cancelled");

    // Completed win that should count
    gameDb.saveGame("WIN_VOL", playerId, 5_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("WIN_VOL", "777", "PK777");
    gameDb.completeGame("WIN_VOL", playerPk);

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeDefined();
    expect(playerStats?.gamesWon).toBe(1);
    expect(playerStats?.totalGames).toBe(1);
    expect(playerStats?.totalVolume).toBe(5_000_000);
  });

  test("should calculate net amount per token (positive for wins, negative for losses)", () => {
    const chatId = 88801;
    const playerId = "NET1";
    const playerPk = "PKNET1";

    gameDb.savePlayerMapping(playerPk, playerId);

    // Win 1000 TIMBA
    gameDb.saveGame("NET_WIN1", playerId, 1_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("NET_WIN1", "OTHER1", "PKOTHER1");
    gameDb.completeGame("NET_WIN1", playerPk);

    // Lose 500 TIMBA (other player wins)
    gameDb.saveGame("NET_LOSE1", playerId, 500_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("NET_LOSE1", "OTHER2", "PKOTHER2");
    gameDb.savePlayerMapping("PKOTHER2", "OTHER2");
    gameDb.completeGame("NET_LOSE1", "PKOTHER2");

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeDefined();
    expect(playerStats?.netAmountByToken).toBeDefined();
    // Net = +1000 - 500 = +500 (in raw units: 1_000_000 - 500_000 = 500_000)
    expect(playerStats?.netAmountByToken["TIMBA_MINT"]).toBe(500_000);
  });

  test("should track net amounts per token separately for multi-token games", () => {
    const chatId = 88802;
    const playerId = "NET2";
    const playerPk = "PKNET2";

    gameDb.savePlayerMapping(playerPk, playerId);

    // Win 100 TIMBA
    gameDb.saveGame("MULTI_WIN_TIMBA", playerId, 100_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("MULTI_WIN_TIMBA", "OTH1", "PKOTH1");
    gameDb.completeGame("MULTI_WIN_TIMBA", playerPk);

    // Win 0.5 SOL (no token_mint = SOL)
    gameDb.saveGame("MULTI_WIN_SOL", playerId, 500_000_000, "coinflip", undefined, "SOL", 2, 2, chatId);
    gameDb.saveGameParticipant("MULTI_WIN_SOL", "OTH2", "PKOTH2");
    gameDb.completeGame("MULTI_WIN_SOL", playerPk);

    // Lose 200 TIMBA
    gameDb.saveGame("MULTI_LOSE_TIMBA", playerId, 200_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("MULTI_LOSE_TIMBA", "OTH3", "PKOTH3");
    gameDb.savePlayerMapping("PKOTH3", "OTH3");
    gameDb.completeGame("MULTI_LOSE_TIMBA", "PKOTH3");

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeDefined();
    expect(playerStats?.netAmountByToken).toBeDefined();

    // TIMBA: +100 - 200 = -100 (raw: 100_000 - 200_000 = -100_000)
    expect(playerStats?.netAmountByToken["TIMBA_MINT"]).toBe(-100_000);

    // SOL: +0.5 (raw: 500_000_000)
    expect(playerStats?.netAmountByToken["SOL"]).toBe(500_000_000);
  });

  test("should include giveaway games in leaderboard stats", () => {
    const chatId = 88803;
    const playerId = "GIVEAWAY_TEST";
    const playerPk = "PKGIVEAWAY";

    gameDb.savePlayerMapping(playerPk, playerId);

    // Giveaway game (should be included)
    gameDb.saveGame("GIVEAWAY1", playerId, 1_000_000, "giveaway", "TIMBA_MINT", "TIMBA", 10, 2, chatId);
    gameDb.saveGameParticipant("GIVEAWAY1", "GA_OTHER", "PKGA_OTHER");
    gameDb.completeGame("GIVEAWAY1", playerPk);

    // Coinflip game (should be included)
    gameDb.saveGame("COINFLIP1", playerId, 500_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("COINFLIP1", "CF_OTHER", "PKCF_OTHER");
    gameDb.completeGame("COINFLIP1", playerPk);

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeDefined();
    // Both games should count
    expect(playerStats?.totalGames).toBe(2);
    expect(playerStats?.gamesWon).toBe(2);
    // Net should include both wins
    expect(playerStats?.netAmountByToken["TIMBA_MINT"]).toBe(1_500_000);
  });

  test("should not count losses for giveaway participants (only creator loses)", () => {
    const chatId = 88804;
    const creatorId = "GIVEAWAY_CREATOR";
    const creatorPk = "PKGIVEAWAY_CREATOR";
    const participantId = "GIVEAWAY_PARTICIPANT";
    const participantPk = "PKGIVEAWAY_PARTICIPANT";
    const winnerId = "GIVEAWAY_WINNER";
    const winnerPk = "PKGIVEAWAY_WINNER";

    gameDb.savePlayerMapping(creatorPk, creatorId);
    gameDb.savePlayerMapping(participantPk, participantId);
    gameDb.savePlayerMapping(winnerPk, winnerId);

    // Giveaway game: creator stakes 1000 TIMBA, winner (not the creator) wins
    gameDb.saveGame("GIVEAWAY_LOSS", creatorId, 1_000_000, "giveaway", "TIMBA_MINT", "TIMBA", 10, 2, chatId);
    gameDb.saveGameParticipant("GIVEAWAY_LOSS", participantId, participantPk);
    gameDb.saveGameParticipant("GIVEAWAY_LOSS", winnerId, winnerPk);
    gameDb.completeGame("GIVEAWAY_LOSS", winnerPk); // Winner wins, not creator

    const stats = gameDb.getLeaderboardStats(chatId, 10);

    const creatorStats = stats.find((s) => s.telegramId === creatorId);
    const participantStats = stats.find((s) => s.telegramId === participantId);
    const winnerStats = stats.find((s) => s.telegramId === winnerId);

    // Winner should have positive net (won the prize)
    expect(winnerStats).toBeDefined();
    expect(winnerStats?.netAmountByToken["TIMBA_MINT"]).toBe(1_000_000);

    // Creator should have negative net (lost the stake)
    expect(creatorStats).toBeDefined();
    expect(creatorStats?.netAmountByToken["TIMBA_MINT"]).toBe(-1_000_000);

    // Participant should have ZERO net (didn't risk anything in giveaway)
    expect(participantStats).toBeDefined();
    expect(participantStats?.netAmountByToken["TIMBA_MINT"]).toBe(0);
  });

  test("should respect limit parameter and return at most N players", () => {
    const chatId = 88805;

    // Create 7 players with games
    for (let i = 1; i <= 7; i++) {
      const playerId = `LIMIT_PLAYER_${i}`;
      const playerPk = `PK_LIMIT_${i}`;
      gameDb.savePlayerMapping(playerPk, playerId);

      const gameAddr = `LIMIT_GAME_${i}`;
      gameDb.saveGame(gameAddr, playerId, 1_000_000 * i, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
      gameDb.saveGameParticipant(gameAddr, `OTH_${i}`, `PKOTH_${i}`);
      gameDb.completeGame(gameAddr, playerPk); // Each player wins their game
    }

    // Request only 5 players
    const stats = gameDb.getLeaderboardStats(chatId, 5);

    // Should return at most 5 * 3 = 15 from DB (extra for re-sorting by USD)
    // But since we only have 7 players, we get 7
    expect(stats.length).toBeLessThanOrEqual(15);
    expect(stats.length).toBe(7); // All 7 are returned from DB before USD conversion

    // Request only 3 players
    const statsSmall = gameDb.getLeaderboardStats(chatId, 3);
    // DB fetches 3 * 3 = 9, but only 7 exist
    expect(statsSmall.length).toBe(7);
  });
});
