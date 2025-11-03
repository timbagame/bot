import type { Bot } from "grammy";

import { createExpiringCache } from "../utils/expiring-cache";
import { mergeWsolIntoSol } from "../utils/balance";
import { WSOL_MINT, getStartVideoId } from "../utils/constants";
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
import type { WalletManager } from "../utils/wallet";
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

type CachedWalletData = {
  solBalance: number;
  nativeSolBalance: number;
  wsolBalance: number;
  tokenBalances: Array<{
    mint: string;
    ticker: string;
    balance: number;
    decimals: number;
    rawBalance: string;
  }>;
  approvedTokens: any[];
};

export type WalletCacheSnapshot = CachedWalletData;

type WalletMenuModuleOptions = {
  bot: Bot;
  wallet: WalletManager;
  getTokenManager: () => TokenManager | undefined;
  wrapCallbackHandler: WrapCallbackHandler;
};

type WalletMenuModule = {
  registerWalletMenuHandlers: () => void;
  registerCallbackPrefixHandler: RegisterCallbackPrefixHandler;
  registerWalletActionMenuHandler: (
    config: WalletActionMenuHandlerConfig
  ) => void;
  getCachedWalletData: (telegramId: bigint) => Promise<CachedWalletData>;
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
    data: {
      solBalance: number;
      tokenBalances: Array<{
        mint: string;
        ticker: string;
        balance: number;
        decimals: number;
        rawBalance: string;
      }>;
      approvedTokens?: any[];
      nativeSolBalance?: number;
      wsolBalance?: number;
    },
    _ts?: number
  ) => void;
};

export const createWalletMenuModule = (
  options: WalletMenuModuleOptions
): WalletMenuModule => {
  const { bot, wallet, getTokenManager, wrapCallbackHandler } = options;

  const walletDataCache = createExpiringCache<CachedWalletData>(30 * 1000);

  const getWalletCacheKey = (
    telegramId: bigint | number | string
  ): string => String(telegramId);

  const getCachedWalletData = async (
    telegramId: bigint
  ): Promise<CachedWalletData> => {
    const cacheKey = getWalletCacheKey(telegramId);
    const stale = walletDataCache.peek(cacheKey);
    const cached = walletDataCache.get(cacheKey);

    if (cached) {
      console.log("📦 Using cached wallet data for user:", telegramId.toString());
      return cached;
    }

    console.log("🔄 Fetching fresh wallet data for user:", telegramId.toString());

    const tokenManager = getTokenManager();

    try {
      let solBalance = await wallet.getBalance(telegramId);
      const nativeSolBalance = solBalance;
      const approvedTokens = tokenManager
        ? tokenManager.getAllApprovedTokensWithMetadata()
        : [];
      let tokenBalances = await wallet.getAllApprovedTokenBalances(
        telegramId,
        approvedTokens
      );

      const wsolToken = tokenBalances.find((token) => token.mint === WSOL_MINT);
      const wsolBalance = wsolToken?.balance ?? 0;

      const merged = mergeWsolIntoSol(solBalance, tokenBalances, WSOL_MINT);
      solBalance = merged.solLamports;
      tokenBalances = merged.tokenBalances as typeof tokenBalances;

      const data: CachedWalletData = {
        solBalance,
        nativeSolBalance,
        wsolBalance,
        tokenBalances,
        approvedTokens,
      };

      walletDataCache.setWithTTL(cacheKey, data);

      return data;
    } catch (error) {
      console.error("Error fetching wallet data:", error);
      if (stale) {
        console.log("⚠️ Using expired cache due to RPC error");
        return stale;
      }
      throw error;
    }
  };

  const clearWalletCache = (telegramId: bigint) => {
    const cacheKey = getWalletCacheKey(telegramId);
    walletDataCache.delete(cacheKey);
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
        const normalized =
          typeof id === "bigint" ? id : BigInt(id as string | number);
        clearWalletCache(normalized);
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
    data: {
      solBalance: number;
      tokenBalances: Array<{
        mint: string;
        ticker: string;
        balance: number;
        decimals: number;
        rawBalance: string;
      }>;
      approvedTokens?: any[];
      nativeSolBalance?: number;
      wsolBalance?: number;
    }
  ) => {
    const cacheKey = getWalletCacheKey(telegramId);
    walletDataCache.setWithTTL(cacheKey, {
      solBalance: data.solBalance,
      nativeSolBalance: data.nativeSolBalance ?? data.solBalance,
      wsolBalance: data.wsolBalance ?? 0,
      tokenBalances: data.tokenBalances,
      approvedTokens: data.approvedTokens ?? [],
    });
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

export type { CachedWalletData };
