import { beforeEach, describe, test, expect } from "bun:test";
import { TokenManager } from "../src/utils/token-manager";
import { ChatDatabase } from "../src/utils/chat-database";
import { TokenDatabase } from "../src/utils/token-database";

beforeEach(() => {
  try { require("fs").rmSync("chat-settings.sqlite", { force: true }); } catch {}
  try { require("fs").rmSync("tokens.sqlite", { force: true }); } catch {}
  // reset singletons
  // @ts-ignore
  ChatDatabase["instance"] = undefined;
  // @ts-ignore
  TokenDatabase["instance"] = undefined;
  // @ts-ignore
  TokenManager["instance"] = undefined;
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
    expect(tm.getKnownTokenByTicker("USDC")?.token_mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(tm.getKnownTokenByMint("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?.token_ticker).toBe("USDC");
    tm.removeToken("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(tm.getTokenCount()).toBe(0);
  });
});

