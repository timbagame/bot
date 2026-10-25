import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameDatabase } from "../src/utils/game-database";

type RawDb = { db: Database };
type SpyHandle = { mock: { calls: unknown[][] }; mockClear(): void; mockRestore(): void };

describe("GameDatabase query edge cases", () => {
  let dir: string;
  let originalDir: string | undefined;
  let originalDebug: string | undefined;
  let db: GameDatabase;
  let raw: Database;
  let logSpy: SpyHandle;
  let errorSpy: SpyHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "game-db-queries-"));
    originalDir = process.env["BOT_DB_DIR"];
    originalDebug = process.env["TIMBA_DEBUG"];
    process.env["BOT_DB_DIR"] = dir;
    delete process.env["TIMBA_DEBUG"];
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    db = Reflect.construct(GameDatabase, []) as GameDatabase;
    raw = (db as unknown as RawDb).db;
  });

  afterEach(() => {
    raw.close();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (originalDir === undefined) delete process.env["BOT_DB_DIR"];
    else process.env["BOT_DB_DIR"] = originalDir;
    if (originalDebug === undefined) delete process.env["TIMBA_DEBUG"];
    else process.env["TIMBA_DEBUG"] = originalDebug;
    rmSync(dir, { recursive: true, force: true });
  });

  test("saveGame stores an explicit creation time instead of the clock", () => {
    db.saveGame("G_TIME", "1", 5, "coinflip", undefined, undefined, 2, 2, 9, 60, 99, 123_456);

    expect(db.getGame("G_TIME")?.created_at).toBe(123_456);
  });

  describe("participant address bookkeeping", () => {
    test("ignores stored participant data that is not a list of addresses", () => {
      db.saveGame("G_P", "1", 5, "coinflip");

      raw.exec(`UPDATE games SET participant_addresses = '{"not":"a list"}'`);
      expect(db.getGameParticipantAddresses("G_P")).toEqual([]);

      raw.exec(`UPDATE games SET participant_addresses = '[broken'`);
      expect(db.getGameParticipantAddresses("G_P")).toEqual([]);

      raw.exec(`UPDATE games SET participant_addresses = '["A", 5, "", "B", null]'`);
      expect(db.getGameParticipantAddresses("G_P")).toEqual(["A", "B"]);
    });

    test("appends a joiner whose ticket index is not a whole number", () => {
      db.saveGame("G_J", "1", 5, "coinflip");
      db.saveGameParticipantAddresses("G_J", ["A", "B"]);

      db.recordGameParticipantJoined("G_J", "C", Number.NaN, 3);

      expect(db.getGameParticipantAddresses("G_J")).toEqual(["A", "B", "C"]);
    });

    test("removes a leaver when no replacement participant was moved into the slot", () => {
      db.saveGame("G_U", "1", 5, "coinflip");
      db.saveGameParticipantAddresses("G_U", ["A", "B", "C"]);

      db.recordGameParticipantUnjoined("G_U", "B", 1, 3);
      expect(db.getGameParticipantAddresses("G_U")).toEqual(["A", "C"]);

      // A leaver that is not in the list changes nothing.
      db.recordGameParticipantUnjoined("G_U", "ZZ", -1, 3);
      expect(db.getGameParticipantAddresses("G_U")).toEqual(["A", "C"]);

      // With a moved participant the slot is overwritten instead.
      db.recordGameParticipantUnjoined("G_U", "A", 0, 3, "C");
      expect(db.getGameParticipantAddresses("G_U")).toEqual(["C"]); // saved addresses are de-duplicated
    });
  });

  describe("getCreatorInfo", () => {
    test("returns null for an unknown game", () => {
      expect(db.getCreatorInfo("NOPE")).toBeNull();
    });

    test("includes the creator wallet only when one is mapped", () => {
      db.saveGame("G_C1", "10", 5, "coinflip");
      db.saveGame("G_C2", "20", 5, "coinflip");
      db.savePlayerMapping("PK_TEN", "10");

      expect(db.getCreatorInfo("G_C1")).toEqual({ telegramId: "10", publicKey: "PK_TEN" });
      expect(db.getCreatorInfo("G_C2")).toEqual({ telegramId: "20", publicKey: null });
    });
  });

  describe("input validation on lookups", () => {
    test("saveUsernameMapping ignores a telegram id that is not numeric", () => {
      db.saveUsernameMapping("someone", "not-a-number");
      db.saveUsernameMapping("   ", "123");

      expect(raw.query("SELECT COUNT(*) AS n FROM username_mappings").get()).toEqual({ n: 0 });
    });

    test("getPlayerTelegramId rejects non-string and blank keys", () => {
      db.savePlayerMapping("PK_X", "42");

      expect(db.getPlayerTelegramId(5 as unknown as string)).toBeNull();
      expect(db.getPlayerTelegramId("   ")).toBeNull();
      expect(db.getPlayerTelegramId(" PK_X ")).toBe("42");
    });

    test("username lookups reject non-string and blank names", () => {
      db.saveUsernameMapping("alice", "77", "@Alice");
      raw.exec("UPDATE username_mappings SET trusted = 1");

      expect(db.findTelegramIdByNormalizedUsername(1 as unknown as string)).toBeNull();
      expect(db.findTelegramIdByNormalizedUsername("   ")).toBeNull();
      expect(db.findTelegramIdByNormalizedUsername(" ALICE ")).toBe("77");

      expect(db.findTelegramIdByUsername(1 as unknown as string)).toBeNull();
      expect(db.findTelegramIdByUsername("   ")).toBeNull();
      expect(db.findTelegramIdByUsername("@")).toBeNull();
      expect(db.findTelegramIdByUsername("@ Alice")).toBe("77");
    });

    test("getGameParticipantsPreview returns nothing for a zero or negative limit", () => {
      db.saveGame("G_PV", "1", 5, "coinflip");
      db.saveGameParticipant("G_PV", "1", "PK1");

      expect(db.getGameParticipantsPreview("G_PV", 0)).toEqual([]);
      expect(db.getGameParticipantsPreview("G_PV", -4)).toEqual([]);
      expect(db.getGameParticipantsPreview("G_PV", 5)).toEqual(["1"]);
    });
  });

  describe("last slot tracking", () => {
    test("logs accepted updates when debugging is enabled", () => {
      db.saveGame("G_S", "1", 5, "coinflip");
      process.env["TIMBA_DEBUG"] = "TRUE";

      expect(db.updateGameLastSlotWithTimestamp("G_S", "slot-a", 100)).toBe(true);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("Updated lastSlot for game G_S to slot-a (timestamp: 100)"),
      );
      // An older timestamp is rejected and not logged again.
      logSpy.mockClear();
      expect(db.updateGameLastSlotWithTimestamp("G_S", "slot-old", 50)).toBe(false);
      expect(logSpy).not.toHaveBeenCalled();
      expect(db.getGameLastSlotWithTimestamp("G_S")).toEqual({
        lastSlot: "slot-a",
        timestamp: 100,
      });
      expect(db.getGameLastSlot("G_S")).toBe("slot-a");
    });

    test("falls back to empty results when the games table cannot be read", () => {
      raw.exec("DROP TABLE games");

      expect(db.updateGameLastSlotWithTimestamp("G_S", "slot-a", 100)).toBe(false);
      expect(db.getGameLastSlotWithTimestamp("G_S")).toEqual({ lastSlot: null, timestamp: null });
      expect(db.getGameLastSlot("G_S")).toBeNull();
    });
  });

  describe("leaderboards", () => {
    function completedGame(address: string, creator: string, chatId: number): void {
      db.saveGame(address, creator, 10, "coinflip", undefined, undefined, 2, 2, chatId);
      raw
        .query(
          "UPDATE games SET status = 'completed', winner_address = 'WINNER' WHERE game_address = ?",
        )
        .run(address);
    }

    test("a chat whose only players have blank ids has no leaderboard", () => {
      completedGame("G_BLANK", "   ", 500);

      expect(db.getLeaderboardStats(500, 10)).toEqual([]);
    });

    test("the global leaderboard has no entries when every player id is blank", () => {
      completedGame("G_BLANK", "   ", 500);

      expect(db.getGlobalLeaderboardStats(10)).toEqual([]);
    });

    test("the global leaderboard skips blank ids but keeps real players", () => {
      completedGame("G_BLANK", "   ", 500);
      completedGame("G_REAL", "10", 500);

      const stats = db.getGlobalLeaderboardStats(10);

      expect(stats.map((row) => row.telegramId)).toEqual(["10"]);
      expect(stats[0]).toMatchObject({ totalGames: 1, gamesCreated: 1, totalVolume: 10 });
    });

    test("leaderboard queries surface database failures", () => {
      completedGame("G_REAL", "10", 500);
      raw.exec("DROP TABLE game_participants");

      expect(() => db.getLeaderboardStats(500, 10)).toThrow();
      expect(() => db.getGlobalLeaderboardStats(10)).toThrow();
      const messages = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes("getting leaderboard stats"))).toBe(true);
      expect(messages.some((message) => message.includes("getting global leaderboard stats"))).toBe(
        true,
      );
    });
  });
});
