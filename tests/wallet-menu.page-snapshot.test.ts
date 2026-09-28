import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  WALLET_PAGE_SNAPSHOT_MAX_AGE_MS,
  createWalletMenuModule,
} from "../src/handlers/wallet-menu";

const createStubWallet = (endpoint = "rpc") => {
  let balance = 1_000;
  let pageDelay: Promise<void> | null = null;
  const listeners: Array<(telegramId: bigint | number | string) => void> = [];
  const wallet = {
    connection: { rpcEndpoint: endpoint },
    getConnection() {
      return this.connection;
    },
    getBalance: async () => balance,
    getWalletTokenBalancePage: async (_id: bigint, _known: unknown, page: number) => {
      if (pageDelay) await pageDelay;
      return {
        tokenBalances: [],
        page,
        pageCount: 3,
        heldMints: [],
        complete: false,
      };
    },
    peekCachedNativeBalance: () => undefined,
    peekCachedWalletTokenBalances: () => undefined,
    clearCachedWalletData: (telegramId: bigint | number | string) => {
      for (const listener of listeners) listener(telegramId);
    },
    onWalletCacheCleared: (listener: (telegramId: bigint | number | string) => void) => {
      listeners.push(listener);
      return () => {};
    },
    getKeyPair: () => ({ publicKey: { toBase58: () => "W" } }),
  } as any;
  return {
    wallet,
    setBalance: (value: number) => {
      balance = value;
    },
    delayPages: (promise: Promise<void> | null) => {
      pageDelay = promise;
    },
  };
};

const createModule = (wallet: any, bot: any = { callbackQuery: () => undefined }) =>
  createWalletMenuModule({
    bot,
    wallet,
    getTokenManager: () => ({ getAllKnownTokensWithMetadata: () => [] }) as any,
    wrapCallbackHandler: (fn: any) => fn,
    rpcRateLimiter: { limiter: { consume: () => ({ allowed: true, resetInMs: 0 }) } as any },
  });

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});

describe("wallet page snapshots (stale-while-revalidate)", () => {
  test("a fetched page is remembered with its fetch time", async () => {
    const { wallet } = createStubWallet();
    const module = createModule(wallet);
    expect(module.peekWalletPageData(1n, 0, 8)).toBeUndefined();

    Date.now = () => 1_000_000;
    const data = await module.getWalletPageData(1n, 0, 8);
    expect(data.fetchedAt).toBe(1_000_000);

    const cached = module.peekWalletPageData(1n, 0, 8);
    expect(cached?.fetchedAt).toBe(1_000_000);
    expect(cached?.data.solBalance).toBe(1_000);
    // Pages and page sizes are cached separately.
    expect(module.peekWalletPageData(1n, 1, 8)).toBeUndefined();
    expect(module.peekWalletPageData(1n, 0, 5)).toBeUndefined();
  });

  test("refresh (clearWalletCache) drops every cached page for the user only", async () => {
    const { wallet } = createStubWallet();
    const module = createModule(wallet);
    await module.getWalletPageData(1n, 0, 8);
    await module.getWalletPageData(1n, 1, 8);
    await module.getWalletPageData(2n, 0, 8);

    await module.clearWalletCache(1n);

    expect(module.peekWalletPageData(1n, 0, 8)).toBeUndefined();
    expect(module.peekWalletPageData(1n, 1, 8)).toBeUndefined();
    expect(module.peekWalletPageData(2n, 0, 8)).toBeDefined();
  });

  test("a fetch that started before a refresh does not repopulate the cache", async () => {
    const { wallet, delayPages } = createStubWallet();
    const module = createModule(wallet);
    let release: () => void = () => {};
    delayPages(new Promise<void>((resolve) => (release = resolve)));

    let now = 2_000_000;
    Date.now = () => now;
    const inFlight = module.getWalletPageData(1n, 0, 8);
    now += 10;
    await module.clearWalletCache(1n);
    now += 10;
    release();
    await inFlight;

    expect(module.peekWalletPageData(1n, 0, 8)).toBeUndefined();
  });

  test("very old snapshots are not served", async () => {
    const { wallet } = createStubWallet();
    const module = createModule(wallet);
    Date.now = () => 3_000_000;
    await module.getWalletPageData(1n, 0, 8);
    Date.now = () => 3_000_000 + WALLET_PAGE_SNAPSHOT_MAX_AGE_MS + 1;
    expect(module.peekWalletPageData(1n, 0, 8)).toBeUndefined();
  });

  test("snapshots are scoped to the active RPC endpoint", async () => {
    const { wallet } = createStubWallet("rpc-a");
    const module = createModule(wallet);
    await module.getWalletPageData(1n, 0, 8);
    wallet.connection.rpcEndpoint = "rpc-b";
    expect(module.peekWalletPageData(1n, 0, 8)).toBeUndefined();
  });
});

