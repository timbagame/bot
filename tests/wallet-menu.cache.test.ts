import { describe, expect, test } from "bun:test";
import { createWalletMenuModule } from "../src/handlers/wallet-menu";

const stubBot = { callbackQuery: () => undefined };
const stubLimiter = { consume: () => ({ allowed: true, resetInMs: 0 }) };
const stubTokenManager = { getAllApprovedTokensWithMetadata: () => [] };

type WalletState = {
  balanceCalls: number;
  balanceValue: number;
  fail: boolean;
  delayMs: number;
  staleNative?: number;
  staleTokens?: Array<any>;
};

const createStubWallet = (
  options: Partial<WalletState> &
    { endpoint?: string; beforeBalance?: () => void } = {}
) => {
  const state: WalletState = {
    balanceCalls: 0,
    balanceValue: options.balanceValue ?? 1000,
    fail: options.fail ?? false,
    delayMs: options.delayMs ?? 0,
    staleNative: options.staleNative,
    staleTokens: options.staleTokens,
  };
  const wallet = {
    connection: { rpcEndpoint: options.endpoint ?? "rpc" },
    getConnection() {
      return this.connection;
    },
    async getBalance() {
      state.balanceCalls++;
      if (options.beforeBalance) {
        options.beforeBalance();
      }
      if (state.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      }
      if (state.fail) {
        throw new Error("rpc fail");
      }
      return state.balanceValue;
    },
    peekCachedNativeBalance: () => state.staleNative,
    getAllApprovedTokenBalances: async () => [],
    peekCachedApprovedTokenBalances: () => state.staleTokens,
    setCachedNativeBalance: () => {},
    setCachedApprovedTokenBalances: () => {},
    clearCachedWalletData: () => {},
    getKeyPair: () => ({ publicKey: { toBase58: () => "W" } }),
    formatSolBalance: () => "sol",
    formatTokenBalance: () => "tok",
  } as any;

  return { wallet, state };
};

const createModule = (wallet: any) =>
  createWalletMenuModule({
    bot: stubBot as any,
    wallet,
    getTokenManager: () => stubTokenManager as any,
    wrapCallbackHandler: (fn: any) => fn,
    rpcRateLimiter: { limiter: stubLimiter as any },
  });

const ensureBalanceCalled = (state: WalletState, expected: number) =>
  expect(state.balanceCalls).toBe(expected);

describe("wallet menu cache guards", () => {
  test("B-001: zero TTL forces repeated RPC", async () => {
    const { wallet, state } = createStubWallet();
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();
    module.__test_setWalletRpcCacheTtlMs(0);

    await module.getCachedWalletData(1n);
    await module.getCachedWalletData(1n);

    ensureBalanceCalled(state, 2);
    module.__test_resetWalletRpcCacheTtlMs();
  });

  test("B-002: clearWalletCache forces re-fetch", async () => {
    const { wallet, state } = createStubWallet();
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();
    module.__test_resetWalletRpcCacheTtlMs();

    await module.getCachedWalletData(1n);
    module.clearWalletCache(1n);
    await module.getCachedWalletData(1n);

    ensureBalanceCalled(state, 2);
  });

  test("B-003: RPC failure without stale data leaves cache empty", async () => {
    const { wallet, state } = createStubWallet({ fail: true });
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();

    await expect(module.getCachedWalletData(5n)).rejects.toThrow("rpc fail");
    expect(module.__test_getWalletSnapshotCacheKeys()).toEqual([]);
    ensureBalanceCalled(state, 1);
  });

  test("B-004: cache segregates by RPC endpoint", async () => {
    const { wallet, state } = createStubWallet({ endpoint: "foo" });
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();

    await module.getCachedWalletData(7n);
    wallet.connection.rpcEndpoint = "bar";
    await module.getCachedWalletData(7n);

    expect(module.__test_getWalletSnapshotCacheKeys()).toEqual([
      "7:foo",
      "7:bar",
    ]);
    ensureBalanceCalled(state, 2);
  });

  test("B-005: concurrent fetch dedupes via pending map", async () => {
    const { wallet, state } = createStubWallet({ delayMs: 30 });
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();

    const [first, second] = await Promise.all([
      module.getCachedWalletData(9n),
      module.getCachedWalletData(9n),
    ]);

    expect(first).toBe(second);
    expect(module.__test_getPendingWalletFetchCount()).toBe(0);
    ensureBalanceCalled(state, 1);
  });

  test("B-006: clearing while fetch in-flight prevents stale snapshot insertion", async () => {
    let moduleRef: ReturnType<typeof createModule> | null = null;
    const { wallet } = createStubWallet({
      delayMs: 100,
      beforeBalance: () => moduleRef?.clearWalletCache(11n),
    });
    const module = createModule(wallet);
    moduleRef = module;
    module.__test_clearWalletSnapshotCache();

    const firstFetch = module.getCachedWalletData(11n);

    await firstFetch;
    expect(module.__test_getWalletSnapshotCacheKeys()).toEqual([]);
  });

  test("B-007: TTL expiration triggers refetch", async () => {
    const { wallet, state } = createStubWallet();
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();
    module.__test_setWalletRpcCacheTtlMs(10);

    await module.getCachedWalletData(13n);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await module.getCachedWalletData(13n);

    ensureBalanceCalled(state, 2);
    module.__test_resetWalletRpcCacheTtlMs();
  });
});
