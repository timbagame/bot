import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createWalletMenuModule } from "../src/handlers/wallet-menu";

const stubBot = { callbackQuery: () => undefined };
const stubLimiter = { consume: () => ({ allowed: true, resetInMs: 0 }) };

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});

const createWallet = (getKeyPair: () => unknown) => {
  const counters = { balanceCalls: 0, clearedFor: [] as string[] };
  const wallet = {
    connection: { rpcEndpoint: "rpc" },
    getConnection() {
      return this.connection;
    },
    async getBalance() {
      counters.balanceCalls += 1;
      return 1000;
    },
    peekCachedNativeBalance: () => undefined,
    getAllWalletTokenBalances: async () => [],
    peekCachedWalletTokenBalances: () => undefined,
    setCachedNativeBalance: () => {},
    setCachedWalletTokenBalances: () => {},
    clearCachedWalletData: (telegramId: bigint | number | string) => {
      counters.clearedFor.push(String(telegramId));
    },
    onWalletCacheCleared: () => () => {},
    getKeyPair,
    formatSolBalance: () => "sol",
    formatTokenBalance: () => "tok",
  } as any;
  return { wallet, counters };
};

const createModule = (wallet: any) =>
  createWalletMenuModule({
    bot: stubBot as any,
    wallet,
    getTokenManager: () => ({ getAllKnownTokensWithMetadata: () => [] }) as any,
    wrapCallbackHandler: (fn: any) => fn,
    rpcRateLimiter: { limiter: stubLimiter as any },
  });

describe("clearWalletCache when the wallet does not exist yet", () => {
  test("still invalidates cached balances and does not throw", async () => {
    const { wallet, counters } = createWallet(() => {
      throw new Error("wallet not found");
    });
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();
    module.__test_resetWalletRpcCacheTtlMs();

    await module.getCachedWalletData(5n);
    expect(counters.balanceCalls).toBe(1);

    await expect(module.clearWalletCache(5n)).resolves.toBeUndefined();
    expect(counters.clearedFor).toEqual(["5"]);
    expect(
      logSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("Cleared wallet cache for user: 5"),
      ),
    ).toBe(true);

    await module.getCachedWalletData(5n);
    expect(counters.balanceCalls).toBe(2);
  });

  test("rejected key pair lookups are tolerated too", async () => {
    const { wallet, counters } = createWallet(async () => {
      throw new Error("no key");
    });
    const module = createModule(wallet);
    module.__test_clearWalletSnapshotCache();

    await expect(module.clearWalletCache(6n)).resolves.toBeUndefined();
    expect(counters.clearedFor).toEqual(["6"]);
  });
});
