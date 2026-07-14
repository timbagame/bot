import * as fs from "node:fs";
import * as path from "node:path";
import { validateMnemonic } from "bip39";

const MAX_SECRET_BYTES = 4096;

export function readProtectedSecretFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
  if (stats.size <= 0 || stats.size > MAX_SECRET_BYTES) {
    throw new Error(`${label} has an invalid size`);
  }
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${label} has insecure permissions (${mode.toString(8)}); use 400 or 600`);
  }
  const value = fs.readFileSync(resolved, "utf8").trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}

export function loadWalletMnemonic(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.MNEMONIC_FILE?.trim();
  const mnemonic = file
    ? readProtectedSecretFile(file, "Wallet mnemonic file")
    : env.MNEMONIC?.trim();
  if (!mnemonic) throw new Error("MNEMONIC_FILE is required (MNEMONIC is supported for development)");
  if (!validateMnemonic(mnemonic)) throw new Error("Wallet mnemonic is not valid BIP-39");
  return mnemonic;
}

export function loadOracleApiToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.ORACLE_API_TOKEN_FILE?.trim();
  return file
    ? readProtectedSecretFile(file, "Oracle API token file")
    : env.ORACLE_API_TOKEN?.trim() || undefined;
}