describe("wallet message view tracking", () => {
  test("a newer button press on the message invalidates the captured view", async () => {
    const middlewares: Array<(ctx: any, next: () => Promise<void>) => Promise<void>> = [];
    const bot = {
      use: (fn: any) => middlewares.push(fn),
      callbackQuery: () => undefined,
    };
    const { wallet } = createStubWallet();
    const module = createModule(wallet, bot);
    module.registerWalletMenuHandlers();
    expect(middlewares.length).toBe(1);

    const press = async (chatId: number, messageId: number) => {
      let nextCalled = false;
      await middlewares[0]!(
        { callbackQuery: { message: { message_id: messageId, chat: { id: chatId } } } },
        async () => {
          nextCalled = true;
        },
      );
      expect(nextCalled).toBe(true);
    };

    await press(10, 1);
    const view = module.captureMessageView(10, 1);
    const otherView = module.captureMessageView(10, 2);
    expect(view()).toBe(true);

    await press(10, 2);
    expect(view()).toBe(true);
    expect(otherView()).toBe(false);

    await press(10, 1);
    expect(view()).toBe(false);

    // Updates without a callback message pass through untouched.
    await middlewares[0]!({ message: { text: "/start" } }, async () => {});
  });
});

describe("wallet menu caches and limits", () => {
  test("rejects wallet reads once the per-user RPC budget is spent", async () => {
    const { wallet } = createStubWallet();
    const module = createWalletMenuModule({
      bot: { callbackQuery: () => undefined } as any,
      wallet,
      getTokenManager: () => ({ getAllKnownTokensWithMetadata: () => [] }) as any,
      wrapCallbackHandler: (fn: any) => fn,
      rpcRateLimiter: {
        limiter: { consume: () => ({ allowed: false, remaining: 0, resetInMs: 2_100 }) } as any,
      },
    });

    await expect(module.getWalletPageData(1n, 0, 8)).rejects.toThrow(
      "⏳ Too many wallet refreshes. Try again in 3s.",
    );
  });

  test("serves the last cached balances when the RPC read fails", async () => {
    const { wallet } = createStubWallet();
    wallet.getBalance = async () => {
      throw new Error("rpc down");
    };
    wallet.getAllWalletTokenBalances = async () => [];
    wallet.peekCachedNativeBalance = () => 7;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const module = createModule(wallet);

      const snapshot = await module.getCachedWalletData(1n);

      expect(snapshot.solBalance).toBe(7);
      expect(snapshot.tokenBalances).toEqual([]);
      expect(warn.mock.calls[0]?.[0]).toContain("Falling back to stale wallet cache for user 1");
    } finally {
      warn.mockRestore();
    }
  });

  test("uses stale token balances and WSOL when only tokens were cached", async () => {
    const { wallet } = createStubWallet();
    wallet.getBalance = async () => {
      throw new Error("rpc down");
    };
    wallet.getAllWalletTokenBalances = async () => [];
    wallet.peekCachedWalletTokenBalances = () => [
      { mint: "So11111111111111111111111111111111111111112", ticker: "WSOL", balance: 3 },
    ];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const snapshot = await createModule(wallet).getCachedWalletData(1n);

      expect(snapshot.solBalance).toBe(0);
      expect(snapshot.wsolBalance).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("rethrows a failed read when nothing was cached", async () => {
    const { wallet } = createStubWallet();
    wallet.getBalance = async () => {
      throw new Error("rpc down");
    };
    wallet.getAllWalletTokenBalances = async () => [];

    await expect(createModule(wallet).getCachedWalletData(1n)).rejects.toThrow("rpc down");
  });

  test("seeding the wallet cache tolerates non-integer raw balances", () => {
    const { wallet } = createStubWallet();
    let seeded: any[] = [];
    wallet.setCachedNativeBalance = () => {};
    wallet.setCachedWalletTokenBalances = (_id: bigint, tokens: any[]) => {
      seeded = tokens;
    };

    createModule(wallet).__test_setWalletCache(1n, {
      solBalance: 1,
      tokenBalances: [
        { mint: "A", ticker: "A", balance: 12.9, decimals: 0, rawBalance: "12.9" },
        { mint: "B", ticker: "B", balance: Number.NaN, decimals: 0 },
        { mint: "C", ticker: "C", balance: 4, decimals: 0 },
      ] as any,
    });

    expect(seeded.map((token) => token.lamports)).toEqual([12n, 0n, 4n]);
    expect(seeded.map((token) => token.rawBalance)).toEqual(["12.9", "0", "4"]);
  });

  test("the oldest page snapshot is evicted beyond the cache limit", async () => {
    const { wallet } = createStubWallet();
    const module = createModule(wallet);

    for (let user = 1; user <= 5_001; user += 1) {
      await module.getWalletPageData(BigInt(user), 0, 8);
    }

    expect(module.peekWalletPageData(1n, 0, 8)).toBeUndefined();
    expect(module.peekWalletPageData(2n, 0, 8)).toBeDefined();
    expect(module.peekWalletPageData(5_001n, 0, 8)).toBeDefined();
  });

  test("views on messages evicted from the activity log are treated as stale", async () => {
    const middlewares: Array<(ctx: any, next: () => Promise<void>) => Promise<void>> = [];
    const { wallet } = createStubWallet();
    const module = createModule(wallet, {
      use: (fn: any) => middlewares.push(fn),
      callbackQuery: () => undefined,
    });
    module.registerWalletMenuHandlers();
    const touch = (messageId: number) =>
      middlewares[0]!(
        { callbackQuery: { message: { message_id: messageId, chat: { id: 1 } } } },
        async () => {},
      );

    await touch(0);
    const view = module.captureMessageView(1, 0);
    for (let messageId = 1; messageId <= 5_000; messageId += 1) await touch(messageId);

    expect(view()).toBe(false);
    expect(module.captureMessageView(1, 5_000)()).toBe(true);
  });
});
