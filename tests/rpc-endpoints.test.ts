import { describe, expect, test } from "bun:test";
import type { Connection } from "#solana";
import {
  DEFAULT_MAINNET_ENDPOINT,
  RpcEndpointManager,
  parseRpcEndpointList,
  redactRpcEndpoint,
  resolvePrimaryRpcEndpoint,
  type ActiveEndpointChange,
} from "../src/utils/rpc-endpoints";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeConnection {
  public constructor(
    public readonly rpcEndpoint: string,
    public readonly commitment: string,
    private readonly shouldFail: boolean,
  ) {}

  public async getSlot(): Promise<bigint> {
    if (this.shouldFail) {
      const error = new Error("ECONNRESET: simulated failure");
      (error as { code?: string }).code = "ECONNRESET";
      throw error;
    }
    return 42n;
  }
}

describe("parseRpcEndpointList", () => {
  test("parses comma-separated list", () => {
    const endpoints = parseRpcEndpointList("https://rpc1.solana.com, https://rpc2.solana.com");
    expect(endpoints).toEqual(["https://rpc1.solana.com", "https://rpc2.solana.com"]);
  });

  test("parses JSON array and deduplicates", () => {
    const endpoints = parseRpcEndpointList(
      '["https://rpc1.solana.com","https://rpc1.solana.com","https://rpc2.solana.com"]',
    );
    expect(endpoints).toEqual(["https://rpc1.solana.com", "https://rpc2.solana.com"]);
  });

  test("falls back to default when missing", () => {
    const endpoints = parseRpcEndpointList(undefined, {
      fallback: DEFAULT_MAINNET_ENDPOINT,
    });
    expect(endpoints).toEqual([DEFAULT_MAINNET_ENDPOINT]);
  });

  test("throws when empty and no fallback", () => {
    expect(() => parseRpcEndpointList("   ")).toThrow("SOLANA_NETWORK is required");
  });
});

describe("resolvePrimaryRpcEndpoint", () => {
  test("returns first endpoint", () => {
    const endpoint = resolvePrimaryRpcEndpoint("https://rpc1.solana.com,https://rpc2.solana.com");
    expect(endpoint).toBe("https://rpc1.solana.com");
  });

  test("uses fallback when env empty", () => {
    const endpoint = resolvePrimaryRpcEndpoint(undefined, DEFAULT_MAINNET_ENDPOINT);
    expect(endpoint).toBe(DEFAULT_MAINNET_ENDPOINT);
  });
});

describe("redactRpcEndpoint", () => {
  test("hides API keys in query strings and paths", () => {
    expect(redactRpcEndpoint("https://mainnet.helius-rpc.com/?api-key=secret")).toBe(
      "https://mainnet.helius-rpc.com/…",
    );
    expect(redactRpcEndpoint("https://example.quiknode.pro/secret-token/")).toBe(
      "https://example.quiknode.pro/…",
    );
    expect(redactRpcEndpoint(DEFAULT_MAINNET_ENDPOINT)).toBe(DEFAULT_MAINNET_ENDPOINT);
    expect(redactRpcEndpoint("not a url secret")).toBe("<invalid RPC URL>");
  });
});

