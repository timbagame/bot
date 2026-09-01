import { expect, test } from "bun:test";
import {
  BUY_ALERT_SWAP_FAILED,
  BUY_ALERT_SWAP_TOAST,
  BUY_ALERT_SWAP_UNAVAILABLE,
  buyAlertNeedDmText,
  handleBuyAlertBuy,
  handleBuyAlertDeepLink,
} from "../src/handlers/buy-alert-buy";
import { buyAlertCallbackData } from "../src/services/buy-alerts/keyboard";
import { WSOL_MINT } from "../src/utils/constants";

const TIMBA_MINT = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

const groupCtx = (data: string, userId = 42) => {
  const replies: unknown[] = [];
  return {
    replies,
    from: { id: userId },
    chat: { id: -100, type: "supergroup" as const },
    me: { username: "timbabot" },
    callbackQuery: { id: "cb1", data },
    reply: async (text: string) => {
      replies.push(text);
      throw new Error("must not reply in the group");
    },
  };
};

test("opens the existing private Swap and toasts without a tap-OK popup", async () => {
  const ctx = groupCtx(buyAlertCallbackData(TIMBA_MINT));
  const acks: Array<{ text?: string; showAlert?: boolean }> = [];
  const opened: Array<{ userId: number; mint: string; ticker: string; decimals: number }> = [];

  await handleBuyAlertBuy(ctx as never, {
    resolveSwapToken: async (mint) => ({
      token_mint: mint,
      token_ticker: "TIMBA",
      decimals: 6,
    }),
    openPrivateSwap: async (args) => {
      opened.push(args);
    },
    ack: async (_ctx, text, showAlert) => {
      acks.push({ text, showAlert });
    },
  });

  expect(opened).toEqual([{ userId: 42, mint: TIMBA_MINT, ticker: "TIMBA", decimals: 6 }]);
  expect(acks).toEqual([{ text: BUY_ALERT_SWAP_TOAST, showAlert: false }]);
  expect(ctx.replies).toEqual([]);
});

test("asks the user to Start when Telegram forbids initiation", async () => {
  const ctx = groupCtx(buyAlertCallbackData(TIMBA_MINT));
  const acks: Array<{ text?: string; showAlert?: boolean }> = [];

  await handleBuyAlertBuy(ctx as never, {
    resolveSwapToken: async (mint) => ({
      token_mint: mint,
      token_ticker: "TIMBA",
      decimals: 6,
    }),
    openPrivateSwap: async () => {
      throw {
        error_code: 403,
        description: "Forbidden: bot can't initiate conversation with a user",
      };
    },
    ack: async (_ctx, text, showAlert) => {
      acks.push({ text, showAlert });
    },
  });

  expect(acks).toEqual([{ text: buyAlertNeedDmText("timbabot"), showAlert: true }]);
  expect(ctx.replies).toEqual([]);
});

test("does not open SOL to SOL", async () => {
  const ctx = groupCtx(buyAlertCallbackData(WSOL_MINT));
  const opened: unknown[] = [];
  const acks: Array<{ text?: string; showAlert?: boolean }> = [];

  await handleBuyAlertBuy(ctx as never, {
    resolveSwapToken: async () => {
      throw new Error("must not resolve WSOL");
    },
    openPrivateSwap: async (args) => {
      opened.push(args);
    },
    ack: async (_ctx, text, showAlert) => {
      acks.push({ text, showAlert });
    },
  });

  expect(opened).toEqual([]);
  expect(acks).toEqual([{ text: BUY_ALERT_SWAP_UNAVAILABLE, showAlert: true }]);
});

test("rejects junk callback data", async () => {
  const ctx = groupCtx("buy_alert_not-a-mint");
  const acks: Array<{ text?: string; showAlert?: boolean }> = [];

  await handleBuyAlertBuy(ctx as never, {
    resolveSwapToken: async () => {
      throw new Error("must not resolve");
    },
    openPrivateSwap: async () => {
      throw new Error("must not open");
    },
    ack: async (_ctx, text, showAlert) => {
      acks.push({ text, showAlert });
    },
  });

  expect(acks).toEqual([{ text: BUY_ALERT_SWAP_FAILED, showAlert: true }]);
});

