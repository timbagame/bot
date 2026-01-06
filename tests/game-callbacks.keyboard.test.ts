import { expect, test } from "bun:test";
import { createPlayerSelectionKeyboard, createGameConfirmKeyboard } from "../src/utils/keyboards";
import {
  decodeGameConfirmPayload,
  decodePlayersSelectionPayload,
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
  const encoded = callbacks.find((cb) => cb.startsWith("gp|"))!;
  const decoded = decodePlayersSelectionPayload(encoded);
  expect(decoded).toMatchObject({
    gameType: "coinflip",
    amount: "150.5",
    players: 2,
    creatorId: "12345",
  });
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(64);
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

test("player selection remains compact for large numbers and creator IDs", () => {
  const kb = createPlayerSelectionKeyboard(
    "giveaway",
    "98765432109876543210.987654",
    "123456789012345678901234567890"
  );
  const callbacks = extractCallbacks(kb);
  const encoded = callbacks.find((cb) => cb.startsWith("gp|"))!;
  expect(encoded).toBeTruthy();
  expect(Buffer.byteLength(encoded, "utf-8")).toBeLessThanOrEqual(64);
  const decoded = decodePlayersSelectionPayload(encoded);
  expect(decoded?.players).toBeGreaterThan(0);
  expect(decoded?.creatorId).toBe("123456789012345678901234567890");
});
