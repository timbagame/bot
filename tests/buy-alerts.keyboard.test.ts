import { expect, test } from "bun:test";
import {
  BUY_ALERT_CALLBACK_PREFIX,
  buyAlertButtonLabel,
  buyAlertCallbackData,
  buyAlertDeepLinkUrl,
  buyAlertStartPayload,
  createBuyAlertKeyboard,
  parseBuyAlertMint,
  parseBuyAlertStartPayload,
  parseBuyAlertStartText,
} from "../src/services/buy-alerts/keyboard";

const TIMBA_MINT = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

test("buy-alert callback data stays under Telegram's 64-byte limit", () => {
  const data = buyAlertCallbackData(TIMBA_MINT);
  expect(data.startsWith(BUY_ALERT_CALLBACK_PREFIX)).toBe(true);
  expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(64);
});

test("parseBuyAlertMint accepts a valid mint and rejects junk", () => {
  expect(parseBuyAlertMint(buyAlertCallbackData(TIMBA_MINT))).toBe(TIMBA_MINT);
  expect(parseBuyAlertMint("buy_alert_not-a-mint")).toBeNull();
  expect(parseBuyAlertMint("swap_to_SOL_USDC")).toBeNull();
  expect(parseBuyAlertMint(undefined)).toBeNull();
});

test("createBuyAlertKeyboard labels Buy with the group ticker", () => {
  const keyboard = createBuyAlertKeyboard(TIMBA_MINT, "magaiba");
  const button = keyboard.inline_keyboard[0]?.[0];
  expect(button?.text).toBe("BUY MAGAIBA");
  expect(button && "callback_data" in button ? button.callback_data : undefined).toBe(
    buyAlertCallbackData(TIMBA_MINT),
  );
});

test("createBuyAlertKeyboard uses a DM start link when the bot username is known", () => {
  const keyboard = createBuyAlertKeyboard(TIMBA_MINT, "magaiba", "playtimbabot");
  const button = keyboard.inline_keyboard[0]?.[0];
  expect(button?.text).toBe("BUY MAGAIBA");
  expect(button && "url" in button ? button.url : undefined).toBe(
    buyAlertDeepLinkUrl("playtimbabot", TIMBA_MINT),
  );
  expect(buyAlertStartPayload(TIMBA_MINT).length).toBeLessThanOrEqual(64);
});

test("parseBuyAlertStartText reads a /start deep link", () => {
  expect(parseBuyAlertStartText(`/start ${buyAlertStartPayload(TIMBA_MINT)}`)).toBe(TIMBA_MINT);
  expect(parseBuyAlertStartText(`/start@playtimbabot ${buyAlertStartPayload(TIMBA_MINT)}`)).toBe(
    TIMBA_MINT,
  );
  expect(parseBuyAlertStartText("/start")).toBeNull();
  expect(parseBuyAlertStartText("/balance")).toBeNull();
});

test("malformed start payloads do not hijack /start", () => {
  expect(parseBuyAlertStartText("/start ba_not-a-mint")).toBeNull();
  expect(parseBuyAlertStartText("/start leftover")).toBeNull();
  expect(parseBuyAlertStartPayload("ba_")).toBeNull();
  expect(parseBuyAlertStartPayload(undefined)).toBeNull();
});

test("buyAlertButtonLabel falls back and stays within Telegram's button limit", () => {
  expect(buyAlertButtonLabel(undefined)).toBe("BUY TOKEN");
  expect(buyAlertButtonLabel("  ")).toBe("BUY TOKEN");
  const long = "X".repeat(80);
  const label = buyAlertButtonLabel(long);
  expect(label.startsWith("BUY ")).toBe(true);
  expect(label.length).toBeLessThanOrEqual(64);
});

test("createBuyAlertKeyboard ignores a blank bot username", () => {
  const keyboard = createBuyAlertKeyboard(TIMBA_MINT, "TIMBA", "   ");
  const button = keyboard.inline_keyboard[0]?.[0];
  expect(button && "callback_data" in button ? button.callback_data : undefined).toBe(
    buyAlertCallbackData(TIMBA_MINT),
  );
});
