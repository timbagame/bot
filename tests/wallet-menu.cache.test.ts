import { describe, expect, test } from "bun:test";
import { createWalletMenuModule } from "../src/handlers/wallet-menu";
import { applyHoldMarks, createMemoryHoldMarkStore } from "../src/services/hold-marks";
import type { WalletTokenCensus } from "../src/utils/wallet";

const stubBot = { callbackQuery: () => undefined };
const stubLimiter = { consume: () => ({ allowed: true, resetInMs: 0 }) };
const stubTokenManager = { getAllKnownTokensWithMetadata: () => [] };

type WalletState = {
  balanceCalls: number;
  balanceValue: number;
  fail: boolean;
  delayMs: number;
  staleNative?: number;
  staleTokens?: Array<any>;
};

const TIMBA = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

const createStubWallet = (
  options: Partial<WalletState> & {
    endpoint?: string;
    beforeBalance?: () => void;
    getAllWalletTokenBalances?: (...args: any[]) => Promise<any>;
    getWalletTokenBalancePage?: (...args: any[]) => Promise<any>;
  } = {},
) => {
  const state: WalletState = {
    balanceCalls: 0,
    balanceValue: options.balanceValue ?? 1000,
    fail: options.fail ?? false,
    delayMs: options.delayMs ?? 0,
    staleNative: options.staleNative,
    staleTokens: options.staleTokens,
  };
  const listeners: Array<(telegramId: bigint | number | string) => void> = [];
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
    getAllWalletTokenBalances: options.getAllWalletTokenBalances ?? (async () => []),
    getWalletTokenBalancePage: options.getWalletTokenBalancePage,
    peekCachedWalletTokenBalances: () => state.staleTokens,
    setCachedNativeBalance: () => {},
    setCachedWalletTokenBalances: () => {},
    clearCachedWalletData: (telegramId: bigint | number | string) => {
      for (const listener of listeners) {
        listener(telegramId);
      }
    },
    onWalletCacheCleared: (listener: (telegramId: bigint | number | string) => void) => {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    getKeyPair: () => ({ publicKey: { toBase58: () => "W" } }),
    formatSolBalance: () => "sol",
    formatTokenBalance: () => "tok",
  } as any;

  return { wallet, state };
};

const createModule = (wallet: any, extras: { holdMarks?: any } = {}) =>
  createWalletMenuModule({
    bot: stubBot as any,
    wallet,
    getTokenManager: () => stubTokenManager as any,
    wrapCallbackHandler: (fn: any) => fn,
    rpcRateLimiter: { limiter: stubLimiter as any },
    ...extras,
  });

const ensureBalanceCalled = (state: WalletState, expected: number) =>
  expect(state.balanceCalls).toBe(expected);

