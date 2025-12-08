import { expect, test, beforeEach } from "bun:test";
import type { GameData } from "../src/types";
import { GameDatabase } from "../src/utils/game-database";
import { GAME_CREATION_RATE_LIMIT_WINDOW_MS } from "../src/utils/constants";
import { resetTestDatabase } from "./helpers/database";

beforeEach(() => {
  resetTestDatabase("games.sqlite");
  GameDatabase.resetForTesting();
});

test("GameDatabase: CRUD for games, mappings, participants, and slot updates", () => {
  const db = GameDatabase.getInstance();

  // Save a game and basic getters
  db.saveGame(
    "gameA",
    "tg_creator",
    1000,
    "coinflip",
    "mintX",
    "XXX",
    8,
    2,
    12345
  );
  expect(db.gameExists("gameA")).toBe(true);
  const game = db.getGame("gameA")!;
  expect(game.creator_telegram_id).toBe("tg_creator");
  expect(db.getCreatorTelegramId("gameA")).toBe("tg_creator");

  // Save message/chat ids
  db.saveGameMessage("gameA", 777, 999);
  const withMsg = db.getGame("gameA")!;
  expect(withMsg.message_id).toBe(777);
  expect(withMsg.chat_id).toBe(999);
  const activeByChat = db.getActiveGamesByChat(999);
  expect(activeByChat.map((g) => g.game_address)).toContain("gameA");
  db.clearGameMessage("gameA");
  const clearedMsg = db.getGame("gameA")!;
  expect(clearedMsg.message_id).toBeNull();
  expect(clearedMsg.chat_id).toBeNull();

  // Player mapping roundtrip
  db.savePlayerMapping("pub_creator", "tg_creator", "@astro");
  expect(db.getPlayerTelegramId("pub_creator")).toBe("tg_creator");
  expect(db.getPlayerPublicKey("tg_creator")).toBe("pub_creator");
  expect(db.getAllPlayerMappings().length).toBe(1);
  expect(db.getPlayerDisplayName("tg_creator")).toBe("@astro");

  // Creator info join
  const creatorInfo = db.getCreatorInfo("gameA")!;
  expect(creatorInfo.telegramId).toBe("tg_creator");
  expect(creatorInfo.publicKey).toBe("pub_creator");

  // Participants CRUD
  db.saveGameParticipant("gameA", "tg_creator", "pub_creator");
  db.saveGameParticipant("gameA", "tg_p2", "pub_p2");
  db.saveGameParticipant("gameA", "tg_pending", "pub_pending", {
    status: "pending",
  });
  expect(db.getGameParticipants("gameA")).toEqual(["tg_creator", "tg_p2"]);
  expect(db.getPlayerParticipatedGames("tg_p2")).toEqual(["gameA"]);
  expect(db.getPlayerTelegramId("pub_pending")).toBe("tg_pending");

  // Active and Recent queries
  const activeForCreator = db.getActiveGames("tg_creator");
  expect(activeForCreator.length).toBe(1);
  expect(db.getActiveGamesByChat(98765).length).toBe(0);

  // Add mapping for participant and mark completion; query recents with mapping
  db.savePlayerMapping("pub_p2", "tg_p2");
  db.completeGame("gameA", "pub_p2", Date.now() - 100);
  const recentWithMap = db.getRecentGames("tg_p2", 10);
  expect(recentWithMap.length).toBe(1);

  // Branch where no public-key mapping exists
  db.saveGame("gameB", "tg_other", 2000, "coinflip");
  db.completeGame("gameB", "pub_w", Date.now());
  const recentNoMap = db.getRecentGames("tg_other", 10);
  expect(recentNoMap.some((g) => g.game_address === "gameB")).toBe(true);

  // Last slot with timestamp updates
  const t1 = Date.now();
  const updated1 = db.updateGameLastSlotWithTimestamp("gameA", "123", t1);
  expect(updated1).toBe(true);
  const tOlder = t1 - 1000;
  const updatedOlder = db.updateGameLastSlotWithTimestamp("gameA", "124", tOlder);
  expect(updatedOlder).toBe(false);
  const last = db.getGameLastSlotWithTimestamp("gameA");
  expect(last.lastSlot).toBe("123");
  expect(typeof last.timestamp).toBe("number");
  expect(db.getGameLastSlot("gameA")).toBe("123");

  // Remove participant and ensure list shrinks
  db.removeGameParticipant("gameA", "tg_p2");
  expect(db.getGameParticipants("gameA")).toEqual(["tg_creator"]);
});

test("updateGameLastSlotWithTimestamp accepts equal timestamp updates", () => {
  const db = GameDatabase.getInstance();

  db.saveGame("slotGame", "creator_slot", 100, "coinflip");
  const now = Date.now();

  const first = db.updateGameLastSlotWithTimestamp("slotGame", "111", now);
  expect(first).toBe(true);

  const second = db.updateGameLastSlotWithTimestamp("slotGame", "222", now);
  expect(second).toBe(true);

  const last = db.getGameLastSlotWithTimestamp("slotGame");
  expect(last.lastSlot).toBe("222");
  expect(last.timestamp).toBe(now);
});

