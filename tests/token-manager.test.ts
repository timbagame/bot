import { describe, beforeEach, expect, test, vi } from "bun:test";
import { Keypair } from "#solana";
import { TokenManager } from "../src/utils/token-manager";
import { ChatDatabase } from "../src/utils/chat-database";
import { TokenDatabase } from "../src/utils/token-database";
import { WSOL_MINT, TOKEN_MANAGER_KNOWN_CACHE_TTL_MS } from "../src/utils/constants";
import * as priceService from "../src/utils/price-service";
import { __test_clearPriceServiceCache } from "../src/utils/price-service";
import { createWalletStub, resetTokenManagerState } from "./helpers/fixtures";
import { contractCapabilities } from "../src/utils/contract-idl";
import { resetTestDatabase } from "./helpers/database";

// Clean DBs and singletons before each test
beforeEach(() => {
  resetTokenManagerState();
  __test_clearPriceServiceCache();
  vi.restoreAllMocks();
});

const mockPriceLookup = (price: number, identifier: string) => ({
  price,
  identifier,
  resolvedAt: Date.now(),
});

test("parseAmount maps SOL to WSOL for game context", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const res = await tm.parseAmount(["/cf", "1", "SOL"], 1, 123, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }
  const data = res.data;
  expect(data.isSol).toBe(false);
  expect(data.requestedNativeSol).toBe(true);
  expect(data.tokenMint).toBe(WSOL_MINT);
  expect(data.tokenTicker).toBe("SOL");
  expect(await tm.resolveMintForTicker("SOL")).toBe(WSOL_MINT);
  expect(await tm.resolveMintForTicker("wsol")).toBe(WSOL_MINT);
});

test("resolveGameTokenContext falls back to chat defaults", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const chatDb = ChatDatabase.getInstance();
  chatDb.setChatDefaultToken(555, WSOL_MINT, "WSOL", "999");
  await tm.addToken(WSOL_MINT, "WSOL", 9);

  const resolved = await tm.resolveGameTokenContext(555);
  if (!resolved.success) {
    throw new Error("expected chat token resolution to succeed");
  }

  expect(resolved.tokenMint).toBe(WSOL_MINT);
  expect(resolved.tokenTicker).toBe("WSOL");
  expect(resolved.decimals).toBe(9);
});

test("resolveGameTokenContext defers v0.3 support decisions to Oracle policy", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const unsupportedMint = (await Keypair.generate()).publicKey.toBase58();
  await tm.addToken(unsupportedMint, "SIDE", 6);

  const resolved = await tm.resolveGameTokenContext(123, "SIDE", "game");
  expect(resolved.success).toBe(contractCapabilities.oracleTokenPolicy);
  if (contractCapabilities.oracleTokenPolicy) {
    if (!resolved.success) throw new Error("expected v0.3 token resolution to succeed");
    expect(resolved.tokenMint).toBe(unsupportedMint);
    return;
  }
  if (resolved.success) {
    throw new Error("expected failure for unsupported game token");
  }
  expect(resolved.error).toBe("unsupported_token");
});

test("resolveMintForTicker returns default token mint for default ticker", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "DEFAULT_MINT", "DEF");
  expect(await tm.resolveMintForTicker("def")).toBe("DEFAULT_MINT");
});

test("resolveMintForTicker prefers known tokens over built-ins", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const overrideBonkMint = "TokenMint11111111111111111111111111111111";
  // Register BONK with a synthetic mint to ensure DB lookup wins over alias map
  await tm.addToken(overrideBonkMint, "BONK");
  expect(await tm.resolveMintForTicker("BONK")).toBe(overrideBonkMint);
});

test("parseAmount accepts SOL for tips and formats as SOL", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const res = await tm.parseAmount(["/tip", "1.5", "SOL"], 1, 42, "tip");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }
  const d = res.data;
  expect(d.isSol).toBe(true);
  expect(d.tokenTicker).toBe("SOL");
  expect(d.formattedAmount).toContain("SOL");
  expect(d.requestedNativeSol).toBe(true);
});

test("parseAmount reports unknown token tickers distinctly", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const res = await tm.parseAmount(["/cf", "10", "UNKN"], 1, 1, "game");
  if (res.success) {
    throw new Error("expected unknown token failure");
  }
  expect(res.error).toBe("unknown_token");
  expect(res.unknownToken).toBe("UNKN");
});

