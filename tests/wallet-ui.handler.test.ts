import { describe, test, expect } from "bun:test";
import { showWalletUI } from "../src/handlers/wallet";
import { buildWalletTokenLines } from "../src/utils/wallet-ui";

function makeCtx() {
  const calls: any[] = [];
  const ctx: any = {
    from: { id: 1 },
    message: { message_id: 7 },
    editMessageMedia: async (...args: any[]) => { calls.push(["edit", ...args]); throw new Error("force-reply"); },
    replyWithVideo: async (...args: any[]) => { calls.push(["video", ...args]); return { ok: true }; },
    __calls: calls,
  };
  return ctx;
}

describe("wallet handler showWalletUI", () => {
  test("renders caption and falls back to replyWithVideo when edit fails", async () => {
    const ctx: any = makeCtx();
    let capturedLines: any;
    const deps: any = {
      wallet: {
        getKeyPair: () => ({ publicKey: { toBase58: () => "WALLETADDR11111111111111111111111111111111" } }),
        formatSolBalance: (_: number) => "0.000000",
        formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
      },
      getCachedWalletData: async () => ({ solBalance: 0, tokenBalances: [{ mint: "EPjF...USDC", ticker: "USDC", balance: 1000000, decimals: 6 }] }),
      getPriceUSD: async (_: string) => 1,
      buildWalletCaption: (_: string, lines: any) => {
        capturedLines = lines;
        return "CAPTION";
      },
      createWalletKeyboard: () => ({ rows: [] } as any),
      WINNER_VIDEO_ID: "VID",
    };
    await showWalletUI(ctx, deps);
    const calls = ctx.__calls;
    expect(calls[0][0]).toBe("edit");
    expect(calls[1][0]).toBe("video");
    expect(capturedLines).toEqual([
      { ticker: "SOL", amount: "0.000000", usdValue: "0.00", unit: "SOL" },
      { ticker: "USDC", amount: "1", usdValue: "1.00" },
    ]);
  });

  test("shows error state when fetching balances fails", async () => {
    const ctx: any = makeCtx();
    const deps: any = {
      wallet: {
        getKeyPair: () => ({ publicKey: { toBase58: () => "WALLETADDR11111111111111111111111111111111" } }),
        formatSolBalance: (_: number) => "0.000000",
      },
      getCachedWalletData: async () => { throw new Error("fail"); },
      getPriceUSD: async (_: string) => 1,
      buildWalletCaption: () => "CAPTION",
      createWalletKeyboard: () => ({ rows: [] } as any),
      WINNER_VIDEO_ID: "VID",
    };
    await showWalletUI(ctx, deps);
    const calls = ctx.__calls;
    // First tries edit, then falls back to replyWithVideo with error caption
    expect(calls[0][0]).toBe("edit");
    expect(calls[1][0]).toBe("video");
    const caption = calls[1][1]?.caption || calls[1][2]?.caption || "";
    expect(String(caption)).toContain("Error loading balances");
  });
});

test("buildWalletTokenLines formats balances and skips empty tokens", async () => {
  const lines = await buildWalletTokenLines({
    solBalanceLamports: 2_000_000_000,
    tokenBalances: [
      { mint: "mint-sol", ticker: "SOL", balance: 1, decimals: 9 },
      { mint: "mint-aaa", ticker: "AAA", balance: 1_500_000, decimals: 6 },
      { mint: "mint-bbb", ticker: "BBB", balance: 0, decimals: 6 },
    ],
    formatSolBalance: (lamports) => (lamports / 1_000_000_000).toFixed(6),
    formatTokenBalance: (amount, decimals) => (amount / Math.pow(10, decimals)).toFixed(3),
    getPriceUSD: async (reference: string) => {
      if (reference === "SOL") {
        return 20;
      }
      return 5;
    },
  });

  expect(lines).toEqual([
    { ticker: "SOL", amount: "2.000000", usdValue: "40.00", unit: "SOL" },
    { ticker: "AAA", amount: "1.500", usdValue: "7.50" },
  ]);
});
