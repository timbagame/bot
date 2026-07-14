import { describe, test, expect } from "bun:test";
import { createAmountSelectionKeyboard } from "../src/utils/keyboards";

// Robust extractor like other keyboard tests
function extractCallbacks(kb: any): string[] {
  const grid = (kb && (kb.inline_keyboard || kb.keyboard)) as any[] | undefined;
  if (Array.isArray(grid)) {
    return grid
      .flat()
      .map((b: any) => b?.callback_data)
      .filter(Boolean);
  }
  const rows = (kb as any).rows as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows
      .flat()
      .map((b: any) => b?.callback_data)
      .filter(Boolean);
  }
  try {
    const j = JSON.parse(JSON.stringify(kb));
    const arr = (j && (j.inline_keyboard || j.keyboard)) as any[] | undefined;
    if (Array.isArray(arr)) {
      return arr
        .flat()
        .map((b: any) => b?.callback_data)
        .filter(Boolean);
    }
  } catch {}
  return [];
}

describe("createAmountSelectionKeyboard ranges", () => {
  const expectedAmounts = [
    "amount_coinflip_20",
    "amount_coinflip_50",
    "amount_coinflip_100",
    "amount_coinflip_200",
    "amount_coinflip_400",
    "amount_coinflip_600",
    "amount_coinflip_1000",
    "amount_coinflip_1500",
    "amount_coinflip_2000",
    "amount_coinflip_3000",
    "amount_coinflip_4000",
    "amount_coinflip_5000",
  ];

  test("medium balance (between 50 and 200) still uses fixed contract minimum multiples", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 120);
    const cbs = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(cbs).toEqual(expectedAmounts);
  });

  test("large balance (between 200 and 1000) still uses fixed contract minimum multiples", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 300);
    const cbs = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(cbs).toEqual(expectedAmounts);
  });

  test("very large balance (>= 1000) still uses fixed contract minimum multiples", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 5_000);
    const cbs = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(cbs).toEqual(expectedAmounts);
  });
});
