import { afterEach, describe, expect, test } from "bun:test";
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
