import { beforeEach, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import { TokenManager } from "../src/utils/token-manager";
import { ChatDatabase } from "../src/utils/chat-database";
import { TokenDatabase } from "../src/utils/token-database";
import { resetTestDatabase } from "./helpers/database";
import {
  WSOL_MINT,
  TOKEN_MANAGER_APPROVED_CACHE_TTL_MS,
} from "../src/utils/constants";

// Clean DBs and singletons before each test
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
    getFullTokenMetadata: async (mint: string) => ({
      decimals: 6,
      symbol: "DISC",
      name: `Token ${mint.slice(0, 4).toUpperCase()}`,
    }),
    formatTokenBalance: (amount: number, decimals: number) => {
      const v = amount / Math.pow(10, decimals);
      return v.toFixed(6).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    },
    formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
    getConnection: () => ({}) as any,
  } as any;
}

test("parseAmount maps SOL to WSOL for game context", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
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

test("resolveMintForTicker returns default token mint for default ticker", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "DEFAULT_MINT", "DEF");
  expect(await tm.resolveMintForTicker("def")).toBe("DEFAULT_MINT");
});

test("resolveMintForTicker prefers known tokens over built-ins", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  const overrideBonkMint = "TokenMint11111111111111111111111111111111";
  // Register BONK with a synthetic mint to ensure DB lookup wins over alias map
  await tm.addToken(overrideBonkMint, "BONK");
  expect(await tm.resolveMintForTicker("BONK")).toBe(overrideBonkMint);
});

test("parseAmount accepts SOL for tips and formats as SOL", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
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
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  const res = await tm.parseAmount(["/cf", "10", "UNKN"], 1, 1, "game");
  if (res.success) {
    throw new Error("expected unknown token failure");
  }
  expect(res.error).toBe("unknown_token");
  expect(res.unknownToken).toBe("UNKN");
});

test("parseAmount uses chat default token when none specified", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "DEF_MINT", "DEF");
  // set chat default token to override
  tm.setChatDefaultToken(7, "CHAT_MINT", "CHAT", "userZ");
  const res = await tm.parseAmount(["/cf", "2"], 1, 7, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }
  const d = res.data;
  expect(d.tokenMint).toBe("CHAT_MINT");
  expect(d.tokenTicker).toBe("CHAT");
});

test("parseAmount accepts token mint addresses when provided", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
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

test("parseAmount treats valid mint strings as explicit tokens even when unknown", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  const mint = "BPFLoader1111111111111111111111111111111111";

  const res = await tm.parseAmount(["/cf", "4", mint], 1, 321, "game");
  if (!res.success) {
    throw new Error(`expected success, got ${res.error}`);
  }
  const data = res.data;
  expect(data.tokenMint).toBe(mint);
  expect(data.tokenTicker).toBe("DISC");
  expect(data.tokenWasSpecified).toBe(true);
});

test("resolveSwapToken returns builtin SOL metadata", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  const solInfo = await tm.resolveSwapToken("SOL");
  expect(solInfo).not.toBeNull();
  expect(solInfo?.token_mint).toBe(WSOL_MINT);
  expect(solInfo?.decimals).toBe(9);
  expect(solInfo?.isNativeSol).toBe(true);
});

test("resolveSwapToken auto-discovers and registers unknown mints", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  TokenManager.setPumpFunClientFactoryForTesting(() => ({
    isPumpFunToken: async () => ({ isPumpFun: false, isGraduated: false }),
    getTokenMetadata: async () => ({
      symbol: "DISC",
      name: "Discovered Token",
      decimals: 6,
    }),
  }) as any);

  const mint = Keypair.generate().publicKey.toBase58();
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
  const explicitMint = Keypair.generate().publicKey.toBase58();
  const wallet = makeWalletStub();
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

test("parseAmount ignores numeric trailing arguments when resolving tokens", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "DEFAULT_MINT", "DEF");
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
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
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
    ...makeWalletStub(),
    getTokenMetadata: async () => ({ decimals: -1 }),
    getFullTokenMetadata: async () => ({ symbol: "BAD", decimals: -1 }),
  };

  const tm = TokenManager.getInstance(
    invalidDecimalsWallet as any,
    "DEF_MINT",
    "DEF"
  );

  const mint = Keypair.generate().publicKey.toBase58();
  const result = await tm.registerTokenIfNeeded({ mint, tickerHint: "BAD" });

  expect(result.status).toBe("failed");
  expect(tm.getKnownTokenByMint(mint)).toBeNull();
});

test("registerTokenIfNeeded ignores excessive decimal metadata", async () => {
  TokenManager.resetForTesting();
  const wallet = {
    ...makeWalletStub(),
    getTokenMetadata: async () => ({ decimals: 99 }),
    getFullTokenMetadata: async () => ({ symbol: "DISC", decimals: 6 }),
  };

  const tm = TokenManager.getInstance(wallet as any, "DEF_MINT", "DEF");
  const mint = Keypair.generate().publicKey.toBase58();

  const result = await tm.registerTokenIfNeeded({ mint, tickerHint: "DISC" });

  expect(result.status).toBe("registered");
  const stored = tm.getKnownTokenByMint(mint);
  expect(stored?.decimals).toBe(6);
});

test("resolveSwapToken treats explicit WSOL mint as SPL token metadata", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  const info = await tm.resolveSwapToken(WSOL_MINT);

  expect(info).not.toBeNull();
  expect(info?.token_mint).toBe(WSOL_MINT);
  expect(info?.token_ticker).toBe("WSOL");
  expect(info?.isNativeSol).toBe(false);
});

test("validateTokenMint validates base58 and metadata path", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  // Valid base58 (USDC) should pass
  expect(await tm.validateTokenMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
  // Clearly invalid should fail
  expect(await tm.validateTokenMint("not-a-mint")).toBe(false);
});

test("getAllApprovedTokensWithMetadata caches results and invalidates on changes", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
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
    expect(tm.getAllApprovedTokensWithMetadata()).toEqual([]);
    expect(calls).toBe(1);

    now += TOKEN_MANAGER_APPROVED_CACHE_TTL_MS - 10;
    expect(tm.getAllApprovedTokensWithMetadata()).toEqual([]);
    expect(calls).toBe(1);

    now += 20;
    expect(tm.getAllApprovedTokensWithMetadata()).toEqual([]);
    expect(calls).toBe(2);

    const newMint = Keypair.generate().publicKey.toBase58();
    await tm.addToken(newMint, "CACHE", 6);
    const cachedAfterAdd = tm.getAllApprovedTokensWithMetadata();
    expect(calls).toBe(3);
    expect(cachedAfterAdd.some((token) => token.token_mint === newMint)).toBe(true);

    tm.removeToken(newMint);
    const afterRemove = tm.getAllApprovedTokensWithMetadata();
    expect(calls).toBe(4);
    expect(afterRemove.some((token) => token.token_mint === newMint)).toBe(false);
  } finally {
    tokenDb.getAllKnownTokens = originalGetter;
    Date.now = originalNow;
  }
});