test("parseAmount converts USD hints using chat/default token pricing", async () => {
  vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(mockPriceLookup(0.5, "TOK"));
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  await tm.addToken("MINT", "TOK", 6);

  const res = await tm.parseAmount(["/cf", "12", "USD"], 1, 1, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  expect(res.data.amount).toBe(24_000_000);
  expect(res.data.tokenMint).toBe("MINT");
  expect(res.data.tokenTicker).toBe("TOK");
  expect(res.data.tokenWasSpecified).toBe(true);
  expect(res.data.formattedAmount).toContain("TOK");
});

test("parseAmount supports USD hints for tips and withdrawals (argIndex != 1)", async () => {
  vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(mockPriceLookup(0.5, "TOK"));
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  await tm.addToken("MINT", "TOK", 6);

  const res = await tm.parseAmount(["/withdraw", "ADDR", "10", "USD"], 2, 1, "tip");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  expect(res.data.amount).toBe(20_000_000);
  expect(res.data.tokenMint).toBe("MINT");
  expect(res.data.tokenTicker).toBe("TOK");
  expect(res.data.tokenWasSpecified).toBe(true);
});

test("parseAmount supports $-prefixed USD amounts without explicit token", async () => {
  vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(mockPriceLookup(2, "TOK"));
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  await tm.addToken("MINT", "TOK", 6);

  const res = await tm.parseAmount(["/cf", "$10"], 1, 1, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  expect(res.data.amount).toBe(5_000_000);
  expect(res.data.tokenMint).toBe("MINT");
  expect(res.data.tokenWasSpecified).toBe(false);
});

test("parseAmount supports $-suffixed USD amounts without explicit token", async () => {
  vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(mockPriceLookup(2, "TOK"));
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  await tm.addToken("MINT", "TOK", 6);

  const res = await tm.parseAmount(["/ga", "1$"], 1, 1, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  expect(res.data.amount).toBe(500_000);
  expect(res.data.tokenMint).toBe("MINT");
  expect(res.data.tokenWasSpecified).toBe(false);
});

test("parseAmount USD conversion keeps precision for low-priced tokens", async () => {
  vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(mockPriceLookup(0.00000654, "TOK"));
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  await tm.addToken("MINT", "TOK", 0);

  const res = await tm.parseAmount(["/cf", "$0.15"], 1, 1, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  // $0.15 / $0.00000654 ≈ 22,935.779... tokens, floored to 22,935
  expect(res.data.amount).toBe(22_935);
});

test("parseAmount supports $-prefixed USD amounts for tips and withdrawals (argIndex != 1)", async () => {
  const wbtcMint = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
  vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(mockPriceLookup(2, "WBTC"));
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  await tm.addToken("MINT", "TOK", 6);
  await tm.addToken(wbtcMint, "WBTC", 8);

  const res = await tm.parseAmount(["/tip", "@bob", "$10", "WBTC"], 2, 1, "tip");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  expect(res.data.amount).toBe(500_000_000);
  expect(res.data.tokenMint).toBe(wbtcMint);
  expect(res.data.tokenTicker).toBe("WBTC");
  expect(res.data.tokenWasSpecified).toBe(true);
});

test("parseAmount fails gracefully when USD pricing is unavailable", async () => {
  vi.spyOn(priceService, "getUsdPrice").mockResolvedValue(null);
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");

  const res = await tm.parseAmount(["/cf", "10", "USD"], 1, 1, "game");

  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected failure when USD pricing missing");
  }
  expect(res.error).toBe("unsupported_token");
  expect(res.reason).toBe("fiat_pricing_unavailable");
  expect(res.unknownToken).toBe("USD");
});

test("parseAmount converts $-prefixed USD amounts when explicit token is provided", async () => {
  const priceSpy = vi
    .spyOn(priceService, "getUsdPrice")
    .mockResolvedValue(mockPriceLookup(2, "WSOL"));
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  await tm.addToken(WSOL_MINT, "WSOL", 9);

  const res = await tm.parseAmount(["/cf", "$10", "WSOL"], 1, 1, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  expect(res.data.tokenMint).toBe(WSOL_MINT);
  expect(res.data.tokenTicker).toBe("WSOL");
  expect(res.data.amount).toBe(5_000_000_000);
  expect(priceSpy).toHaveBeenCalled();
  expect(res.data.tokenWasSpecified).toBe(true);
});

test("parseAmount converts $-prefixed USD amounts into the requested token", async () => {
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const priceSpy = vi
    .spyOn(priceService, "getUsdPrice")
    .mockResolvedValue(mockPriceLookup(2, "USDC"));
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  await tm.addToken(usdcMint, "USDC", 6);

  const res = await tm.parseAmount(["/cf", "$10", "USDC"], 1, 1, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  expect(res.data.tokenMint).toBe(usdcMint);
  expect(res.data.tokenTicker).toBe("USDC");
  expect(res.data.amount).toBe(5_000_000);
  expect(res.data.tokenWasSpecified).toBe(true);
  expect(res.data.formattedAmount).toContain("USDC");
  expect(priceSpy).toHaveBeenCalled();
});

test("parseAmount rejects 19-digit numeric token arguments as invalid", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const res = await tm.parseAmount(["/cf", "10", "123456789012345678901"], 1, 2, "game");

  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected invalid amount failure");
  }
  expect(res.error).toBe("invalid_amount");
});

test("parseAmount surfaces overflow from parseDecimalAmount", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const oversized = (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString();

  const res = await tm.parseAmount(["/tip", oversized], 1, 77, "tip");

  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected amount_too_large failure");
  }
  expect(res.error).toBe("amount_too_large");
});

test("parseAmount uses chat default token when none specified", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "DEF_MINT", "DEF");
  // set chat default token to override
  tm.setChatDefaultToken(7, "DEF_MINT", "CHAT", "userZ");
  const res = await tm.parseAmount(["/cf", "2"], 1, 7, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }
  const d = res.data;
  expect(d.tokenMint).toBe("DEF_MINT");
  expect(d.tokenTicker).toBe("CHAT");
});

