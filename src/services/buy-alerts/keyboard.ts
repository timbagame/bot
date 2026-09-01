import { InlineKeyboard } from "grammy";
import { PublicKey } from "@solana/web3.js";

export const BUY_ALERT_CALLBACK_PREFIX = "buy_alert_";
export const BUY_ALERT_START_PREFIX = "ba_";
const BUY_ALERT_BUTTON_MAX = 64;

export function buyAlertCallbackData(mint: string): string {
  return `${BUY_ALERT_CALLBACK_PREFIX}${mint.trim()}`;
}

function normalizeMint(mint: string): string | null {
  const trimmed = mint.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return null;
  }
}

export function parseBuyAlertMint(callbackData: string | undefined): string | null {
  const raw = String(callbackData ?? "");
  if (!raw.startsWith(BUY_ALERT_CALLBACK_PREFIX)) {
    return null;
  }
  return normalizeMint(raw.slice(BUY_ALERT_CALLBACK_PREFIX.length));
}

export function buyAlertStartPayload(mint: string): string {
  return `${BUY_ALERT_START_PREFIX}${mint.trim()}`;
}

export function parseBuyAlertStartPayload(payload: string | undefined): string | null {
  const raw = String(payload ?? "").trim();
  if (!raw.startsWith(BUY_ALERT_START_PREFIX)) {
    return null;
  }
  return normalizeMint(raw.slice(BUY_ALERT_START_PREFIX.length));
}

export function parseBuyAlertStartText(text: string | undefined): string | null {
  const match = String(text ?? "").match(/^\/start(?:@\w+)?\s+(\S+)/i);
  if (!match?.[1]) {
    return null;
  }
  return parseBuyAlertStartPayload(match[1]);
}

export function buyAlertDeepLinkUrl(botUsername: string, mint: string): string {
  const username = botUsername.trim().replace(/^@+/, "");
  return `https://t.me/${username}?start=${buyAlertStartPayload(mint)}`;
}

export function buyAlertButtonLabel(ticker: string | undefined): string {
  const symbol = ticker?.trim().replace(/\s+/g, "") || "TOKEN";
  const label = `BUY ${symbol.toUpperCase()}`;
  if (label.length <= BUY_ALERT_BUTTON_MAX) {
    return label;
  }
  return `BUY ${symbol.toUpperCase().slice(0, BUY_ALERT_BUTTON_MAX - 4)}`;
}

export function createBuyAlertKeyboard(
  mint: string,
  ticker?: string,
  botUsername?: string,
): InlineKeyboard {
  const label = buyAlertButtonLabel(ticker);
  const username = botUsername?.trim();
  if (username) {
    return new InlineKeyboard().url(label, buyAlertDeepLinkUrl(username, mint));
  }
  return new InlineKeyboard().text(label, buyAlertCallbackData(mint));
}
