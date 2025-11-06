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
  expect(db.getGameParticipants("gameA")).toEqual(["tg_creator", "tg_p2"]);
  expect(db.getPlayerParticipatedGames("tg_p2")).toEqual(["gameA"]);

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
