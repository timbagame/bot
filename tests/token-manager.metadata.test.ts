import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { TokenManager } from "../src/utils/token-manager";
import { TokenDatabase } from "../src/utils/token-database";
import { contractCapabilities } from "../src/utils/contract-idl";
import { WSOL_MINT } from "../src/utils/constants";
import { getBuiltinTokenMetadataByMint } from "../src/utils/token-registry";
import { createWalletStub, resetTokenManagerState } from "./helpers/fixtures";

// Fake but valid base58 mints that are not builtin tokens.
const UNKNOWN_MINT = "FakeTokenMint1111111111111111111111111111111";
const OTHER_MINT = "FakeTokenMint2222222222222222222222222222222";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WBTC_MINT = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const TIMBA_MINT = "F3A1baCgv4TF79TSjdMTvpMDtNv8DJvHZwNc9DG8pump";

type FullMetadata = { decimals: number; symbol: string; name: string };
const full = (overrides: Partial<Record<keyof FullMetadata, unknown>> = {}) =>
  ({ decimals: 6, symbol: "DISC", name: "Discovered", ...overrides }) as FullMetadata;

const makeManager = (walletOverrides: Parameters<typeof createWalletStub>[0] = {}) =>
  TokenManager.getInstance(createWalletStub(walletOverrides), "DEFMINT", "DEF");

beforeEach(() => {
  resetTokenManagerState();
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTokenManagerState();
});

describe("TokenManager initialization", () => {
  test("first getInstance without wallet and default token info fails", () => {
    expect(() => TokenManager.getInstance()).toThrow(
      "TokenManager first initialization requires wallet and default token info",
    );
    expect(() => TokenManager.getInstance(createWalletStub(), "", "TOK")).toThrow(
      "requires wallet and default token info",
    );
  });
});

describe("addToken decimals validation", () => {
  test("rejects non-finite, fractional, negative and oversized decimals", async () => {
    const tm = makeManager();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 19]) {
      expect(await tm.addToken(UNKNOWN_MINT, "BAD", bad)).toBe(false);
    }
    expect(tm.getTokenCount()).toBe(0);
    expect(await tm.addToken(UNKNOWN_MINT, "good", 18)).toBe(true);
    expect(tm.getKnownTokenByMint(UNKNOWN_MINT)).toMatchObject({
      token_ticker: "GOOD",
      decimals: 18,
    });
  });

  test("rejects invalid decimals reported by the wallet and logs the failure", async () => {
    const tm = makeManager({ getTokenMetadata: async () => ({ decimals: 40 }) });

    expect(await tm.addToken(UNKNOWN_MINT, "big")).toBe(false);

    expect(tm.getTokenCount()).toBe(0);
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(logged[0]?.[0])).toContain("Error adding token big:");
    expect(String(logged[0]?.[1])).toContain("Invalid token decimals received for BIG");
  });
});

