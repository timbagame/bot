import { test, expect } from "bun:test";
import { onBalance } from "../src/handlers/wallet";

function makeCtx(privateChat: boolean) {
  const calls: any[] = [];
  const ctx: any = {
    from: { id: 1, first_name: "User" },
    chat: { id: privateChat ? 1 : 2, type: privateChat ? "private" : "group" },
    reply: async (...args: any[]) => { calls.push(["reply", ...args]); return { ok: true }; },
    __calls: calls,
  };
  return ctx;
}

test("onBalance in private chat clears cache and calls showWalletUI", async () => {
  const ctx: any = makeCtx(true);
  let cleared: any = null;
  let shown = 0;
  await onBalance(ctx, {
    isPrivateChat: (c: any) => c.chat.type === "private",
    clearWalletCache: (id: bigint) => { cleared = id; },
    showWalletUI: async () => { shown++; },
    getPlayerData: async () => ({ keypair: { publicKey: { toBase58: () => "addr" } }, solBalance: 0 }),
    getApprovedTokens: () => [],
    buildTokenBalances: async () => [],
    TOKENS_LIST: [],
    wallet: { formatTokenBalance: (_n: number, _d: number) => "0", formatSolBalance: (n: number) => String(n) },
    handleCommandError: async () => {},
  });
  expect(cleared).toBe(1n);
  expect(shown).toBe(1);
});

test("onBalance private chat errors call handler", async () => {
  const ctx: any = makeCtx(true);
  let handled = 0;
  await onBalance(ctx, {
    isPrivateChat: () => true,
    clearWalletCache: (_: bigint) => { throw new Error("cache-fail"); },
    showWalletUI: async () => { throw new Error("ui-fail"); },
    getPlayerData: async () => ({ keypair: { publicKey: { toBase58: () => "addr" } }, solBalance: 0 }),
    getApprovedTokens: () => [],
    buildTokenBalances: async () => [],
    TOKENS_LIST: [],
    wallet: { formatTokenBalance: () => "0", formatSolBalance: (n: number) => String(n) },
    handleCommandError: async () => { handled++; },
  });
  expect(handled).toBe(1);
});

test("onBalance in group replies summary with SOL and tokens", async () => {
  const ctx: any = makeCtx(false);
  await onBalance(ctx, {
    isPrivateChat: () => false,
    clearWalletCache: (_: any) => {},
    showWalletUI: async () => {},
    getPlayerData: async () => ({ keypair: { publicKey: { toBase58: () => "WALLETADDR" } }, solBalance: 1000000000 }),
    getApprovedTokens: () => [{ token_mint: "USDC", token_ticker: "USDC", decimals: 6 }],
    buildTokenBalances: async () => [{ mint: "USDC", ticker: "USDC", balance: 1000000, decimals: 6 }],
    TOKENS_LIST: [{ mint: "So11111111111111111111111111111111111111112", ticker: "WSOL" }],
    wallet: { formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0), formatSolBalance: (n: number) => (n / 1_000_000_000).toFixed(6) },
    handleCommandError: async () => {},
  });
  const calls = ctx.__calls;
  expect(calls[0][0]).toBe("reply");
  const text = calls[0][1];
  expect(String(text)).toContain("WALLETADDR");
  expect(String(text)).toContain("1.000000 SOL");
  expect(String(text)).toContain("1 USDC");
});

test("onBalance merges WSOL and lists extra token count", async () => {
  const ctx: any = makeCtx(false);
  ctx.from.username = "alice";
  const tokens = [
    { mint: "So11111111111111111111111111111111111111112", ticker: "WSOL", balance: 500_000_000, decimals: 9 },
    { mint: "mint1", ticker: "AAA", balance: 1_000_000, decimals: 6 },
    { mint: "mint2", ticker: "BBB", balance: 2_000_000, decimals: 6 },
    { mint: "mint3", ticker: "CCC", balance: 3_000_000, decimals: 6 },
    { mint: "mint4", ticker: "DDD", balance: 4_000_000, decimals: 6 },
    { mint: "mint5", ticker: "EEE", balance: 5_000_000, decimals: 6 },
  ];

  await onBalance(ctx, {
    isPrivateChat: () => false,
    clearWalletCache: (_: any) => {},
    showWalletUI: async () => {},
    getPlayerData: async () => ({
      keypair: { publicKey: { toBase58: () => "ADDR123" } },
      solBalance: 1_000_000_000,
    }),
    getApprovedTokens: () => tokens.map(({ mint, ticker, decimals }) => ({ token_mint: mint, token_ticker: ticker, decimals })),
    buildTokenBalances: async () => tokens,
    TOKENS_LIST: [{ mint: "So11111111111111111111111111111111111111112", ticker: "WSOL" }],
    wallet: {
      formatTokenBalance: (amount: number, decimals: number) => (amount / Math.pow(10, decimals)).toFixed(2),
      formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
    },
    handleCommandError: async () => {},
  });

  const message = String(ctx.__calls[0][1]);
  expect(message).toContain("ADDR123");
  expect(message).toContain("1.500000 SOL");
  expect(message).toContain("+1 more tokens");
});
