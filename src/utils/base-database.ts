import type { Changes, SQLQueryBindings } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
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
  const baseDir = configuredBaseDir ? resolve(configuredBaseDir) : resolve(process.cwd());
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
  private readonly filename: string;

  protected constructor(filename: string, initStatements: string[], name: string) {
    const resolvedFilename = resolveDatabaseFilename(filename);
    this.name = name;
    this.filename = filename; // Store original filename
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
    operation: string = "running statement",
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
    operation: string = "executing query",
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
    operation: string = "executing query",
  ): T[] {
    try {
      const stmt = this.db.prepare(sql);
      const normalizedParams = this.normalizeParams(params);
      return stmt.all(...(normalizedParams as any)) as T[];
    } catch (error) {
      return this.handleError(`during ${operation}`, error);
    }
  }

  protected getCount(
    sql: string,
    params: SQLQueryBindings | SQLQueryBindings[] = [],
    operation: string = "executing count query",
  ): number {
    try {
      const result = this.get<{ count: number }>(sql, params, operation);
      return result?.count ?? 0;
    } catch (error) {
      this.handleError(`during ${operation}`, error);
    }
  }

  private normalizeParams(
    params: SQLQueryBindings | SQLQueryBindings[] | undefined,
  ): SQLQueryBindings[] {
    if (params === undefined) {
      return [];
    }

    return Array.isArray(params) ? params : [params];
  }

  /**
   * This method is intentionally marked as `protected` so subclasses can
   * customize or reuse the shared error handling behavior. This is an
   * intentional API expansion to support database-specific overrides.
   */
  protected handleError(operation: string, error: unknown): never {
    console.error(`[${this.name} DB] Error ${operation}:`, error);
    throw error instanceof Error ? error : new Error(String(error));
  }

  /**
   * Internal method to get the original filename for cleanup purposes
   * @internal
   */
  getFilenameForCleanup(): string {
    return this.filename;
  }
}

export interface DatabaseInstanceHandle<T> {
  getInstance: () => T;
  reset: () => void;
}

export function createDatabaseHandle<T>(factory: () => T): DatabaseInstanceHandle<T> {
  const singleton = createSingleton(factory);

  return {
    getInstance: () => singleton.getInstance(),
    reset: () => singleton.reset(),
  };
}

/**
 * Helper to initialize singleton pattern for database classes.
 * Reduces boilerplate by generating getInstance and resetForTesting methods.
 *
 * Usage: Call this in a static block to set up the singleton pattern.
 *
 * @example
 * ```ts
 * export class MyDatabase extends BaseDatabase {
 *   public static getInstance: () => MyDatabase;
 *   public static resetForTesting: () => void;
 *
 *   static {
 *     initializeDatabaseSingleton(MyDatabase, () => new MyDatabase());
 *   }
 *
 *   private constructor() {
 *     super("my-db.sqlite", [...schemas], "MyDb");
 *   }
 * }
 * ```
 */
export function initializeDatabaseSingleton<T extends BaseDatabase>(
  DatabaseClass: { getInstance?: () => T; resetForTesting?: () => void },
  factory: () => T,
): void {
  const { getInstance, resetForTesting } = createDatabaseSingleton(factory);
  DatabaseClass.getInstance = getInstance;
  DatabaseClass.resetForTesting = resetForTesting;
}

export function createDatabaseSingleton<T extends BaseDatabase>(
  factory: () => T,
): {
  getInstance: () => T;
  resetForTesting: () => void;
} {
  const { getInstance, reset } = createDatabaseHandle(factory);
  let cachedFilename: string | null = null;

  return {
    getInstance: () => {
      const instance = getInstance();
      // Cache the filename from the first instance
      if (!cachedFilename && instance instanceof BaseDatabase) {
        cachedFilename = (instance as any).getFilenameForCleanup?.() || null;
      }
      return instance;
    },
    resetForTesting: () => {
      // Clean up the database file before resetting
      if (cachedFilename) {
        try {
          const fullPath = resolveDatabaseFilename(cachedFilename);
          if (fullPath && fullPath !== ":memory:" && !fullPath.startsWith("file:")) {
            rmSync(fullPath, { force: true });
          }
        } catch (error) {
          // Ignore cleanup errors, similar to resetTestDatabase behavior
        }
      }
      reset();
      cachedFilename = null;
    },
  };
}
