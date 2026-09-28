import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Keypair } from "../src/utils/solana";
import {
  ORACLE_OPERATOR_KEYPAIR_ENV,
  loadKeypairFromPath,
  resolveKeypairFromEnv,
  resolveOracleOperatorKeypair,
  uniqueSigners,
} from "../src/utils/keypairs";

const dir = mkdtempSync(join(tmpdir(), "keypairs-test-"));

const writeKeypair = async (name: string) => {
  const keypair = await Keypair.generate();
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(Array.from(keypair.secretKey)));
  return { keypair, file };
};

let logSpy: ReturnType<typeof spyOn>;
const envBefore = { ...process.env };
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  for (const key of ["TEST_KEYPAIR_PATH", ORACLE_OPERATOR_KEYPAIR_ENV]) {
    if (envBefore[key] === undefined) delete process.env[key];
    else process.env[key] = envBefore[key];
  }
});

describe("loadKeypairFromPath", () => {
  test("loads a keypair from an absolute path", async () => {
    const { keypair, file } = await writeKeypair("absolute.json");

    const loaded = await loadKeypairFromPath(file);

    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });

  test("resolves relative paths against the working directory", async () => {
    const { keypair, file } = await writeKeypair("relative.json");

    const loaded = await loadKeypairFromPath(relative(process.cwd(), file));

    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
  });

  test("reports the resolved path when the file is missing", async () => {
    const missing = join(dir, "missing.json");

    await expect(loadKeypairFromPath(missing)).rejects.toThrow(
      `Failed to load keypair from ${missing}`,
    );
  });

  test("rejects files that are not JSON", async () => {
    const file = join(dir, "garbage.json");
    writeFileSync(file, "not json");

    await expect(loadKeypairFromPath(file)).rejects.toThrow("Failed to load keypair");
  });

  test("rejects secret keys with the wrong length", async () => {
    const file = join(dir, "short.json");
    writeFileSync(file, JSON.stringify([1, 2, 3]));

    await expect(loadKeypairFromPath(file)).rejects.toThrow("Failed to load keypair");
  });
});

describe("resolveKeypairFromEnv", () => {
  test("uses the fallback when the variable is unset", async () => {
    delete process.env["TEST_KEYPAIR_PATH"];
    const fallback = await Keypair.generate();

    expect(await resolveKeypairFromEnv("TEST_KEYPAIR_PATH", fallback, "Role")).toBe(fallback);
    expect(logSpy.mock.calls[0]?.[0]).toContain("Role: env TEST_KEYPAIR_PATH not set");
  });

  test("uses the fallback when the variable is only whitespace", async () => {
    process.env["TEST_KEYPAIR_PATH"] = "   ";
    const fallback = await Keypair.generate();

    expect(await resolveKeypairFromEnv("TEST_KEYPAIR_PATH", fallback, "Role")).toBe(fallback);
  });

  test("loads the configured keypair and trims the path", async () => {
    const { keypair, file } = await writeKeypair("env.json");
    process.env["TEST_KEYPAIR_PATH"] = `  ${file}  `;
    const fallback = await Keypair.generate();

    const loaded = await resolveKeypairFromEnv("TEST_KEYPAIR_PATH", fallback, "Role");

    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    expect(logSpy.mock.calls[0]?.[0]).toBe(
      `Role: loaded ${keypair.publicKey.toBase58()} from ${file}`,
    );
  });

  test("fails loudly instead of falling back when the configured file is bad", async () => {
    process.env["TEST_KEYPAIR_PATH"] = join(dir, "nope.json");
    const fallback = await Keypair.generate();

    await expect(resolveKeypairFromEnv("TEST_KEYPAIR_PATH", fallback, "Role")).rejects.toThrow(
      `Role: failed to load keypair from ${join(dir, "nope.json")}`,
    );
  });
});

describe("resolveOracleOperatorKeypair", () => {
  test("reads the default oracle operator variable", async () => {
    const { keypair, file } = await writeKeypair("oracle.json");
    process.env[ORACLE_OPERATOR_KEYPAIR_ENV] = file;

    const loaded = await resolveOracleOperatorKeypair(await Keypair.generate());

    expect(loaded.publicKey.toBase58()).toBe(keypair.publicKey.toBase58());
    expect(logSpy.mock.calls[0]?.[0]).toStartWith("Oracle operator keypair: loaded");
  });

  test("honours a custom variable and description", async () => {
    delete process.env["TEST_KEYPAIR_PATH"];
    const fallback = await Keypair.generate();

    const loaded = await resolveOracleOperatorKeypair(fallback, {
      envVar: "TEST_KEYPAIR_PATH",
      description: "Custom signer",
    });

    expect(loaded).toBe(fallback);
    expect(logSpy.mock.calls[0]?.[0]).toStartWith("Custom signer: env TEST_KEYPAIR_PATH not set");
  });
});

describe("uniqueSigners", () => {
  const signer = (key: string) => ({ publicKey: { toBase58: () => key } });

  test("drops nullish entries and duplicate public keys, keeping first occurrence order", () => {
    const a = signer("A");
    const b = signer("B");
    const aAgain = signer("A");

    expect(uniqueSigners(null, a, undefined, b, aAgain)).toEqual([a, b]);
    expect(uniqueSigners(null, a, undefined, b, aAgain)[0]).toBe(a);
  });

  test("returns an empty list when there is nothing to sign with", () => {
    expect(uniqueSigners()).toEqual([]);
    expect(uniqueSigners(null, undefined)).toEqual([]);
  });
});
