import { expect, test } from "bun:test";
import { InlineKeyboard } from "grammy";
import { WSOL_MINT } from "../src/utils/constants";
import { onWalletPositions } from "../src/handlers/wallet-positions";

const TIMBA = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

const createCtx = (data = "wallet_positions") => {
  const menus: Array<{ text: string; options?: any }> = [];
  const answers: string[] = [];
  const ctx: any = {
    from: { id: 42 },
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

test("onWalletPositions shows an empty state when there are no bot buys", async () => {
  const { ctx, menus } = createCtx();
  await onWalletPositions(ctx, {
    getWalletAddress: () => "wallet-1",
    getHoldings: async () => [{ mint: TIMBA, ticker: "TIMBA", balance: 10, decimals: 6 }],
    getSwapsByWallet: () => [],
    fetchPricesUSD: async () => ({ [WSOL_MINT]: 100, [TIMBA]: 1 }),
    createKeyboard: () => new InlineKeyboard(),
  });

  expect(menus[0]?.text).toContain("No tracked positions yet");
});

test("onWalletPositions renders a tracked token and pages by index", async () => {
  const magaiba = "A6rSPi9JmJgVkW6BatsA6MjFYLseizPM2Fnt92coFjf4";
  const { ctx, menus } = createCtx("wallet_pos_1");

  await onWalletPositions(ctx, {
    getWalletAddress: () => "wallet-1",
    getHoldings: async () => [
      { mint: TIMBA, ticker: "TIMBA", balance: 100, decimals: 6 },
      { mint: magaiba, ticker: "MAGAIBA", balance: 50, decimals: 8 },
    ],
    getSwapsByWallet: () => [
      {
        signature: "b1",
        wallet: "wallet-1",
        input_mint: WSOL_MINT,
        output_mint: TIMBA,
        input_ticker: "SOL",
        output_ticker: "TIMBA",
        amount_in: "1000000000",
        amount_out: "100000000",
        referral_applied: false,
        timestamp: 1,
      },
      {
        signature: "b2",
        wallet: "wallet-1",
        input_mint: WSOL_MINT,
        output_mint: magaiba,
        input_ticker: "SOL",
        output_ticker: "MAGAIBA",
        amount_in: "500000000",
        amount_out: "5000000000",
        referral_applied: false,
        timestamp: 2,
      },
    ],
    fetchPricesUSD: async () => ({ [WSOL_MINT]: 100, [TIMBA]: 1.2, [magaiba]: 0.8 }),
    createKeyboard: ({ index, count }) =>
      new InlineKeyboard().text(`${index + 1}/${count}`, "noop"),
  });

  expect(menus[0]?.text).toContain("MAGAIBA · 2/2");
  expect(menus[0]?.text).toContain("Avg entry");
});
