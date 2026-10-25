import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { formatParseAmountError, TokenManager } from "../src/utils/token-manager";
import * as amountModule from "../src/utils/amount";
import * as priceService from "../src/utils/price-service";
import { __test_clearPriceServiceCache } from "../src/utils/price-service";
import type { ParseAmountResult } from "../src/types";
import { createWalletStub, resetTokenManagerState } from "./helpers/fixtures";

const priceLookup = (price: number) => ({
  price,
  identifier: "TOK",
  resolvedAt: 1_000,
});

const makeManager = () => TokenManager.getInstance(createWalletStub(), "MINT", "TOK");

type Failure = Extract<ParseAmountResult, { success: false }>;
const failure = (result: ParseAmountResult): Failure => {
  if (result.success) throw new Error("expected a failed parse");
  return result;
};

beforeEach(() => {
  resetTokenManagerState();
  __test_clearPriceServiceCache();
  spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTokenManagerState();
});

describe("parseAmount argument validation", () => {
  test("rejects missing, empty and marker-only amounts", async () => {
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf"], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
    });
    expect(await tm.parseAmount(["/cf", ""], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
    });
    expect(await tm.parseAmount(["/cf", "$"], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
    });
    expect(await tm.parseAmount(["/cf", " $ "], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
    });
  });

  test("rejects a non-numeric token amount", async () => {
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf", "abc"], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
    });
    expect(await tm.parseAmount(["/cf", "abc", "USDC"], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
    });
  });

  test("reports unknown tokens that are neither tickers nor mints", async () => {
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf", "1", "ab1c"], 1, 1, "game")).toEqual({
      success: false,
      error: "unknown_token",
      unknownToken: "AB1C",
    });
  });
});

describe("parseAmount USD conversion failures", () => {
  test("marker amounts that are not numbers are invalid, not unsupported", async () => {
    const priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue(priceLookup(1));
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf", "$abc"], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
      reason: undefined,
    });
    // Parsing fails before any price lookup is attempted.
    expect(priceSpy).not.toHaveBeenCalled();
  });

  test("hint amounts that are not numbers are invalid", async () => {
    spyOn(priceService, "getUsdPrice").mockResolvedValue(priceLookup(1));
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf", "abc", "USD"], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
      reason: undefined,
    });
  });

  test("a parser overflow is reported as amount_too_large", async () => {
    spyOn(priceService, "getUsdPrice").mockResolvedValue(priceLookup(1));
    spyOn(amountModule, "parseDecimalAmount").mockImplementation(() => {
      throw new Error("Amount is too large");
    });
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf", "$5"], 1, 1, "game")).toEqual({
      success: false,
      error: "amount_too_large",
      reason: undefined,
    });
    expect(await tm.parseAmount(["/cf", "5"], 1, 1, "game")).toEqual({
      success: false,
      error: "amount_too_large",
    });
  });

  test("marker amounts without a usable price report pricing as unavailable", async () => {
    const lookup = spyOn(priceService, "getUsdPrice").mockResolvedValue(null);
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf", "$5"], 1, 1, "game")).toEqual({
      success: false,
      error: "unsupported_token",
      unknownToken: "USD",
      reason: "fiat_pricing_unavailable",
    });

    lookup.mockResolvedValue(priceLookup(1e-30));
    // A price too small to scale into a non-zero integer is unusable as well.
    expect(await tm.parseAmount(["/cf", "$5"], 1, 1, "game")).toEqual({
      success: false,
      error: "unsupported_token",
      unknownToken: "USD",
      reason: "fiat_pricing_unavailable",
    });
    expect(await tm.parseAmount(["/cf", "5", "USD"], 1, 1, "game")).toEqual({
      success: false,
      error: "unsupported_token",
      unknownToken: "USD",
      reason: "fiat_pricing_unavailable",
    });
  });

  test("amounts below one raw unit are reported as too small", async () => {
    // $0.000001 at $1,000,000 per token with 6 decimals is less than one raw unit.
    spyOn(priceService, "getUsdPrice").mockResolvedValue(priceLookup(1_000_000));
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf", "$0.000001"], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
      reason: "fiat_amount_too_small",
    });
    expect(await tm.parseAmount(["/cf", "0.000001", "USD"], 1, 1, "game")).toEqual({
      success: false,
      error: "invalid_amount",
      reason: "fiat_amount_too_small",
    });
  });

  test("results beyond the safe integer range are reported as too large", async () => {
    spyOn(priceService, "getUsdPrice").mockResolvedValue(priceLookup(1e-9));
    const tm = makeManager();

    expect(await tm.parseAmount(["/cf", "$1000000"], 1, 1, "game")).toEqual({
      success: false,
      error: "amount_too_large",
      reason: undefined,
    });
    expect(await tm.parseAmount(["/cf", "1000000", "USD"], 1, 1, "game")).toEqual({
      success: false,
      error: "amount_too_large",
      reason: undefined,
    });
  });

  test("failure objects carry the structured error for the formatter", async () => {
    spyOn(priceService, "getUsdPrice").mockResolvedValue(priceLookup(1_000_000));
    const result = failure(await makeManager().parseAmount(["/cf", "$0.000001"], 1, 1, "game"));

    expect(formatParseAmountError(result, "fallback")).toBe(
      "❌ USD amount is too small for this token's minimum units. Please try a larger amount.",
    );
  });
});

