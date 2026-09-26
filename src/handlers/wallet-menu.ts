import type { Bot } from "grammy";

import {
  WSOL_MINT,
  getStartVideoId,
  USER_WALLET_RPC_MAX_CALLS,
  WALLET_RPC_CACHE_TTL_MS,
} from "../utils/constants";
import {
  buildWalletCaption,
  buildWalletActionMenuForUser,
  type BuildWalletActionMenuForUserOptions,
  type WalletMenuBalances,
} from "../utils/wallet-ui";
import {
  createPositionsKeyboard,
  createWalletKeyboard,
  createWalletSettingsKeyboard,
} from "../utils/keyboards";
import { getPricesUSD } from "../utils/prices";
import { TransactionHistory } from "../utils/transaction-history";
import { clearPositionSnapshot, type TokenHolding } from "../services/positions";
import { pruneHoldMarks, type HoldMarkStore } from "../services/hold-marks";
import { createHoldMarksDatabaseStore } from "../utils/hold-marks-database";
import { onWalletPositions } from "./wallet-positions";
import { respondWithMenu } from "../utils/menu-response";
import { safeAnswerCallbackQuery, requireTelegramId } from "../utils/context-helpers";
import type {
  WalletManager,
  WalletBalancesSnapshot,
  WalletTokenBalance,
  WalletTokenCensus,
} from "../utils/wallet";
import type { TokenManager } from "../utils/token-manager";
import {
  showWalletUI as showWalletUIHandler,
  onMainWallet,
  onWalletRefresh,
  onWalletSettings,
  type WalletHandlersDeps,
} from "./wallet";
import {
  createCallbackPrefixRegistrar,
  type RegisterCallbackPrefixHandler,
  type WrapCallbackHandler,
} from "../utils/callback-registry";
import { RateLimitExceededError, SlidingWindowRateLimiter } from "../utils/rate-limiter";

export type WalletActionMenuResolution = {
  menuOptions: Omit<BuildWalletActionMenuForUserOptions, "ctx">;
  successAck?: string;
};

export type WalletActionMenuHandlerConfig = {
  callback: string;
  logLabel?: string;
  errorAck: string;
  resolve: (ctx: any) => Promise<WalletActionMenuResolution | null | undefined>;
};

export type WalletCacheSnapshot = WalletBalancesSnapshot;

type WalletSnapshotSeed = {
  solBalance: number;
  tokenBalances: Array<
    Partial<WalletTokenBalance> & {
      mint: string;
      ticker: string;
      balance: number;
      decimals: number;
      rawBalance?: string;
    }
  >;
  knownTokens?: WalletBalancesSnapshot["knownTokens"];
  nativeSolBalance?: number;
  wsolBalance?: number;
};

type WalletMenuModuleOptions = {
  bot: Bot;
  wallet: WalletManager;
  getTokenManager: () => TokenManager | undefined;
  wrapCallbackHandler: WrapCallbackHandler;
  rpcRateLimiter: {
    limiter: SlidingWindowRateLimiter;
    maxRequests?: number;
  };
  holdMarks?: HoldMarkStore;
};

type WalletMenuModule = {
  registerWalletMenuHandlers: () => void;
  registerCallbackPrefixHandler: RegisterCallbackPrefixHandler;
  registerWalletActionMenuHandler: (config: WalletActionMenuHandlerConfig) => void;
  getCachedWalletData: (telegramId: bigint) => Promise<WalletBalancesSnapshot>;
  getWalletPageData: (
    telegramId: bigint,
    page: number,
    pageSize: number,
  ) => Promise<{
    solBalance: number;
    tokenBalances: WalletTokenBalance[];
    page: number;
    pageCount: number;
    heldMints: string[];
    complete: boolean;
  }>;
  clearWalletCache: (telegramId: bigint) => void | Promise<void>;
  defaultWalletActionMenuDeps: {
    requireTelegramId: typeof requireTelegramId;
    getWalletAddress: (telegramId: bigint) => string | Promise<string>;
    getWalletBalances: (telegramId: bigint) => Promise<WalletMenuBalances>;
    formatSolBalance: (lamports: number) => string;
    formatTokenBalance: (balance: number, decimals: number) => string;
  };
  showWalletUI: (ctx: any) => Promise<void>;
  __test_setWalletCache: (
    telegramId: bigint | number | string,
    data: WalletSnapshotSeed,
    ttlOverrideMs?: number,
  ) => void;
  __test_getWalletSnapshotCacheKeys: () => string[];
  __test_clearWalletSnapshotCache: () => void;
  __test_getPendingWalletFetchCount: () => number;
  __test_setWalletRpcCacheTtlMs: (value: number) => void;
  __test_resetWalletRpcCacheTtlMs: () => void;
};

