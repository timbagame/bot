import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Database as SqliteDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameDatabase } from "../src/utils/game-database";

type RawDb = { db: Database };
type SpyHandle = { mock: { calls: unknown[][] }; mockRestore(): void };

describe("GameDatabase schema upgrades and failure handling", () => {
  let dir: string;
  let originalDir: string | undefined;
  const opened: GameDatabase[] = [];
  let errorSpy: SpyHandle;
  let logSpy: SpyHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "game-db-schema-"));
    originalDir = process.env["BOT_DB_DIR"];
    process.env["BOT_DB_DIR"] = dir;
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const db of opened.splice(0)) (db as unknown as RawDb).db.close();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    if (originalDir === undefined) delete process.env["BOT_DB_DIR"];
    else process.env["BOT_DB_DIR"] = originalDir;
    rmSync(dir, { recursive: true, force: true });
  });

  function seedLegacy(sql: string): void {
    const legacy = new SqliteDatabase(join(dir, "games.sqlite"), { create: true });
    legacy.exec(sql);
    legacy.close();
  }

  function open(): GameDatabase {
    const db = Reflect.construct(GameDatabase, []) as GameDatabase;
    opened.push(db);
    return db;
  }

  function columnsOf(db: GameDatabase, table: string): string[] {
    return (db as unknown as RawDb).db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name);
  }

  test("adds every missing column when opening a database from before those columns existed", () => {
    seedLegacy(`
      CREATE TABLE games (
        game_address TEXT PRIMARY KEY, creator_telegram_id TEXT NOT NULL, amount INTEGER NOT NULL,
        created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', winner_address TEXT,
        completed_at INTEGER, message_id INTEGER, chat_id INTEGER, game_type TEXT NOT NULL,
        token_mint TEXT, token_ticker TEXT, max_players INTEGER, min_players INTEGER,
        last_slot TEXT, last_slot_timestamp INTEGER
      );
      CREATE TABLE game_participants (
        game_address TEXT NOT NULL, telegram_id TEXT NOT NULL, public_key TEXT NOT NULL,
        joined_at INTEGER NOT NULL, PRIMARY KEY (game_address, telegram_id)
      );
      CREATE TABLE player_mappings (public_key TEXT PRIMARY KEY, telegram_id TEXT NOT NULL);
      INSERT INTO games (game_address, creator_telegram_id, amount, created_at, game_type, chat_id, message_id)
        VALUES ('LEGACY_GAME', '111', 5, 1000, 'coinflip', 77, 9);
      INSERT INTO game_participants VALUES ('LEGACY_GAME', '111', 'PK_LEGACY', 1000);
      INSERT INTO player_mappings VALUES ('PK_LEGACY', '111');
    `);

    const db = open();

    expect(columnsOf(db, "game_participants")).toEqual(
      expect.arrayContaining(["status", "join_signature", "last_verified_at"]),
    );
    expect(columnsOf(db, "player_mappings")).toContain("display_name");
    expect(columnsOf(db, "games")).toEqual(
      expect.arrayContaining([
        "timeout_seconds",
        "expires_at",
        "total_amount",
        "participant_addresses",
        "fee_amount_raw",
        "completion_signature",
        "completion_network_fee_lamports",
      ]),
    );

    // Existing rows survive the upgrade and get sensible defaults.
    expect(db.getGame("LEGACY_GAME")?.creator_telegram_id).toBe("111");
    const raw = (db as unknown as RawDb).db;
    expect(raw.query("SELECT status FROM game_participants").get()).toEqual({
      status: "confirmed",
    });
    expect(db.getPlayerPublicKey("111")).toBe("PK_LEGACY");
    // The pre-existing message reference is copied into the per-chat message table.
    expect(raw.query("SELECT chat_id, message_id FROM game_messages").get()).toEqual({
      chat_id: 77,
      message_id: 9,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  const brokenViews: Array<[string, string, string]> = [
    [
      "game_participants",
      "CREATE VIEW game_participants AS SELECT game_address, game_address AS telegram_id FROM backing",
      "Failed to ensure game_participants schema:",
    ],
    [
      "player_mappings",
      "CREATE VIEW player_mappings AS SELECT game_address AS public_key, game_address AS telegram_id FROM backing",
      "Failed to ensure player_mappings schema:",
    ],
    [
      "username_mappings",
      "CREATE VIEW username_mappings AS SELECT game_address AS normalized_username FROM backing",
      "Failed to ensure username_mappings schema:",
    ],
    [
      "chat_membership_cache",
      "CREATE VIEW chat_membership_cache AS SELECT game_address AS chat_id FROM backing",
      "Failed to ensure membership cache schema:",
    ],
  ];

  for (const [name, createView, message] of brokenViews) {
    test(`reports but survives a ${name} object that cannot be migrated`, () => {
      seedLegacy(`CREATE TABLE backing (game_address TEXT); ${createView};`);

      const db = open();

      expect(errorSpy.mock.calls.map((call) => call[0])).toContain(message);
      // The rest of the database still works.
      db.saveGame("G_AFTER", "1", 1, "coinflip");
      expect(db.getGame("G_AFTER")?.game_address).toBe("G_AFTER");
    });
  }

  test("reports a games schema that cannot be migrated and skips the message backfill", () => {
    seedLegacy(`
      CREATE TABLE backing (game_address TEXT);
      CREATE VIEW games AS SELECT game_address, game_address AS creator_telegram_id FROM backing;
    `);

    open();

    const messages = errorSpy.mock.calls.map((call) => call[0]);
    expect(messages).toContain("Failed to ensure games schema:");
    expect(messages).toContain("Failed to ensure game_messages schema:");
  });
});

describe("GameDatabase membership cache", () => {
  let dir: string;
  let originalDir: string | undefined;
  let db: GameDatabase;
  let errorSpy: SpyHandle;
  let logSpy: SpyHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "game-db-membership-"));
    originalDir = process.env["BOT_DB_DIR"];
    process.env["BOT_DB_DIR"] = dir;
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    db = Reflect.construct(GameDatabase, []) as GameDatabase;
  });

  afterEach(() => {
    (db as unknown as RawDb).db.close();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    if (originalDir === undefined) delete process.env["BOT_DB_DIR"];
    else process.env["BOT_DB_DIR"] = originalDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns safe defaults and logs when the cache table is unavailable", () => {
    (db as unknown as RawDb).db.exec("DROP TABLE chat_membership_cache");

    expect(db.getCachedMembership(1, "2")).toBeNull();
    expect(db.getCachedMemberships(1, ["2", "3"]).size).toBe(0);
    expect(() => db.saveMembershipCache(1, "2", true)).not.toThrow();
    expect(db.cleanupMembershipCache()).toBe(0);

    const messages = errorSpy.mock.calls
      .map((call) => call[0])
      .map(String)
      .filter((message) => !message.startsWith("[Game DB]"));
    expect(messages).toEqual([
      "Error getting cached membership:",
      "Error getting cached memberships:",
      "Error saving membership cache:",
      "Error cleaning up membership cache:",
    ]);
  });

  test("returns the number of expired cache rows removed", () => {
    db.saveMembershipCache(1, "2", true);
    db.saveMembershipCache(1, "3", false);
    (db as unknown as RawDb).db.exec("UPDATE chat_membership_cache SET checked_at = 1");

    expect(db.cleanupMembershipCache(1000)).toBe(2);
    expect(db.getCachedMembership(1, "2")).toBeNull();
  });
});
