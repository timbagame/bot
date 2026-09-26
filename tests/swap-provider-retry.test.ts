import { describe, expect, test } from "bun:test";
import {
  SWAP_QUOTE_RETRY_LABEL,
  SWAP_QUOTE_RETRY_PREFIX,
  buildSwapProviderRetryKeyboard,
  buildSwapProviderSlowMessage,
  createSwapQuoteRetryStore,
  isSwapProviderUnavailableError,
} from "../src/utils/swap/provider-retry";

describe("isSwapProviderUnavailableError", () => {
  test.each([
    [
      "timeout DOMException",
      Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }),
    ],
    ["abort", Object.assign(new Error("signal"), { name: "AbortError" })],
    ["wrapped timeout", new Error("Failed to request Jupiter order: The operation timed out.")],
    ["error code", Object.assign(new Error("connect"), { code: "ECONNRESET" })],
    ["undici code", Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" })],
    ["http 503", new Error("Jupiter order failed: 503 Service Unavailable - upstream")],
    ["http 429", new Error("Jupiter build failed: 429 Too Many Requests - slow down")],
    ["network", new Error("fetch failed")],
    [
      "cause chain",
      new Error("Failed to request Jupiter order: request failed", {
        cause: Object.assign(new Error("inner"), { name: "TimeoutError" }),
      }),
    ],
    ["plain string", "socket hang up"],
  ])("detects %s", (_label, error) => {
    expect(isSwapProviderUnavailableError(error)).toBe(true);
  });

  test.each([
    ["no route", new Error("Jupiter order error (code 1): No routes found")],
    ["http 400", new Error("Jupiter order failed: 400 Bad Request - invalid mint")],
    ["balance", new Error("Insufficient balance to attempt this swap.")],
    ["null", null],
    ["undefined", undefined],
  ])("ignores %s", (_label, error) => {
    expect(isSwapProviderUnavailableError(error)).toBe(false);
  });

  test("survives cyclic causes", () => {
    const error: any = new Error("Jupiter order error: route");
    error.cause = error;
    expect(isSwapProviderUnavailableError(error)).toBe(false);
  });
});

describe("swap quote retry store", () => {
  test("saves requests behind short callback data", () => {
    const store = createSwapQuoteRetryStore();
    const request = {
      userId: "7",
      fromTokenIdentifier: "SOL",
      toToken: "USDC",
      amount: "0.5",
      overrides: { fromMint: "So11111111111111111111111111111111111111112", fromDecimals: 9 },
    };
    const callback = store.save(request);
    expect(callback.startsWith(SWAP_QUOTE_RETRY_PREFIX)).toBe(true);
    expect(Buffer.byteLength(callback)).toBeLessThanOrEqual(64);
    expect(store.get(callback.slice(SWAP_QUOTE_RETRY_PREFIX.length))).toEqual(request);
    expect(store.get("missing")).toBeUndefined();
    store.clear();
    expect(store.get(callback.slice(SWAP_QUOTE_RETRY_PREFIX.length))).toBeUndefined();
  });

  test("entries expire", async () => {
    const store = createSwapQuoteRetryStore(5);
    const callback = store.save({
      userId: "1",
      fromTokenIdentifier: "A",
      toToken: "B",
      amount: "1",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.get(callback.slice(SWAP_QUOTE_RETRY_PREFIX.length))).toBeUndefined();
  });
});

describe("provider slow copy", () => {
  test("names the exact quote and escapes HTML", () => {
    const text = buildSwapProviderSlowMessage({
      amount: "0.5",
      fromTicker: "SOL",
      toTicker: "<b>X</b>",
    });
    expect(text).toContain("🐢 <b>Provider is slow right now</b>");
    expect(text).toContain("0.5 SOL → &lt;b&gt;X&lt;/b&gt;");
    expect(text).not.toMatch(/[—·]/);
  });

  test("keyboard offers Retry then a way back", () => {
    const keyboard = buildSwapProviderRetryKeyboard("swap_retry_abc", "swap_to_SOL_USDC");
    expect(keyboard.inline_keyboard).toEqual([
      [{ text: SWAP_QUOTE_RETRY_LABEL, callback_data: "swap_retry_abc" }],
      [{ text: "← Change Amount", callback_data: "swap_to_SOL_USDC" }],
    ]);
  });
});
