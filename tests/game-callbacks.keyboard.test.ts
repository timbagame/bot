import { expect, test } from "bun:test";
import { createPlayerSelectionKeyboard, createGameConfirmKeyboard } from "../src/utils/keyboards";
import {
  decodeGameConfirmPayload,
  decodeTimeoutChangePayload,
  decodeVisibilityPayload,
} from "../src/utils/callback-data";

// Helper to extract callback_data strings from InlineKeyboard
function extractCallbacks(kb: any): string[] {
  // Try typical grammy InlineKeyboard shape
  const grid = (kb && (kb.inline_keyboard || kb.keyboard || kb['inlineKeyboard'] || kb['rows'])) as any[] | undefined;
  if (Array.isArray(grid)) {
    return grid.flat().map((b: any) => b?.callback_data).filter(Boolean);
  }
  // Fallback: attempt JSON-serialize and inspect
  try {
    const j = JSON.parse(JSON.stringify(kb));
    const arr = (j && (j.inline_keyboard || j.keyboard)) as any[] | undefined;
    if (Array.isArray(arr)) {
      return arr.flat().map((b: any) => b?.callback_data).filter(Boolean);
    }
  } catch {}
  // Last resort: dig known private field used by some versions
  const rows = (kb as any).rows as any[] | undefined;
  if (Array.isArray(rows)) {
    return rows.flat().map((b: any) => b?.callback_data).filter(Boolean);
  }
  return [];
}

test("player selection keyboard embeds decimal amount in callbacks when creatorId present", () => {
  const kb = createPlayerSelectionKeyboard("coinflip", "150.5", "12345");
  const callbacks = extractCallbacks(kb);
  expect(callbacks.some(s => s?.startsWith("players_coinflip_150.5_"))).toBe(true);
  // Must include creatorId at end
  expect(callbacks.some(s => /players_coinflip_150\.5_\d+_12345$/.test(s))).toBe(true);
});

test("game confirm keyboard embeds decimal amount and creatorId", () => {
  const kb = createGameConfirmKeyboard("giveaway", "0.75", "10", "999");
  const callbacks = extractCallbacks(kb);
  const confirm = callbacks.find((s) => s?.startsWith("cg|"))!;
  expect(confirm).toBeTruthy();
  const decoded = decodeGameConfirmPayload(confirm);
  expect(decoded).toMatchObject({
    gameType: "giveaway",
    amount: "0.75",
    players: 10,
    timeoutSeconds: 3600,
    minPlayers: 1,
    isPrivate: true,
    creatorId: "999",
  });
  expect(Buffer.byteLength(confirm, "utf-8")).toBeLessThanOrEqual(64);
  const timeoutChange = callbacks.find((s) => s?.startsWith("ct|"))!;
  const decodedTimeout = decodeTimeoutChangePayload(timeoutChange);
  expect(decodedTimeout?.deltaMinutes).toBe(-30);
  expect(Buffer.byteLength(timeoutChange, "utf-8")).toBeLessThanOrEqual(64);
  const visibility = callbacks.find((s) => s?.startsWith("cv|"))!;
  const decodedVisibility = decodeVisibilityPayload(visibility);
  expect(decodedVisibility?.isPrivate).toBe(false);
  expect(Buffer.byteLength(visibility, "utf-8")).toBeLessThanOrEqual(64);
});

test("long inputs still keep confirm callbacks within Telegram limits", () => {
  const kb = createGameConfirmKeyboard(
    "coinflip",
    "12345678901234567890.123456",
    "25",
    "123456789012345678901234567890"
  );
  const callbacks = extractCallbacks(kb);
  expect(callbacks.some((cb) => cb.startsWith("cg|"))).toBe(true);
  expect(
    callbacks.every((cb) => Buffer.byteLength(cb, "utf-8") <= 64)
  ).toBe(true);
});