describe("formatParseAmountError", () => {
  const failed = (
    error: Failure["error"],
    extra: Partial<Omit<Failure, "success" | "error">> = {},
  ): ParseAmountResult => ({ success: false, error, ...extra });

  test("returns the fallback for successful or unrecognised results", () => {
    const ok: ParseAmountResult = {
      success: true,
      data: {
        amount: 1,
        isSol: false,
        formattedAmount: "1 TOK",
        tokenMint: "MINT",
        tokenTicker: "TOK",
        decimals: 0,
        tokenWasSpecified: false,
      },
    };
    expect(formatParseAmountError(ok, "fallback")).toBe("fallback");
    expect(formatParseAmountError(failed("something_else" as never), "fallback")).toBe("fallback");
  });

  test("describes invalid amounts by reason", () => {
    expect(formatParseAmountError(failed("invalid_amount"), "fallback")).toBe("fallback");
    expect(
      formatParseAmountError(
        failed("invalid_amount", { reason: "fiat_pricing_unavailable" }),
        "fallback",
      ),
    ).toBe(
      "❌ USD pricing is unavailable right now for the selected token. Please provide the token amount directly.",
    );
    expect(
      formatParseAmountError(
        failed("invalid_amount", { reason: "fiat_amount_too_small" }),
        "fallback",
      ),
    ).toBe(
      "❌ USD amount is too small for this token's minimum units. Please try a larger amount.",
    );
  });

  test("describes oversized amounts", () => {
    expect(formatParseAmountError(failed("amount_too_large"), "fallback")).toBe(
      "Amount is too large; please use a smaller value.",
    );
  });

  test("escapes the unknown token name, or falls back when it is missing", () => {
    expect(
      formatParseAmountError(failed("unknown_token", { unknownToken: "<B>&" }), "fallback"),
    ).toBe("❌ Unknown token <code>&lt;B&gt;&amp;</code>");
    expect(formatParseAmountError(failed("unknown_token"), "fallback")).toBe("fallback");
  });

  test("describes unsupported tokens with and without a name", () => {
    expect(
      formatParseAmountError(failed("unsupported_token", { unknownToken: "A<B" }), "fallback"),
    ).toBe("❌ <code>A&lt;B</code> is not supported yet. Contact an admin if you'd like it added.");
    expect(formatParseAmountError(failed("unsupported_token"), "fallback")).toBe(
      "❌ This token is not supported yet. Contact an admin if you'd like it added.",
    );
    expect(
      formatParseAmountError(
        failed("unsupported_token", { unknownToken: "USD", reason: "fiat_pricing_unavailable" }),
        "fallback",
      ),
    ).toBe(
      "❌ USD pricing is unavailable for this token. Please specify the token amount instead.",
    );
  });
});
