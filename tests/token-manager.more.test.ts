import { beforeEach, expect, test } from "bun:test";
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

