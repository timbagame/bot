import type { Bot } from "grammy";

import { WSOL_MINT, getStartVideoId, USER_WALLET_RPC_MAX_CALLS } from "../utils/constants";
import {
  buildWalletCaption,
  buildWalletActionMenuForUser,
  type BuildWalletActionMenuForUserOptions,
  type WalletMenuBalances,
} from "../utils/wallet-ui";
import { createWalletKeyboard, createWalletSettingsKeyboard } from "../utils/keyboards";
import { getPricesUSD } from "../utils/prices";
import { respondWithMenu } from "../utils/menu-response";
import { safeAnswerCallbackQuery, requireTelegramId } from "../utils/context-helpers";
import type {
  WalletManager,
  WalletBalancesSnapshot,
  ApprovedTokenBalance,
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
import {
  RateLimitExceededError,
  SlidingWindowRateLimiter,
} from "../utils/rate-limiter";


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
    Partial<ApprovedTokenBalance> & {
      mint: string;
      ticker: string;
      balance: number;
      decimals: number;
      rawBalance?: string;
    }
  >;
  approvedTokens?: WalletBalancesSnapshot["approvedTokens"];
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
};

type WalletMenuModule = {
  registerWalletMenuHandlers: () => void;
  registerCallbackPrefixHandler: RegisterCallbackPrefixHandler;
  registerWalletActionMenuHandler: (
    config: WalletActionMenuHandlerConfig
  ) => void;
  getCachedWalletData: (telegramId: bigint) => Promise<WalletBalancesSnapshot>;
  clearWalletCache: (telegramId: bigint) => void;
  defaultWalletActionMenuDeps: {
    requireTelegramId: typeof requireTelegramId;
    getWalletAddress: (telegramId: bigint) => string;
    getWalletBalances: (
      telegramId: bigint
    ) => Promise<WalletMenuBalances>;
    formatSolBalance: (lamports: number) => string;
    formatTokenBalance: (balance: number, decimals: number) => string;
  };
  showWalletUI: (ctx: any) => Promise<void>;
  __test_setWalletCache: (
    telegramId: bigint | number | string,
    data: WalletSnapshotSeed,
    ttlOverrideMs?: number
  ) => void;
};

