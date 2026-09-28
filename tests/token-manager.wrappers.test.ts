import { beforeEach, describe, test, expect, spyOn } from "bun:test";
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

function makeWallet() {
  return {
    getTokenMetadata: async (_: string) => ({ decimals: 6 }),
    formatTokenBalance: (n: number, d: number) => String(n / Math.pow(10, d)),
    formatSolBalance: (_: number) => "0",
    getConnection: () => ({}) as any,
  } as any;
}

describe("TokenManager wrapper methods", () => {
  test("default getters and setters", () => {
    const tm = TokenManager.getInstance(makeWallet(), "MINTA", "TOKA");
    const def1 = tm.getDefaultToken();
    expect(def1.tokenMint).toBe("MINTA");
    expect(def1.tokenTicker).toBe("TOKA");
    tm.setDefaultToken("MINTB", "TOKB");
    const def2 = tm.getDefaultToken();
    expect(def2.tokenMint).toBe("MINTB");
    expect(def2.tokenTicker).toBe("TOKB");
  });

  test("chat config wrappers set/get/remove", () => {
    const tm = TokenManager.getInstance(makeWallet(), "MINT", "TOK");
    expect(tm.getChatDefaultToken(99)).toBeNull();
    tm.setChatDefaultToken(99, "CHAT_MINT", "CHAT", "user");
    const cfg = tm.getChatDefaultToken(99)!;
    expect(cfg.token_mint).toBe("CHAT_MINT");
    tm.removeChatDefaultToken(99);
    expect(tm.getChatDefaultToken(99)).toBeNull();
  });

  test("token DB wrappers list/get/remove and count", async () => {
    const tm = TokenManager.getInstance(makeWallet(), "MINT", "TOK");
    expect(tm.getTokenCount()).toBe(0);
    await tm.addToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC");
    expect(tm.getTokenCount()).toBe(1);
    const all = tm.getAllKnownTokens();
    expect(all.length).toBe(1);
    expect(tm.getKnownTokenByTicker("USDC")?.token_mint).toBe(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    );
    expect(
      tm.getKnownTokenByMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?.token_ticker,
    ).toBe("USDC");
    tm.removeToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(tm.getTokenCount()).toBe(0);
  });

  test("chat count reflects configured chats", () => {
    const tm = TokenManager.getInstance(makeWallet(), "MINT", "TOK");
    expect(tm.getChatCount()).toBe(0);
    tm.setChatDefaultToken(-10, "CHAT_MINT", "CHAT", "user");
    tm.setChatDefaultToken(-20, "CHAT_MINT", "CHAT", "user");
    expect(tm.getChatCount()).toBe(2);
  });

  test("getBalanceWithMetadata scales the raw balance by the token decimals", async () => {
    const calls: Array<[bigint, string]> = [];
    const wallet = {
      ...makeWallet(),
      getTokenBalance: async (telegramId: bigint, mint: string) => {
        calls.push([telegramId, mint]);
        return 1_234_500;
      },
    };
    const tm = TokenManager.getInstance(wallet, "MINT", "TOK");

    const result = await tm.getBalanceWithMetadata(42n, {
      tokenMint: "MINT_X",
      tokenTicker: "X",
      decimals: 4,
    });

    expect(calls).toEqual([[42n, "MINT_X"]]);
    expect(result).toEqual({
      rawBalance: 1_234_500,
      displayBalance: 123.45,
      tokenMint: "MINT_X",
      tokenTicker: "X",
      decimals: 4,
    });
  });

  test("getBalanceWithMetadata reports a zero balance when the lookup fails", async () => {
    const failure = new Error("rpc down");
    const wallet = {
      ...makeWallet(),
      getTokenBalance: async () => {
        throw failure;
      },
    };
    const tm = TokenManager.getInstance(wallet, "MINT", "TOK");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await tm.getBalanceWithMetadata(7n, {
        tokenMint: "MINT_Y",
        tokenTicker: "Y",
        decimals: 9,
      });
      expect(result).toEqual({
        rawBalance: 0,
        displayBalance: 0,
        tokenMint: "MINT_Y",
        tokenTicker: "Y",
        decimals: 9,
      });
      expect(errorSpy).toHaveBeenCalledWith("Error getting token balance with metadata:", failure);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
