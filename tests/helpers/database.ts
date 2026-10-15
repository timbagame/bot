import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { clearDatabaseForTesting } from "../../src/utils/base-database";

export function getTestDatabasePath(filename: string): string {
  if (!filename || filename === ":memory:" || filename.startsWith("file:")) {
    return filename;
  }

  if (isAbsolute(filename)) {
    return filename;
  }

  const configuredBaseDir = process.env["BOT_DB_DIR"];
  const baseDir = configuredBaseDir ? resolve(configuredBaseDir) : resolve(process.cwd());
  return join(baseDir, filename);
}

export function resetTestDatabase(filename: string): void {
  const path = getTestDatabasePath(filename);
  if (!path || path === ":memory:" || path.startsWith("file:") || !existsSync(path)) {
    return;
  }
  const db = new Database(path);
  try {
    clearDatabaseForTesting(db);
  } finally {
    db.close();
  }
}
