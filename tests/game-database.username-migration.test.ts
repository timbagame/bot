import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameDatabase } from "../src/utils/game-database";

test("a copy of legacy data quarantines usernames and preserves player mappings across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "username-migration-"));
  const originalDir = process.env["BOT_DB_DIR"];
  const opened: Database[] = [];
  try {
    const source = join(dir, "legacy.sqlite");
    const legacy = new Database(source);
    legacy.exec(`
      CREATE TABLE username_mappings (normalized_username TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, display_name TEXT, updated_at INTEGER NOT NULL);
      INSERT INTO username_mappings VALUES ('victim', '222', '@victim', 1);
      CREATE TABLE player_mappings (public_key TEXT PRIMARY KEY, telegram_id TEXT NOT NULL, display_name TEXT);
      INSERT INTO player_mappings VALUES ('fictional-wallet', '222', 'Fictional Player');
    `);
    legacy.close();
    const copied = join(dir, "copy");
    mkdirSync(copied);
    copyFileSync(source, join(copied, "games.sqlite"));
    process.env["BOT_DB_DIR"] = copied;
    // Construct independent connections without resetting the shared singleton.
    const db = Reflect.construct(GameDatabase, []) as GameDatabase;
    const sql = (db as any).db as Database;
    opened.push(sql);
    expect(db.findTelegramIdByUsername("@victim")).toBeNull();
    expect(sql.query("SELECT trusted FROM username_mappings").get()).toEqual({ trusted: 0 });
    expect(db.getPlayerPublicKey("222")).toBe("fictional-wallet");
    expect(db.getPlayerDisplayName("222")).toBe("Fictional Player");

    db.saveUsernameMapping("victim", "111", "@victim");
    const reopened = Reflect.construct(GameDatabase, []) as GameDatabase;
    opened.push((reopened as any).db);
    expect(reopened.findTelegramIdByUsername("@victim")).toBe("111");
    expect(reopened.getPlayerPublicKey("222")).toBe("fictional-wallet");

    // Schema rollback preserves the original rows without making them trusted.
    sql.exec("ALTER TABLE username_mappings DROP COLUMN trusted");
    sql.exec("BEGIN");
    (db as any).ensureUsernameMappingSchema();
    sql.exec("ROLLBACK");
    expect(
      sql
        .query("PRAGMA table_info(username_mappings)")
        .all()
        .some((column: any) => column.name === "trusted"),
    ).toBe(false);
    expect(sql.query("SELECT telegram_id FROM username_mappings").get()).toEqual({
      telegram_id: "111",
    });
  } finally {
    for (const db of opened) db.close();
    if (originalDir === undefined) delete process.env["BOT_DB_DIR"];
    else process.env["BOT_DB_DIR"] = originalDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
