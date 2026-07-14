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
    getFullTokenMetadata: async (_mint: string) => ({
      decimals: 6,
      symbol: "DISC",
      name: "Discovered Token",
    }),
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

test("autoDiscoverTokenInfo returns TOKEN_ prefix for unknown mint", async () => {
  const tm = TokenManager.getInstance(makeWalletStub(), "DEF_MINT", "DEF");
  // Use a fake but valid base58 mint that is not in builtin tokens
  const mint = "FakeTokenMint1111111111111111111111111111111";
  const res = await tm.autoDiscoverTokenInfo(mint);
  expect(res?.ticker).toBe("DISC");
  expect(res?.decimals).toBe(6);
});
