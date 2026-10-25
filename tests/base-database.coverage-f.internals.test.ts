import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BaseDatabase } from "../src/utils/base-database";

class ProbeDatabase extends BaseDatabase {
  constructor() {
    super(
      ":memory:",
      ["CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY, label TEXT)"],
      "Probe",
    );
  }

  cacheSize(): number {
    return (this as unknown as { statements: Map<string, unknown> }).statements.size;
  }

  cachedStatement(sql: string): unknown {
    return (this as unknown as { statements: Map<string, unknown> }).statements.get(sql);
  }

  insert(id: number, label: string) {
    return this.run("INSERT INTO probe (id, label) VALUES (?, ?)", [id, label], "inserting probe");
  }

  select(sql: string) {
    return this.all<{ n: number }>(sql, [], "selecting");
  }

  count(sql: string, params: Array<string | number> = []) {
    return this.getCount(sql, params, "counting probes");
  }

  close() {
    this.db.close();
  }
}

let db: ProbeDatabase;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  db = new ProbeDatabase();
});

afterEach(() => {
  db.close();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

describe("BaseDatabase statement cache", () => {
  test("drops every cached statement once the cache reaches its limit and keeps working", () => {
    for (let i = 0; i < 256; i += 1) {
      expect(db.select(`SELECT ${i} AS n`)).toEqual([{ n: i }]);
    }
    expect(db.cacheSize()).toBe(256);
    const first = db.cachedStatement("SELECT 0 AS n") as { finalize: () => void };
    const finalizeSpy = spyOn(first, "finalize");

    // One more distinct statement overflows the cache: everything is finalized and cleared.
    expect(db.select("SELECT 999 AS n")).toEqual([{ n: 999 }]);

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(db.cacheSize()).toBe(1);
    expect(db.cachedStatement("SELECT 0 AS n")).toBeUndefined();
    // A previously cached statement is re-prepared and still returns the right rows.
    expect(db.select("SELECT 0 AS n")).toEqual([{ n: 0 }]);
    expect(db.cacheSize()).toBe(2);
  });
});

describe("BaseDatabase.getCount", () => {
  test("returns the count column, or zero when the query yields no row", () => {
    db.insert(1, "a");
    db.insert(2, "b");
    expect(db.count("SELECT COUNT(*) AS count FROM probe")).toBe(2);
    expect(db.count("SELECT 1 AS count WHERE 0")).toBe(0);
  });

  test("logs and rethrows when the underlying query fails", () => {
    expect(() => db.count("SELECT COUNT(*) AS count FROM missing_table")).toThrow(/missing_table/);
    const messages = errorSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(
      messages.some((m: string) => m.includes("[Probe DB] Error during counting probes:")),
    ).toBe(true);
  });
});

describe("BaseDatabase.normalizeParams", () => {
  test("treats undefined as no bindings and wraps a lone binding in an array", () => {
    const normalize = (
      db as unknown as { normalizeParams: (p: unknown) => unknown[] }
    ).normalizeParams.bind(db);
    expect(normalize(undefined)).toEqual([]);
    expect(normalize("x")).toEqual(["x"]);
    expect(normalize(["x", 1])).toEqual(["x", 1]);
  });

  test("handleError wraps non-Error values in an Error", () => {
    expect(() =>
      (db as unknown as { handleError: (op: string, e: unknown) => never }).handleError(
        "testing",
        "plain string",
      ),
    ).toThrow("plain string");
  });
});