test("savePlayerMapping normalizes inputs and ignores blanks", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;

  db.savePlayerMapping("  pub_key  ", "  555  ", "  Astro  ");
  const mappings = db.getAllPlayerMappings();
  expect(mappings.length).toBe(1);
  const mapping = mappings[0]!;
  expect(mapping.public_key).toBe("pub_key");
  expect(mapping.telegram_id).toBe("555");

  const stored = sqlite
    .prepare(
      "SELECT public_key, telegram_id, display_name FROM player_mappings WHERE public_key = ?"
    )
    .get("pub_key");
  expect(stored.display_name).toBe("Astro");
  expect(db.getPlayerDisplayName("555")).toBe("Astro");
  expect(db.getPlayerPublicKey("555")).toBe("pub_key");
  expect(db.getPlayerTelegramId("pub_key")).toBe("555");

  db.savePlayerMapping("   ", "777");
  db.savePlayerMapping("valid", "   ");
  expect(db.getAllPlayerMappings().length).toBe(1);
});

test("getGamesExpiringBefore returns games with zero and large timeouts", () => {
  const db = GameDatabase.getInstance();
  const now = Date.now();
  const zeroAddress = "game_zero_expiry";
  const largeAddress = "game_large_expiry";

  db.saveGame(
    zeroAddress,
    "creator_zero",
    100,
    "coinflip",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
    now
  );

  const hugeTimeoutSeconds = 1_000_000_000;
  db.saveGame(
    largeAddress,
    "creator_large",
    200,
    "coinflip",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    hugeTimeoutSeconds,
    now + hugeTimeoutSeconds * 1000
  );

  const immediate = db.getGamesExpiringBefore(now + 1000);
  expect(immediate.map((g) => g.game_address)).toContain(zeroAddress);

  const farFuture = now + hugeTimeoutSeconds * 1000 + 1_000;
  const farResults = db.getGamesExpiringBefore(farFuture);
  expect(farResults.map((g) => g.game_address)).toContain(largeAddress);
});

test("getGamesExpiringBefore can paginate large batches by excluding processed entries", () => {
  const db = GameDatabase.getInstance();
  const base = Date.now();
  const total = 60;
  const addresses = [];
  for (let i = 0; i < total; i += 1) {
    const addr = `paginated-${i}`;
    addresses.push(addr);
    db.saveGame(
      addr,
      `creator-${i}`,
      50,
      "coinflip",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      10,
      base
    );
  }

  const seen = new Set<string>();
  const limit = 15;
  let batch: GameData[] = [];
  let excludes: string[] = [];
  do {
    batch = db.getGamesExpiringBefore(base + 1000, limit, excludes);
    for (const game of batch) {
      seen.add(game.game_address);
      excludes.push(game.game_address);
    }
  } while (batch.length === limit);

  expect(seen.size).toBe(total);
});

test("getGamesExpiringBefore honors excludes and fills with oldest non-expiring", () => {
  const db = GameDatabase.getInstance();
  const now = Date.now();

  db.saveGame("exp-1", "creator", 50, "coinflip", undefined, undefined, undefined, undefined, undefined, 15, now + 500);
  db.saveGame("exp-2", "creator", 50, "coinflip", undefined, undefined, undefined, undefined, undefined, 15, now + 800);
  db.saveGame("no-exp-1", "creator", 50, "coinflip");
  db.saveGame("no-exp-2", "creator", 50, "coinflip");

  const results = db.getGamesExpiringBefore(now + 1_000, 3, ["exp-1"]);

  expect(results.map((g) => g.game_address)).toEqual([
    "exp-2",
    "no-exp-1",
    "no-exp-2",
  ]);
});

test("findTelegramIdByUsername normalizes usernames", () => {
  const db = GameDatabase.getInstance();

  db.savePlayerMapping("pk_old", "111", "@CaseUser");
  db.savePlayerMapping("pk_new", "222", "caseuser");
  db.savePlayerMapping("pk_other", "333", "@otherUser");
  db.savePlayerMapping("pk_plain", "444", "alice");

  expect(db.findTelegramIdByUsername("@CASEUSER")).toBe("111");
  expect(db.findTelegramIdByUsername("caseuser")).toBe("111");
  expect(db.findTelegramIdByUsername("otheruser")).toBe("333");
  expect(db.findTelegramIdByUsername("@alice")).toBeNull();
  expect(db.findTelegramIdByUsername("@missing")).toBeNull();
  expect(db.findTelegramIdByUsername("   ")).toBeNull();
});

test("username mapping lookup persists normalized usernames", () => {
  const db = GameDatabase.getInstance();

  db.saveUsernameMapping("caseuser", "888", "@CaseUser");

  expect(db.findTelegramIdByNormalizedUsername("caseuser")).toBe("888");
  expect(db.findTelegramIdByNormalizedUsername("CaseUser")).toBe("888");
  expect(db.findTelegramIdByUsername("@CASEUSER")).toBe("888");
  expect(db.findTelegramIdByUsername("@missing")).toBeNull();
});

