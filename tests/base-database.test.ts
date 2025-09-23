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
    expect(String(errors[0][0])).toContain("Error initializing FailingDatabase database");
  } finally {
    console.error = originalError;
  }
});
