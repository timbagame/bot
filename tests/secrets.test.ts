import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import fc from "fast-check";
import { execFileSync, spawnSync } from "node:child_process";
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

  test.each([0o601, 0o602, 0o604, 0o610, 0o620, 0o640])(
    "rejects every permission bit for other users (mode %i)",
    (mode) => {
      const file = secretFile("token");
      chmodSync(file, mode);
      expect(() => readProtectedSecretFile(file, "Secret")).toThrow("insecure permissions");
    },
  );

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

  test("a path replaced after inspection cannot substitute another secret", () => {
    const file = secretFile("original-token");
    const replacement = secretFile("replacement-token");
    chmodSync(replacement, 0o644);
    const swap = () => {
      fs.renameSync(file, `${file}-original`);
      symlinkSync(replacement, file);
    };
    const realLstat = fs.lstatSync;
    const realFstat = fs.fstatSync;
    const pathHook = spyOn(fs, "lstatSync").mockImplementationOnce(((file: fs.PathLike) => {
      const stats = realLstat(file);
      swap();
      return stats;
    }) as typeof fs.lstatSync);
    const descriptorHook = spyOn(fs, "fstatSync").mockImplementationOnce(((fd: number) => {
      const stats = realFstat(fd);
      swap();
      return stats;
    }) as typeof fs.fstatSync);
    try {
      expect(readProtectedSecretFile(file, "Secret")).toBe("original-token");
    } finally {
      pathHook.mockRestore();
      descriptorHook.mockRestore();
    }
  });

  test("rejects a symlink substituted just before opening", () => {
    const file = secretFile("original-token");
    const replacement = secretFile("replacement-token");
    const realOpen = fs.openSync;
    const hook = spyOn(fs, "openSync").mockImplementationOnce((...args) => {
      fs.unlinkSync(file);
      symlinkSync(replacement, file);
      return realOpen(...args);
    });
    try {
      expect(() => readProtectedSecretFile(file, "Secret")).toThrow("not a symlink");
    } finally {
      hook.mockRestore();
    }
  });

  test("rejects directories", () => {
    const file = secretFile("token");
    expect(() => readProtectedSecretFile(join(file, ".."), "Secret")).toThrow("regular file");
  });

  test("validates the opened file even if its path becomes a protected replacement", () => {
    const file = secretFile("unprotected-token");
    chmodSync(file, 0o644);
    const replacement = secretFile("protected-token");
    const realOpen = fs.openSync;
    const hook = spyOn(fs, "openSync").mockImplementationOnce((...args) => {
      const fd = realOpen(...args);
      fs.renameSync(file, `${file}-original`);
      fs.renameSync(replacement, file);
      return fd;
    });
    try {
      expect(() => readProtectedSecretFile(file, "Secret")).toThrow("insecure permissions");
    } finally {
      hook.mockRestore();
    }
  });

  test("a substituted FIFO is refused without blocking", () => {
    const file = secretFile("token");
    fs.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `import { readProtectedSecretFile } from ${JSON.stringify(join(import.meta.dir, "../src/utils/secrets.ts"))};
         try { readProtectedSecretFile(${JSON.stringify(file)}, "Secret"); process.exit(1); }
         catch (error) { console.log(error.message); }`,
      ],
      { timeout: 2000, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("must be a regular file");
  });

  test.each(["", "to", "token-extra", "x".repeat(4097)])(
    "rejects size changes after inspection (%#. case)",
    (value) => {
      const file = secretFile("token");
      const realFstat = fs.fstatSync;
      const hook = spyOn(fs, "fstatSync").mockImplementationOnce(((fd: number) => {
        const stats = realFstat(fd);
        writeFileSync(file, value);
        return stats;
      }) as typeof fs.fstatSync);
      try {
        expect(() => readProtectedSecretFile(file, "Secret")).toThrow("invalid size");
      } finally {
        hook.mockRestore();
      }
    },
  );

  test("short reads preserve a multibyte secret", () => {
    const file = secretFile("  token-é🎲  ");
    const realRead = fs.readSync;
    const hook = spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | bigint | null,
    ) => realRead(fd, buffer, offset, Math.min(length, 1), position)) as typeof fs.readSync);
    try {
      expect(readProtectedSecretFile(file, "Secret")).toBe("token-é🎲");
    } finally {
      hook.mockRestore();
    }
  });

  test("detects growth beyond the limit even when the original file filled the buffer", () => {
    const file = secretFile("x".repeat(4096));
    const realFstat = fs.fstatSync;
    const hook = spyOn(fs, "fstatSync").mockImplementationOnce(((fd: number) => {
      const stats = realFstat(fd);
      writeFileSync(file, "x".repeat(4097));
      return stats;
    }) as typeof fs.fstatSync);
    try {
      expect(() => readProtectedSecretFile(file, "Secret")).toThrow("invalid size");
    } finally {
      hook.mockRestore();
    }
  });

  test.each(["fstatSync", "readSync"] as const)("closes the file when %s fails", (method) => {
    const file = secretFile("token");
    const failure = new Error("synthetic-read-failure");
    const realFstat = fs.fstatSync;
    const close = spyOn(fs, "closeSync");
    const hook = spyOn(fs, method).mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() => readProtectedSecretFile(file, "Secret")).toThrow(failure);
      const fd = close.mock.calls[0]![0];
      expect(() => realFstat(fd)).toThrow();
    } finally {
      hook.mockRestore();
      close.mockRestore();
    }
  });

  test("closes the file after success", () => {
    const file = secretFile("token");
    const close = spyOn(fs, "closeSync");
    try {
      expect(readProtectedSecretFile(file, "Secret")).toBe("token");
      expect(() => fs.fstatSync(close.mock.calls[0]![0])).toThrow();
    } finally {
      close.mockRestore();
    }
  });

  test("UTF-8 secrets round-trip and whitespace is rejected (property)", () => {
    const file = secretFile("token");
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "é", "🎲", "\u0000", " ", "\n"), { maxLength: 50 }),
        (characters) => {
          const value = characters.join("");
          writeFileSync(file, value);
          if (value.trim()) expect(readProtectedSecretFile(file, "Secret")).toBe(value.trim());
          else expect(() => readProtectedSecretFile(file, "Secret")).toThrow();
        },
      ),
      { seed: 4096, numRuns: 100 },
    );
  });
});
