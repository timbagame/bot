import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import * as database from "../src/utils/base-database";
import { resetTestDatabase } from "./helpers/database";

class ResetProbe extends database.BaseDatabase {
  constructor(filename: string) {
    super(
      filename,
      ["CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)"],
      "ResetProbe",
    );
  }
  insert(name: string): number {
    return Number(this.run("INSERT INTO items (name) VALUES (?)", [name]).lastInsertRowid);
  }
  names(): string[] {
    return this.all<{ name: string }>("SELECT name FROM items ORDER BY id").map(({ name }) => name);
  }
  close(): void {
    this.db.close();
  }
}

describe("database reset", () => {
  test("singleton reset keeps retained connections usable and restarts IDs", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-reset-"));
    const singleton = database.createDatabaseSingleton(
      () => new ResetProbe(join(dir, "probe.sqlite")),
    );
    const opened: ResetProbe[] = [];
    try {
      singleton.resetForTesting();
      const retained = singleton.getInstance();
      opened.push(retained);
      expect(retained.insert("before")).toBe(1);
      expect(retained.names()).toEqual(["before"]);
      singleton.resetForTesting();
      const fresh = singleton.getInstance();
      opened.push(fresh);
      expect(fresh).not.toBe(retained);
      expect(retained.names()).toEqual([]);
      expect(fresh.insert("after")).toBe(1);
      expect(retained.names()).toEqual(["after"]);
      singleton.resetForTesting();
      expect(retained.names()).toEqual([]);
    } finally {
      for (const probe of opened) probe.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file reset clears data and sequences through an existing cached statement", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-reset-"));
    const filename = join(dir, "probe.sqlite");
    const retained = new ResetProbe(filename);
    try {
      retained.insert("before");
      expect(retained.names()).toEqual(["before"]);
      resetTestDatabase(filename);
      expect(existsSync(filename)).toBe(true);
      expect(retained.names()).toEqual([]);
      expect(retained.insert("after")).toBe(1);
    } finally {
      retained.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing and special filenames do not create files", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-reset-"));
    try {
      for (const name of ["", ":memory:", "file:memory", join(dir, "missing.sqlite")])
        resetTestDatabase(name);
      expect(existsSync(join(dir, "missing.sqlite"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clears foreign-key tables without changing foreign-key enforcement", () => {
    const db = new Database(":memory:");
    try {
      db.run("PRAGMA foreign_keys = ON");
      db.run("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
      db.run("CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))");
      db.run("INSERT INTO parent VALUES (1)");
      db.run("INSERT INTO child VALUES (1)");
      database.clearDatabaseForTesting(db);
      expect(db.query("SELECT * FROM parent").all()).toEqual([]);
      expect(db.query("SELECT * FROM child").all()).toEqual([]);
      expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.query("PRAGMA defer_foreign_keys").get()).toEqual({ defer_foreign_keys: 0 });
      expect(() => db.run("INSERT INTO child VALUES (1)")).toThrow();
    } finally {
      db.close();
    }
  });

  test("failed cleanup rolls back and is reported to the caller", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-reset-"));
    const filename = join(dir, "probe.sqlite");
    const db = new Database(filename);
    try {
      db.run("CREATE TABLE first (id INTEGER)");
      db.run("CREATE TABLE blocked (id INTEGER)");
      db.run("INSERT INTO first VALUES (1)");
      db.run("INSERT INTO blocked VALUES (2)");
      db.run(
        "CREATE TRIGGER block_cleanup BEFORE DELETE ON blocked BEGIN SELECT RAISE(ABORT, 'blocked cleanup'); END",
      );
      expect(() => resetTestDatabase(filename)).toThrow("blocked cleanup");
      expect(db.query("SELECT * FROM first").all()).toEqual([{ id: 1 }]);
      expect(db.query("SELECT * FROM blocked").all()).toEqual([{ id: 2 }]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clears empty databases and in-memory singleton data", () => {
    const empty = new Database(":memory:");
    const singleton = database.createDatabaseSingleton(() => new ResetProbe(":memory:"));
    const retained = singleton.getInstance();
    try {
      database.clearDatabaseForTesting(empty);
      retained.insert("before");
      singleton.resetForTesting();
      expect(retained.names()).toEqual([]);
    } finally {
      empty.close();
      retained.close();
    }
  });

  test("quoted table names and arbitrary rows survive repeated reset cycles", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 10 }), (names) => {
        const db = new Database(":memory:");
        try {
          db.run('CREATE TABLE "odd""table" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)');
          for (const name of names)
            db.query('INSERT INTO "odd""table" (name) VALUES (?)').run(name);
          database.clearDatabaseForTesting(db);
          database.clearDatabaseForTesting(db);
          expect(db.query('SELECT * FROM "odd""table"').all()).toEqual([]);
          expect(
            db.query('INSERT INTO "odd""table" (name) VALUES (?)').run("after").lastInsertRowid,
          ).toBe(1);
        } finally {
          db.close();
        }
      }),
      { numRuns: 30 },
    );
  });
});