describe("autoDiscoverTokenInfo metadata resolution", () => {
  test("uses builtin ticker and decimals without calling the wallet", async () => {
    const getFull = vi.fn(async () => full());
    const getToken = vi.fn(async () => ({ decimals: 1 }));
    const tm = makeManager({ getFullTokenMetadata: getFull, getTokenMetadata: getToken });

    expect(await tm.autoDiscoverTokenInfo(USDC_MINT)).toEqual({ ticker: "USDC", decimals: 6 });
    expect(getFull).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  test("falls back to on-chain decimals and a TOKEN_ ticker when full metadata fails", async () => {
    const tm = makeManager({
      getFullTokenMetadata: async () => {
        throw new Error("metadata service down");
      },
      getTokenMetadata: async () => ({ decimals: 4 }),
    });

    expect(await tm.autoDiscoverTokenInfo(UNKNOWN_MINT)).toEqual({
      ticker: `TOKEN_${UNKNOWN_MINT.toUpperCase()}`,
      decimals: 4,
    });
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(warnings[0]?.[0])).toContain(`Failed to fetch full metadata for ${UNKNOWN_MINT}`);
  });

  test("ignores empty, whitespace and UNKNOWN symbols", async () => {
    for (const symbol of [null, "   ", "UNKNOWN"]) {
      resetTokenManagerState();
      const tm = makeManager({
        getFullTokenMetadata: async () => full({ symbol, decimals: 7 }),
      });
      expect(await tm.autoDiscoverTokenInfo(UNKNOWN_MINT)).toEqual({
        ticker: `TOKEN_${UNKNOWN_MINT.toUpperCase()}`,
        decimals: 7,
      });
    }
  });

  test("returns null when no source provides valid decimals", async () => {
    const tm = makeManager({
      getFullTokenMetadata: async () => full({ decimals: 99 }),
      getTokenMetadata: async () => {
        throw new Error("rpc down");
      },
    });

    expect(await tm.autoDiscoverTokenInfo(UNKNOWN_MINT)).toBeNull();
    expect((tm as unknown as { lastMetadataFailure: unknown }).lastMetadataFailure).toEqual({
      reason: "invalid_decimals",
      mint: UNKNOWN_MINT,
    });
  });
});

describe("registerTokenIfNeeded", () => {
  test("reports tokens that are already registered without resolving metadata", async () => {
    const getFull = vi.fn(async () => full());
    const tm = makeManager({ getFullTokenMetadata: getFull });
    await tm.addToken(UNKNOWN_MINT, "KNOWN", 5);

    const result = await tm.registerTokenIfNeeded({ mint: UNKNOWN_MINT, source: "Test" });

    expect(result.status).toBe("already_registered");
    expect(result.resolvedTicker).toBe("KNOWN");
    expect(result.token).toMatchObject({ token_mint: UNKNOWN_MINT, decimals: 5 });
    expect(getFull).not.toHaveBeenCalled();
    const logs = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logs.map((c) => String(c[0]))).toContain(
      `[Test] Token already registered: KNOWN (${UNKNOWN_MINT})`,
    );
  });

  test("walks custom resolvers, skipping empty, null and throwing ones", async () => {
    const getFull = vi.fn(async () => full());
    const tm = makeManager({ getFullTokenMetadata: getFull });
    const calls: string[] = [];

    const result = await tm.registerTokenIfNeeded({
      mint: OTHER_MINT,
      metadataResolvers: [
        undefined as never,
        async () => {
          calls.push("null");
          return null;
        },
        async () => {
          calls.push("throws");
          throw new Error("resolver exploded");
        },
        async () => {
          calls.push("good");
          return { symbol: "resolved", decimals: 7 };
        },
        async () => {
          calls.push("after-break");
          return { symbol: "late", decimals: 2 };
        },
      ],
    });

    expect(calls).toEqual(["null", "throws", "good"]);
    expect(result).toMatchObject({ status: "registered", resolvedTicker: "RESOLVED" });
    expect(tm.getKnownTokenByMint(OTHER_MINT)).toMatchObject({
      token_ticker: "RESOLVED",
      decimals: 7,
    });
    // Resolver supplied ticker and decimals, so the wallet was never consulted.
    expect(getFull).not.toHaveBeenCalled();
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(warnings[0]?.[0])).toContain(`Metadata resolver failed for ${OTHER_MINT}`);
  });

  test("asks the wallet for decimals when a resolver only supplies a symbol", async () => {
    const getFull = vi.fn(async () => full({ decimals: 3, symbol: "WALLETSYM" }));
    const tm = makeManager({ getFullTokenMetadata: getFull });

    const result = await tm.registerTokenIfNeeded({
      mint: OTHER_MINT,
      metadataResolvers: [async () => ({ symbol: "fromresolver" })],
    });

    expect(getFull).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("registered");
    // The wallet's symbol overrides the resolver's, and its decimals fill the gap.
    expect(tm.getKnownTokenByMint(OTHER_MINT)).toMatchObject({
      token_ticker: "WALLETSYM",
      decimals: 3,
    });
  });

  test("fails with the uppercased hint when no metadata can be resolved", async () => {
    const tm = makeManager({
      getFullTokenMetadata: async () => {
        throw new Error("down");
      },
      getTokenMetadata: async () => {
        throw new Error("down");
      },
    });

    const result = await tm.registerTokenIfNeeded({ mint: OTHER_MINT, tickerHint: " hint " });

    expect(result).toEqual({ status: "failed", resolvedTicker: "HINT" });
    expect(tm.getTokenCount()).toBe(0);
  });

  test("registers the wrapped SOL mint under the WSOL ticker", async () => {
    const tm = makeManager();

    const result = await tm.registerTokenIfNeeded({ mint: WSOL_MINT });

    expect(result.status).toBe("registered");
    expect(result.resolvedTicker).toBe("WSOL");
    expect(tm.getKnownTokenByMint(WSOL_MINT)).toMatchObject({
      token_ticker: "WSOL",
      decimals: 9,
    });
  });

  test("reports failure when the token cannot be stored", async () => {
    const tm = makeManager();
    spyOn(TokenDatabase.getInstance(), "addKnownToken").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await tm.registerTokenIfNeeded({ mint: OTHER_MINT, tickerHint: "oops" });

    // The wallet-reported symbol takes precedence over the caller's hint.
    expect(result).toEqual({ status: "failed", resolvedTicker: "DISC" });
    expect(tm.getKnownTokenByMint(OTHER_MINT)).toBeNull();
    const logs = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logs.some((c) => String(c[0]).includes("Failed to auto-register token"))).toBe(true);
  });
});

