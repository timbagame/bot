import { expect, test, describe } from "bun:test";
import {
  createMainMenuKeyboard,
  createWalletKeyboard,
  createWalletSettingsKeyboard,
  createConfirmWrapKeyboard,
  createConfirmUnwrapKeyboard,
  createTradeConfirmKeyboard,
  createAmountSelectionKeyboard,
  createPlayerSelectionKeyboard,
  createGameConfirmKeyboard,
  createSliderAmountKeyboard,
  getFeeWarningMessage,
} from "../src/utils/keyboards";

// Helper to extract callback_data strings from InlineKeyboard
function extractCallbacks(kb: any): string[] {
  const grid = (kb && (kb.inline_keyboard || kb.keyboard)) as any[] | undefined;
  if (Array.isArray(grid)) {
    return grid.flat().map((b: any) => b?.callback_data).filter(Boolean);
  }
  // Fallback for grammy's internal representation
  const rows = (kb as any).rows as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows.flat().map((b: any) => b?.callback_data).filter(Boolean);
  }
  try {
    const j = JSON.parse(JSON.stringify(kb));
    const arr = (j && (j.inline_keyboard || j.keyboard)) as any[] | undefined;
    if (Array.isArray(arr)) {
      return arr.flat().map((b: any) => b?.callback_data).filter(Boolean);
    }
  } catch {}
  return [];
}

function extractTexts(kb: any): string[] {
  const grid = (kb && (kb.inline_keyboard || kb.keyboard)) as any[] | undefined;
  if (Array.isArray(grid)) {
    return grid.flat().map((b: any) => b?.text).filter(Boolean);
  }
  const rows = (kb as any).rows as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows.flat().map((b: any) => b?.text).filter(Boolean);
  }
  try {
    const j = JSON.parse(JSON.stringify(kb));
    const arr = (j && (j.inline_keyboard || j.keyboard)) as any[] | undefined;
    if (Array.isArray(arr)) {
      return arr.flat().map((b: any) => b?.text).filter(Boolean);
    }
  } catch {}
  return [];
}

describe("keyboards: main and wallet", () => {
  test("main menu contains expected actions", () => {
    const kb = createMainMenuKeyboard();
    const callbacks = extractCallbacks(kb);
    expect(callbacks).toContain("main_wallet");
    expect(callbacks).toContain("cmd_help");
  });

  test("wallet keyboard contains buy/sell/refresh and settings", () => {
    const kb = createWalletKeyboard();
    const callbacks = extractCallbacks(kb);
    expect(callbacks).toContain("cmd_withdraw");
    expect(callbacks).toContain("cmd_buy");
    expect(callbacks).toContain("cmd_sell");
    expect(callbacks).toContain("wallet_refresh");
    expect(callbacks).toContain("wallet_settings");
  });

  test("wallet settings keyboard includes wrap, unwrap, private key, and back", () => {
    const kb = createWalletSettingsKeyboard();
    const callbacks = extractCallbacks(kb);
    const texts = extractTexts(kb);

    expect(callbacks).toContain("cmd_wrap");
    expect(callbacks).toContain("cmd_unwrap");
    expect(callbacks).toContain("cmd_privatekey");
    expect(callbacks).toContain("main_wallet");

    expect(texts).toContain("🔧 Wrap SOL");
    expect(texts).toContain("🧼 Unwrap WSOL");
    expect(texts).toContain("🔐 Private Key");
    expect(texts).toContain("← Back to Wallet");
  });
});

describe("keyboards: misc menus", () => {
  test("confirm wrap keyboard embeds amount and cancel", () => {
    const kb = createConfirmWrapKeyboard(42);
    const callbacks = extractCallbacks(kb);
    expect(callbacks).toContain("confirm_wrap_42");
    expect(callbacks).toContain("cmd_wrap");
  });

  test("confirm unwrap keyboard shows actionable button when balance exists", () => {
    const kb = createConfirmUnwrapKeyboard(true);
    const callbacks = extractCallbacks(kb);
    const texts = extractTexts(kb);

    expect(callbacks).toContain("unwrap_confirm");
    expect(callbacks).not.toContain("noop");
    expect(texts).toContain("✅ Unwrap All WSOL");
  });

  test("confirm unwrap keyboard disables action when no balance", () => {
    const kb = createConfirmUnwrapKeyboard(false);
    const callbacks = extractCallbacks(kb);
    const texts = extractTexts(kb);

    expect(callbacks).not.toContain("unwrap_confirm");
    expect(callbacks).toContain("noop");
    expect(texts).toContain("❌ No WSOL to unwrap");
  });

  test("trade confirm keyboard renders custom confirm/cancel buttons", () => {
    const kb = createTradeConfirmKeyboard({
      confirmLabel: "✅ Confirm",
      confirmCallback: "confirm_test",
      cancelLabel: "❌ Back",
      cancelCallback: "cmd_back",
    });
    const callbacks = extractCallbacks(kb);
    const texts = extractTexts(kb);
    expect(callbacks).toContain("confirm_test");
    expect(callbacks).toContain("cmd_back");
    expect(texts).toContain("✅ Confirm");
    expect(texts).toContain("❌ Back");
  });
});

