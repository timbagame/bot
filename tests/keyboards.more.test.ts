import { expect, test, describe } from "bun:test";
import {
  createWalletKeyboard,
  createWalletSettingsKeyboard,
  createBackToSettingsKeyboard,
  createConfirmWrapKeyboard,
  createConfirmUnwrapKeyboard,
  createTradeConfirmKeyboard,
  createAmountSelectionKeyboard,
  createPlayerSelectionKeyboard,
  createGameConfirmKeyboard,
  getFeeWarningMessage,
} from "../src/utils/keyboards";
import {
  decodeGameConfirmPayload,
  decodeAmountSelectionPayload,
  decodeMinPlayersChangePayload,
  decodePlayersSelectionPayload,
  decodeTimeoutChangePayload,
  decodeVisibilityPayload,
} from "../src/utils/callback-data";

// Helper to extract callback_data strings from InlineKeyboard
function extractCallbacks(kb: any): string[] {
  const grid = (kb && (kb.inline_keyboard || kb.keyboard)) as any[] | undefined;
  if (Array.isArray(grid)) {
    return grid
      .flat()
      .map((b: any) => b?.callback_data)
      .filter(Boolean);
  }
  // Fallback for grammy's internal representation
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

function extractTexts(kb: any): string[] {
  const grid = (kb && (kb.inline_keyboard || kb.keyboard)) as any[] | undefined;
  if (Array.isArray(grid)) {
    return grid
      .flat()
      .map((b: any) => b?.text)
      .filter(Boolean);
  }
  const rows = (kb as any).rows as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows
      .flat()
      .map((b: any) => b?.text)
      .filter(Boolean);
  }
  try {
    const j = JSON.parse(JSON.stringify(kb));
    const arr = (j && (j.inline_keyboard || j.keyboard)) as any[] | undefined;
    if (Array.isArray(arr)) {
      return arr
        .flat()
        .map((b: any) => b?.text)
        .filter(Boolean);
    }
  } catch {}
  return [];
}

describe("keyboards: main and wallet", () => {
  test("wallet keyboard contains swap/withdraw/refresh and settings", () => {
    const kb = createWalletKeyboard();
    const callbacks = extractCallbacks(kb);
    expect(callbacks).toContain("cmd_swap");
    expect(callbacks).toContain("cmd_withdraw");
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

test("back to settings keyboard returns wallet_settings callback", () => {
  const kb = createBackToSettingsKeyboard();
  const callbacks = extractCallbacks(kb);
  const texts = extractTexts(kb);

  expect(callbacks).toContain("wallet_settings");
  expect(texts).toContain("← Back to Settings");
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
  const expectedDefaultCallbacks = [
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

  const usdTargets = [0.25, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 25] as const;

  test("defaults to fixed contract minimum multiples when no balance", () => {
    const kb = createAmountSelectionKeyboard("coinflip");
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(callbacks).toEqual(expectedDefaultCallbacks);
  });

  test("small balance still surfaces fixed contract minimum multiples", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 3);
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(callbacks).toEqual(expectedDefaultCallbacks);
  });

  test("sub-unit balances still show contract minimum first and keep ordering", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 1.2);
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(callbacks).toEqual(expectedDefaultCallbacks);
  });

  test("balance under 50 still starts from contract minimum", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 40);
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));
    expect(callbacks[0]).toBe("amount_coinflip_20");
    expect(callbacks).toEqual(expectedDefaultCallbacks);
  });

  test("amount buttons render two per row", () => {
    const kb = createAmountSelectionKeyboard("coinflip", 200);
    const rows = (kb && (kb as any).inline_keyboard) || (kb && (kb as any).rows) || [];
    const amountRows = rows.filter((row: any[]) =>
      row.some((btn: any) => btn?.callback_data?.startsWith("amount_coinflip_")),
    );
    const flattened = amountRows
      .flat()
      .filter((btn: any) => btn?.callback_data?.startsWith("amount_coinflip_"));
    expect(flattened.map((btn: any) => btn.callback_data)).toEqual(expectedDefaultCallbacks);
    expect(amountRows.every((row: any[]) => row.length === 2)).toBe(true);
  });

  test("creatorId is appended to callbacks when provided", () => {
    const kb = createAmountSelectionKeyboard("giveaway", 60, "999");
    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("ga|"));
    expect(callbacks.length).toBeGreaterThan(0);
    const decoded = callbacks.map((cb) => decodeAmountSelectionPayload(cb)).filter(Boolean);
    expect(decoded.every((d) => d?.creatorId === "999")).toBe(true);
    expect(callbacks.every((cb) => Buffer.byteLength(cb, "utf-8") <= 64)).toBe(true);
  });

  test("amount buttons omit token ticker and show USD when price is known", () => {
    const kb = createAmountSelectionKeyboard("coinflip", undefined, undefined, 20, {
      decimals: 2,
      tokenPriceUSD: 0.01,
    });
    const texts = extractTexts(kb).filter((text) => /^\d/.test(text));
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((text) => !text.includes("TIMBA"))).toBe(true);
    expect(texts.every((text) => !text.includes("~"))).toBe(true);
    expect(texts.every((text) => /\(\$[0-9,]+(?:\.\d+)?\)/.test(text))).toBe(true);
  });

  test("amount callbacks stay within Telegram limits for large inputs", () => {
    const kb = createAmountSelectionKeyboard(
      "coinflip",
      10_000_000_000_000,
      "123456789012345678901234567890",
      20,
    );
    const callbacks = extractCallbacks(kb);
    expect(callbacks.length).toBeGreaterThan(0);
    expect(callbacks.every((cb) => Buffer.byteLength(cb, "utf-8") <= 64)).toBe(true);
  });

  test("amount callbacks follow USD tiers when token price is known", () => {
    const tokenPriceUSD = 0.01;
    const kb = createAmountSelectionKeyboard("coinflip", 5000, undefined, 20, {
      decimals: 2,
      tokenPriceUSD,
    });

    const callbacks = extractCallbacks(kb).filter((s) => s.startsWith("amount_coinflip_"));

    const expected = [
      "amount_coinflip_20",
      ...usdTargets.map((usd) => `amount_coinflip_${Number((usd / tokenPriceUSD).toFixed(6))}`),
    ];

    expect(callbacks).toEqual(expected);
  });

  test("minimum bet button renders USD equivalent when price is provided", () => {
    const kb = createAmountSelectionKeyboard("coinflip", undefined, undefined, 20, {
      decimals: 2,
      tokenPriceUSD: 0.05,
    });

    const texts = extractTexts(kb);
    const minButton = texts.find((text) => text.startsWith("20"));

    expect(minButton).toBeDefined();
    expect(minButton).toContain("$1");
    expect(minButton).not.toContain("$1.0");
  });

  test("fee warning message shows for low balance", () => {
    const msg = getFeeWarningMessage("coinflip", 5, 20);
    expect(msg).toContain("Low Balance Warning");
    expect(msg).toContain("Contract minimum: 20 TIMBA");
  });

  test("fee warning message can omit personal balance details", () => {
    const msg = getFeeWarningMessage("coinflip", 5, 20, undefined, {
      includeBalanceInfo: false,
    });
    expect(msg).toContain("Low Balance Warning");
    expect(msg).toContain("Contract minimum: 20 TIMBA");
    expect(msg).not.toContain("Your balance");
  });
});

