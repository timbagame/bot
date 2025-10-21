import { beforeEach, expect, test } from "bun:test";
import { TokenManager } from "../src/utils/token-manager";
import { ChatDatabase } from "../src/utils/chat-database";
import { TokenDatabase } from "../src/utils/token-database";
import { resetTestDatabase } from "./helpers/database";
import { WSOL_MINT } from "../src/utils/constants";

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
    formatTokenBalance: (amount: number, decimals: number) => {
      const v = amount / Math.pow(10, decimals);
      return v.toFixed(6).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    },
    formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
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
  expect(data.tokenTicker).toBe(mint);
  expect(data.tokenWasSpecified).toBe(true);
});

test("validateTokenMint validates base58 and metadata path", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  // Valid base58 (USDC) should pass
  expect(await tm.validateTokenMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
  // Clearly invalid should fail
  expect(await tm.validateTokenMint("not-a-mint")).toBe(false);
});
