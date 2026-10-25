import { describe, expect, test } from "bun:test";
import type { Connection } from "#solana";
import {
  DEFAULT_MAINNET_ENDPOINT,
  RpcEndpointManager,
  isRetryableRpcError,
  parseRpcEndpointList,
} from "../src/utils/rpc-endpoints";

const resetError = (message = "ECONNRESET: simulated failure") => {
  const error = new Error(message);
  (error as { code?: string }).code = "ECONNRESET";
  return error;
};

const asConnection = (value: unknown) => value as unknown as Connection;

describe("isRetryableRpcError status codes", () => {
  test("treats numeric server codes as retryable and client codes as final", () => {
    expect(isRetryableRpcError({ code: 500, message: "internal" })).toBe(true);
    expect(isRetryableRpcError({ code: 599, message: "weird" })).toBe(true);
    expect(isRetryableRpcError({ code: 404, message: "missing" })).toBe(false);
  });
});

describe("RpcEndpointManager construction", () => {
  test("requires at least one endpoint", () => {
    expect(() => new RpcEndpointManager([])).toThrow("At least one RPC endpoint is required");
    expect(() => new RpcEndpointManager(undefined as unknown as string[])).toThrow(
      "At least one RPC endpoint is required",
    );
  });

  test("rejects endpoint lists that are blank after trimming", () => {
    expect(() => new RpcEndpointManager(["   ", ""])).toThrow(
      "SOLANA_NETWORK did not resolve to any RPC endpoints",
    );
  });

  test("builds real connections by default and exposes proxy metadata", () => {
    const manager = new RpcEndpointManager(["http://127.0.0.1:1/coverage-d"], {
      commitment: "finalized",
    });
    const connection = manager.getConnection();

    expect(connection.rpcEndpoint).toBe("http://127.0.0.1:1/coverage-d");
    expect(connection.commitment).toBe("finalized");
    expect(Object.prototype.toString.call(connection)).toBe("[object Connection]");
  });
});

describe("RpcEndpointManager listeners", () => {
  test("logs synchronous listener failures and still notifies the others", async () => {
    const endpoints = ["https://rpc-primary", "https://rpc-secondary"];
    const errors: unknown[][] = [];
    const manager = new RpcEndpointManager(endpoints, {
      connectionFactory: (endpoint: string) =>
        asConnection({
          getSlot: async () => {
            if (endpoint === endpoints[0]) throw resetError();
            return 7n;
          },
        }),
      logger: { error: (...args: unknown[]) => errors.push(args) },
    });
    const boom = new Error("sync listener failed");
    manager.onActiveEndpointChange(() => {
      throw boom;
    });
    const seen: string[] = [];
    manager.onActiveEndpointChange((change) => {
      seen.push(change.endpoint);
    });

    expect(await manager.getConnection().getSlot()).toBe(7n);

    expect(errors).toEqual([["RPC endpoint change listener threw:", boom]]);
    expect(seen).toEqual(["https://rpc-secondary"]);
  });
});

describe("RpcEndpointManager call handling", () => {
  test("returns a non-function member as-is when the method disappears between lookups", async () => {
    let lookups = 0;
    const connection = {
      get shifting() {
        lookups += 1;
        return lookups === 1 ? async () => "never used" : "plain-value";
      },
    };
    const manager = new RpcEndpointManager(["https://rpc-only"], {
      connectionFactory: () => asConnection(connection),
    });

    const result = await (manager.getConnection() as any).shifting();

    expect(result).toBe("plain-value");
  });

  test("does not time-box write calls and returns their result", async () => {
    const manager = new RpcEndpointManager(["https://rpc-only"], {
      connectionFactory: () => asConnection({ sendRawTransaction: async () => "signature-1" }),
    });

    expect(await (manager.getConnection() as any).sendRawTransaction(new Uint8Array(1))).toBe(
      "signature-1",
    );
  });

  test("logs and rethrows a retryable write error from the only endpoint", async () => {
    const lines: unknown[][] = [];
    const failure = resetError();
    const manager = new RpcEndpointManager(["https://rpc-only/secret-key"], {
      connectionFactory: () =>
        asConnection({
          sendRawTransaction: async () => {
            throw failure;
          },
        }),
      logger: { error: (...args: unknown[]) => lines.push(args), warn: () => {} },
    });

    await expect(
      (manager.getConnection() as any).sendRawTransaction(new Uint8Array(1)),
    ).rejects.toBe(failure);

    expect(lines).toEqual([
      ["RPC call sendRawTransaction failed on https://rpc-only/… without fallback:", failure],
    ]);
  });

  test("rethrows a non-retryable error raised while verifying the fallback provider", async () => {
    const fatal = new Error("invalid genesis response");
    const manager = new RpcEndpointManager(["https://rpc-only"], {
      fallbackEndpoint: "https://rpc-fallback",
      connectionFactory: (endpoint: string) =>
        asConnection({
          getSlot: async () => {
            throw resetError();
          },
          getGenesisHash: async () => {
            if (endpoint === "https://rpc-fallback") throw fatal;
            return "genesis";
          },
        }),
    });

    await expect(manager.getConnection().getSlot()).rejects.toBe(fatal);
  });

  test("keeps going after a retryable fallback verification failure and retries the primary", async () => {
    let primaryCalls = 0;
    const manager = new RpcEndpointManager(["https://rpc-only"], {
      fallbackEndpoint: "https://rpc-fallback",
      connectionFactory: (endpoint: string) =>
        asConnection({
          getSlot: async () => {
            primaryCalls += 1;
            if (primaryCalls === 1) throw resetError();
            return 55n;
          },
          getGenesisHash: async () => {
            if (endpoint === "https://rpc-fallback") throw resetError("socket hang up");
            return "genesis";
          },
        }),
    });

    expect(await manager.getConnection().getSlot()).toBe(55n);
    expect(primaryCalls).toBe(2);
  });
});

describe("parseRpcEndpointList edge cases", () => {
  test("ignores blank fallback entries", () => {
    expect(parseRpcEndpointList(undefined, { fallback: ["https://a", "  ", ""] })).toEqual([
      "https://a",
    ]);
  });

  test("skips empty JSON array entries and keeps the remaining endpoints", () => {
    expect(parseRpcEndpointList('["", "https://a", "  "]')).toEqual(["https://a"]);
  });

  test("uses the fallback when every entry is blank", () => {
    expect(parseRpcEndpointList('[""]', { fallback: DEFAULT_MAINNET_ENDPOINT })).toEqual([
      DEFAULT_MAINNET_ENDPOINT,
    ]);
    expect(parseRpcEndpointList(" , ,", { fallback: [DEFAULT_MAINNET_ENDPOINT] })).toEqual([
      DEFAULT_MAINNET_ENDPOINT,
    ]);
  });

  test("throws when every entry is blank and there is no fallback", () => {
    expect(() => parseRpcEndpointList("[]")).toThrow("SOLANA_NETWORK resolved to an empty list");
    expect(() => parseRpcEndpointList(" , ")).toThrow("SOLANA_NETWORK resolved to an empty list");
  });
});
