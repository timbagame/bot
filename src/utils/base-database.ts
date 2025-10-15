import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function resolveDatabaseFilename(filename: string): string {
  if (!filename || filename === ":memory:" || filename.startsWith("file:")) {
    return filename;
  }

  if (isAbsolute(filename)) {
    mkdirSync(dirname(filename), { recursive: true });
    return filename;
  }

  const configuredBaseDir = process.env["BOT_DB_DIR"];
  const baseDir = configuredBaseDir
    ? resolve(configuredBaseDir)
    : resolve(process.cwd());
  const fullPath = join(baseDir, filename);
  mkdirSync(dirname(fullPath), { recursive: true });
  return fullPath;
}

/**
 * Shared SQLite database base class
 */
export abstract class BaseDatabase {
  protected db: Database;

  protected constructor(
    filename: string,
    initStatements: string[],
    name: string
  ) {
    const resolvedFilename = resolveDatabaseFilename(filename);
    this.db = new Database(resolvedFilename, { create: true });
    try {
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
    } catch (pragmaError) {
      console.warn("Unable to apply SQLite pragmas:", pragmaError);
    }

    try {
      for (const stmt of initStatements) {
        this.db.run(stmt);
      }
      console.log(`${name} database initialized`);
    } catch (error) {
      console.error(`Error initializing ${name} database:`, error);
      throw error;
    }
  }
}
