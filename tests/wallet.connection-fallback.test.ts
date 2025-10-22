import { expect, test } from "bun:test";
import { WalletManager } from "../src/utils/wallet";

const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";

const resetInstance = () => {
  // @ts-ignore - allow resetting singleton for testing
  WalletManager["instance"] = undefined;
};

class FakeConnection {
  public rpcEndpoint: string;
  public readonly requestCalls: Array<{ method: string; params: any }>;
  public readonly batchCalls: any[];
  private remainingFailures: number;
  private readonly value: any;

  constructor(endpoint: string, options: { failTimes?: number; value?: any } = {}) {
    this.rpcEndpoint = endpoint;
    this.remainingFailures = options.failTimes ?? 0;
    this.value = options.value ?? { endpoint };
    this.requestCalls = [];
    this.batchCalls = [];
  }

  async _rpcRequest(method: string, params: any): Promise<any> {
    this.requestCalls.push({ method, params });
    if (this.remainingFailures > 0) {
      this.remainingFailures--;
      const error = new Error("fetch failed");
      (error as any).code = "ECONNREFUSED";
      throw error;
    }
    return this.value;
  }

  async _rpcBatchRequest(payload: any[]): Promise<any[]> {
    this.batchCalls.push(payload);
    if (this.remainingFailures > 0) {
      this.remainingFailures--;
      const error = new Error("fetch failed");
      (error as any).code = "ECONNREFUSED";
      throw error;
    }
    return payload.map(() => this.value);
  }
}

test("WalletManager falls back to default RPC when primary endpoint fails", async () => {
  resetInstance();
  const primaryEndpoint = "https://rpc.primary.example";
  const primaryConnection = new FakeConnection(primaryEndpoint, { failTimes: 1 });
  const fallbackConnection = new FakeConnection(FALLBACK_RPC, {
    value: { endpoint: FALLBACK_RPC, ok: true },
  });

  let primaryFactoryCalls = 0;
  let fallbackFactoryCalls = 0;

  const manager = WalletManager.createForTest(mnemonic, {
    primaryEndpoint,
    connectionFactory: (endpoint, isFallback) => {
      if (isFallback) {
        fallbackFactoryCalls++;
        expect(endpoint).toBe(FALLBACK_RPC);
        return fallbackConnection as unknown as any;
      }
      primaryFactoryCalls++;
      expect(endpoint).toBe(primaryEndpoint);
      return primaryConnection as unknown as any;
    },
  });

  const connection = manager.getConnection();
  expect(connection).toBe(primaryConnection as any);

  const firstResult = await (connection as any)._rpcRequest("getLatestBlockhash", []);
  expect(firstResult).toEqual({ endpoint: FALLBACK_RPC, ok: true });

  expect(primaryConnection.requestCalls).toHaveLength(1);
  expect(fallbackConnection.requestCalls).toHaveLength(1);
  expect(primaryFactoryCalls).toBe(1);
  expect(fallbackFactoryCalls).toBe(1);

  const currentConnection = manager.getConnection();
  expect(currentConnection).toBe(fallbackConnection as any);

  const secondResult = await (connection as any)._rpcRequest("getBalance", []);
  expect(secondResult).toEqual({ endpoint: FALLBACK_RPC, ok: true });

  expect(primaryConnection.requestCalls).toHaveLength(1);
  expect(fallbackConnection.requestCalls).toHaveLength(2);

  resetInstance();
});
