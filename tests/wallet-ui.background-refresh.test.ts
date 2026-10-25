import "./setup-env";
import { describe, expect, test } from "bun:test";
import { InlineKeyboard } from "grammy";
import { WALLET_BACKGROUND_REFRESH_MIN_AGE_MS, showWalletUI } from "../src/handlers/wallet";
import { buildWalletCaption } from "../src/utils/wallet-ui";

const ADDRESS = "WALLETADDR11111111111111111111111111111111";
const NOW = 7_000_000;

const page = (solBalance: number) => ({
  solBalance,
  tokenBalances: [],
  page: 0,
  pageCount: 1,
  fetchedAt: NOW,
});

describe("wallet background refresh without a message target", () => {
  test("fetches fresh balances but edits nothing when the sent message cannot be identified", async () => {
    const calls: any[] = [];
    let fetches = 0;
    let captureCalls = 0;
    const ctx: any = {
      from: { id: 1 },
      chat: { id: 99, type: "private" },
      // The reply result carries no message id or chat, and there is no callback message.
      reply: async (...args: any[]) => {
        calls.push(["reply", ...args]);
        return {};
      },
      editMessageText: async (...args: any[]) => {
        calls.push(["ctxEditText", ...args]);
        return true;
      },
      api: {
        editMessageText: async (...args: any[]) => {
          calls.push(["apiEditText", ...args]);
          return true;
        },
        editMessageCaption: async (...args: any[]) => {
          calls.push(["apiEditCaption", ...args]);
          return true;
        },
      },
    };

    await showWalletUI(ctx, {
      wallet: {
        getKeyPair: () => ({ publicKey: { toBase58: () => ADDRESS } }),
        formatSolBalance: (lamports: number) => (lamports / 1e9).toFixed(4),
      },
      getCachedWalletData: async () => {
        throw new Error("not used");
      },
      getWalletPageData: async () => {
        fetches += 1;
        return page(2e9);
      },
      peekWalletPageData: () => ({
        data: page(1e9),
        fetchedAt: NOW - WALLET_BACKGROUND_REFRESH_MIN_AGE_MS - 1_000,
      }),
      captureMessageView: () => {
        captureCalls += 1;
        return () => true;
      },
      fetchPricesUSD: async () => ({}),
      buildWalletCaption: (address, lines, options) =>
        buildWalletCaption(address, lines, { ...options, explorerUrl: null }),
      createWalletKeyboard: () => new InlineKeyboard().text("🔄 Refresh", "wallet_refresh"),
      WINNER_VIDEO_ID: null,
      now: () => NOW,
    });
    await ctx.__walletBackgroundRefresh;

    expect(fetches).toBe(1);
    expect(captureCalls).toBe(0);
    expect(calls.filter(([kind]) => kind === "reply")).toHaveLength(1);
    expect(calls.filter(([kind]) => kind !== "reply")).toEqual([]);
  });
});
