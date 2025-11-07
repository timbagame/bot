import { describe, expect, test } from "bun:test";
import type { Connection } from "@solana/web3.js";
import {
  DEFAULT_MAINNET_ENDPOINT,
  RpcEndpointManager,
  parseRpcEndpointList,
  resolvePrimaryRpcEndpoint,
  type ActiveEndpointChange,
} from "../src/utils/rpc-endpoints";

class FakeConnection {
  public constructor(
    public readonly rpcEndpoint: string,
    public readonly commitment: string,
    private readonly shouldFail: boolean,
  ) {}

  public async getSlot(): Promise<number> {
    if (this.shouldFail) {
      const error = new Error("ECONNRESET: simulated failure");
      (error as { code?: string }).code = "ECONNRESET";
      throw error;
    }
    return 42;
  }
}

describe("parseRpcEndpointList", () => {
  test("parses comma-separated list", () => {
    const endpoints = parseRpcEndpointList(
      "https://rpc1.solana.com, https://rpc2.solana.com",
    );
    expect(endpoints).toEqual([
      "https://rpc1.solana.com",
      "https://rpc2.solana.com",
    ]);
  });

  test("parses JSON array and deduplicates", () => {
    const endpoints = parseRpcEndpointList(
      '["https://rpc1.solana.com","https://rpc1.solana.com","https://rpc2.solana.com"]',
    );
    expect(endpoints).toEqual([
      "https://rpc1.solana.com",
      "https://rpc2.solana.com",
    ]);
  });

  test("falls back to default when missing", () => {
    const endpoints = parseRpcEndpointList(undefined, {
      fallback: DEFAULT_MAINNET_ENDPOINT,
    });
    expect(endpoints).toEqual([DEFAULT_MAINNET_ENDPOINT]);
  });

  test("throws when empty and no fallback", () => {
    expect(() => parseRpcEndpointList("   ")).toThrow(
      "SOLANA_NETWORK is required",
    );
  });
});

describe("resolvePrimaryRpcEndpoint", () => {
  test("returns first endpoint", () => {
    const endpoint = resolvePrimaryRpcEndpoint(
      "https://rpc1.solana.com,https://rpc2.solana.com",
    );
    expect(endpoint).toBe("https://rpc1.solana.com");
  });

  test("uses fallback when env empty", () => {
    const endpoint = resolvePrimaryRpcEndpoint(undefined, DEFAULT_MAINNET_ENDPOINT);
    expect(endpoint).toBe(DEFAULT_MAINNET_ENDPOINT);
  });
});

describe("RpcEndpointManager", () => {
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

    expect(slot).toBe(42);
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
});