export const createWalletMenuModule = (options: WalletMenuModuleOptions): WalletMenuModule => {
  const { bot, wallet, getTokenManager, wrapCallbackHandler, rpcRateLimiter } = options;

  const walletRpcLimiter = rpcRateLimiter.limiter;
  const walletRpcMax = Math.max(1, rpcRateLimiter.maxRequests ?? USER_WALLET_RPC_MAX_CALLS);
  let walletRpcCacheTtlMs = WALLET_RPC_CACHE_TTL_MS;
  const walletSnapshotCache = new Map<
    string,
    { expiresAt: number; snapshot: WalletBalancesSnapshot }
  >();
  const pendingWalletFetches = new Map<string, Promise<WalletBalancesSnapshot>>();
  const cacheInvalidations = new Map<string, number>();

  const testKnownTokenOverrides = new Map<string, WalletBalancesSnapshot["knownTokens"]>();
  const holdMarks = options.holdMarks ?? createHoldMarksDatabaseStore();

  const pruneSoldHoldMarks = async (telegramId: bigint, census: WalletTokenCensus) => {
    try {
      const walletAddress = (await wallet.getKeyPair(telegramId)).publicKey.toBase58();
      pruneHoldMarks(walletAddress, census.heldMints, holdMarks, {
        complete: census.complete,
        scannedMints: census.scannedMints,
      });
    } catch {
      // No keypair yet; marks stay until the next successful wallet fetch.
    }
  };

  const normalizeTelegramId = (value: bigint | number | string): bigint =>
    typeof value === "bigint" ? value : BigInt(value);

  const invalidateWalletSnapshot = (telegramId: bigint) => {
    const cacheKey = getCacheKey(telegramId);
    walletSnapshotCache.delete(cacheKey);
    pendingWalletFetches.delete(cacheKey);
    testKnownTokenOverrides.delete(telegramId.toString());
    cacheInvalidations.set(cacheKey, Date.now());
  };

  wallet.onWalletCacheCleared((telegramId) => {
    invalidateWalletSnapshot(normalizeTelegramId(telegramId));
  });

  const coerceWalletTokenBalances = (
    entries: WalletSnapshotSeed["tokenBalances"],
  ): WalletTokenBalance[] =>
    entries.map((entry) => {
      const rawBalance =
        entry.rawBalance ?? (Number.isFinite(entry.balance) ? String(entry.balance) : "0");

      let lamports: bigint;
      try {
        lamports = BigInt(rawBalance);
      } catch {
        lamports = BigInt(Math.max(0, Math.trunc(entry.balance ?? 0)));
      }

      return {
        mint: entry.mint,
        ticker: entry.ticker,
        balance: entry.balance,
        decimals: entry.decimals,
        rawBalance,
        lamports,
        formattedBalance: entry.formattedBalance ?? String(entry.balance ?? 0),
        decimalBalance: entry.decimalBalance ?? Number(entry.balance ?? 0),
        truncated: entry.truncated ?? false,
      };
    });

  const enforceWalletBudget = (telegramId: bigint) => {
    const result = walletRpcLimiter.consume(telegramId, walletRpcMax);
    if (!result.allowed) {
      const retryAfterMs = result.resetInMs;
      const waitSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      throw new RateLimitExceededError(
        `⏳ Too many wallet refreshes. Try again in ${waitSeconds}s.`,
        retryAfterMs,
      );
    }
  };

  const getCacheKey = (telegramId: bigint) => {
    const rpcEndpoint = wallet.getConnection()?.rpcEndpoint ?? "default";
    return `${telegramId.toString()}:${rpcEndpoint}`;
  };

  const getCachedWalletData = async (telegramId: bigint): Promise<WalletBalancesSnapshot> => {
    const cacheKey = getCacheKey(telegramId);
    const now = Date.now();
    const cachedSnapshot = walletSnapshotCache.get(cacheKey);
    if (cachedSnapshot && cachedSnapshot.expiresAt > now) {
      return cachedSnapshot.snapshot;
    }

    const pending = pendingWalletFetches.get(cacheKey);
    if (pending) {
      return pending;
    }

    const tokenManager = getTokenManager();
    const overrideKey = telegramId.toString();
    const overrideKnownTokens = testKnownTokenOverrides.get(overrideKey);
    const knownTokens =
      overrideKnownTokens ?? (tokenManager ? tokenManager.getAllKnownTokensWithMetadata() : []);

    const staleNative = wallet.peekCachedNativeBalance(telegramId);
    const staleTokens = wallet.peekCachedWalletTokenBalances(telegramId);
    const allowStaleOnError = staleNative !== undefined || (staleTokens?.length ?? 0) > 0;

    const fetchPromise = (async () => {
      const fetchStart = Date.now();
      enforceWalletBudget(telegramId);
      try {
        let tokenCensus: WalletTokenCensus = {
          complete: false,
          heldMints: [],
          scannedMints: [],
        };
        // Independent RPC reads: run them together instead of paying two round trips.
        const [nativeSolBalance, tokenBalances] = await Promise.all([
          wallet.getBalance(telegramId, {
            allowStaleOnError,
          }),
          wallet.getAllWalletTokenBalances(telegramId, knownTokens, {
            allowStaleOnError,
            onCensus: (census) => {
              tokenCensus = census;
            },
          }),
        ]);

        const wsolToken = tokenBalances.find((token) => token.mint === WSOL_MINT);
        const wsolBalance = wsolToken?.balance ?? 0;

        const snapshot: WalletBalancesSnapshot = {
          solBalance: nativeSolBalance,
          nativeSolBalance,
          wsolBalance,
          tokenBalances,
          knownTokens,
        };
        await pruneSoldHoldMarks(telegramId, tokenCensus);
        const invalidatedAt = cacheInvalidations.get(cacheKey) ?? 0;
        if (invalidatedAt < fetchStart) {
          walletSnapshotCache.set(cacheKey, {
            snapshot,
            expiresAt: Date.now() + walletRpcCacheTtlMs,
          });
        }
        return snapshot;
      } catch (error) {
        if (allowStaleOnError) {
          const fallbackNative = wallet.peekCachedNativeBalance(telegramId) ?? staleNative;
          const fallbackTokens = wallet.peekCachedWalletTokenBalances(telegramId) ?? staleTokens;

          if (fallbackNative !== undefined || (fallbackTokens && fallbackTokens.length > 0)) {
            console.warn(
              `⚠️ Falling back to stale wallet cache for user ${telegramId.toString()} due to RPC error:`,
              error,
            );

            const resolvedNative = fallbackNative ?? 0;
            const resolvedTokensSource = fallbackTokens ?? [];
            const resolvedTokens: WalletTokenBalance[] = resolvedTokensSource.map((token) => ({
              ...token,
            }));
            const wsolToken = resolvedTokens.find((token) => token.mint === WSOL_MINT);
            const wsolBalance = wsolToken?.balance ?? 0;

            const snapshot: WalletBalancesSnapshot = {
              solBalance: resolvedNative,
              nativeSolBalance: resolvedNative,
              wsolBalance,
              tokenBalances: resolvedTokens,
              knownTokens,
            };
            const invalidatedAt = cacheInvalidations.get(cacheKey) ?? 0;
            if (invalidatedAt < fetchStart) {
              walletSnapshotCache.set(cacheKey, {
                snapshot,
                expiresAt: Date.now() + walletRpcCacheTtlMs,
              });
            }
            return snapshot;
          }
        }

        throw error;
      }
    })();

    pendingWalletFetches.set(cacheKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      pendingWalletFetches.delete(cacheKey);
    }
  };

  const holdingsFromTokenBalances = (
    tokenBalances: WalletBalancesSnapshot["tokenBalances"],
  ): TokenHolding[] =>
    tokenBalances.map((token) => ({
      mint: token.mint,
      ticker: token.ticker,
      balance: token.decimalBalance,
      decimals: token.decimals,
      rawBalance: token.rawBalance,
    }));

  const clearWalletCache = async (telegramId: bigint) => {
    wallet.clearCachedWalletData(telegramId);
    invalidateWalletSnapshot(telegramId);
    try {
      clearPositionSnapshot((await wallet.getKeyPair(telegramId)).publicKey.toBase58());
    } catch {
      // Wallet may not exist yet; the snapshot is keyed by address when it does.
    }
    console.log(`🗑️ Cleared wallet cache for user: ${telegramId}`);
  };

  const getWalletSnapshotCacheKeys = () => Array.from(walletSnapshotCache.keys());
  const clearWalletSnapshotCache = () => walletSnapshotCache.clear();
  const getPendingWalletFetchCount = () => pendingWalletFetches.size;
  const setWalletRpcCacheTtlMs = (value: number) => {
    walletRpcCacheTtlMs = value;
  };
  const resetWalletRpcCacheTtlMs = () => {
    walletRpcCacheTtlMs = WALLET_RPC_CACHE_TTL_MS;
  };

  const getWalletPageData = async (telegramId: bigint, page: number, pageSize: number) => {
    enforceWalletBudget(telegramId);
    const tokenManager = getTokenManager();
    const knownTokens = tokenManager ? tokenManager.getAllKnownTokensWithMetadata() : [];
    const [solBalance, tokenPage] = await Promise.all([
      wallet.getBalance(telegramId, { allowStaleOnError: true }),
      wallet.getWalletTokenBalancePage(telegramId, knownTokens, page, pageSize),
    ]);
    await pruneSoldHoldMarks(telegramId, {
      complete: tokenPage.complete === true,
      heldMints: tokenPage.heldMints ?? [],
      scannedMints: tokenPage.heldMints ?? [],
    });
    return { solBalance, ...tokenPage };
  };

  const showWalletUI = async (ctx: any) => {
    await showWalletUIHandler(ctx, {
      wallet,
      getCachedWalletData,
      getWalletPageData,
      fetchPricesUSD: getPricesUSD,
      buildWalletCaption,
      createWalletKeyboard,
      WINNER_VIDEO_ID: getStartVideoId(),
      holdMarks,
    });
  };

  const createWalletHandlerDeps = (): WalletHandlersDeps =>
    Object.freeze({
      showWalletUI: (c: any) => showWalletUI(c),
      clearWalletCache: async (id: bigint | string | number) => {
        await clearWalletCache(normalizeTelegramId(id));
      },
      createSettingsKeyboard: () => createWalletSettingsKeyboard(),
    });

  const walletHandlerDeps = createWalletHandlerDeps();

  const registerWalletMenuHandlers = () => {
    bot.callbackQuery("main_wallet", async (ctx) => {
      await onMainWallet(ctx as any, walletHandlerDeps);
    });

    bot.callbackQuery("wallet_refresh", async (ctx) => {
      await onWalletRefresh(ctx as any, walletHandlerDeps);
    });

    bot.callbackQuery(/^wallet_page_\d+$/, async (ctx) => {
      await onMainWallet(ctx as any, walletHandlerDeps);
    });

    bot.callbackQuery("wallet_settings", async (ctx) => {
      await onWalletSettings(ctx as any, walletHandlerDeps);
    });

    const positionDeps = {
      getWalletAddress: async (telegramId: bigint) =>
        (await wallet.getKeyPair(telegramId)).publicKey.toBase58(),
      getHoldings: async (telegramId: bigint) => {
        const { tokenBalances } = await getCachedWalletData(telegramId);
        return holdingsFromTokenBalances(tokenBalances);
      },
      getSwapsByWallet: (walletAddress: string) =>
        TransactionHistory.getInstance().getSwapsByWallet(walletAddress),
      fetchPricesUSD: getPricesUSD,
      getKnownTokens: () => {
        const tokenManager = getTokenManager();
        return tokenManager ? tokenManager.getAllKnownTokensWithMetadata() : [];
      },
      createKeyboard: createPositionsKeyboard,
      refreshCaches: async (telegramId: bigint) => {
        await clearWalletCache(telegramId);
      },
    };

    bot.callbackQuery("wallet_positions", async (ctx) => {
      await onWalletPositions(ctx as any, positionDeps);
    });

    bot.callbackQuery(/^wallet_pos_(?:r_)?\d+$/, async (ctx) => {
      await onWalletPositions(ctx as any, positionDeps);
    });
  };

  const registerCallbackPrefixHandler = createCallbackPrefixRegistrar({
    bot,
    wrapCallbackHandler,
  });

  const defaultWalletActionMenuDeps = {
    requireTelegramId,
    getWalletAddress: async (telegramId: bigint) =>
      (await wallet.getKeyPair(telegramId)).publicKey.toBase58(),
    getWalletBalances: async (telegramId: bigint): Promise<WalletMenuBalances> => {
      const { solBalance, tokenBalances } = await getCachedWalletData(telegramId);
      return { solBalance, tokenBalances };
    },
    formatSolBalance: (lamports: number) => wallet.formatSolBalance(lamports),
    formatTokenBalance: (balance: number, decimals: number) =>
      wallet.formatTokenBalance(balance, decimals),
  } as const;

  const registerWalletActionMenuHandler = ({
    callback,
    logLabel,
    errorAck,
    resolve,
  }: WalletActionMenuHandlerConfig) => {
    bot.callbackQuery(
      callback,
      wrapCallbackHandler(
        async (ctx) => {
          const resolution = await resolve(ctx);
          if (!resolution) {
            return;
          }

          const { menu } = await buildWalletActionMenuForUser(defaultWalletActionMenuDeps, {
            ctx,
            ...resolution.menuOptions,
          });

          await respondWithMenu(ctx, menu);

          if (resolution.successAck) {
            await safeAnswerCallbackQuery(ctx, resolution.successAck);
          }
        },
        { action: logLabel ?? callback, errorAck },
      ),
    );
  };

  const __test_setWalletCache = (
    telegramId: bigint | number | string,
    data: WalletSnapshotSeed,
    ttlOverrideMs?: number,
  ) => {
    const normalizedId = normalizeTelegramId(telegramId);
    const nativeBalance = data.nativeSolBalance ?? data.solBalance;
    const coercedTokenBalances = coerceWalletTokenBalances(data.tokenBalances ?? []);

    wallet.setCachedNativeBalance(normalizedId, nativeBalance, ttlOverrideMs);
    wallet.setCachedWalletTokenBalances(normalizedId, coercedTokenBalances, ttlOverrideMs);

    if (data.knownTokens) {
      testKnownTokenOverrides.set(normalizedId.toString(), data.knownTokens);
    }
  };

  return {
    registerWalletMenuHandlers,
    registerCallbackPrefixHandler,
    registerWalletActionMenuHandler,
    getCachedWalletData,
    getWalletPageData,
    clearWalletCache,
    defaultWalletActionMenuDeps,
    showWalletUI,
    __test_getWalletSnapshotCacheKeys: getWalletSnapshotCacheKeys,
    __test_clearWalletSnapshotCache: clearWalletSnapshotCache,
    __test_getPendingWalletFetchCount: getPendingWalletFetchCount,
    __test_setWalletRpcCacheTtlMs: setWalletRpcCacheTtlMs,
    __test_resetWalletRpcCacheTtlMs: resetWalletRpcCacheTtlMs,
    __test_setWalletCache,
  };
};
