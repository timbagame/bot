import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  buildTokenList,
  getTokenByMint,
  getTokenByTicker,
  getSupportedTokens,
  requireTokenByMint,
  requireTokenByTicker,
  resolveDefaultToken,
  WSOL_MINT,
} from "../src/utils/token-registry";
import { NetworkDetector, type SolanaNetwork } from "../src/utils/network-detector";

const ORIGINAL_ENV = {
  DEFAULT_TOKEN_MINT: process.env.DEFAULT_TOKEN_MINT,
  DEFAULT_TOKEN_TICKER: process.env.DEFAULT_TOKEN_TICKER,
};

const restoreDefaultTokenEnv = () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

describe("token-registry", () => {
  let networkSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    restoreDefaultTokenEnv();
    networkSpy?.mockRestore();
  });

  afterEach(() => {
    restoreDefaultTokenEnv();
    networkSpy?.mockRestore();
  });

  test("resolveDefaultToken prefers env overrides and trims values", () => {
    process.env.DEFAULT_TOKEN_MINT = "  CustomMint  ";
    process.env.DEFAULT_TOKEN_TICKER = "  cust  ";

    const token = resolveDefaultToken();

    expect(token).toEqual({ mint: "CustomMint", ticker: "cust" });
  });

  test("resolveDefaultToken falls back to network defaults when overrides blank", () => {
    process.env.DEFAULT_TOKEN_MINT = "  ";
    process.env.DEFAULT_TOKEN_TICKER = "";
    networkSpy = spyOn(NetworkDetector, "getCurrentNetwork").mockReturnValue(
      "devnet" as SolanaNetwork,
    );

    const token = resolveDefaultToken();

    expect(token.ticker).toBe("TIMBA");
  });

  test("buildTokenList dedupes default token and respects includeDefault", () => {
    networkSpy = spyOn(NetworkDetector, "getCurrentNetwork").mockReturnValue("mainnet");

    const defaultToken = { mint: WSOL_MINT, ticker: "WSOL" };
    const withoutDefault = buildTokenList({ includeDefault: false, defaultToken });
    expect(withoutDefault.find((token) => token.mint === WSOL_MINT)).toBeDefined();

    const withCustomDefault = buildTokenList({ defaultToken });
    const occurrences = withCustomDefault.filter((token) => token.mint === WSOL_MINT);
    expect(occurrences).toHaveLength(1);
  });

  test("getSupportedTokens honors custom defaults", () => {
    const customDefault = { mint: "Custom", ticker: "CSTM" };
    networkSpy = spyOn(NetworkDetector, "getCurrentNetwork").mockReturnValue("mainnet");

    const tokens = getSupportedTokens({ defaultToken: customDefault });
    expect(tokens).toContainEqual(customDefault);
  });

  test("getToken lookups normalize ticker and mint values", () => {
    const tokens = getSupportedTokens();
    const ticker = tokens[0]?.ticker ?? "TIMBA";
    const mint = tokens[0]?.mint ?? "unknown";

    expect(getTokenByTicker(ticker.toLowerCase())).toEqual(getTokenByTicker(ticker.toUpperCase()));
    expect(getTokenByMint(`  ${mint}  `)?.mint).toBe(mint);
  });

  test("requireToken helpers throw for missing entries", () => {
    expect(() => requireTokenByTicker("missing")).toThrowError(/Token missing is not configured/);
    expect(() => requireTokenByMint("missing")).toThrowError(
      /Token mint missing is not configured/,
    );
  });
  test("requireToken helpers return configured entries", () => {
    networkSpy = spyOn(NetworkDetector, "getCurrentNetwork").mockReturnValue("mainnet");
    const wsol = getTokenByMint(WSOL_MINT);
    expect(wsol).toBeDefined();

    expect(requireTokenByMint(`  ${WSOL_MINT} `)).toEqual(wsol!);
    expect(requireTokenByTicker(wsol!.ticker.toLowerCase())).toEqual(wsol!);
  });
});
