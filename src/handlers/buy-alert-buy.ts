import type { Context } from "grammy";
import { WSOL_MINT } from "../utils/constants";
import { isBotInitiationForbidden } from "../utils/telegram-errors";
import { parseBuyAlertMint } from "../services/buy-alerts/keyboard";

export const BUY_ALERT_SWAP_UNAVAILABLE = "This token isn't available to buy here.";
export const BUY_ALERT_SWAP_FAILED = "Couldn't open Swap. Try Wallet → Swap.";
export const BUY_ALERT_SWAP_TOAST = "Swap opened in your private chat.";

export function buyAlertNeedDmText(botUsername?: string): string {
  const botMention = botUsername ? `@${botUsername}` : "the bot";
  const startInstruction = botUsername
    ? `Tap ${botMention} and press Start, then tap Buy again.`
    : "Open a private chat with the bot, tap Start, then tap Buy again.";

  return [
    "I can’t DM you yet",
    "",
    "Start a private chat with the bot so I can share your balances.",
    startInstruction,
  ].join("\n");
}

export type BuyAlertSwapToken = {
  token_mint: string;
  token_ticker: string;
  decimals: number;
  isNativeSol?: boolean;
};

export type BuyAlertOpenArgs = {
  mint: string;
  ticker: string;
  decimals: number;
};

export type BuyAlertBuyDeps = {
  resolveSwapToken: (mint: string) => Promise<BuyAlertSwapToken | null>;
  openPrivateSwap: (args: BuyAlertOpenArgs & { userId: number }) => Promise<void>;
  ack: (ctx: Context, text?: string, showAlert?: boolean) => Promise<void>;
};

export type BuyAlertDeepLinkDeps = {
  resolveSwapToken: (mint: string) => Promise<BuyAlertSwapToken | null>;
  openSwap: (args: BuyAlertOpenArgs) => Promise<void>;
  replyError: (text: string) => Promise<void>;
};

export async function handleBuyAlertBuy(ctx: Context, deps: BuyAlertBuyDeps): Promise<void> {
  const mint = parseBuyAlertMint(ctx.callbackQuery?.data);
  const userId = ctx.from?.id;
  if (!mint || userId == null) {
    await deps.ack(ctx, BUY_ALERT_SWAP_FAILED, true);
    return;
  }

  if (mint === WSOL_MINT) {
    await deps.ack(ctx, BUY_ALERT_SWAP_UNAVAILABLE, true);
    return;
  }

  try {
    const resolved = await deps.resolveSwapToken(mint);
    if (!resolved || resolved.isNativeSol || resolved.token_mint === WSOL_MINT) {
      await deps.ack(ctx, BUY_ALERT_SWAP_UNAVAILABLE, true);
      return;
    }

    await deps.openPrivateSwap({
      userId,
      mint: resolved.token_mint,
      ticker: resolved.token_ticker,
      decimals: resolved.decimals,
    });
    await deps.ack(ctx, BUY_ALERT_SWAP_TOAST, false);
  } catch (error) {
    if (isBotInitiationForbidden(error)) {
      await deps.ack(ctx, buyAlertNeedDmText(ctx.me?.username), true);
      return;
    }
    console.error("Failed to open buy-alert swap:", error);
    await deps.ack(ctx, BUY_ALERT_SWAP_FAILED, true);
  }
}

export async function handleBuyAlertDeepLink(
  mint: string,
  deps: BuyAlertDeepLinkDeps,
): Promise<void> {
  if (mint === WSOL_MINT) {
    await deps.replyError(BUY_ALERT_SWAP_UNAVAILABLE);
    return;
  }

  try {
    const resolved = await deps.resolveSwapToken(mint);
    if (!resolved || resolved.isNativeSol || resolved.token_mint === WSOL_MINT) {
      await deps.replyError(BUY_ALERT_SWAP_UNAVAILABLE);
      return;
    }

    await deps.openSwap({
      mint: resolved.token_mint,
      ticker: resolved.token_ticker,
      decimals: resolved.decimals,
    });
  } catch (error) {
    console.error("Failed to open buy-alert swap from start:", error);
    await deps.replyError(BUY_ALERT_SWAP_FAILED);
  }
}
