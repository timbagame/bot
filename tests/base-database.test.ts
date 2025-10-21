import type { Changes, Database, SQLQueryBindings } from "bun:sqlite";
import { expect, test } from "bun:test";
import { BaseDatabase } from "../src/utils/base-database";

class TestDatabase extends BaseDatabase {
  constructor(statements: string[]) {
    super(":memory:", statements, "TestDatabase");
  }

  hasTable(name: string) {
    const result = this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      )
      .get(name) as { name?: string } | undefined;
    return result?.name === name;
  }

  close() {
    this.db.close();
  }
}

test("BaseDatabase runs initialization statements and logs success", () => {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };

  const db = new TestDatabase([
    "CREATE TABLE IF NOT EXISTS demo (id INTEGER PRIMARY KEY AUTOINCREMENT)",
  ]);

  try {
    expect(db.hasTable("demo")).toBe(true);
    expect(logs.some((entry) => entry.includes("TestDatabase database initialized"))).toBe(true);
  } finally {
    db.close();
    console.log = originalLog;
  }
});

class FailingDatabase extends BaseDatabase {
  constructor() {
    super(":memory:", ["CREATE TABLE bad"], "FailingDatabase");
  }
}

test("BaseDatabase surfaces initialization errors", () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    expect(() => new FailingDatabase()).toThrow();
    expect(errors.length).toBeGreaterThan(0);
    const firstError = errors[0];
    expect(firstError).toBeDefined();
    const message = String(firstError?.[0] ?? "");
    expect(message).toContain("[FailingDatabase DB] Error initializing FailingDatabase database");
  } finally {
    console.error = originalError;
  }
});

class WrapperDatabase extends BaseDatabase {
  constructor() {
    super(":memory:", [], "Wrapper");
  }

  public setMockDatabase(mockDb: Partial<Database>): void {
    this.db = mockDb as Database;
  }

  public runPublic(
    sql: string,
    params: SQLQueryBindings | SQLQueryBindings[] | undefined,
    operation: string
  ) {
    return this.run(sql, params ?? [], operation);
  }

  public getPublic<T>(
    sql: string,
    params: SQLQueryBindings | SQLQueryBindings[] | undefined,
    operation: string
  ) {
    return this.get<T>(sql, params ?? [], operation);
  }

  public allPublic<T>(
    sql: string,
    params: SQLQueryBindings | SQLQueryBindings[] | undefined,
    operation: string
  ) {
    return this.all<T>(sql, params ?? [], operation);
  }
}

test("BaseDatabase helpers prepare statements and pass parameters", () => {
  const captured: unknown[] = [];
  const mockDb = {
    prepare: (sql: string) => {
      expect(sql).toBe("TEST SQL");
      return {
        run: (...args: SQLQueryBindings[]) => {
          captured.push(...args);
          return { changes: 42, lastInsertRowid: 7 } as Changes;
        },
      };
    },
  } as unknown as Partial<Database>;

  const db = new WrapperDatabase();
  db.setMockDatabase(mockDb);
  const result = db.runPublic("TEST SQL", [1, "two"], "running test");

  expect(captured).toEqual([1, "two"]);
  expect(result).toEqual({ changes: 42, lastInsertRowid: 7 });
});

test("BaseDatabase helpers log and rethrow errors", () => {
  const error = new Error("boom");
  const mockDb = {
    prepare: () => ({
      run: () => {
        throw error;
      },
      get: () => {
        throw error;
      },
      all: () => {
        throw error;
      },
    }),
  } as unknown as Partial<Database>;

  const db = new WrapperDatabase();
  db.setMockDatabase(mockDb);

  const originalError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    expect(() => db.runPublic("RUN SQL", [], "run operation")).toThrow(error);
    expect(() => db.getPublic("GET SQL", [], "get operation")).toThrow(error);
    expect(() => db.allPublic("ALL SQL", [], "all operation")).toThrow(error);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    const [firstLog] = logs;
    expect(String(firstLog?.[0] ?? "")).toContain(
      "[Wrapper DB] Error during run operation"
    );
  } finally {
    console.error = originalError;
  }
});
