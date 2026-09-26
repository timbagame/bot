import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";

import { createExpiringCache } from "../expiring-cache";
import { escapeHtml } from "../format-amount";

/** Callback prefix for the one-tap retry of a quote that failed on the provider side. */
export const SWAP_QUOTE_RETRY_PREFIX = "swap_retry_";
export const SWAP_QUOTE_RETRY_LABEL = "🔄 Retry";
/** Matches the pending swap transaction lifetime, so a retry never outlives its context. */
export const SWAP_QUOTE_RETRY_TTL_MS = 5 * 60 * 1000;

const PROVIDER_ERROR_NAMES = new Set(["timeouterror", "aborterror"]);
const PROVIDER_ERROR_TOKENS = [
  "timed out",
  "timeout",
  "aborted",
  "etimedout",
  "econnreset",
  "econnrefused",
  "fetch failed",
  "failed to fetch",
  "network request failed",
  "unable to connect",
  "socket hang up",
  "socket connection was closed",
  "bad gateway",
  "gateway timeout",
  "service unavailable",
  "temporarily unavailable",
  "too many requests",
];
// "Jupiter order failed: 503 Service Unavailable - …" and friends.
const PROVIDER_HTTP_STATUS = /jupiter (?:order|build) failed: (429|5\d\d)\b/i;

/**
 * True when a quote failed because the swap provider was slow or unreachable
 * (timeouts, network errors, HTTP 429/5xx), as opposed to a problem with the
 * trade itself (no route, not tradable, insufficient balance). Walks `cause`.
 */
export const isSwapProviderUnavailableError = (
  error: unknown,
  seen: Set<unknown> = new Set(),
): boolean => {
  if (error === null || error === undefined || seen.has(error)) {
    return false;
  }
  seen.add(error);

  if (typeof error === "object") {
    const name = String((error as { name?: unknown }).name ?? "").toLowerCase();
    if (PROVIDER_ERROR_NAMES.has(name)) {
      return true;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^(etimedout|econn|und_err)/i.test(code)) {
      return true;
    }
  }

  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (PROVIDER_HTTP_STATUS.test(message)) {
    return true;
  }
  if (PROVIDER_ERROR_TOKENS.some((token) => message.includes(token))) {
    return true;
  }

  return (
    typeof error === "object" &&
    isSwapProviderUnavailableError((error as { cause?: unknown }).cause, seen)
  );
};

export type SwapQuoteRetryRequest = {
  userId: string;
  fromTokenIdentifier: string;
  toToken: string;
  amount: string;
  overrides?: {
    fromMint?: string;
    fromDecimals?: number;
    toMint?: string;
    toDecimals?: number;
  };
};

export type SwapQuoteRetryStore = {
  /** Remembers the quote parameters and returns the retry button's callback data. */
  save: (request: SwapQuoteRetryRequest) => string;
  /** Resolves a retry payload (the part after the prefix). */
  get: (id: string) => SwapQuoteRetryRequest | undefined;
  clear: () => void;
};

export const createSwapQuoteRetryStore = (
  ttlMs: number = SWAP_QUOTE_RETRY_TTL_MS,
): SwapQuoteRetryStore => {
  const cache = createExpiringCache<SwapQuoteRetryRequest>(ttlMs);
  return {
    save: (request) => {
      const id = randomBytes(6).toString("base64url");
      cache.setWithTTL(id, request, ttlMs);
      return `${SWAP_QUOTE_RETRY_PREFIX}${id}`;
    },
    get: (id) => cache.get(id),
    clear: () => cache.clear(),
  };
};

/**
 * Friendly copy for a provider timeout or outage, naming the exact quote that
 * the Retry button will request again.
 */
export const buildSwapProviderSlowMessage = (params: {
  amount: string;
  fromTicker: string;
  toTicker: string;
}): string => {
  const pair = `${escapeHtml(params.amount)} ${escapeHtml(params.fromTicker)} → ${escapeHtml(
    params.toTicker,
  )}`;
  return [
    "🐢 <b>Provider is slow right now</b>",
    "",
    `The swap provider didn't answer in time for ${pair}.`,
    "Nothing was swapped. Tap <b>Retry</b> to ask again with the same amount.",
  ].join("\n");
};

export const buildSwapProviderRetryKeyboard = (
  retryCallback: string,
  backCallback: string,
): InlineKeyboard =>
  new InlineKeyboard()
    .text(SWAP_QUOTE_RETRY_LABEL, retryCallback)
    .row()
    .text("← Change Amount", backCallback);