test("parseAmount defers v0.3 chat-default support decisions to Oracle policy", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "DEF_MINT", "DEF");
  const unsupportedMint = (await Keypair.generate()).publicKey.toBase58();
  tm.setChatDefaultToken(321, unsupportedMint, "CHAT", "userZ");

  const res = await tm.parseAmount(["/cf", "1"], 1, 321, "game");

  expect(res.success).toBe(contractCapabilities.oracleTokenPolicy);
  if (contractCapabilities.oracleTokenPolicy) {
    if (!res.success) throw new Error("expected v0.3 chat token resolution to succeed");
    expect(res.data.tokenMint).toBe(unsupportedMint);
    return;
  }
  if (res.success) {
    throw new Error("expected chat default unsupported failure");
  }
  expect(res.error).toBe("unsupported_token");
  expect(res.unknownToken).toBe("CHAT");
});

test("parseAmount accepts token mint addresses when provided", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  expect(await tm.addToken(usdcMint, "USDC")).toBe(true);

  const res = await tm.parseAmount(["/cf", "3", usdcMint], 1, 123, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }
  const data = res.data;
  expect(data.tokenMint).toBe(usdcMint);
  expect(data.tokenTicker).toBe("USDC");
  expect(data.tokenWasSpecified).toBe(true);
});

test("parseAmount defers valid v0.3 mint support decisions to Oracle policy", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const mint = "BPFLoader1111111111111111111111111111111111";

  const res = await tm.parseAmount(["/cf", "4", mint], 1, 321, "game");

  expect(res.success).toBe(contractCapabilities.oracleTokenPolicy);
  if (contractCapabilities.oracleTokenPolicy) {
    if (!res.success) throw new Error("expected v0.3 mint resolution to succeed");
    expect(res.data.tokenMint).toBe(mint);
    expect(tm.getKnownTokenByMint(mint)).toBeNull();
    return;
  }
  if (res.success) {
    throw new Error("expected unsupported token failure");
  }

  expect(res.error).toBe("unsupported_token");
  expect(res.unknownToken).toBe("DISC");
  expect(tm.getKnownTokenByMint(mint)).toBeNull();
});

