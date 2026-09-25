import { afterEach, expect, test } from "bun:test";
import { InlineKeyboard } from "grammy";
import { WSOL_MINT } from "../src/utils/constants";
import {
  loadWalletPositions,
  onWalletPositions,
  type WalletPositionsDeps,
} from "../src/handlers/wallet-positions";
import { clearPositionSnapshot } from "../src/services/positions";
import type { SwapStatRecord } from "../src/utils/transaction-history";

afterEach(() => {
  clearPositionSnapshot();
});

const TIMBA = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";
const MAGAIBA = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";
const TOKEN_C = "C1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_D = "D1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const createCtx = (data = "wallet_positions", fromId: number | undefined = 42) => {
  const menus: Array<{ text: string; options?: any }> = [];
  const answers: string[] = [];
  const ctx: any = {
    from: fromId === undefined ? undefined : { id: fromId },
    chat: { id: 99, type: "private" },
    callbackQuery: { data, message: { message_id: 7, chat: { id: 99 } } },
    editMessageText: async (text: string, options?: any) => {
      menus.push({ text, options });
      return {};
    },
    answerCallbackQuery: async (text?: string) => {
      if (text) answers.push(text);
    },
  };
  return { ctx, menus, answers };
};

const buy = (
  outputMint: string,
  outputTicker: string,
  amountOut: string,
  timestamp: number,
): SwapStatRecord => ({
  signature: `buy-${outputTicker}-${timestamp}`,
  wallet: "wallet-1",
  input_mint: WSOL_MINT,
  output_mint: outputMint,
  input_ticker: "SOL",
  output_ticker: outputTicker,
  amount_in: "1000000000",
  amount_out: amountOut,
  referral_applied: false,
  timestamp,
});

const baseDeps = (overrides: Partial<WalletPositionsDeps> = {}): WalletPositionsDeps => ({
  getWalletAddress: () => "wallet-1",
  getHoldings: async () => [{ mint: TIMBA, ticker: "TIMBA", balance: 10, decimals: 6 }],
  getSwapsByWallet: () => [],
  fetchPricesUSD: async () => ({ [WSOL_MINT]: 100, [TIMBA]: 1 }),
  createKeyboard: () => new InlineKeyboard(),
  ...overrides,
});