describe("wallet menu cache guards", () => {
  test("zero TTL forces repeated RPC calls", async () => {
    const { wallet, state } = createStubWallet();
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();
    module.__test_setWalletRpcCacheTtlMs(0);

    await module.getCachedWalletData(1n);
    await module.getCachedWalletData(1n);

    ensureBalanceCalled(state, 2);
    module.__test_resetWalletRpcCacheTtlMs();
  });

  test("clearWalletCache causes a fresh RPC", async () => {
    const { wallet, state } = createStubWallet();
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();
    module.__test_resetWalletRpcCacheTtlMs();

    await module.getCachedWalletData(1n);
    module.clearWalletCache(1n);
    await module.getCachedWalletData(1n);

    ensureBalanceCalled(state, 2);
  });

  test("wallet.clearCachedWalletData invalidates snapshot cache", async () => {
    const { wallet, state } = createStubWallet();
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();
    module.__test_resetWalletRpcCacheTtlMs();

    await module.getCachedWalletData(3n);
    wallet.clearCachedWalletData(3n);
    await module.getCachedWalletData(3n);

    ensureBalanceCalled(state, 2);
  });

  test("RPC failure without fallback leaves cache empty", async () => {
    const { wallet, state } = createStubWallet({ fail: true });
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();

    await expect(module.getCachedWalletData(5n)).rejects.toThrow("rpc fail");
    expect(module.__test_getWalletSnapshotCacheKeys()).toEqual([]);
    ensureBalanceCalled(state, 1);
  });

  test("cache keys include RPC endpoint", async () => {
    const { wallet, state } = createStubWallet({ endpoint: "foo" });
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();

    await module.getCachedWalletData(7n);
    wallet.connection.rpcEndpoint = "bar";
    await module.getCachedWalletData(7n);

    expect(module.__test_getWalletSnapshotCacheKeys()).toEqual(["7:foo", "7:bar"]);
    ensureBalanceCalled(state, 2);
  });

  test("concurrent fetches dedupe via pending map", async () => {
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

  test("clearing during in-flight fetch prevents stale snapshot insertion", async () => {
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

  test("TTL expiration triggers new RPC", async () => {
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

describe("wallet menu hold-mark prune", () => {
  const seedTimbaMark = (store: ReturnType<typeof createMemoryHoldMarkStore>) => {
    applyHoldMarks({
      walletAddress: "W",
      marks: [{ mint: TIMBA, priceUsd: 0.00000551069 }],
      store,
    });
  };

  test("a successful empty token list does not re-anchor a hold mark", async () => {
    const store = createMemoryHoldMarkStore();
    seedTimbaMark(store);
    const { wallet } = createStubWallet();
    const module = createModule(wallet, { holdMarks: store });

    await module.getCachedWalletData(1n);

    expect(store.get("W", TIMBA)).toBeCloseTo(0.00000551069, 12);
  });

  test("an ATA-only list missing a token does not drop that mark", async () => {
    const store = createMemoryHoldMarkStore();
    seedTimbaMark(store);
    const { wallet } = createStubWallet({
      getAllWalletTokenBalances: async (_id, _known, options) => {
        const census: WalletTokenCensus = {
          complete: false,
          heldMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
          scannedMints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
        };
        options?.onCensus?.(census);
        return [];
      },
    });
    const module = createModule(wallet, { holdMarks: store });

    await module.getCachedWalletData(1n);

    expect(store.get("W", TIMBA)).toBeCloseTo(0.00000551069, 12);
  });

  test("a complete empty census drops the mark so the next hold starts fresh", async () => {
    const store = createMemoryHoldMarkStore();
    seedTimbaMark(store);
    const { wallet } = createStubWallet({
      getAllWalletTokenBalances: async (_id, _known, options) => {
        options?.onCensus?.({
          complete: true,
          heldMints: [],
          scannedMints: [TIMBA],
        });
        return [];
      },
    });
    const module = createModule(wallet, { holdMarks: store });

    await module.getCachedWalletData(1n);

    expect(store.get("W", TIMBA)).toBeUndefined();
  });

  test("/start page scan prunes sold marks using the full owner list, not the page slice", async () => {
    const store = createMemoryHoldMarkStore();
    seedTimbaMark(store);
    applyHoldMarks({
      walletAddress: "W",
      marks: [{ mint: "other-mint", priceUsd: 1 }],
      store,
    });
    const { wallet } = createStubWallet({
      getWalletTokenBalancePage: async () => ({
        tokenBalances: [],
        page: 0,
        pageCount: 2,
        heldMints: ["other-mint"],
        complete: true,
      }),
    });
    const module = createModule(wallet, { holdMarks: store });

    await module.getWalletPageData(1n, 0, 8);

    expect(store.get("W", TIMBA)).toBeUndefined();
    expect(store.get("W", "other-mint")).toBe(1);
  });

  test("/start does not prune when the page scan is incomplete", async () => {
    const store = createMemoryHoldMarkStore();
    seedTimbaMark(store);
    const { wallet } = createStubWallet({
      getWalletTokenBalancePage: async () => ({
        tokenBalances: [],
        page: 0,
        pageCount: 1,
        heldMints: [],
        complete: false,
      }),
    });
    const module = createModule(wallet, { holdMarks: store });

    await module.getWalletPageData(1n, 0, 8);

    expect(store.get("W", TIMBA)).toBeCloseTo(0.00000551069, 12);
  });
});