test("parseAmount keeps v0.2 allowlisting while v0.3 defers to Oracle policy", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const spoofMint = (await Keypair.generate()).publicKey.toBase58();

  const originalResolveSwapToken = tm.resolveSwapToken.bind(tm);
  (tm as any).resolveSwapToken = async () => ({
    token_mint: spoofMint,
    token_ticker: "USDC",
    decimals: 6,
    added_at: Date.now(),
  });

  const res = await tm.parseAmount(["/cf", "5", spoofMint], 1, 9, "game");
  (tm as any).resolveSwapToken = originalResolveSwapToken;

  expect(res.success).toBe(contractCapabilities.oracleTokenPolicy);
  if (contractCapabilities.oracleTokenPolicy) {
    if (!res.success) throw new Error("expected v0.3 mint resolution to succeed");
    expect(res.data.tokenMint).toBe(spoofMint);
    return;
  }
  if (res.success) {
    throw new Error("expected unsupported token failure");
  }
  expect(res.error).toBe("unsupported_token");
  expect(res.unknownToken).toBe("USDC");
});

test("games defer discovered v0.3 chat tokens to Oracle policy", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const discoveredMint = (await Keypair.generate()).publicKey.toBase58();

  const tipResult = await tm.parseAmount(["/tip", "1", discoveredMint], 1, 999, "tip");

  if (!tipResult.success) {
    throw new Error(`expected tip success, got ${tipResult.error}`);
  }

  tm.setChatDefaultToken(999, discoveredMint, "DISC", "userZ");

  const gameResult = await tm.parseAmount(["/cf", "1"], 1, 999, "game");

  expect(gameResult.success).toBe(contractCapabilities.oracleTokenPolicy);
  if (contractCapabilities.oracleTokenPolicy) {
    if (!gameResult.success) throw new Error("expected v0.3 chat token resolution to succeed");
    expect(gameResult.data.tokenMint).toBe(discoveredMint);
    expect(tm.getKnownTokenByMint(discoveredMint)).not.toBeNull();
    return;
  }
  if (gameResult.success) {
    throw new Error("expected unsupported token for discovered chat default");
  }
  expect(gameResult.error).toBe("unsupported_token");
  expect(gameResult.unknownToken).toBe("DISC");
  expect(tm.getKnownTokenByMint(discoveredMint)).not.toBeNull();
});

test("resolveSwapToken returns builtin SOL metadata", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const solInfo = await tm.resolveSwapToken("SOL");
  expect(solInfo).not.toBeNull();
  expect(solInfo?.token_mint).toBe(WSOL_MINT);
  expect(solInfo?.decimals).toBe(9);
  expect(solInfo?.isNativeSol).toBe(true);
});

test("resolveSwapToken auto-discovers and registers unknown mints", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");

  const mint = (await Keypair.generate()).publicKey.toBase58();
  const info = await tm.resolveSwapToken(mint);
  expect(info).not.toBeNull();
  expect(info?.token_mint).toBe(mint);
  expect(info?.token_ticker).toBe("DISC");
  expect(info?.newlyDiscovered).toBe(true);

  const stored = tm.getKnownTokenByMint(mint);
  expect(stored).not.toBeNull();
  expect(stored?.token_ticker).toBe("DISC");
});

test("parseAmount fails when explicit mint metadata cannot be fetched", async () => {
  const explicitMint = (await Keypair.generate()).publicKey.toBase58();
  const wallet = await createWalletStub();
  const metadataCalls: string[] = [];

  wallet.getTokenMetadata = async (mint: string) => {
    metadataCalls.push(mint);
    if (mint === explicitMint) {
      throw new Error("missing metadata");
    }
    return { decimals: 6 };
  };

  wallet.getFullTokenMetadata = async (mint: string) => {
    if (mint === explicitMint) {
      return null;
    }
    return {
      decimals: 6,
      symbol: "DISC",
      name: `Token ${mint.slice(0, 4).toUpperCase()}`,
    };
  };

  const tm = TokenManager.getInstance(wallet, "DEFAULT_MINT", "DEF");
  const res = await tm.parseAmount(["/cf", "5", explicitMint], 1, 9, "game");

  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected explicit mint failure");
  }
  expect(res.error).toBe("unknown_token");
  expect(res.unknownToken).toBe(explicitMint.toUpperCase());
  expect(metadataCalls).toEqual([explicitMint]);
});

