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

test("onBalance in group sends balance privately to user", async () => {
  const ctx: any = makeCtx(false);
  // Mock api.sendMessage to track calls
  const sendMessageCalls: any[] = [];
  ctx.api = {
    sendMessage: (chatId: any, text: any, options: any) => {
      sendMessageCalls.push({ chatId, text, options });
      return Promise.resolve();
    }
  };
  
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
  
  // Should not reply in group
  const calls = ctx.__calls;
  expect(calls.length).toBe(0);
  
  // Should send privately to user
  expect(sendMessageCalls.length).toBe(1);
  expect(sendMessageCalls[0].chatId).toBe(1); // user ID from makeCtx
  const text = String(sendMessageCalls[0].text);
  expect(text).toContain("WALLETADDR");
  expect(text).toContain("1.000000 SOL");
  expect(text).toContain("1 USDC");
  expect(sendMessageCalls[0].options.parse_mode).toBe("HTML");
});

test("onBalance merges WSOL and sends privately to user", async () => {
  const ctx: any = makeCtx(false);
  ctx.from.username = "alice";
  
  // Mock api.sendMessage to track calls
  const sendMessageCalls: any[] = [];
  ctx.api = {
    sendMessage: (chatId: any, text: any, options: any) => {
      sendMessageCalls.push({ chatId, text, options });
      return Promise.resolve();
    }
  };
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

  // Should not reply in group
  const calls = ctx.__calls;
  expect(calls.length).toBe(0);
  
  // Should send privately to user
  expect(sendMessageCalls.length).toBe(1);
  expect(sendMessageCalls[0].chatId).toBe(1); // user ID
  const message = String(sendMessageCalls[0].text);
  expect(message).toContain("@alice");
  expect(message).toContain("1.500000 SOL"); // 1 SOL + 0.5 WSOL
  expect(message).toContain("1.00 AAA");
  expect(message).toContain("+1 more tokens"); // 5 remaining after WSOL merge, showing 4, so +1 more
});

test("onBalance escapes HTML-sensitive values when sending privately", async () => {
  const ctx: any = makeCtx(false);
  ctx.from.first_name = "<User>";
  
  // Mock api.sendMessage to track calls
  const sendMessageCalls: any[] = [];
  ctx.api = {
    sendMessage: (chatId: any, text: any, options: any) => {
      sendMessageCalls.push({ chatId, text, options });
      return Promise.resolve();
    }
  };
  await onBalance(ctx, {
    isPrivateChat: () => false,
    clearWalletCache: (_: any) => {},
    showWalletUI: async () => {},
    getPlayerData: async () => ({
      keypair: { publicKey: { toBase58: () => 'ADDR<&"' } },
      solBalance: 1_000_000_000,
    }),
    getApprovedTokens: () => [{ token_mint: "mint", token_ticker: '<T&"', decimals: 6 }],
    buildTokenBalances: async () => [
      { mint: "mint", ticker: '<T&"', balance: 2_000_000, decimals: 6 },
    ],
    TOKENS_LIST: [],
    wallet: {
      formatTokenBalance: () => '2 & change',
      formatSolBalance: () => '<1 & more>',
    },
    handleCommandError: async () => {},
  });

  // Should not reply in group
  const calls = ctx.__calls;
  expect(calls.length).toBe(0);
  
  // Should send privately to user with HTML escaped
  expect(sendMessageCalls.length).toBe(1);
  expect(sendMessageCalls[0].chatId).toBe(1); // user ID
  const output = String(sendMessageCalls[0].text);
  expect(output).toContain("&lt;User&gt;");
  expect(output).toContain('<code>ADDR&lt;&amp;&quot;');
  expect(output).toContain("&lt;1 &amp; more&gt; SOL");
  expect(output).toContain("2 &amp; change &lt;T&amp;&quot;");
});
