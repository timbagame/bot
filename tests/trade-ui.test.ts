import { describe, expect, test } from "bun:test";
import {
  buildBuyMenuUI,
  buildProcessingStatus,
  buildSellMenuUI,
  SELL_NOOP_CALLBACK,
} from "../src/utils/trade-ui";

function extractCallbacks(kb: any): string[] {
  const rows = (kb && (kb.inline_keyboard || kb.rows)) as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows.flat().map((btn: any) => btn?.callback_data).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(JSON.stringify(kb));
    const grid = (parsed && (parsed.inline_keyboard || parsed.rows)) as any[] | undefined;
    if (Array.isArray(grid)) {
      return grid.flat().map((btn: any) => btn?.callback_data).filter(Boolean);
    }
  } catch {}
  return [];
}

function extractTexts(kb: any): string[] {
  const rows = (kb && (kb.inline_keyboard || kb.rows)) as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows.flat().map((btn: any) => btn?.text).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(JSON.stringify(kb));
    const grid = (parsed && (parsed.inline_keyboard || parsed.rows)) as any[] | undefined;
    if (Array.isArray(grid)) {
      return grid.flat().map((btn: any) => btn?.text).filter(Boolean);
    }
  } catch {}
  return [];
}

describe("trade ui helpers", () => {
  test("buy menu lists token choices and quick actions", () => {
    const { message, keyboard } = buildBuyMenuUI({
      walletAddress: "1234567890ABCDEF",
      formattedSolBalance: "1.000",
      totalUsd: 123.45,
      tokenButtons: [
        { label: "TIMBA (10.0)", callbackData: "buy_dynamic_SOL_1" },
        { label: "USDC (50)", callbackData: "buy_dynamic_SOL_2" },
      ],
    });

    expect(message).toContain("BUY TOKENS");
    expect(message).toContain("1234567890ABCDEF");
    expect(message).toContain("$123.45");
    expect(message).toContain("Select a token to buy");
    expect(message).toContain("Paste a contract address");

    const callbacks = extractCallbacks(keyboard);
    expect(callbacks.slice(0, 2)).toEqual([
      "buy_dynamic_SOL_1",
      "buy_dynamic_SOL_2",
    ]);
    expect(callbacks).toContain("main_wallet");
    expect(callbacks).not.toContain("buy_with_SOL");
    expect(callbacks).not.toContain("buy_with_other_tokens");
    expect(callbacks).not.toContain("buy_contract_SOL");
    expect(callbacks).not.toContain("buy_search_SOL");
  });

  test("buy menu prompts for address when no tokens listed", () => {
    const { message, keyboard } = buildBuyMenuUI({
      walletAddress: "ABCXYZ123456",
      formattedSolBalance: "0.000",
      totalUsd: 0,
      tokenButtons: [],
    });

    expect(message).toContain("Paste a token contract address to get started");
    const callbacks = extractCallbacks(keyboard);
    expect(callbacks).toContain("main_wallet");
    expect(callbacks).not.toContain("buy_contract_SOL");
    expect(callbacks).not.toContain("buy_search_SOL");
    expect(callbacks).not.toContain("buy_with_SOL");
  });

  test("sell menu lists tokens or fallback button", () => {
    const withTokens = buildSellMenuUI({
      walletAddress: "123XYZ567890",
      tokenButtons: [
        { label: "TIMBA (25)", callbackData: "sell_token_TIMBA" },
        { label: "USDC (5)", callbackData: "sell_token_USDC" },
      ],
    });

    expect(withTokens.message).toContain("SELL TOKENS");
    expect(withTokens.message).toContain("Select a token to sell");
    expect(withTokens.message).toContain("choose the amount");

    const callbacksWithTokens = extractCallbacks(withTokens.keyboard);
    expect(callbacksWithTokens.slice(0, 2)).toEqual([
      "sell_token_TIMBA",
      "sell_token_USDC",
    ]);
    expect(callbacksWithTokens).toContain("main_wallet");

    const withoutTokens = buildSellMenuUI({
      walletAddress: "123XYZ567890",
      tokenButtons: [],
    });

    expect(withoutTokens.message).toContain("No tokens available to sell");
    const callbacksWithoutTokens = extractCallbacks(withoutTokens.keyboard);
    expect(callbacksWithoutTokens).toContain(SELL_NOOP_CALLBACK);
    expect(callbacksWithoutTokens).toContain("main_wallet");

    const labels = extractTexts(withoutTokens.keyboard);
    expect(labels[0]).toContain("No tokens to sell");
  });

  test("processing status formats html content per kind", () => {
    const swap = buildProcessingStatus("swap", "5", "SOL", "BONK");
    expect(swap.message).toContain("<b>PROCESSING SWAP</b>");
    expect(swap.message).toContain("Swapping 5 SOL → BONK...");
    expect(swap.message).toContain("<i>Please wait...</i>");
    expect(typeof swap.keyboard?.text).toBe("function");

    const buy = buildProcessingStatus("buy", "2", "SOL", "TIMBA");
    expect(buy.message).toContain("Processing Buy Transaction");
    expect(buy.message).toContain("Executing 2 SOL → TIMBA");
    expect(buy.keyboard).toBeUndefined();
  });

  test("processing status supports plain text output", () => {
    const sellPlain = buildProcessingStatus("sell", "1.5", "TIMBA", "SOL", {
      plain: true,
    });

    expect(sellPlain.message).not.toContain("<b>");
    expect(sellPlain.message).toContain("Processing Sell Transaction");
    expect(sellPlain.message).toContain("Executing 1.5 TIMBA → SOL");
  });
});
