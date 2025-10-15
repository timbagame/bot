import { describe, expect, test } from "bun:test";
import { buildBuyMenuUI, buildSellMenuUI, SELL_NOOP_CALLBACK } from "../src/utils/trade-ui";

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
  test("buy menu highlights owned tokens and payment actions", () => {
    const { message, keyboard } = buildBuyMenuUI({
      walletAddress: "1234567890ABCDEF",
      formattedSolBalance: "1.000",
      totalUsd: 123.45,
      ownedTokenButtons: [
        { label: "TIMBA (10.0)", callbackData: "buy_dynamic_SOL_1" },
        { label: "USDC (50)", callbackData: "buy_dynamic_SOL_2" },
      ],
      allowTokenPayments: true,
      hasAnyTokens: true,
    });

    expect(message).toContain("BUY TOKENS");
    expect(message).toContain("1234567890ABCDEF");
    expect(message).toContain("$123.45");
    expect(message).toContain("Select a token below");

    const callbacks = extractCallbacks(keyboard);
    expect(callbacks.slice(0, 2)).toEqual([
      "buy_dynamic_SOL_1",
      "buy_dynamic_SOL_2",
    ]);
    expect(callbacks).toContain("buy_with_SOL");
    expect(callbacks).toContain("buy_with_other_tokens");
    expect(callbacks).toContain("buy_contract_SOL");
    expect(callbacks).toContain("buy_search_SOL");
    expect(callbacks).toContain("main_wallet");
  });

  test("buy menu omits token payment option when no balances", () => {
    const { message, keyboard } = buildBuyMenuUI({
      walletAddress: "ABCXYZ123456",
      formattedSolBalance: "0.000",
      totalUsd: 0,
      ownedTokenButtons: [],
      allowTokenPayments: false,
      hasAnyTokens: false,
    });

    expect(message).toContain("Select how you'd like to buy");
    const callbacks = extractCallbacks(keyboard);
    expect(callbacks).toContain("buy_with_SOL");
    expect(callbacks).not.toContain("buy_with_other_tokens");
    expect(callbacks).toContain("main_wallet");
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
});