describe("RpcEndpointManager", () => {
  test("never logs endpoint secrets and keeps rejected calls to one line", async () => {
    const endpoints = [
      "https://rpc-primary.example/?api-key=primary-secret",
      "https://rpc-secondary.example/secondary-secret",
    ];
    const lines: unknown[][] = [];
    const record = (...args: unknown[]) => lines.push(args);
    const connectionFactory = (endpoint: string) =>
      ({
        getSlot: async () => {
          if (endpoint === endpoints[0]) {
            const error = new Error("ECONNRESET: simulated failure");
            (error as { code?: string }).code = "ECONNRESET";
            throw error;
          }
          return 42n;
        },
        getBlockTime: async () => {
          throw new Error("Block not available for slot 1");
        },
      }) as unknown as Connection;
    const manager = new RpcEndpointManager(endpoints, {
      commitment: "confirmed",
      connectionFactory,
      logger: { info: record, warn: record, error: record },
    });

    const connection = manager.getConnection();
    expect(await connection.getSlot()).toBe(42n);
    await expect(connection.getBlockTime(1)).rejects.toThrow("Block not available");

    const logged = JSON.stringify(lines.map((args) => args.map(String)));
    expect(logged).not.toContain("secret");
    expect(lines.at(-1)).toEqual([
      "RPC call getBlockTime rejected by https://rpc-secondary.example/…: Block not available for slot 1",
    ]);
  });

  test("switches to secondary endpoint after failure", async () => {
    const endpoints = ["https://rpc-primary", "https://rpc-secondary"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FakeConnection(endpoint, commitment, endpoint === endpoints[0]) as unknown as Connection;

    const manager = new RpcEndpointManager(endpoints, {
      commitment: "confirmed",
      connectionFactory,
    });

    const connection = manager.getConnection();
    const slot = await connection.getSlot();

    expect(slot).toBe(42n);
    expect(manager.getActiveEndpoint()).toBe("https://rpc-secondary");
  });

  test("notifies listeners when active endpoint changes", async () => {
    const endpoints = ["https://rpc-primary", "https://rpc-secondary"];
    const connectionFactory = (endpoint: string, commitment: string) =>
      new FakeConnection(endpoint, commitment, endpoint === endpoints[0]) as unknown as Connection;

    const manager = new RpcEndpointManager(endpoints, {
      commitment: "confirmed",
      connectionFactory,
    });

    const changes: ActiveEndpointChange[] = [];
    manager.onActiveEndpointChange((change) => {
      changes.push(change);
    });

    const connection = manager.getConnection();
    await connection.getSlot();

    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({
      endpoint: "https://rpc-secondary",
      index: 1,
      previousEndpoint: "https://rpc-primary",
      previousIndex: 0,
    });
  });

  test("maintains promoted endpoint across concurrent fallbacks", async () => {
    const endpoints = ["https://rpc-primary", "https://rpc-secondary"];

    class FlakyConnection {
      private readonly failureDelays = [0, 25];

      public constructor(
        public readonly rpcEndpoint: string,
        public readonly commitment: string,
      ) {}

      public async getSlot(): Promise<bigint> {
        if (this.rpcEndpoint === endpoints[0]) {
          const delay = this.failureDelays.shift() ?? 0;
          await sleep(delay);
          const error = new Error("ECONNRESET: simulated failure");
          (error as { code?: string }).code = "ECONNRESET";
          throw error;
        }

        await sleep(5);
        return 99n;
      }
    }

    const manager = new RpcEndpointManager(endpoints, {
      commitment: "confirmed",
      connectionFactory: (endpoint: string, commitment: string) =>
        new FlakyConnection(endpoint, commitment) as unknown as Connection,
    });

    const connection = manager.getConnection();
    const firstCall = connection.getSlot();
    const secondCall = connection.getSlot();

    const results = await Promise.all([firstCall, secondCall]);

    expect(results).toEqual([99n, 99n]);
    expect(manager.getActiveEndpoint()).toBe("https://rpc-secondary");
  });
});

describe("Foreground read recovery", () => {
  test("retries a wrapped socket closure on a single provider", async () => {
    let calls = 0;
    const manager = new RpcEndpointManager(["https://private.test"], {
      connectionFactory: () =>
        ({
          getSlot: async () => {
            if (++calls === 1)
              throw new Error("account read failed", {
                cause: new TypeError("The socket connection was closed unexpectedly"),
              });
            return 42n;
          },
        }) as unknown as Connection,
    });
    expect(await manager.getConnection().getSlot()).toBe(42n);
    expect(calls).toBe(2);
  });
  for (const sameCluster of [true, false])
    test(`independent fallback requires matching genesis: ${sameCluster}`, async () => {
      let fallbackReads = 0;
      const manager = new RpcEndpointManager(["https://private.test"], {
        connectionFactory: (endpoint) =>
          ({
            getGenesisHash: async () =>
              endpoint === DEFAULT_MAINNET_ENDPOINT && !sameCluster ? "other" : "chain",
            getSlot: async () => {
              if (endpoint !== DEFAULT_MAINNET_ENDPOINT)
                throw new Error("socket connection was closed");
              fallbackReads++;
              return 42n;
            },
          }) as unknown as Connection,
      });
      if (sameCluster) expect(await manager.getConnection().getSlot()).toBe(42n);
      else await expect(manager.getConnection().getSlot()).rejects.toThrow("socket");
      expect(fallbackReads).toBe(sameCluster ? 1 : 0);
    });
  test("a hung read cannot consume an unlimited deadline or start more attempts", async () => {
    let calls = 0;
    const manager = new RpcEndpointManager(["https://one.test", "https://two.test"], {
      readTimeoutMs: 25,
      connectionFactory: () =>
        ({
          getSlot: () => {
            calls++;
            return new Promise(() => {});
          },
        }) as unknown as Connection,
    });
    await expect(manager.getConnection().getSlot()).rejects.toThrow("timed out");
    expect(calls).toBe(1);
  });
});

test("subscription removals retain their owner while new listeners follow HTTP failover", async () => {
  const registrations: string[] = [];
  const removals: Array<[string, number]> = [];
  const endpoints: [string, string] = ["https://rpc-primary", "https://rpc-secondary"];
  const manager = new RpcEndpointManager(endpoints, {
    connectionFactory: (endpoint, commitment) => {
      const connection = new FakeConnection(endpoint, commitment, endpoint === endpoints[0]);
      return Object.assign(connection, {
        onLogs(this: FakeConnection) {
          registrations.push(this.rpcEndpoint);
          return 7;
        },
        async removeOnLogsListener(this: FakeConnection, id: number) {
          removals.push([this.rpcEndpoint, id]);
        },
      }) as unknown as Connection;
    },
  });
  const connection = manager.getConnection();
  const id = connection.onLogs("all", () => {});
  expect(typeof id).toBe("number");
  await connection.getSlot();
  expect(manager.getActiveEndpoint()).toBe(endpoints[1]);
  const replacementId = connection.onLogs("all", () => {});
  expect(typeof replacementId).toBe("number");
  expect(replacementId).not.toBe(id);
  await connection.removeOnLogsListener(id);
  await connection.removeOnLogsListener(replacementId);
  expect(registrations).toEqual([endpoints[0], endpoints[1]]);
  expect(removals).toEqual([
    [endpoints[0], 7],
    [endpoints[1], 7],
  ]);
});