describe("keyboards: player selection and confirm", () => {
  test("player selection includes correct callbacks for coinflip", () => {
    const kb = createPlayerSelectionKeyboard("coinflip", "25");
    const callbacks = extractCallbacks(kb).filter((s) => s?.startsWith("players_coinflip_25_"));
    expect(callbacks).toContain("players_coinflip_25_2");
    expect(callbacks).toContain("players_coinflip_25_3");
    expect(callbacks).toContain("players_coinflip_25_4");
    expect(callbacks).toContain("players_coinflip_25_5");
    expect(callbacks).toContain("players_coinflip_25_10");
    expect(callbacks).toContain("players_coinflip_25_20");
    expect(callbacks.every((cb) => Buffer.byteLength(cb, "utf-8") <= 64)).toBe(true);
    // Also includes custom and back-to-amount
    const all = extractCallbacks(kb);
    expect(all).toContain("custom_players_coinflip_25");
    expect(all).toContain("back_to_amounts_coinflip");
  });

  test("player selection for giveaway uses specific player options", () => {
    const kb = createPlayerSelectionKeyboard("giveaway", "10", "42");
    const callbacks = extractCallbacks(kb).filter((s) => s?.startsWith("gp|"));
    const decoded = callbacks.map((cb) => decodePlayersSelectionPayload(cb)).filter(Boolean);
    const playerCounts = decoded.map((d) => d?.players);
    expect(playerCounts).toEqual(expect.arrayContaining([1, 2, 3, 5, 10, 20]));
    expect(callbacks.every((cb) => Buffer.byteLength(cb, "utf-8") <= 64)).toBe(true);
  });

  test("confirm keyboard includes confirm and back with creatorId", () => {
    const kb = createGameConfirmKeyboard("coinflip", "30", "4", "abc");
    const callbacks = extractCallbacks(kb);
    const texts = extractTexts(kb);
    const confirm = callbacks.find((s) => s.startsWith("cg|"))!;
    const decodedConfirm = decodeGameConfirmPayload(confirm);
    expect(decodedConfirm).toMatchObject({
      gameType: "coinflip",
      amount: "30",
      players: 4,
      minPlayers: 2,
      isPrivate: true,
      creatorId: "abc",
    });
    expect(Buffer.byteLength(confirm, "utf-8")).toBeLessThanOrEqual(64);
    const backToAmount =
      callbacks.find((s) => s.startsWith("ga|")) ??
      callbacks.find((s) => s.startsWith("amount_coinflip_"));
    const decodedAmountPayload = backToAmount ? decodeAmountSelectionPayload(backToAmount) : null;
    expect(decodedAmountPayload?.gameType).toBe("coinflip");
    expect(decodedAmountPayload?.amount).toBe("30");
    expect(decodedAmountPayload?.creatorId).toBe("abc");
    const timeoutDeltas = callbacks
      .filter((s) => s.startsWith("ct|"))
      .map((s) => decodeTimeoutChangePayload(s)?.deltaMinutes);
    expect(timeoutDeltas).toEqual(expect.arrayContaining([-30, -15, 30, 60]));
    const visibility = callbacks.find((s) => s.startsWith("cv|"))!;
    const decodedVisibility = decodeVisibilityPayload(visibility);
    expect(decodedVisibility?.isPrivate).toBe(false);
    const minPlayersDeltas = callbacks
      .filter((s) => s.startsWith("cm|"))
      .map((s) => decodeMinPlayersChangePayload(s)?.deltaPlayers);
    expect(minPlayersDeltas).toEqual(expect.arrayContaining([1, 2]));
    expect(texts).toContain("Min 2");
    expect(texts).toContain("MAX");
  });
});
