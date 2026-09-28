import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { botModule, restoreStubs, stub, useBotHarness, wallet } from "./helpers/bot-harness";
import * as feeBudgetRefresh from "../src/utils/fee-budget-refresh";

useBotHarness();

let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  restoreStubs();
  warnSpy.mockRestore();
});

describe("getCachedTokenMetadata", () => {
  test("requires a mint", async () => {
    await expect(botModule.__test_getCachedTokenMetadata("  ")).rejects.toThrow(
      "token mint is required",
    );
  });

  test("rejects metadata without decimals", async () => {
    stub(wallet, "getTokenMetadata", async () => ({ symbol: "ODD" }));

    await expect(
      botModule.__test_getCachedTokenMetadata("NoDecimalsMint1111111111111111111111111111"),
    ).rejects.toThrow("Token metadata missing decimals");
  });
});

describe("refreshSolFeeBuffer", () => {
  test("adopts the refreshed single-transaction budget", async () => {
    const saved = botModule.__test_getSolFeeBufferLamports();
    const refresh = spyOn(feeBudgetRefresh, "refreshDynamicFeeBudgets").mockResolvedValue({
      singleTransactionLamports: 123_456,
    } as any);
    try {
      await botModule.__test_refreshSolFeeBuffer();
      expect(botModule.__test_getSolFeeBufferLamports()).toBe(123_456);
    } finally {
      refresh.mockRestore();
      botModule.__test_setSolFeeBufferLamports(saved);
    }
  });

  test("keeps the cached budget when the refresh fails", async () => {
    const saved = botModule.__test_getSolFeeBufferLamports();
    const refresh = spyOn(feeBudgetRefresh, "refreshDynamicFeeBudgets").mockRejectedValue(
      new Error("rpc down"),
    );
    try {
      await botModule.__test_refreshSolFeeBuffer();

      expect(botModule.__test_getSolFeeBufferLamports()).toBe(saved);
      expect(warnSpy).toHaveBeenCalledWith(
        "Failed to refresh dynamic fee budgets during startup:",
        expect.any(Error),
      );
    } finally {
      refresh.mockRestore();
    }
  });
});

describe("clampSolFeeBufferLamports", () => {
  test("no buffer is kept for zero, negative or non-finite requests", () => {
    expect(botModule.__test_clampSolFeeBufferLamports(1_000_000, 0)).toBe(0);
    expect(botModule.__test_clampSolFeeBufferLamports(1_000_000, -5)).toBe(0);
    expect(botModule.__test_clampSolFeeBufferLamports(1_000_000, Number.NaN)).toBe(0);
  });
});

describe("parseOracleNumeric", () => {
  const parse = botModule.__test_parseOracleNumeric;

  test("rejects non-finite and unsafe numbers", () => {
    expect(parse(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parse(2 ** 60)).toBeNull();
    expect(parse(-(2 ** 60))).toBeNull();
    expect(parse(42)).toBe(42);
  });

  test("converts BN-like values within the safe range", () => {
    expect(parse({ toNumber: () => 7 })).toBe(7);
    expect(parse({ toNumber: () => Number.NaN })).toBeNull();
    expect(parse({ toNumber: () => 2 ** 60 })).toBeNull();
    expect(parse({ toNumber: () => -(2 ** 60) })).toBeNull();
  });

  test("a BN-like value that cannot convert is logged and ignored", () => {
    const tooBig = {
      toNumber: () => {
        throw new Error("Number can only safely store up to 53 bits");
      },
    };

    expect(parse(tooBig)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to convert oracle numeric value:",
      expect.any(Error),
    );
  });
});

describe("formatUsdThresholdLabel", () => {
  const format = botModule.__test_formatUsdThresholdLabel;

  test("shows cents only for small fractional thresholds", () => {
    expect(format(2.5)).toBe("$2.50");
    expect(format(10)).toBe("$10");
    expect(format(1_234.56)).toBe("$1,235");
  });

  test("non-positive or invalid thresholds show $0", () => {
    expect(format(0)).toBe("$0");
    expect(format(-3)).toBe("$0");
    expect(format(Number.NaN)).toBe("$0");
  });
});

describe("resolveFormattedBalance", () => {
  const resolve = botModule.__test_resolveFormattedBalance;
  const tokens = [{ mint: "BonkMint", ticker: "BONK", balance: 1_500_000, decimals: 5 }];

  test("SOL uses the lamport balance", () => {
    expect(resolve("SOL", 2_500_000_000, tokens)).toEqual({
      decimalBalance: 2.5,
      formattedBalance: "2.5",
    });
  });

  test("tokens are found by mint or ticker", () => {
    expect(resolve("BonkMint", 0, tokens).decimalBalance).toBe(15);
    expect(resolve("BONK", 0, tokens)).toEqual({ decimalBalance: 15, formattedBalance: "15" });
  });

  test("unknown tokens have a zero balance", () => {
    expect(resolve("WIF", 0, tokens)).toEqual({ decimalBalance: 0, formattedBalance: "0" });
  });
});

describe("formatSlippagePercent", () => {
  const format = botModule.__test_formatSlippagePercent;

  test("uses more precision for smaller slippage", () => {
    expect(format(1.25)).toBe("1.3%");
    expect(format(0.5)).toBe("0.5%");
    expect(format(0.05)).toBe("0.05%");
    expect(format(0.005)).toBe("0.005%");
  });

  test("zero and invalid values show 0%", () => {
    expect(format(0)).toBe("0%");
    expect(format(Number.NaN)).toBe("0%");
  });
});