test("parseAmount surfaces invalid decimal metadata as unsupported", async () => {
  const invalidMint = (await Keypair.generate()).publicKey.toBase58();
  const wallet = await createWalletStub();

  wallet.getTokenMetadata = async (mint: string) => ({
    decimals: mint === invalidMint ? 19 : 6,
  });

  wallet.getFullTokenMetadata = async (mint: string) => ({
    decimals: mint === invalidMint ? 19 : 6,
    symbol: "ODD",
    name: `Token ${mint.slice(0, 4).toUpperCase()}`,
  });

  const tm = TokenManager.getInstance(wallet as any, "DEFAULT_MINT", "DEF");
  const res = await tm.parseAmount(["/cf", "2", invalidMint], 1, 33, "game");

  expect(res.success).toBe(false);
  if (res.success) {
    throw new Error("expected invalid decimals failure");
  }
  expect(res.error).toBe("unsupported_token");
  const unknown = res.unknownToken ?? "";
  expect([invalidMint.toUpperCase(), "ODD"]).toContain(unknown);
  expect(tm.getKnownTokenByMint(invalidMint)).toBeNull();
});

test("parseAmount clears stale metadata failures between parses", async () => {
  const invalidMint = (await Keypair.generate()).publicKey.toBase58();
  const wallet = await createWalletStub();

  wallet.getTokenMetadata = async (mint: string) => ({
    decimals: mint === invalidMint ? 19 : 6,
  });

  wallet.getFullTokenMetadata = async (mint: string) => ({
    decimals: mint === invalidMint ? 19 : 6,
    symbol: "BAD",
    name: `Token ${mint.slice(0, 4).toUpperCase()}`,
  });

  const tm = TokenManager.getInstance(wallet as any, "DEFAULT_MINT", "DEF");
  await tm.addToken("DEFAULT_MINT", "DEF", 6);

  const first = await tm.parseAmount(["/cf", "2", invalidMint], 1, 100, "game");
  expect(first.success).toBe(false);
  if (first.success) {
    throw new Error("expected unsupported token for invalid metadata");
  }
  expect(first.error).toBe("unsupported_token");

  const second = await tm.parseAmount(["/cf", "2", "UNKN"], 1, 100, "game");
  expect(second.success).toBe(false);
  if (second.success) {
    throw new Error("expected unknown token after metadata failure reset");
  }
  expect(second.error).toBe("unknown_token");
  expect(second.unknownToken).toBe("UNKN");
});

test("parseAmount does not share metadata failures across concurrent parses", async () => {
  const invalidMint = (await Keypair.generate()).publicKey.toBase58();
  const validMint = (await Keypair.generate()).publicKey.toBase58();
  const wallet = await createWalletStub();

  wallet.getTokenMetadata = async (mint: string) => ({
    decimals: mint === invalidMint ? 19 : 6,
  });

  wallet.getFullTokenMetadata = async (mint: string) => {
    if (mint === validMint) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        decimals: 6,
        symbol: "GOOD",
        name: "Good Token",
      };
    }

    if (mint === invalidMint) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        decimals: 19,
        symbol: "BAD",
        name: "Bad Token",
      };
    }

    return {
      decimals: 6,
      symbol: "GEN",
      name: "Generic Token",
    };
  };

  const tm = TokenManager.getInstance(wallet as any, "DEFAULT_MINT", "DEF");

  const [validResult, invalidResult] = await Promise.all([
    tm.parseAmount(["/cf", "2", validMint], 1, 120, "tip"),
    tm.parseAmount(["/cf", "2", invalidMint], 1, 120, "tip"),
  ]);

  expect(validResult.success).toBe(true);
  if (!validResult.success) {
    throw new Error(`expected valid mint to succeed, got ${validResult.error}`);
  }

  expect(invalidResult.success).toBe(false);
  if (invalidResult.success) {
    throw new Error("expected invalid decimals to fail");
  }
  expect(invalidResult.error).toBe("unsupported_token");
});

test("parseAmount ignores numeric trailing arguments when resolving tokens", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "DEFAULT_MINT", "DEF");
  const res = await tm.parseAmount(["/cf", "10", "5"], 1, 22, "game");

  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  const data = res.data;
  expect(data.tokenMint).toBe("DEFAULT_MINT");
  expect(data.tokenWasSpecified).toBe(false);
  expect(data.requestedNativeSol).toBe(false);
});