test("getPlayerTelegramId prioritizes confirmed participants over pending fallback", () => {
  const db = GameDatabase.getInstance();

  db.saveGame("pendingGame", "creator_pending", 100, "coinflip");
  db.saveGameParticipant("pendingGame", "tg_pending", "pub_shared", {
    status: "pending",
  });

  expect(db.getPlayerTelegramId("pub_shared")).toBe("tg_pending");

  db.saveGame("confirmedGame", "creator_confirmed", 100, "coinflip");
  db.saveGameParticipant("confirmedGame", "tg_confirmed", "pub_shared", {
    status: "confirmed",
  });

  expect(db.getPlayerTelegramId("pub_shared")).toBe("tg_confirmed");

  db.saveGame("pendingLater", "creator_pending2", 100, "coinflip");
  db.saveGameParticipant("pendingLater", "tg_pending2", "pub_shared", {
    status: "pending",
  });

  expect(db.getPlayerTelegramId("pub_shared")).toBe("tg_confirmed");
});

test("saveGameParticipant preserves confirmed status when pending write races", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;

  db.saveGame("raceGame", "creator_race", 100, "coinflip");

  db.saveGameParticipant("raceGame", "tg_race", "pub_race", {
    status: "pending",
    joinSignature: "sig_pending",
  });

  const verifiedAt = Date.now();
  db.saveGameParticipant("raceGame", "tg_race", "pub_race", {
    status: "confirmed",
    joinSignature: "sig_confirmed",
    lastVerifiedAt: verifiedAt,
  });

  db.saveGameParticipant("raceGame", "tg_race", "pub_race", {
    status: "pending",
  });

  const row = sqlite
    .prepare(
      "SELECT status, join_signature, last_verified_at FROM game_participants WHERE game_address = ? AND telegram_id = ?"
    )
    .get("raceGame", "tg_race");

  expect(row.status).toBe("confirmed");
  expect(row.join_signature).toBe("sig_confirmed");
  expect(row.last_verified_at).toBeGreaterThanOrEqual(verifiedAt);
});

test("GameDatabase read helpers return safe defaults on errors", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;
  const originalPrepare = sqlite.prepare.bind(sqlite);

  sqlite.prepare = () => {
    throw new Error("boom");
  };

  expect(db.getGamesByCreator(123n)).toEqual([]);
  expect(db.getGamesByPlayer(456n)).toEqual([]);
  expect(db.getPlayer("789")).toBeNull();

  sqlite.prepare = originalPrepare;
});

test("countRecentGamesByCreator respects rate-limit window boundaries", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;

  const creator = "creator_123";
  db.saveGame("game_old", creator, 100, "coinflip");
  db.saveGame("game_window_edge", creator, 150, "coinflip");
  db.saveGame("game_recent", creator, 200, "coinflip");

  const now = Date.now();
  const windowStart = now - GAME_CREATION_RATE_LIMIT_WINDOW_MS;

  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(windowStart - 1, "game_old");
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(windowStart, "game_window_edge");
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(windowStart + 1, "game_recent");

  const inclusiveCount = db.countRecentGamesByCreator(creator, windowStart);
  expect(inclusiveCount).toBe(2);

  const afterWindowCount = db.countRecentGamesByCreator(
    creator,
    windowStart + 1
  );
  expect(afterWindowCount).toBe(1);
});

test("cleanupOldGames deletes games and participants older than specified days", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;

  const now = Date.now();
  const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
  const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000;

  // Create old game (31 days ago)
  db.saveGame("old_game", "creator_old", 100, "coinflip");
  db.saveGameParticipant("old_game", "participant_old", "pk_old");
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(thirtyOneDaysAgo, "old_game");

  // Create recent game (29 days ago)
  db.saveGame("recent_game", "creator_recent", 200, "coinflip");
  db.saveGameParticipant("recent_game", "participant_recent", "pk_recent");
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(twentyNineDaysAgo, "recent_game");

  // Verify both exist before cleanup
  expect(db.gameExists("old_game")).toBe(true);
  expect(db.gameExists("recent_game")).toBe(true);
  expect(db.getGameParticipants("old_game").length).toBe(1);
  expect(db.getGameParticipants("recent_game").length).toBe(1);

  // Run cleanup for 30 days
  const result = db.cleanupOldGames(30);

  // Old game should be deleted
  expect(db.gameExists("old_game")).toBe(false);
  expect(db.getGameParticipants("old_game").length).toBe(0);

  // Recent game should still exist
  expect(db.gameExists("recent_game")).toBe(true);
  expect(db.getGameParticipants("recent_game").length).toBe(1);

  // Verify returned counts
  expect(result.gamesDeleted).toBe(1);
  expect(result.participantsDeleted).toBe(1);
});