describe("resolveTokenForChat fallbacks", () => {
  test("falls back to the default token when the chat token cannot be resolved", async () => {
    const tm = makeManager({
      getFullTokenMetadata: async (mint: string) => {
        if (mint === OTHER_MINT) throw new Error("no metadata");
        return full({ decimals: 5 });
      },
      getTokenMetadata: async (mint: string) => {
        if (mint === OTHER_MINT) throw new Error("no metadata");
        return { decimals: 5 };
      },
    });
    tm.setChatDefaultToken(77, OTHER_MINT, "BROKEN", "1");

    expect(await tm.resolveTokenForChat(77)).toEqual({
      tokenMint: "DEFMINT",
      tokenTicker: "DEF",
      decimals: 5,
    });
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(
      warnings.some((c) =>
        String(c[0]).includes(
          `Failed to resolve metadata for chat token BROKEN (${OTHER_MINT}), falling back to default token`,
        ),
      ),
    ).toBe(true);
  });

  test("uses zero decimals when even the default token cannot be resolved", async () => {
    const tm = makeManager({
      getFullTokenMetadata: async () => {
        throw new Error("down");
      },
      getTokenMetadata: async () => {
        throw new Error("down");
      },
    });

    expect(await tm.resolveTokenForChat()).toEqual({
      tokenMint: "DEFMINT",
      tokenTicker: "DEF",
      decimals: 0,
    });
  });
});

describe("resolveMintForTicker", () => {
  test("returns undefined for empty or whitespace tickers", async () => {
    const tm = makeManager();
    expect(await tm.resolveMintForTicker("")).toBeUndefined();
    expect(await tm.resolveMintForTicker("   ")).toBeUndefined();
  });
});