test("parseAmount preserves explicit WSOL mint without switching to SOL", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const res = await tm.parseAmount(["/tip", "1", WSOL_MINT], 1, 11, "tip");

  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }

  const data = res.data;
  expect(data.isSol).toBe(false);
  expect(data.tokenMint).toBe(WSOL_MINT);
  expect(data.tokenTicker).toBe("WSOL");
  expect(data.tokenWasSpecified).toBe(true);
  expect(data.requestedNativeSol).toBe(false);
});

test("registerTokenIfNeeded fails when metadata decimals invalid", async () => {
  TokenManager.resetForTesting();
  const invalidDecimalsWallet = {
    ...(await createWalletStub()),
    getTokenMetadata: async () => ({ decimals: -1 }),
    getFullTokenMetadata: async () => ({ symbol: "BAD", decimals: -1 }),
  };

  const tm = TokenManager.getInstance(invalidDecimalsWallet as any, "DEF_MINT", "DEF");

  const mint = (await Keypair.generate()).publicKey.toBase58();
  const result = await tm.registerTokenIfNeeded({ mint, tickerHint: "BAD" });

  expect(result.status).toBe("failed");
  expect(tm.getKnownTokenByMint(mint)).toBeNull();
});

test("registerTokenIfNeeded ignores excessive decimal metadata", async () => {
  TokenManager.resetForTesting();
  const wallet = {
    ...(await createWalletStub()),
    getTokenMetadata: async () => ({ decimals: 99 }),
    getFullTokenMetadata: async () => ({ symbol: "DISC", decimals: 6 }),
  };

  const tm = TokenManager.getInstance(wallet as any, "DEF_MINT", "DEF");
  const mint = (await Keypair.generate()).publicKey.toBase58();

  const result = await tm.registerTokenIfNeeded({ mint, tickerHint: "DISC" });

  expect(result.status).toBe("registered");
  const stored = tm.getKnownTokenByMint(mint);
  expect(stored?.decimals).toBe(6);
});

test("registerTokenIfNeeded handles concurrent registration requests", async () => {
  TokenManager.resetForTesting();
  const tm = TokenManager.getInstance(await createWalletStub(), "DEF_MINT", "DEF");
  const mint = (await Keypair.generate()).publicKey.toBase58();

  const [first, second] = await Promise.all([
    tm.registerTokenIfNeeded({ mint, tickerHint: "DISC" }),
    tm.registerTokenIfNeeded({ mint, tickerHint: "DISC" }),
  ]);

  expect([first.status, second.status]).toContain("registered");
  const stored = tm.getKnownTokenByMint(mint);
  expect(stored).not.toBeNull();
  expect(stored?.token_ticker).toBe("DISC");
  expect(tm.getTokenCount()).toBe(1);
});

test("resolveSwapToken treats explicit WSOL mint as SPL token metadata", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const info = await tm.resolveSwapToken(WSOL_MINT);

  expect(info).not.toBeNull();
  expect(info?.token_mint).toBe(WSOL_MINT);
  expect(info?.token_ticker).toBe("WSOL");
  expect(info?.isNativeSol).toBe(false);
});

test("validateTokenMint validates base58 and metadata path", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  // Valid base58 (USDC) should pass
  expect(await tm.validateTokenMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
  // Clearly invalid should fail
  expect(await tm.validateTokenMint("not-a-mint")).toBe(false);
});

test("getAllKnownTokensWithMetadata caches results and invalidates on changes", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const tokenDb = TokenDatabase.getInstance();
  const originalGetter = tokenDb.getAllKnownTokens.bind(tokenDb);
  let calls = 0;
  tokenDb.getAllKnownTokens = function patched() {
    calls += 1;
    return originalGetter();
  };

  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;

  try {
    const initial = tm.getAllKnownTokensWithMetadata();
    expect(calls).toBe(1);

    now += TOKEN_MANAGER_KNOWN_CACHE_TTL_MS - 10;
    expect(tm.getAllKnownTokensWithMetadata()).toEqual(initial);
    expect(calls).toBe(1);

    now += 20;
    expect(tm.getAllKnownTokensWithMetadata()).toEqual(initial);
    expect(calls).toBe(2);

    const newMint = (await Keypair.generate()).publicKey.toBase58();
    await tm.addToken(newMint, "CACHE", 6);
    const cachedAfterAdd = tm.getAllKnownTokensWithMetadata();
    expect(calls).toBe(3);
    expect(cachedAfterAdd.some((token) => token.token_mint === newMint)).toBe(true);

    tm.removeToken(newMint);
    const afterRemove = tm.getAllKnownTokensWithMetadata();
    expect(calls).toBe(4);
    expect(afterRemove.some((token) => token.token_mint === newMint)).toBe(false);
  } finally {
    tokenDb.getAllKnownTokens = originalGetter;
    Date.now = originalNow;
  }
});

