import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadOracleApiToken,
  loadWalletMnemonic,
  readProtectedSecretFile,
} from "../src/utils/secrets";

const dirs: string[] = [];
const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function secretFile(value: string): string {
  const dir = mkdtempSync(join(tmpdir(), "timba-secret-"));
  dirs.push(dir);
  const file = join(dir, "secret");
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("protected secrets", () => {
  test("loads a valid mnemonic without changing derivation input", () => {
    expect(loadWalletMnemonic({ MNEMONIC_FILE: secretFile(mnemonic) } as NodeJS.ProcessEnv)).toBe(
      mnemonic,
    );
  });

  test("loads the oracle token from a protected file", () => {
    expect(
      loadOracleApiToken({ ORACLE_API_TOKEN_FILE: secretFile("token\n") } as NodeJS.ProcessEnv),
    ).toBe("token");
  });

  test("rejects group-readable files", () => {
    const file = secretFile("token");
    chmodSync(file, 0o640);
    expect(() => readProtectedSecretFile(file, "Secret")).toThrow("insecure permissions");
  });

  test("rejects symlinks", () => {
    const target = secretFile("token");
    const link = `${target}-link`;
    symlinkSync(target, link);
    expect(() => readProtectedSecretFile(link, "Secret")).toThrow("not a symlink");
  });

  test("rejects invalid BIP-39 mnemonics", () => {
    expect(() =>
      loadWalletMnemonic({ MNEMONIC_FILE: secretFile("not a mnemonic") } as NodeJS.ProcessEnv),
    ).toThrow("not valid BIP-39");
  });
  test("rejects empty and oversized files before reading them", () => {
    expect(() => readProtectedSecretFile(secretFile(""), "Secret")).toThrow(
      "Secret has an invalid size",
    );
    expect(() => readProtectedSecretFile(secretFile("x".repeat(4097)), "Secret")).toThrow(
      "Secret has an invalid size",
    );
    expect(readProtectedSecretFile(secretFile("x".repeat(4096)), "Secret")).toHaveLength(4096);
  });

  test("rejects files that contain only whitespace", () => {
    expect(() => readProtectedSecretFile(secretFile(" \n\t"), "Secret")).toThrow("Secret is empty");
  });
});
