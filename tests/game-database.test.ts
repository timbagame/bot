import { expect, test, beforeEach } from "bun:test";
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