test("getAllKnownTokensWithMetadata refreshes cache when tokens removed externally", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const tokenDb = TokenDatabase.getInstance();
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;

  const mintA = (await Keypair.generate()).publicKey.toBase58();
  const mintB = (await Keypair.generate()).publicKey.toBase58();

  await tm.addToken(mintA, "AAA", 6);
  await tm.addToken(mintB, "BBB", 6);

  try {
    const initial = tm.getAllKnownTokensWithMetadata();
    expect(initial.some((token) => token.token_mint === mintA)).toBe(true);
    expect(initial.some((token) => token.token_mint === mintB)).toBe(true);

    now += TOKEN_MANAGER_KNOWN_CACHE_TTL_MS / 2;
    tokenDb.removeKnownToken(mintA);

    const afterRemoval = tm.getAllKnownTokensWithMetadata();
    expect(afterRemoval.some((token) => token.token_mint === mintA)).toBe(false);
    expect(afterRemoval.some((token) => token.token_mint === mintB)).toBe(true);
  } finally {
    Date.now = originalNow;
  }
});

test("getSupportedGameTokens returns hardcoded tokens including default", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MY_DEFAULT_MINT", "MYDEF");

  const supported = tm.getSupportedGameTokens();

  // Should include the default token
  expect(supported.some((t) => t.mint === "MY_DEFAULT_MINT" && t.ticker === "MYDEF")).toBe(true);

  // Should have multiple tokens from TOKENS_LIST
  expect(supported.length).toBeGreaterThan(1);

  // Each entry should have mint and ticker
  for (const token of supported) {
    expect(typeof token.mint).toBe("string");
    expect(typeof token.ticker).toBe("string");
    expect(token.mint.length).toBeGreaterThan(0);
    expect(token.ticker.length).toBeGreaterThan(0);
  }
});

test("getSupportedGameTokens does not include dynamically discovered tokens", async () => {
  const tm = TokenManager.getInstance(await createWalletStub(), "MINT", "TOK");
  const discoveredMint = (await Keypair.generate()).publicKey.toBase58();

  // Discover a token via tip parsing
  await tm.parseAmount(["/tip", "1", discoveredMint], 1, 999, "tip");

  // Verify it was added to known tokens
  expect(tm.getKnownTokenByMint(discoveredMint)).not.toBeNull();

  // But it should NOT appear in supported game tokens
  const supported = tm.getSupportedGameTokens();
  expect(supported.some((t) => t.mint === discoveredMint)).toBe(false);
});

describe("TokenManager with fresh chat and token databases", () => {
  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    resetTestDatabase("tokens.sqlite");
    ChatDatabase.resetForTesting();
    TokenDatabase.resetForTesting();
    TokenManager.resetForTesting();
  });

  function makeWalletStub() {
    return {
      getTokenMetadata: async (_mint: string) => ({ decimals: 6 }),
      formatTokenBalance: (amount: number, decimals: number) => {
        const v = amount / Math.pow(10, decimals);
        return v
          .toFixed(6)
          .replace(/\.0+$/, "")
          .replace(/(\.\d*?)0+$/, "$1");
      },
      formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
      getConnection: () => ({}) as any,
    } as any;
  }

  test("addToken registers token and appears in approved tokens list", async () => {
    const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
    const ok = await tm.addToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC");
    expect(ok).toBe(true);

    const list = tm.getAllKnownTokensWithMetadata();
    expect(list.length).toBe(1);
    expect(list[0]!.token_ticker).toBe("USDC");
  });

  test("getAllChatTokenConfigs returns stored chat defaults", () => {
    const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
    tm.setChatDefaultToken(123, "MINT", "TOK", "setter");
    const configs = tm.getAllChatTokenConfigs();
    expect(configs.some((cfg) => cfg.chat_id === 123 && cfg.token_ticker === "TOK")).toBe(true);
  });
});
