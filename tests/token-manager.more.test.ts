import { beforeEach, expect, test } from "bun:test";
import { TokenManager } from "../src/utils/token-manager";
import { ChatDatabase } from "../src/utils/chat-database";
import { TokenDatabase } from "../src/utils/token-database";
import { resetTestDatabase } from "./helpers/database";

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
    getConnection: () => ({}) as any,
  } as any;
}

test("addToken registers token and appears in approved tokens list", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  const ok = await tm.addToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC");
  expect(ok).toBe(true);

  const list = tm.getAllApprovedTokensWithMetadata();
  expect(list.length).toBe(1);
  expect(list[0]!.token_ticker).toBe("USDC");
});

test("getAllChatTokenConfigs returns stored chat defaults", () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "MINT", "TOK");
  tm.setChatDefaultToken(123, "MINT", "TOK", "setter");
  const configs = tm.getAllChatTokenConfigs();
  expect(configs.some((cfg) => cfg.chat_id === 123 && cfg.token_ticker === "TOK")).toBe(true);
});

