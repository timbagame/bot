import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BaseDatabase } from "../src/utils/base-database";

class PragmaProbeDatabase extends BaseDatabase {
  constructor(filename: string) {
    super(
      filename,
      ["CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)"],
      "Probe",
    );
  }

  pragma<T>(name: string): T | null {
    return this.get<T>(`PRAGMA ${name}`);
  }

  insert(name: string): void {
    this.run("INSERT INTO items (name) VALUES (?)", [name]);
  }

  names(): string[] {
    return this.all<{ name: string }>("SELECT name FROM items ORDER BY id").map((row) => row.name);
  }
}

describe("BaseDatabase", () => {
  test("opens file databases in WAL mode with a busy timeout", () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-db-"));
    try {
      const db = new PragmaProbeDatabase(join(dir, "probe.sqlite"));
      expect(db.pragma<{ journal_mode: string }>("journal_mode")?.journal_mode).toBe("wal");
      expect(db.pragma<{ synchronous: number }>("synchronous")?.synchronous).toBe(1);
      expect(db.pragma<{ timeout: number }>("busy_timeout")?.timeout).toBe(5000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reuses cached statements across calls", () => {
    const db = new PragmaProbeDatabase(":memory:");
    for (let i = 0; i < 300; i += 1) {
      db.insert(`item-${i}`);
    }
    const names = db.names();
    expect(names).toHaveLength(300);
    expect(names[299]).toBe("item-299");
  });
});
