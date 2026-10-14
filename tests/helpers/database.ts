import { isAbsolute, join, resolve } from "node:path";
import { clearDatabaseFileForTesting } from "../../src/utils/base-database";

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
  clearDatabaseFileForTesting(getTestDatabasePath(filename));
}
