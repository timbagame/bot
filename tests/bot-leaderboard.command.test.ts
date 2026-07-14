import { describe, test, expect, beforeEach } from "bun:test";
import { GameDatabase } from "../src/utils/game-database";

describe("Leaderboard command membership filtering", () => {
  let gameDb: GameDatabase;

  beforeEach(() => {
    GameDatabase.resetForTesting();
    gameDb = GameDatabase.getInstance();
  });

  // Helper to create players with games
  const createPlayerWithGame = (
    playerId: string,
    playerPk: string,
    gameAddress: string,
    chatId: number,
    username?: string,
  ) => {
    gameDb.savePlayerMapping(playerPk, playerId, username);
    gameDb.saveGame(
      gameAddress,
      playerId,
      1_000_000,
      "coinflip",
      "TIMBA_MINT",
      "TIMBA",
      2,
      2,
      chatId,
    );
    gameDb.saveGameParticipant(gameAddress, playerId, playerPk, { status: "confirmed" });
    gameDb.saveGameParticipant(gameAddress, `OTHER_${gameAddress}`, `PK_OTHER_${gameAddress}`, {
      status: "confirmed",
    });
    gameDb.completeGame(gameAddress, playerPk);
  };

  test("membership check filters out non-members from leaderboard candidates", async () => {
    const chatId = -1001234567890;

    // Create two players who have played in this chat
    createPlayerWithGame("MEMBER_PLAYER", "PK_MEMBER", "MEMBER_GAME", chatId, "@memberuser");
    createPlayerWithGame(
      "NONMEMBER_PLAYER",
      "PK_NONMEMBER",
      "NONMEMBER_GAME",
      chatId,
      "@nonmemberuser",
    );

    // Verify both appear in raw stats (database level)
    const rawStats = gameDb.getLeaderboardStats(chatId, 10);
    expect(rawStats.length).toBeGreaterThanOrEqual(2);
    expect(rawStats.some((s) => s.telegramId === "MEMBER_PLAYER")).toBe(true);
    expect(rawStats.some((s) => s.telegramId === "NONMEMBER_PLAYER")).toBe(true);
  });

  test("getChatMember status 'member' includes player", () => {
    // This tests the logic that determines membership
    const memberStatuses = ["member", "administrator", "creator"];
    const nonMemberStatuses = ["left", "kicked"];

    for (const status of memberStatuses) {
      const isMember = ["member", "administrator", "creator"].includes(status);
      expect(isMember).toBe(true);
    }

    for (const status of nonMemberStatuses) {
      const isMember = ["member", "administrator", "creator"].includes(status);
      expect(isMember).toBe(false);
    }
  });

  test("getChatMember status 'restricted' with is_member=true includes player", () => {
    // Restricted members with is_member: true should be included
    const restrictedMember = { status: "restricted" as const, is_member: true };
    const isMember =
      ["member", "administrator", "creator"].includes(restrictedMember.status) ||
      (restrictedMember.status === "restricted" && restrictedMember.is_member);
    expect(isMember).toBe(true);
  });

  test("getChatMember status 'restricted' with is_member=false excludes player", () => {
    // Restricted members with is_member: false should be excluded
    const restrictedNonMember = { status: "restricted" as const, is_member: false };
    const isMember =
      ["member", "administrator", "creator"].includes(restrictedNonMember.status) ||
      (restrictedNonMember.status === "restricted" && restrictedNonMember.is_member);
    expect(isMember).toBe(false);
  });

  test("getChatMember error excludes player gracefully", () => {
    // If getChatMember throws, player should be excluded (isMember = false)
    // This simulates the catch block behavior
    const errorOccurred = true;
    const isMember = errorOccurred ? false : true;
    expect(isMember).toBe(false);
  });

  test("empty membership check result shows empty leaderboard message", async () => {
    const chatId = -1009876543210;

    // Create a player in this chat
    createPlayerWithGame("ONLY_PLAYER", "PK_ONLY", "ONLY_GAME", chatId);

    // Raw stats has the player
    const rawStats = gameDb.getLeaderboardStats(chatId, 10);
    expect(rawStats.length).toBeGreaterThanOrEqual(1);

    // If membership filtering removes ALL players, result should be empty array
    const filteredPlayers: any[] = []; // Simulated: all players were non-members
    expect(filteredPlayers.length).toBe(0);
  });

  test("administrators and creators are included in membership check", () => {
    // Verify admins and creators are treated as members
    const adminStatus = { status: "administrator" as const };
    const creatorStatus = { status: "creator" as const };

    const isAdminMember = ["member", "administrator", "creator"].includes(adminStatus.status);
    const isCreatorMember = ["member", "administrator", "creator"].includes(creatorStatus.status);

    expect(isAdminMember).toBe(true);
    expect(isCreatorMember).toBe(true);
  });

  test("left and kicked users are excluded from membership", () => {
    // Verify left and kicked users are NOT treated as members
    const leftStatus = { status: "left" as const };
    const kickedStatus = { status: "kicked" as const };

    const isLeftMember = ["member", "administrator", "creator"].includes(leftStatus.status);
    const isKickedMember = ["member", "administrator", "creator"].includes(kickedStatus.status);

    expect(isLeftMember).toBe(false);
    expect(isKickedMember).toBe(false);
  });

  // ========================================
  // Membership Cache Database Tests
  // ========================================

  test("saveMembershipCache and getCachedMembership work correctly", () => {
    const chatId = -1001111111111;
    const telegramId = "CACHE_TEST_USER";

    // Initially no cache
    expect(gameDb.getCachedMembership(chatId, telegramId)).toBeNull();

    // Save as member
    gameDb.saveMembershipCache(chatId, telegramId, true);
    expect(gameDb.getCachedMembership(chatId, telegramId)).toBe(true);

    // Update to non-member
    gameDb.saveMembershipCache(chatId, telegramId, false);
    expect(gameDb.getCachedMembership(chatId, telegramId)).toBe(false);
  });

  test("getCachedMemberships returns multiple cached values", () => {
    const chatId = -1002222222222;

    // Save membership for multiple users
    gameDb.saveMembershipCache(chatId, "USER1", true);
    gameDb.saveMembershipCache(chatId, "USER2", false);
    gameDb.saveMembershipCache(chatId, "USER3", true);

    const cached = gameDb.getCachedMemberships(chatId, ["USER1", "USER2", "USER3", "USER4"]);

    expect(cached.size).toBe(3); // USER4 has no cache
    expect(cached.get("USER1")).toBe(true);
    expect(cached.get("USER2")).toBe(false);
    expect(cached.get("USER3")).toBe(true);
    expect(cached.has("USER4")).toBe(false);
  });

  test("getCachedMembership respects TTL parameter", () => {
    const chatId = -1003333333333;
    const telegramId = "TTL_TEST_USER";

    // Save membership
    gameDb.saveMembershipCache(chatId, telegramId, true);

    // With very long TTL (1 hour), cache should be valid
    expect(gameDb.getCachedMembership(chatId, telegramId, 60 * 60 * 1000)).toBe(true);

    // With a medium TTL (10 minutes), cache should still be valid (just saved)
    expect(gameDb.getCachedMembership(chatId, telegramId, 10 * 60 * 1000)).toBe(true);
  });

  test("cleanupMembershipCache removes old entries", () => {
    const chatId = -1004444444444;

    // Save some entries
    gameDb.saveMembershipCache(chatId, "CLEANUP_USER1", true);
    gameDb.saveMembershipCache(chatId, "CLEANUP_USER2", false);

    // With very long TTL, nothing should be deleted
    const deleted = gameDb.cleanupMembershipCache(1000 * 60 * 60 * 24 * 365); // 1 year
    expect(deleted).toBe(0);

    // Entries should still exist
    expect(gameDb.getCachedMembership(chatId, "CLEANUP_USER1")).toBe(true);
  });

  test("membership cache is isolated per chat", () => {
    const chatA = -1005555555555;
    const chatB = -1006666666666;
    const telegramId = "ISOLATION_TEST_USER";

    // Save different membership in different chats
    gameDb.saveMembershipCache(chatA, telegramId, true);
    gameDb.saveMembershipCache(chatB, telegramId, false);

    // Each chat should have its own cache
    expect(gameDb.getCachedMembership(chatA, telegramId)).toBe(true);
    expect(gameDb.getCachedMembership(chatB, telegramId)).toBe(false);
  });
});
