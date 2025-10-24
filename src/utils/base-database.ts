import type { Changes, SQLQueryBindings } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { createSingleton } from "./singleton";

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
  private readonly name: string;

  protected constructor(
    filename: string,
    initStatements: string[],
    name: string
  ) {
    const resolvedFilename = resolveDatabaseFilename(filename);
    this.name = name;
    this.db = new Database(resolvedFilename, { create: true });

    try {
      for (const stmt of initStatements) {
        this.db.run(stmt);
      }
      console.log(`${name} database initialized`);
    } catch (error) {
      this.handleError(`initializing ${name} database`, error);
    }
  }

  protected run(
    sql: string,
    params: SQLQueryBindings | SQLQueryBindings[] = [],
    operation: string = "running statement"
  ): Changes {
    try {
      const stmt = this.db.prepare(sql);
      const normalizedParams = this.normalizeParams(params);
      return stmt.run(...(normalizedParams as any));
    } catch (error) {
      return this.handleError(`during ${operation}`, error);
    }
  }

  protected get<T>(
    sql: string,
    params: SQLQueryBindings | SQLQueryBindings[] = [],
    operation: string = "executing query"
  ): T | null {
    try {
      const stmt = this.db.prepare(sql);
      const normalizedParams = this.normalizeParams(params);
      const result = stmt.get(...(normalizedParams as any)) as T | undefined;
      return result ?? null;
    } catch (error) {
      return this.handleError(`during ${operation}`, error);
    }
  }

  protected all<T>(
    sql: string,
    params: SQLQueryBindings | SQLQueryBindings[] = [],
    operation: string = "executing query"
  ): T[] {
    try {
      const stmt = this.db.prepare(sql);
      const normalizedParams = this.normalizeParams(params);
      return stmt.all(...(normalizedParams as any)) as T[];
    } catch (error) {
      return this.handleError(`during ${operation}`, error);
    }
  }

  private normalizeParams(
    params: SQLQueryBindings | SQLQueryBindings[] | undefined
  ): SQLQueryBindings[] {
    if (params === undefined) {
      return [];
    }

    return Array.isArray(params) ? params : [params];
  }

  private handleError(operation: string, error: unknown): never {
    console.error(`[${this.name} DB] Error ${operation}:`, error);
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export interface DatabaseInstanceHandle<T> {
  getInstance: () => T;
  reset: () => void;
}

export function createDatabaseHandle<T>(
  factory: () => T
): DatabaseInstanceHandle<T> {
  const singleton = createSingleton(factory);

  return {
    getInstance: () => singleton.getInstance(),
    reset: () => singleton.reset(),
  };
}

export function createDatabaseSingleton<T>(factory: () => T): {
  getInstance: () => T;
  resetForTesting: () => void;
} {
  const { getInstance, reset } = createDatabaseHandle(factory);
  return {
    getInstance,
    resetForTesting: () => reset(),
  };
}