describe("keyboards: amount selection", () => {
  test("defaults to 3 simple amounts when no balance", () => {
    const kb = createAmountSelectionKeyboard("coinflip");
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(callbacks).toEqual([
      "amount_coinflip_20",
      "amount_coinflip_100",
      "amount_coinflip_200",
    ]);
  });

  test("very small balance yields <= balance amounts without duplicates", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 3);
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    const amounts = callbacks.map((s) => Number(s.split("_")[2]));
    expect(amounts).toContain(20);
    expect(amounts).toContain(3);
    expect(new Set(amounts).size).toBe(amounts.length);
  });

  test("sub-unit balances still show at least one affordable option", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 1.2);
    const amounts = extractCallbacks(kb)
      .filter((s) => s.startsWith("amount_coinflip_"))
      .map((s) => Number(s.split("_")[2]));
    expect(amounts[0]).toBe(20);
    expect(amounts).toContain(1.2);
    expect(new Set(amounts).size).toBe(amounts.length);
  });

  test("balance under 50 starts from recommended minimum", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 40);
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(callbacks).toEqual([
      "amount_coinflip_20",
      "amount_coinflip_100",
      "amount_coinflip_200",
    ]);
  });

  test("creatorId is appended to callbacks when provided", () => {
    const kb = createAmountSelectionKeyboard("giveaway", 60, "999");
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_giveaway_"));
    expect(callbacks.every((s) => s.endsWith("_999"))).toBe(true);
  });

  test("fee warning message shows for low balance", () => {
    const msg = getFeeWarningMessage("coinflip", 5, 20);
    expect(msg).toContain("Low Balance Warning");
    expect(msg).toContain("Contract minimum: 20 TIMBA");
  });
});

describe("keyboards: player selection and confirm", () => {
  test("player selection includes correct callbacks for coinflip", () => {
    const kb = createPlayerSelectionKeyboard("coinflip", "25");
    const callbacks = extractCallbacks(kb).filter((s) => s?.startsWith("players_coinflip_25_"));
    expect(callbacks).toContain("players_coinflip_25_2");
    expect(callbacks).toContain("players_coinflip_25_3");
    expect(callbacks).toContain("players_coinflip_25_4");
    // Also includes custom and cancel
    const all = extractCallbacks(kb);
    expect(all).toContain("custom_players_coinflip_25");
    expect(all).toContain("cancel_game_setup");
  });

  test("player selection for giveaway uses specific player options", () => {
    const kb = createPlayerSelectionKeyboard("giveaway", "10", "42");
    const callbacks = extractCallbacks(kb).filter((s) => s?.startsWith("players_giveaway_10_"));
    expect(callbacks).toContain("players_giveaway_10_2_42");
    expect(callbacks).toContain("players_giveaway_10_3_42");
    expect(callbacks).toContain("players_giveaway_10_5_42");
    expect(callbacks).toContain("players_giveaway_10_10_42");
    expect(callbacks).toContain("players_giveaway_10_15_42");
    expect(callbacks).toContain("players_giveaway_10_20_42");
  });

  test("confirm keyboard includes confirm and back with creatorId", () => {
    const kb = createGameConfirmKeyboard("coinflip", "30", "4", "abc");
    const callbacks = extractCallbacks(kb);
    expect(callbacks).toContain("confirm_game_coinflip_30_4_abc");
    expect(callbacks).toContain("amount_coinflip_30_abc");
  });
});

describe("keyboards: slider amount", () => {
  test("uses correct step sizes based on current amount", () => {
    const cases: Array<[number, number]> = [
      [10, 1],
      [150, 5],
      [500, 25],
      [2000, 100],
    ];

    for (const [amt, step] of cases) {
      const kb = createSliderAmountKeyboard("coinflip", amt, 10_000);
      const texts = extractTexts(kb);
      expect(texts).toContain(`-${step}`);
      expect(texts).toContain(`+${step}`);
      const expectedLabel = `✅ Use ${amt.toLocaleString("en-US")} TIMBA`;
      expect(texts).toContain(expectedLabel);
    }
  });

  test("respects user balance for min/max quick options", () => {
    const kb = createSliderAmountKeyboard("coinflip", 25, 88, "777");
    const callbacks = extractCallbacks(kb);
    expect(callbacks).toContain("slider_coinflip_1_777");
    // 25% and 50% of 88 => 22 and 44
    expect(callbacks).toContain("slider_coinflip_22_777");
    expect(callbacks).toContain("slider_coinflip_44_777");
    // Max uses balance
    expect(callbacks).toContain("slider_coinflip_88_777");
  });
});
