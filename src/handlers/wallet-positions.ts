import { InlineKeyboard } from "grammy";
import { getTelegramId, safeAnswerCallbackQuery } from "../utils/context-helpers";
import { respondWithMenu } from "../utils/menu-response";
import {
  formatPositionsPage,
  loadTokenPositionsForWallet,
  POSITIONS_PAGE_SIZE,
  type TokenHolding,
  type TokenPosition,
} from "../services/positions";
import type { SwapStatRecord } from "../utils/transaction-history";

export type WalletPositionsDeps = {
  getWalletAddress: (telegramId: bigint) => string;
  getHoldings: (telegramId: bigint) => Promise<TokenHolding[]>;
  getSwapsByWallet: (wallet: string) => SwapStatRecord[];
  fetchPricesUSD: (mints: string[]) => Promise<Record<string, number>>;
  getKnownTokens?: () => Array<{ mint?: string; token_mint?: string; decimals: number }>;
  createKeyboard: (args: { page: number; pageCount: number }) => InlineKeyboard;
  refreshCaches?: (telegramId: bigint) => void | Promise<void>;
};

const EMPTY_TEXT = [
  "📊 Positions",
  "",
  "No tracked positions yet.",
  "Buy a token with Swap to start seeing PNL from your average entry.",
].join("\n");

const parsePositionsView = (
  callbackData: string | undefined,
): { page: number; refresh: boolean } => {
  const raw = String(callbackData ?? "");
  const refreshMatch = raw.match(/^wallet_pos_r_(\d+)$/);
  if (refreshMatch) {
    return { page: Number(refreshMatch[1]), refresh: true };
  }
  const pageMatch = raw.match(/^wallet_pos_(\d+)$/);
  if (pageMatch) {
    return { page: Number(pageMatch[1]), refresh: false };
  }
  return { page: 0, refresh: false };
};

export async function loadWalletPositions(
  telegramId: bigint,
  deps: WalletPositionsDeps,
): Promise<TokenPosition[]> {
  const walletAddress = deps.getWalletAddress(telegramId);
  return loadTokenPositionsForWallet({
    walletAddress,
    getHoldings: () => deps.getHoldings(telegramId),
    getSwaps: () => deps.getSwapsByWallet(walletAddress),
    fetchPricesUSD: deps.fetchPricesUSD,
    knownTokens: deps.getKnownTokens?.(),
  });
}

export async function onWalletPositions(ctx: any, deps: WalletPositionsDeps): Promise<void> {
  try {
    const telegramId = getTelegramId(ctx);
    if (telegramId === 0n) {
      await safeAnswerCallbackQuery(ctx, "❌ Could not load positions");
      return;
    }

    const view = parsePositionsView(ctx.callbackQuery?.data);
    if (view.refresh) {
      await deps.refreshCaches?.(telegramId);
    }

    const positions = await loadWalletPositions(telegramId, deps);
    if (positions.length === 0) {
      await respondWithMenu(ctx, {
        text: EMPTY_TEXT,
        keyboard: new InlineKeyboard()
          .text("🔁 Refresh", "wallet_pos_r_0")
          .row()
          .text("← Back to Wallet", "main_wallet"),
      });
      await safeAnswerCallbackQuery(ctx);
      return;
    }

    const pageCount = Math.max(1, Math.ceil(positions.length / POSITIONS_PAGE_SIZE));
    const page = Math.min(Math.max(0, view.page), pageCount - 1);
    const start = page * POSITIONS_PAGE_SIZE;
    const pagePositions = positions.slice(start, start + POSITIONS_PAGE_SIZE);
    const text = formatPositionsPage(pagePositions, { page, pageCount });

    await respondWithMenu(ctx, {
      text,
      parseMode: "HTML",
      keyboard: deps.createKeyboard({
        page,
        pageCount,
      }),
    });
    await safeAnswerCallbackQuery(ctx);
  } catch (error) {
    console.error("Error in wallet_positions:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error loading positions");
  }
}