test("onWalletPositions shows an empty state when there are no bot buys", async () => {
  const { ctx, menus } = createCtx();
  await onWalletPositions(ctx, baseDeps());

  expect(menus[0]?.text).toContain("No tracked positions yet");
  expect(menus[0]?.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe(
    "wallet_pos_r_0",
  );
});

test("onWalletPositions refresh from empty clears caches", async () => {
  const { ctx } = createCtx("wallet_pos_r_0");
  const refreshed: bigint[] = [];
  await onWalletPositions(
    ctx,
    baseDeps({
      refreshCaches: (telegramId) => {
        refreshed.push(telegramId);
      },
    }),
  );
  expect(refreshed).toEqual([42n]);
});

test("onWalletPositions renders tracked tokens on one page when there are few", async () => {
  const { ctx, menus } = createCtx("wallet_positions");

  await onWalletPositions(
    ctx,
    baseDeps({
      getHoldings: async () => [
        { mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6 },
        { mint: MAGAIBA, ticker: "MAGAIBA", balance: 50, decimals: 8 },
      ],
      getSwapsByWallet: () => [
        buy(TIMBA, "TIMBA", "100000000", 1),
        buy(MAGAIBA, "MAGAIBA", "5000000000", 2),
      ],
      fetchPricesUSD: async () => ({ [WSOL_MINT]: 100, [TIMBA]: 1.2, [MAGAIBA]: 0.8 }),
      createKeyboard: ({ page, pageCount }) =>
        new InlineKeyboard().text(`${page + 1}/${pageCount}`, "noop"),
    }),
  );

  expect(menus[0]?.text).toContain("TIMBA");
  expect(menus[0]?.text).toContain("MAGAIBA");
  expect(menus[0]?.text).toContain("Avg entry");
  expect(menus[0]?.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.text).toBe("1/1");
});

test("onWalletPositions shows the second page of four tracked tokens", async () => {
  const { ctx, menus } = createCtx("wallet_pos_1");
  const pages: Array<{ page: number; pageCount: number }> = [];

  await onWalletPositions(
    ctx,
    baseDeps({
      getHoldings: async () => [
        { mint: TIMBA, ticker: "TIMBA", balance: 40, decimals: 6 },
        { mint: MAGAIBA, ticker: "MAGAIBA", balance: 30, decimals: 8 },
        { mint: TOKEN_C, ticker: "CCC", balance: 20, decimals: 6 },
        { mint: TOKEN_D, ticker: "DDD", balance: 10, decimals: 6 },
      ],
      getSwapsByWallet: () => [
        buy(TIMBA, "TIMBA", "40000000", 1),
        buy(MAGAIBA, "MAGAIBA", "3000000000", 2),
        buy(TOKEN_C, "CCC", "20000000", 3),
        buy(TOKEN_D, "DDD", "10000000", 4),
      ],
      fetchPricesUSD: async () => ({
        [WSOL_MINT]: 100,
        [TIMBA]: 1,
        [MAGAIBA]: 1,
        [TOKEN_C]: 1,
        [TOKEN_D]: 1,
      }),
      createKeyboard: ({ page, pageCount }) => {
        pages.push({ page, pageCount });
        return new InlineKeyboard().text(`${page + 1}/${pageCount}`, "noop");
      },
    }),
  );

  expect(pages[0]).toEqual({ page: 1, pageCount: 2 });
  expect(menus[0]?.text).toContain("📊 Positions (2/2)");
  expect(menus[0]?.text).toContain("DDD");
  expect(menus[0]?.text).not.toContain("📊 TIMBA");
});

test("onWalletPositions clamps an out-of-range page to the last page", async () => {
  const { ctx, menus } = createCtx("wallet_pos_99");
  const pages: Array<{ page: number; pageCount: number }> = [];

  await onWalletPositions(
    ctx,
    baseDeps({
      getHoldings: async () => [
        { mint: TIMBA, ticker: "TIMBA", balance: 40, decimals: 6 },
        { mint: MAGAIBA, ticker: "MAGAIBA", balance: 30, decimals: 8 },
        { mint: TOKEN_C, ticker: "CCC", balance: 20, decimals: 6 },
        { mint: TOKEN_D, ticker: "DDD", balance: 10, decimals: 6 },
      ],
      getSwapsByWallet: () => [
        buy(TIMBA, "TIMBA", "40000000", 1),
        buy(MAGAIBA, "MAGAIBA", "3000000000", 2),
        buy(TOKEN_C, "CCC", "20000000", 3),
        buy(TOKEN_D, "DDD", "10000000", 4),
      ],
      fetchPricesUSD: async () => ({
        [WSOL_MINT]: 100,
        [TIMBA]: 1,
        [MAGAIBA]: 1,
        [TOKEN_C]: 1,
        [TOKEN_D]: 1,
      }),
      createKeyboard: ({ page, pageCount }) => {
        pages.push({ page, pageCount });
        return new InlineKeyboard();
      },
    }),
  );

  expect(pages[0]).toEqual({ page: 1, pageCount: 2 });
  expect(menus[0]?.text).toContain("DDD");
});

test("onWalletPositions refresh clears caches and stays on the same page", async () => {
  const { ctx, menus } = createCtx("wallet_pos_r_1");
  const refreshed: bigint[] = [];
  const pages: Array<{ page: number; pageCount: number }> = [];

  await onWalletPositions(
    ctx,
    baseDeps({
      getHoldings: async () => [
        { mint: TIMBA, ticker: "TIMBA", balance: 40, decimals: 6 },
        { mint: MAGAIBA, ticker: "MAGAIBA", balance: 30, decimals: 8 },
        { mint: TOKEN_C, ticker: "CCC", balance: 20, decimals: 6 },
        { mint: TOKEN_D, ticker: "DDD", balance: 10, decimals: 6 },
      ],
      getSwapsByWallet: () => [
        buy(TIMBA, "TIMBA", "40000000", 1),
        buy(MAGAIBA, "MAGAIBA", "3000000000", 2),
        buy(TOKEN_C, "CCC", "20000000", 3),
        buy(TOKEN_D, "DDD", "10000000", 4),
      ],
      fetchPricesUSD: async () => ({
        [WSOL_MINT]: 100,
        [TIMBA]: 1,
        [MAGAIBA]: 1,
        [TOKEN_C]: 1,
        [TOKEN_D]: 1,
      }),
      createKeyboard: ({ page, pageCount }) => {
        pages.push({ page, pageCount });
        return new InlineKeyboard();
      },
      refreshCaches: (telegramId) => {
        refreshed.push(telegramId);
      },
    }),
  );

  expect(refreshed).toEqual([42n]);
  expect(pages[0]).toEqual({ page: 1, pageCount: 2 });
  expect(menus[0]?.text).toContain("DDD");
});

test("onWalletPositions rejects a missing telegram user", async () => {
  const { ctx, menus, answers } = createCtx("wallet_positions", 0);
  await onWalletPositions(ctx, baseDeps());

  expect(menus).toEqual([]);
  expect(answers).toContain("❌ Could not load positions");
});

test("loadWalletPositions reuses the snapshot so /start and Positions share one price fetch", async () => {
  let priceCalls = 0;
  const deps = baseDeps({
    getHoldings: async () => [{ mint: TIMBA, ticker: "TIMBA", balance: 10, decimals: 6 }],
    getSwapsByWallet: () => [buy(TIMBA, "TIMBA", "10000000", 1)],
    fetchPricesUSD: async () => {
      priceCalls += 1;
      return { [WSOL_MINT]: 100, [TIMBA]: 1 };
    },
  });

  const first = await loadWalletPositions(42n, deps);
  const second = await loadWalletPositions(42n, deps);

  expect(priceCalls).toBe(1);
  expect(second).toEqual(first);
  expect(first[0]?.ticker).toBe("TIMBA");
});

test("onWalletPositions reports an error when prices fail", async () => {
  const { ctx, menus, answers } = createCtx();
  await onWalletPositions(
    ctx,
    baseDeps({
      getHoldings: async () => [{ mint: TIMBA, ticker: "TIMBA", balance: 10, decimals: 6 }],
      getSwapsByWallet: () => [buy(TIMBA, "TIMBA", "10000000", 1)],
      fetchPricesUSD: async () => {
        throw new Error("prices down");
      },
    }),
  );

  expect(menus).toEqual([]);
  expect(answers).toContain("❌ Error loading positions");
});
