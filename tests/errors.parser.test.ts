import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  collectErrorLogs,
  extractLamportsInfo,
  extractLamportsInfoFromError,
  extractSignature,
  isTransactionExpiredError,
  isTransactionTimeoutError,
} from "../src/utils/errors/parser";

const connection = {} as any;
const throwingGetter = (key: string, message = `cannot read ${key}`) =>
  Object.defineProperty({}, key, {
    enumerable: true,
    get() {
      throw new Error(message);
    },
  });

let debugSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  debugSpy = spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => debugSpy.mockRestore());

describe("collectErrorLogs", () => {
  test("ignores non-object errors", async () => {
    expect(await collectErrorLogs(null)).toEqual([]);
    expect(await collectErrorLogs("insufficient lamports 1, need 2")).toEqual([]);
  });

  test("collects string logs from every known field and skips other entries", async () => {
    const error = {
      logs: ["a", 1, "b"],
      logMessages: ["c"],
      transactionLogs: "not an array",
    };

    expect(await collectErrorLogs(error)).toEqual(["a", "b", "c"]);
  });

  test("walks data, error and cause chains without looping on cycles", async () => {
    const root: any = { logs: ["root"] };
    root.data = { logs: ["data"] };
    root.error = { logs: ["error"], cause: root };
    root.cause = { logs: ["cause"] };

    expect(await collectErrorLogs(root)).toEqual(["root", "data", "error", "cause"]);
  });

  test("asks the error for logs only when a connection is supplied", async () => {
    let calls = 0;
    const error = {
      getLogs: async (conn: unknown) => {
        calls += 1;
        expect(conn).toBe(connection);
        return ["from rpc"];
      },
    };

    expect(await collectErrorLogs(error)).toEqual([]);
    expect(await collectErrorLogs(error, new Set(), connection)).toEqual(["from rpc"]);
    expect(calls).toBe(1);
  });

  test("accepts synchronous getLogs results", async () => {
    const error = { getLogs: () => ["sync"] };

    expect(await collectErrorLogs(error, new Set(), connection)).toEqual(["sync"]);
  });

  test("keeps going when getLogs rejects", async () => {
    const error = {
      logs: ["kept"],
      getLogs: async () => {
        throw new Error("rpc down");
      },
    };

    expect(await collectErrorLogs(error, new Set(), connection)).toEqual(["kept"]);
    expect(debugSpy).toHaveBeenCalledWith("Failed to extract logs from error", expect.any(Error));
  });

  test("survives a log field whose getter throws", async () => {
    const error = Object.assign(throwingGetter("logs"), { logMessages: ["kept"] });

    expect(await collectErrorLogs(error)).toEqual(["kept"]);
    expect(debugSpy).toHaveBeenCalledWith("Failed to read logs from error", expect.any(Error));
  });

  test("survives an array whose iteration throws", async () => {
    const hostile = new Proxy(["x"], {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) throw new Error("no iteration");
        return Reflect.get(target, prop, receiver);
      },
    });

    expect(await collectErrorLogs({ logs: hostile, logMessages: ["kept"] })).toEqual(["kept"]);
    expect(debugSpy).toHaveBeenCalledWith("Failed to process extracted logs", expect.any(Error));
  });

  test.each([
    ["data", "Failed to read data from error"],
    ["error", "Failed to read nested error"],
    ["cause", "Failed to read error cause"],
  ])("survives a %s getter that throws", async (key, message) => {
    const error = Object.assign(throwingGetter(key), { logs: ["kept"] });

    expect(await collectErrorLogs(error)).toEqual(["kept"]);
    expect(debugSpy).toHaveBeenCalledWith(message, expect.any(Error));
  });

  test("survives a nested error that blows up while being inspected", async () => {
    const nested = throwingGetter("getLogs", "hostile nested");
    const error = { logs: ["outer"], cause: nested };

    expect(await collectErrorLogs(error, new Set(), connection)).toEqual(["outer"]);
    expect(debugSpy).toHaveBeenCalledWith("Failed to collect nested logs", expect.any(Error));
  });
});

describe("extractLamportsInfoFromError", () => {
  test("returns the first insufficient-lamports line from nested logs", async () => {
    const error = {
      logs: ["Program log: starting"],
      cause: {
        logs: ["Transfer: insufficient lamports 100, need 250", "insufficient lamports 1, need 2"],
      },
    };

    expect(await extractLamportsInfoFromError(error)).toEqual({ current: 100, needed: 250 });
  });

  test("returns null when no log mentions lamports", async () => {
    expect(await extractLamportsInfoFromError({ logs: ["ok"] })).toBeNull();
    expect(await extractLamportsInfoFromError(undefined)).toBeNull();
  });
});

describe("message helpers", () => {
  test("extractLamportsInfo parses the counts case-insensitively", () => {
    expect(extractLamportsInfo("Insufficient Lamports 5, need 10")).toEqual({
      current: 5,
      needed: 10,
    });
    expect(extractLamportsInfo("insufficient funds")).toBeNull();
  });

  test("timeout and expiry detection", () => {
    expect(isTransactionTimeoutError("transaction was not confirmed in 30s")).toBe(true);
    expect(isTransactionTimeoutError("Transaction Was Not Confirmed")).toBe(false);
    expect(isTransactionExpiredError("block height exceeded: last valid block height 5")).toBe(
      true,
    );
    expect(isTransactionExpiredError("expired")).toBe(false);
  });

  test("extractSignature prefers labelled signatures and falls back to bare base58", () => {
    const sig = "5".repeat(44);
    const bare = "A".repeat(86);

    expect(extractSignature(`failed: signature ${sig}`)).toBe(sig);
    expect(extractSignature(`see ${bare} for details`)).toBe(bare);
    expect(extractSignature("short 123")).toBeNull();
  });
});
