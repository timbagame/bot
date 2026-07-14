import { rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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
  const fullPath = getTestDatabasePath(filename);
  if (!fullPath || fullPath === ":memory:" || fullPath.startsWith("file:")) {
    return;
  }

  try {
    rmSync(fullPath, { force: true });
  } catch {
    // Ignore errors, matches previous behaviour of best-effort cleanup.
  }
}
