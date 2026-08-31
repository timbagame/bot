import { InlineKeyboard } from "grammy";
import { WSOL_MINT } from "../utils/constants";
import { getTelegramId } from "../utils/context-helpers";
import { respondWithMenu } from "../utils/menu-response";
import { safeAnswerCallbackQuery } from "../utils/context-helpers";
import {
  buildDexScreenerTokenUrl,
  buildTokenPositions,
  createDecimalResolver,
  fillsFromSwaps,
  formatPositionMessage,
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
  createKeyboard: (args: {
    index: number;
    count: number;
    dexUrl?: string | null;
  }) => InlineKeyboard;
};

const EMPTY_TEXT = [
  "📊 Positions",
  "",
  "No tracked positions yet.",
  "Buy a token with Swap to start seeing PNL from your average entry.",
].join("\n");

const parsePositionIndex = (callbackData: string | undefined): number => {
  const match = String(callbackData ?? "").match(/^wallet_pos_(\d+)$/);
  if (!match) {
    return 0;
  }
  return Number(match[1]);
};

export async function loadWalletPositions(
  telegramId: bigint,
  deps: WalletPositionsDeps,
): Promise<TokenPosition[]> {
  const walletAddress = deps.getWalletAddress(telegramId);
  const holdings = await deps.getHoldings(telegramId);
  const swaps = deps.getSwapsByWallet(walletAddress);
  const fills = fillsFromSwaps(
    swaps,
    createDecimalResolver([...(deps.getKnownTokens?.() ?? []), ...holdings]),
  );
  const priceMints = new Set<string>([WSOL_MINT]);
  for (const holding of holdings) {
    priceMints.add(holding.mint);
  }
  const pricesUsd = await deps.fetchPricesUSD([...priceMints]);
  return buildTokenPositions({ fills, holdings, pricesUsd });
}

export async function onWalletPositions(ctx: any, deps: WalletPositionsDeps): Promise<void> {
  try {
    const telegramId = getTelegramId(ctx);
    if (telegramId === 0n) {
      await safeAnswerCallbackQuery(ctx, "❌ Could not load positions");
      return;
    }

    const positions = await loadWalletPositions(telegramId, deps);
    if (positions.length === 0) {
      await respondWithMenu(ctx, {
        text: EMPTY_TEXT,
        keyboard: new InlineKeyboard().text("← Back to Wallet", "main_wallet"),
      });
      await safeAnswerCallbackQuery(ctx);
      return;
    }

    const index = Math.min(
      Math.max(0, parsePositionIndex(ctx.callbackQuery?.data)),
      positions.length - 1,
    );
    const position = positions[index]!;
    const text = formatPositionMessage(position, {
      index,
      count: positions.length,
    });

    await respondWithMenu(ctx, {
      text,
      parseMode: "HTML",
      keyboard: deps.createKeyboard({
        index,
        count: positions.length,
        dexUrl: buildDexScreenerTokenUrl(position.mint),
      }),
    });
    await safeAnswerCallbackQuery(ctx);
  } catch (error) {
    console.error("Error in wallet_positions:", error);
    await safeAnswerCallbackQuery(ctx, "❌ Error loading positions");
  }
}