test("does not treat an SPL ticker named SOL as native SOL", async () => {
  const ctx = groupCtx(buyAlertCallbackData(TIMBA_MINT));
  const opened: Array<{ mint: string; ticker: string }> = [];

  await handleBuyAlertBuy(ctx as never, {
    resolveSwapToken: async (mint) => ({
      token_mint: mint,
      token_ticker: "SOL",
      decimals: 6,
    }),
    openPrivateSwap: async (args) => {
      opened.push({ mint: args.mint, ticker: args.ticker });
    },
    ack: async () => {},
  });

  expect(opened).toEqual([{ mint: TIMBA_MINT, ticker: "SOL" }]);
});

test("failed token lookup does not open Swap", async () => {
  const ctx = groupCtx(buyAlertCallbackData(TIMBA_MINT));
  const opened: unknown[] = [];
  const acks: Array<{ text?: string; showAlert?: boolean }> = [];

  await handleBuyAlertBuy(ctx as never, {
    resolveSwapToken: async () => {
      throw new Error("metadata HTTP 500");
    },
    openPrivateSwap: async (args) => {
      opened.push(args);
    },
    ack: async (_ctx, text, showAlert) => {
      acks.push({ text, showAlert });
    },
  });

  expect(opened).toEqual([]);
  expect(acks).toEqual([{ text: BUY_ALERT_SWAP_FAILED, showAlert: true }]);
  expect(ctx.replies).toEqual([]);
});

test("unknown token is unavailable instead of a fake venue", async () => {
  const ctx = groupCtx(buyAlertCallbackData(TIMBA_MINT));
  const opened: unknown[] = [];
  const acks: Array<{ text?: string; showAlert?: boolean }> = [];

  await handleBuyAlertBuy(ctx as never, {
    resolveSwapToken: async () => null,
    openPrivateSwap: async (args) => {
      opened.push(args);
    },
    ack: async (_ctx, text, showAlert) => {
      acks.push({ text, showAlert });
    },
  });

  expect(opened).toEqual([]);
  expect(acks).toEqual([{ text: BUY_ALERT_SWAP_UNAVAILABLE, showAlert: true }]);
});

test("opens Swap with the resolved mint, not the callback string", async () => {
  const ctx = groupCtx(buyAlertCallbackData(TIMBA_MINT));
  const opened: Array<{ mint: string }> = [];

  await handleBuyAlertBuy(ctx as never, {
    resolveSwapToken: async () => ({
      token_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      token_ticker: "USDC",
      decimals: 6,
    }),
    openPrivateSwap: async (args) => {
      opened.push({ mint: args.mint });
    },
    ack: async () => {},
  });

  expect(opened).toEqual([{ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }]);
});

test("deep link opens Swap in the current private chat", async () => {
  const opened: Array<{ mint: string; ticker: string; decimals: number }> = [];
  const errors: string[] = [];

  await handleBuyAlertDeepLink(TIMBA_MINT, {
    resolveSwapToken: async (mint) => ({
      token_mint: mint,
      token_ticker: "MAGAIBA",
      decimals: 6,
    }),
    openSwap: async (args) => {
      opened.push(args);
    },
    replyError: async (text) => {
      errors.push(text);
    },
  });

  expect(opened).toEqual([{ mint: TIMBA_MINT, ticker: "MAGAIBA", decimals: 6 }]);
  expect(errors).toEqual([]);
});

test("deep link refuses WSOL and a failed lookup", async () => {
  const errors: string[] = [];
  const opened: unknown[] = [];
  const deps = {
    openSwap: async (args: { mint: string }) => {
      opened.push(args);
    },
    replyError: async (text: string) => {
      errors.push(text);
    },
  };

  await handleBuyAlertDeepLink(WSOL_MINT, {
    ...deps,
    resolveSwapToken: async () => {
      throw new Error("must not resolve WSOL");
    },
  });

  await handleBuyAlertDeepLink(TIMBA_MINT, {
    ...deps,
    resolveSwapToken: async () => null,
  });

  await handleBuyAlertDeepLink(TIMBA_MINT, {
    ...deps,
    resolveSwapToken: async () => {
      throw new Error("timeout");
    },
  });

  expect(opened).toEqual([]);
  expect(errors).toEqual([
    BUY_ALERT_SWAP_UNAVAILABLE,
    BUY_ALERT_SWAP_UNAVAILABLE,
    BUY_ALERT_SWAP_FAILED,
  ]);
});
