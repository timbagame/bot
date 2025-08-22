import { Database } from "bun:sqlite";

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
    this.db = new Database(filename, { create: true });

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