describe("resolveSwapToken edge cases", () => {
  test("returns null for blank input", async () => {
    expect(await makeManager().resolveSwapToken("   ")).toBeNull();
  });

  test("finds a stored token whose mint is not valid base58", async () => {
    const tm = makeManager();
    await tm.addToken("legacy-mint!", "LEGACY", 3);

    expect(await tm.resolveSwapToken("legacy-mint!")).toMatchObject({
      token_mint: "legacy-mint!",
      token_ticker: "LEGACY",
      decimals: 3,
    });
    expect(await tm.resolveSwapToken("not-stored!")).toBeNull();
  });

  test("resolves builtin mints that are not registered game tokens from the builtin table", async () => {
    const getFull = vi.fn(async () => full());
    const tm = makeManager({ getFullTokenMetadata: getFull });

    const resolved = await tm.resolveSwapToken(WBTC_MINT);

    expect(resolved).toMatchObject({
      token_mint: WBTC_MINT,
      token_ticker: "WBTC",
      decimals: 8,
    });
    expect(resolved?.isNativeSol).toBeFalsy();
    expect(getFull).not.toHaveBeenCalled();
    expect(tm.getTokenCount()).toBe(0);
  });

  test("builtin mint helper names native SOL by the input the user typed", () => {
    const tm = makeManager();
    const resolve = (
      tm as unknown as {
        resolveBuiltinMintToken: (
          metadata: ReturnType<typeof getBuiltinTokenMetadataByMint> | null,
          input: string,
        ) => Record<string, unknown> | null;
      }
    ).resolveBuiltinMintToken.bind(tm);
    const wsol = getBuiltinTokenMetadataByMint(WSOL_MINT);

    expect(resolve(null, "x")).toBeNull();
    expect(resolve(wsol, " sol ")).toMatchObject({
      token_mint: WSOL_MINT,
      token_ticker: "SOL",
      decimals: 9,
      isNativeSol: true,
    });
    expect(resolve(wsol, WSOL_MINT)).toMatchObject({ token_ticker: "WSOL", isNativeSol: false });
    expect(
      resolve({ mint: "other-mint", ticker: "ODD", decimals: 2, isNativeSol: true }, "x"),
    ).toMatchObject({ token_mint: "other-mint", token_ticker: "ODD", isNativeSol: false });
  });

  test("records invalid decimals in the failure sink and stops without auto-discovery", async () => {
    const getToken = vi.fn(async () => ({ decimals: 99 }));
    const tm = makeManager({
      getFullTokenMetadata: async () => full({ decimals: 99 }),
      getTokenMetadata: getToken,
    });
    const sink: { value: { reason: "invalid_decimals"; mint: string } | null } = { value: null };

    const resolved = await tm.resolveSwapToken(TIMBA_MINT, {
      allowAutoDiscover: false,
      metadataFailureSink: sink,
    });

    expect(resolved).toBeNull();
    expect(sink.value).toEqual({ reason: "invalid_decimals", mint: TIMBA_MINT });
    expect((tm as unknown as { lastMetadataFailure: unknown }).lastMetadataFailure).toEqual(
      sink.value,
    );
    expect(tm.getTokenCount()).toBe(0);
  });

  test("allowAutoDiscover=false without a failure leaves the sink empty", async () => {
    const tm = makeManager();
    const sink: { value: { reason: "invalid_decimals"; mint: string } | null } = { value: null };

    expect(
      await tm.resolveSwapToken(UNKNOWN_MINT, {
        allowAutoDiscover: false,
        metadataFailureSink: sink,
      }),
    ).toBeNull();
    expect(sink.value).toBeNull();
  });
});

describe("resolveGameTokenContext", () => {
  test("reports unknown_token when swap token resolution throws", async () => {
    const tm = makeManager();
    spyOn(tm, "resolveSwapToken").mockRejectedValue(new Error("db exploded"));

    expect(await tm.resolveGameTokenContext(1, "weird", "game")).toEqual({
      success: false,
      error: "unknown_token",
      unknownToken: "WEIRD",
    });
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(String(warnings[0]?.[0])).toContain("Failed to resolve token weird:");
  });

  test("treats a default token named SOL as native SOL in game context", async () => {
    const tm = TokenManager.getInstance(createWalletStub(), "SOL", "SOL");

    expect(await tm.resolveGameTokenContext(undefined, undefined, "game")).toEqual({
      success: true,
      tokenMint: "SOL",
      tokenTicker: "SOL",
      decimals: 9,
      isSol: true,
      tokenWasSpecified: false,
      requestedNativeSol: false,
    });
  });

  test("game token support without a chat default follows the contract policy", async () => {
    const tm = makeManager();
    await tm.addToken(UNKNOWN_MINT, "SIDE", 6);

    const resolved = await tm.resolveGameTokenContext(undefined, "SIDE", "game");

    expect(resolved.success).toBe(contractCapabilities.oracleTokenPolicy);
    if (!resolved.success) expect(resolved.error).toBe("unsupported_token");

    const supports = (
      tm as unknown as { isTokenSupportedForGames: (mint: string, isSol?: boolean) => boolean }
    ).isTokenSupportedForGames.bind(tm);
    expect(supports("anything", true)).toBe(true);
    // A blank mint is only rejected when the Oracle policy does not decide support.
    expect(supports("   ", false)).toBe(contractCapabilities.oracleTokenPolicy);
  });
});

describe("TokenManager missing-decimals handling", () => {
  test("invalid decimals from the wallet become an unsupported token for explicit mints", async () => {
    const tm = makeManager({
      getFullTokenMetadata: async () => full({ decimals: 99 }),
      getTokenMetadata: async () => ({ decimals: 99 }),
    });

    const resolved = await tm.resolveGameTokenContext(1, TIMBA_MINT, "game");

    expect(resolved).toEqual({
      success: false,
      error: "unsupported_token",
      unknownToken: TIMBA_MINT.toUpperCase(),
    });
  });
});