export const createWalletMenuModule = (
  options: WalletMenuModuleOptions
): WalletMenuModule => {
  const { bot, wallet, getTokenManager, wrapCallbackHandler, rpcRateLimiter } =
    options;

  const walletRpcLimiter = rpcRateLimiter.limiter;
  const walletRpcMax = Math.max(
    1,
    rpcRateLimiter.maxRequests ?? USER_WALLET_RPC_MAX_CALLS
  );

  const testApprovedTokenOverrides = new Map<
    string,
    WalletBalancesSnapshot["approvedTokens"]
  >();

  const normalizeTelegramId = (
    value: bigint | number | string
  ): bigint => (typeof value === "bigint" ? value : BigInt(value));

  const coerceApprovedTokenBalances = (
    entries: WalletSnapshotSeed["tokenBalances"]
  ): ApprovedTokenBalance[] =>
    entries.map((entry) => {
      const rawBalance =
        entry.rawBalance ??
        (Number.isFinite(entry.balance) ? String(entry.balance) : "0");

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
        formattedBalance:
          entry.formattedBalance ?? String(entry.balance ?? 0),
        decimalBalance:
          entry.decimalBalance ?? Number(entry.balance ?? 0),
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
        retryAfterMs
      );
    }
  };

  const getCachedWalletData = async (
    telegramId: bigint
  ): Promise<WalletBalancesSnapshot> => {
    enforceWalletBudget(telegramId);

    const tokenManager = getTokenManager();
    const overrideKey = telegramId.toString();
    const overrideApprovedTokens =
      testApprovedTokenOverrides.get(overrideKey);
    const approvedTokens =
      overrideApprovedTokens ??
      (tokenManager
        ? tokenManager.getAllApprovedTokensWithMetadata()
        : []);

    const staleNative = wallet.peekCachedNativeBalance(telegramId);
    const staleTokens = wallet.peekCachedApprovedTokenBalances(telegramId);
    const allowStaleOnError =
      staleNative !== undefined || (staleTokens?.length ?? 0) > 0;

    try {
      const nativeSolBalance = await wallet.getBalance(telegramId, {
        allowStaleOnError,
      });
      const tokenBalances = await wallet.getAllApprovedTokenBalances(
        telegramId,
        approvedTokens,
        { allowStaleOnError }
      );

      const wsolToken = tokenBalances.find((token) => token.mint === WSOL_MINT);
      const wsolBalance = wsolToken?.balance ?? 0;

      return {
        solBalance: nativeSolBalance,
        nativeSolBalance,
        wsolBalance,
        tokenBalances,
        approvedTokens,
      };
    } catch (error) {
      if (allowStaleOnError) {
        const fallbackNative =
          wallet.peekCachedNativeBalance(telegramId) ?? staleNative;
        const fallbackTokens =
          wallet.peekCachedApprovedTokenBalances(telegramId) ?? staleTokens;

        if (
          fallbackNative !== undefined ||
          (fallbackTokens && fallbackTokens.length > 0)
        ) {
          console.warn(
            `⚠️ Falling back to stale wallet cache for user ${telegramId.toString()} due to RPC error:`,
            error
          );

          const resolvedNative = fallbackNative ?? 0;
          const resolvedTokensSource = fallbackTokens ?? [];
          const resolvedTokens: ApprovedTokenBalance[] =
            resolvedTokensSource.map((token) => ({ ...token }));
          const wsolToken = resolvedTokens.find(
            (token) => token.mint === WSOL_MINT
          );
          const wsolBalance = wsolToken?.balance ?? 0;

          return {
            solBalance: resolvedNative,
            nativeSolBalance: resolvedNative,
            wsolBalance,
            tokenBalances: resolvedTokens,
            approvedTokens,
          };
        }
      }

      throw error;
    }
  };

  const clearWalletCache = (telegramId: bigint) => {
    wallet.clearCachedWalletData(telegramId);
    testApprovedTokenOverrides.delete(telegramId.toString());
    console.log(`🗑️ Cleared wallet cache for user: ${telegramId}`);
  };

  const showWalletUI = async (ctx: any) => {
    await showWalletUIHandler(ctx, {
      wallet,
      getCachedWalletData,
      fetchPricesUSD: getPricesUSD,
      buildWalletCaption,
      createWalletKeyboard,
      WINNER_VIDEO_ID: getStartVideoId(),
    });
  };

  const createWalletHandlerDeps = (): WalletHandlersDeps =>
    Object.freeze({
      showWalletUI: (c: any) => showWalletUI(c),
      clearWalletCache: (id: bigint | string | number) => {
        clearWalletCache(normalizeTelegramId(id));
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

    bot.callbackQuery("wallet_settings", async (ctx) => {
      await onWalletSettings(ctx as any, walletHandlerDeps);
    });
  };

  const registerCallbackPrefixHandler = createCallbackPrefixRegistrar({
    bot,
    wrapCallbackHandler,
  });

  const defaultWalletActionMenuDeps = {
    requireTelegramId,
    getWalletAddress: (telegramId: bigint) =>
      wallet.getKeyPair(telegramId).publicKey.toBase58(),
    getWalletBalances: async (
      telegramId: bigint
    ): Promise<WalletMenuBalances> => {
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

          const { menu } = await buildWalletActionMenuForUser(
            defaultWalletActionMenuDeps,
            {
              ctx,
              ...resolution.menuOptions,
            }
          );

          await respondWithMenu(ctx, menu);

          if (resolution.successAck) {
            await safeAnswerCallbackQuery(ctx, resolution.successAck);
          }
        },
        { action: logLabel ?? callback, errorAck }
      )
    );
  };

  const __test_setWalletCache = (
    telegramId: bigint | number | string,
    data: WalletSnapshotSeed,
    ttlOverrideMs?: number
  ) => {
    const normalizedId = normalizeTelegramId(telegramId);
    const nativeBalance = data.nativeSolBalance ?? data.solBalance;
    const coercedTokenBalances = coerceApprovedTokenBalances(
      data.tokenBalances ?? []
    );

    wallet.setCachedNativeBalance(normalizedId, nativeBalance, ttlOverrideMs);
    wallet.setCachedApprovedTokenBalances(
      normalizedId,
      coercedTokenBalances,
      ttlOverrideMs
    );

    if (data.approvedTokens) {
      testApprovedTokenOverrides.set(
        normalizedId.toString(),
        data.approvedTokens
      );
    }
  };

  return {
    registerWalletMenuHandlers,
    registerCallbackPrefixHandler,
    registerWalletActionMenuHandler,
    getCachedWalletData,
    clearWalletCache,
    defaultWalletActionMenuDeps,
    showWalletUI,
    __test_setWalletCache,
  };
};
