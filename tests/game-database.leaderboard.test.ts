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

    // Net profit for win is: totalPot (amount * 2) - amount = 1_000_000 (legacy default)
    // Loss is -amount = -500_000
    // Total net = 1_000_000 - 500_000 = 500_000
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

  test("should exclude giveaway games from leaderboard stats", () => {
    const chatId = 88803;
    const playerId = "GIVEAWAY_TEST";
    const playerPk = "PKGIVEAWAY";

    gameDb.savePlayerMapping(playerPk, playerId);

    // Giveaway game (should be EXCLUDED)
    gameDb.saveGame("GIVEAWAY1", playerId, 1_000_000, "giveaway", "TIMBA_MINT", "TIMBA", 10, 2, chatId);
    gameDb.saveGameParticipant("GIVEAWAY1", "GA_OTHER", "PKGA_OTHER");
    gameDb.completeGame("GIVEAWAY1", playerPk);

    // Coinflip game (should be INCLUDED)
    gameDb.saveGame("COINFLIP1", playerId, 500_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("COINFLIP1", "CF_OTHER", "PKCF_OTHER");
    gameDb.completeGame("COINFLIP1", playerPk);

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeDefined();
    // Only coinflip game should count (giveaway excluded)
    expect(playerStats?.totalGames).toBe(1);
    expect(playerStats?.gamesWon).toBe(1);
    // Net should only include coinflip win (giveaway excluded)
    expect(playerStats?.netAmountByToken["TIMBA_MINT"]).toBe(500_000);
  });

  test("should not show players who only played giveaways", () => {
    const chatId = 88804;
    const giveawayOnlyPlayer = "GIVEAWAY_ONLY";
    const giveawayOnlyPk = "PKGIVEAWAY_ONLY";

    gameDb.savePlayerMapping(giveawayOnlyPk, giveawayOnlyPlayer);

    // Only giveaway games - player should not appear on leaderboard
    gameDb.saveGame("GIVEAWAY_ONLY1", giveawayOnlyPlayer, 1_000_000, "giveaway", "TIMBA_MINT", "TIMBA", 10, 2, chatId);
    gameDb.saveGameParticipant("GIVEAWAY_ONLY1", "PART1", "PKPART1");
    gameDb.completeGame("GIVEAWAY_ONLY1", giveawayOnlyPk);

    const stats = gameDb.getLeaderboardStats(chatId, 10);
    const playerStats = stats.find((s) => s.telegramId === giveawayOnlyPlayer);

    // Player should NOT appear since they only have giveaway games
    expect(playerStats).toBeUndefined();
  });

  test("should respect limit parameter and return at most N*3 players (for USD re-sorting)", () => {
    const chatId = 88805;

    // Create 20 players with games (more than any reasonable limit*3)
    for (let i = 1; i <= 20; i++) {
      const playerId = `LIMIT_PLAYER_${i}`;
      const playerPk = `PK_LIMIT_${i}`;
      gameDb.savePlayerMapping(playerPk, playerId);

      const gameAddr = `LIMIT_GAME_${i}`;
      gameDb.saveGame(gameAddr, playerId, 1_000_000 * i, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
      gameDb.saveGameParticipant(gameAddr, `OTH_${i}`, `PKOTH_${i}`);
      gameDb.completeGame(gameAddr, playerPk); // Each player wins their game
    }

    // Request only 5 players: DB should return 5 * 3 = 15 players (for re-sorting by USD)
    const stats = gameDb.getLeaderboardStats(chatId, 5);
    expect(stats.length).toBe(15);

    // Request only 3 players: DB should return 3 * 3 = 9 players
    const statsSmall = gameDb.getLeaderboardStats(chatId, 3);
    expect(statsSmall.length).toBe(9);

    // All players should have their netAmountByToken populated
    for (const stat of stats) {
      expect(stat.netAmountByToken).toBeDefined();
    }
  });

  test("should calculate correct net profit for multi-player games using total_amount", () => {
    const chatId = 99901;
    const ticketAmount = 1_000;
    const creatorId = "MP_CREATOR";
    const player2Id = "MP_P2";
    const player3Id = "MP_P3";
    const gameAddress = "MP_GAME";

    gameDb.saveGame(
      gameAddress,
      creatorId,
      ticketAmount,
      "coinflip",
      "SOL",
      "SOL",
      3,
      2,
      chatId,
      30
    );

    gameDb.saveGameParticipant(gameAddress, creatorId, "PK_CREATOR", { status: "confirmed" });
    gameDb.saveGameParticipant(gameAddress, player2Id, "PK_P2", { status: "confirmed" });
    gameDb.saveGameParticipant(gameAddress, player3Id, "PK_P3", { status: "confirmed" });

    // Winner gets entire pot (3 players * 1000 = 3000)
    // Profit = 3000 - 1000 = 2000
    const totalPot = ticketAmount * 3;
    gameDb.completeGame(gameAddress, "PK_CREATOR", Date.now(), totalPot);

    gameDb.savePlayerMapping("PK_CREATOR", creatorId, "@Creator");
    gameDb.savePlayerMapping("PK_P2", player2Id, "@Player2");
    gameDb.savePlayerMapping("PK_P3", player3Id, "@Player3");

    const stats = gameDb.getLeaderboardStats(chatId);

    const creatorStats = stats.find(s => s.telegramId === creatorId);
    expect(creatorStats).toBeDefined();
    expect(creatorStats!.gamesWon).toBe(1);
    expect(creatorStats!.netAmountByToken["SOL"]).toBe(2000);

    const p2Stats = stats.find(s => s.telegramId === player2Id);
    expect(p2Stats!.netAmountByToken["SOL"]).toBe(-1000);
  });

  test("should fallback to assumed 2-player profit for legacy games without total_amount", () => {
    const chatId = 99902;
    const ticketAmount = 500;
    const creatorId = "LEGACY_CREATOR";
    const player2Id = "LEGACY_P2";
    const gameAddress = "LEGACY_GAME";

    gameDb.saveGame(
      gameAddress,
      creatorId,
      ticketAmount,
      "coinflip",
      "SOL",
      "SOL",
      2,
      2,
      chatId
    );

    gameDb.saveGameParticipant(gameAddress, creatorId, "PK_L_CREATOR", { status: "confirmed" });
    gameDb.saveGameParticipant(gameAddress, player2Id, "PK_L_P2", { status: "confirmed" });

    // Complete WITHOUT passing totalPot (simulating old data)
    gameDb.completeGame(gameAddress, "PK_L_CREATOR", Date.now());

    gameDb.savePlayerMapping("PK_L_CREATOR", creatorId);
    gameDb.savePlayerMapping("PK_L_P2", player2Id);

    const stats = gameDb.getLeaderboardStats(chatId);

    // Expected profit: (ticket * 2) - ticket = ticket
    const creatorStats = stats.find(s => s.telegramId === creatorId);
    expect(creatorStats).toBeDefined();
    expect(creatorStats!.netAmountByToken["SOL"]).toBe(ticketAmount);
  });

  test("getGlobalLeaderboardStats aggregates players across all chats", () => {
    // Create players in different chats
    const chatA = -1001111111111;
    const chatB = -1002222222222;
    const chatC = -1003333333333;

    // Player 1 plays in chat A
    const player1 = "GLOBAL_P1";
    const player1Pk = "PK_GLOBAL_P1";
    gameDb.savePlayerMapping(player1Pk, player1, "@Player1");
    gameDb.saveGame("GLOBAL_GAME_A1", player1, 1_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatA);
    gameDb.saveGameParticipant("GLOBAL_GAME_A1", player1, player1Pk, { status: "confirmed" });
    gameDb.saveGameParticipant("GLOBAL_GAME_A1", "OTHER_A1", "PK_OTHER_A1", { status: "confirmed" });
    gameDb.completeGame("GLOBAL_GAME_A1", player1Pk);

    // Player 2 plays in chat B
    const player2 = "GLOBAL_P2";
    const player2Pk = "PK_GLOBAL_P2";
    gameDb.savePlayerMapping(player2Pk, player2, "@Player2");
    gameDb.saveGame("GLOBAL_GAME_B1", player2, 2_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatB);
    gameDb.saveGameParticipant("GLOBAL_GAME_B1", player2, player2Pk, { status: "confirmed" });
    gameDb.saveGameParticipant("GLOBAL_GAME_B1", "OTHER_B1", "PK_OTHER_B1", { status: "confirmed" });
    gameDb.completeGame("GLOBAL_GAME_B1", player2Pk);

    // Player 3 plays in chat C
    const player3 = "GLOBAL_P3";
    const player3Pk = "PK_GLOBAL_P3";
    gameDb.savePlayerMapping(player3Pk, player3, "@Player3");
    gameDb.saveGame("GLOBAL_GAME_C1", player3, 3_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatC);
    gameDb.saveGameParticipant("GLOBAL_GAME_C1", player3, player3Pk, { status: "confirmed" });
    gameDb.saveGameParticipant("GLOBAL_GAME_C1", "OTHER_C1", "PK_OTHER_C1", { status: "confirmed" });
    gameDb.completeGame("GLOBAL_GAME_C1", player3Pk);

    // Global leaderboard should include all players from all chats
    const globalStats = gameDb.getGlobalLeaderboardStats(100);

    // Should include our 3 winners (losers may also appear)
    expect(globalStats.length).toBeGreaterThanOrEqual(3);
    expect(globalStats.some((s) => s.telegramId === player1)).toBe(true);
    expect(globalStats.some((s) => s.telegramId === player2)).toBe(true);
    expect(globalStats.some((s) => s.telegramId === player3)).toBe(true);

    // Check individual stats for winners
    const p1Stats = globalStats.find((s) => s.telegramId === player1);
    expect(p1Stats?.gamesWon).toBe(1);
    expect(p1Stats?.totalGames).toBe(1);

    const p3Stats = globalStats.find((s) => s.telegramId === player3);
    expect(p3Stats?.gamesWon).toBe(1);
    expect(p3Stats?.totalGames).toBe(1);
  });

  test("getGlobalLeaderboardStats respects limit parameter", () => {
    const chatId = -100999888;

    // Create many players
    for (let i = 1; i <= 10; i++) {
      const playerId = `GB_LIMIT_${i}`;
      const playerPk = `PKGB_LIMIT_${i}`;
      gameDb.savePlayerMapping(playerPk, playerId);
      gameDb.saveGame(`GB_LIMIT_GAME_${i}`, playerId, 100_000 * i, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
      gameDb.saveGameParticipant(`GB_LIMIT_GAME_${i}`, `GB_OTH_${i}`, `PK_GB_OTH_${i}`);
      gameDb.completeGame(`GB_LIMIT_GAME_${i}`, playerPk);
    }

    // Request limit of 3 (should return 3*3=9 for re-sorting by USD)
    const stats = gameDb.getGlobalLeaderboardStats(3);
    expect(stats.length).toBe(9);
  });

  test("getGlobalLeaderboardStats excludes giveaways like regular leaderboard", () => {
    const chatId = -100777666;
    const playerId = "GB_GIVEAWAY_TEST";
    const playerPk = "PK_GB_GIVEAWAY";

    gameDb.savePlayerMapping(playerPk, playerId);

    // Giveaway (excluded)
    gameDb.saveGame("GB_GIVEAWAY1", playerId, 1_000_000, "giveaway", "TIMBA_MINT", "TIMBA", 10, 2, chatId);
    gameDb.saveGameParticipant("GB_GIVEAWAY1", playerId, playerPk, { status: "confirmed" });
    gameDb.saveGameParticipant("GB_GIVEAWAY1", "GB_GA_OTH", "PK_GB_GA_OTH");
    gameDb.completeGame("GB_GIVEAWAY1", playerPk);

    // Coinflip (included)
    gameDb.saveGame("GB_COINFLIP1", playerId, 500_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatId);
    gameDb.saveGameParticipant("GB_COINFLIP1", playerId, playerPk, { status: "confirmed" });
    gameDb.saveGameParticipant("GB_COINFLIP1", "GB_CF_OTH", "PK_GB_CF_OTH", { status: "confirmed" });
    gameDb.completeGame("GB_COINFLIP1", playerPk);

    const globalStats = gameDb.getGlobalLeaderboardStats(100);
    const playerStats = globalStats.find((s) => s.telegramId === playerId);

    expect(playerStats).toBeDefined();
    expect(playerStats?.totalGames).toBe(1); // Only coinflip (giveaway excluded)
    expect(playerStats?.gamesWon).toBe(1);
  });

  test("getGlobalLeaderboardStats returns empty array when no games exist", () => {
    const stats = gameDb.getGlobalLeaderboardStats(10);
    expect(stats).toEqual([]);
  });

  // ========================================
  // Tests for getLeaderboardStats (global stats for group members)
  // ========================================

  test("getLeaderboardStats shows global stats for players who played in the chat", () => {
    const chatA = -1001111111111;
    const chatB = -1002222222222;

    // Player 1 plays in BOTH chats
    const player1 = "CROSS_CHAT_P1";
    const player1Pk = "PK_CROSS_CHAT_P1";
    gameDb.savePlayerMapping(player1Pk, player1, "@CrossChatPlayer1");

    // Game in Chat A (player1 is creator and winner)
    gameDb.saveGame("CROSS_GAME_A1", player1, 1_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatA);
    gameDb.saveGameParticipant("CROSS_GAME_A1", player1, player1Pk, { status: "confirmed" });
    gameDb.saveGameParticipant("CROSS_GAME_A1", "OTHER_A1", "PK_OTHER_A1", { status: "confirmed" });
    gameDb.completeGame("CROSS_GAME_A1", player1Pk);

    // Game in Chat B (player1 is creator and winner)
    gameDb.saveGame("CROSS_GAME_B1", player1, 2_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatB);
    gameDb.saveGameParticipant("CROSS_GAME_B1", player1, player1Pk, { status: "confirmed" });
    gameDb.saveGameParticipant("CROSS_GAME_B1", "OTHER_B1", "PK_OTHER_B1", { status: "confirmed" });
    gameDb.completeGame("CROSS_GAME_B1", player1Pk);

    // Get leaderboard for Chat A - should include player1's global stats (from both chats)
    const statsA = gameDb.getLeaderboardStats(chatA, 10);
    const player1StatsInA = statsA.find((s) => s.telegramId === player1);

    expect(player1StatsInA).toBeDefined();
    // Should count BOTH games (from A and B)
    expect(player1StatsInA?.totalGames).toBe(2);
    expect(player1StatsInA?.gamesWon).toBe(2);
  });

  test("getLeaderboardStats excludes players who never played in the requested chat", () => {
    const chatA = -1001111111112;
    const chatB = -1002222222223;

    // Player 1 only plays in Chat A
    const player1 = "CHATONLY_P1";
    const player1Pk = "PK_CHATONLY_P1";
    gameDb.savePlayerMapping(player1Pk, player1);
    gameDb.saveGame("CHATONLY_GAME_A", player1, 1_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatA);
    gameDb.saveGameParticipant("CHATONLY_GAME_A", player1, player1Pk, { status: "confirmed" });
    gameDb.saveGameParticipant("CHATONLY_GAME_A", "OTHER1", "PK_OTHER1", { status: "confirmed" });
    gameDb.completeGame("CHATONLY_GAME_A", player1Pk);

    // Player 2 only plays in Chat B
    const player2 = "CHATONLY_P2";
    const player2Pk = "PK_CHATONLY_P2";
    gameDb.savePlayerMapping(player2Pk, player2);
    gameDb.saveGame("CHATONLY_GAME_B", player2, 2_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatB);
    gameDb.saveGameParticipant("CHATONLY_GAME_B", player2, player2Pk, { status: "confirmed" });
    gameDb.saveGameParticipant("CHATONLY_GAME_B", "OTHER2", "PK_OTHER2", { status: "confirmed" });
    gameDb.completeGame("CHATONLY_GAME_B", player2Pk);

    // Get leaderboard for Chat A - should NOT include player2
    const statsA = gameDb.getLeaderboardStats(chatA, 10);
    const player1InA = statsA.find((s) => s.telegramId === player1);
    const player2InA = statsA.find((s) => s.telegramId === player2);

    expect(player1InA).toBeDefined();
    expect(player2InA).toBeUndefined(); // Player 2 never played in Chat A

    // Get leaderboard for Chat B - should NOT include player1
    const statsB = gameDb.getLeaderboardStats(chatB, 10);
    const player1InB = statsB.find((s) => s.telegramId === player1);
    const player2InB = statsB.find((s) => s.telegramId === player2);

    expect(player2InB).toBeDefined();
    expect(player1InB).toBeUndefined(); // Player 1 never played in Chat B
  });

  test("getLeaderboardStats includes participant who joined (not created) in chat", () => {
    const chatA = -1001111111113;
    const chatB = -1002222222224;

    // Player creates game in Chat B
    const joinerPlayer = "JOINER_PLAYER";
    const joinerPk = "PK_JOINER";
    gameDb.savePlayerMapping(joinerPk, joinerPlayer);

    const creatorPlayer = "CREATOR_PLAYER";
    const creatorPk = "PK_CREATOR";
    gameDb.savePlayerMapping(creatorPk, creatorPlayer);

    // Creator makes a game in Chat A, joiner joins
    gameDb.saveGame("JOIN_TEST_GAME_A", creatorPlayer, 1_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatA);
    gameDb.saveGameParticipant("JOIN_TEST_GAME_A", creatorPlayer, creatorPk, { status: "confirmed" });
    gameDb.saveGameParticipant("JOIN_TEST_GAME_A", joinerPlayer, joinerPk, { status: "confirmed" });
    gameDb.completeGame("JOIN_TEST_GAME_A", joinerPk); // Joiner wins

    // Joiner also plays in Chat B (to have cross-chat stats)
    gameDb.saveGame("JOIN_TEST_GAME_B", joinerPlayer, 500_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatB);
    gameDb.saveGameParticipant("JOIN_TEST_GAME_B", joinerPlayer, joinerPk, { status: "confirmed" });
    gameDb.saveGameParticipant("JOIN_TEST_GAME_B", "OTHER_B", "PK_OTHER_B", { status: "confirmed" });
    gameDb.completeGame("JOIN_TEST_GAME_B", joinerPk);

    // Chat A leaderboard should include joiner (they joined a game there)
    // and show their GLOBAL stats (2 wins total)
    const statsA = gameDb.getLeaderboardStats(chatA, 10);
    const joinerStats = statsA.find((s) => s.telegramId === joinerPlayer);

    expect(joinerStats).toBeDefined();
    expect(joinerStats?.totalGames).toBe(2); // Both games (A + B)
    expect(joinerStats?.gamesWon).toBe(2);
  });

  test("getLeaderboardStats calculates global net amounts for group members", () => {
    const chatA = -1001111111114;
    const chatB = -1002222222225;

    const player = "NET_GLOBAL_P1";
    const playerPk = "PK_NET_GLOBAL";
    gameDb.savePlayerMapping(playerPk, player);

    // Win 1000 TIMBA in Chat A
    gameDb.saveGame("NET_GLOBAL_WIN_A", player, 1_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatA);
    gameDb.saveGameParticipant("NET_GLOBAL_WIN_A", player, playerPk, { status: "confirmed" });
    gameDb.saveGameParticipant("NET_GLOBAL_WIN_A", "LOSER_A", "PK_LOSER_A", { status: "confirmed" });
    gameDb.completeGame("NET_GLOBAL_WIN_A", playerPk);

    // Win 2000 TIMBA in Chat B
    gameDb.saveGame("NET_GLOBAL_WIN_B", player, 2_000_000, "coinflip", "TIMBA_MINT", "TIMBA", 2, 2, chatB);
    gameDb.saveGameParticipant("NET_GLOBAL_WIN_B", player, playerPk, { status: "confirmed" });
    gameDb.saveGameParticipant("NET_GLOBAL_WIN_B", "LOSER_B", "PK_LOSER_B", { status: "confirmed" });
    gameDb.completeGame("NET_GLOBAL_WIN_B", playerPk);

    // Get Chat A leaderboard - net amount should include BOTH wins
    const statsA = gameDb.getLeaderboardStats(chatA, 10);
    const playerStats = statsA.find((s) => s.telegramId === player);

    expect(playerStats).toBeDefined();
    expect(playerStats?.totalGames).toBe(2);
    // Net = 1_000_000 (win A) + 2_000_000 (win B) = 3_000_000
    expect(playerStats?.netAmountByToken["TIMBA_MINT"]).toBe(3_000_000);
  });

  test("getLeaderboardStats returns empty when no one has played in the chat", () => {
    const emptyChat = -1009999999999;
    const stats = gameDb.getLeaderboardStats(emptyChat, 10);
    expect(stats).toEqual([]);
  });
});
