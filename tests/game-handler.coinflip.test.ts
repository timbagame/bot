import { describe, test, expect } from "bun:test";
import { handleCoinflipCommand } from "../src/handlers/game";

function makeCtx(text: string, chatType: "private" | "group" | "supergroup" = "group") {
  const calls: any[] = [];
  const ctx: any = {
    from: { id: 1, username: "alice", first_name: "Alice" },
    chat: { id: 100, type: chatType },
    message: { text },
    reply: async (...args: any[]) => {
      calls.push(["reply", ...args]);
      return { ok: true } as any;
    },
    __calls: calls,
  };
  return ctx;
}

describe("game handler: coinflip command", () => {
  test("rejects in private chat", async () => {
    const ctx: any = makeCtx("/cf 10", "private");
    const deps: any = {
      isGroupChat: () => false,
      parseAmount: async () => ({ success: false, error: "unknown_token" }),
      inferMaxPlayers: () => ({ ok: false, error: "noop" }),
      wallet: { getTokenBalance: async () => 0, getTokenMetadata: async () => ({ decimals: 6 }), formatTokenBalance: () => "0" },
      gameManager: { createGame: async () => ({ success: false, error: "x" }), createGameMessage: async () => 0 },
    };
    await handleCoinflipCommand(ctx, deps);
    const calls = ctx.__calls;
    expect(calls.length).toBe(1);
    expect(String(calls[0][1])).toContain("only be created in groups");
  });

  test("shows usage when missing args", async () => {
    const ctx: any = makeCtx("/cf", "group");
    const deps: any = {
      isGroupChat: () => true,
      parseAmount: async () => ({ success: false, error: "noop" }),
      inferMaxPlayers: () => ({ ok: false, error: "noop" }),
      wallet: { getTokenBalance: async () => 0, getTokenMetadata: async () => ({ decimals: 6 }), formatTokenBalance: () => "0" },
      gameManager: { createGame: async () => ({ success: false, error: "x" }), createGameMessage: async () => 0 },
    };
    await handleCoinflipCommand(ctx, deps);
    expect(String(ctx.__calls[0][1])).toContain("Please provide a valid amount");
  });

  test("unknown token error maps to user message", async () => {
    const ctx: any = makeCtx("/cf 10 FOO", "group");
    const deps: any = {
      isGroupChat: () => true,
      parseAmount: async () => ({ success: false, error: "unknown_token", unknownToken: "FOO" }),
      inferMaxPlayers: () => ({ ok: true, value: 2 }),
      wallet: { getTokenBalance: async () => 0, getTokenMetadata: async () => ({ decimals: 6 }), formatTokenBalance: () => "0" },
      gameManager: { createGame: async () => ({ success: false, error: "x" }), createGameMessage: async () => 0 },
    };
    await handleCoinflipCommand(ctx, deps);
    expect(String(ctx.__calls[0][1])).toContain('Unknown token "FOO"');
  });

  test("SOL not supported error uses provided message", async () => {
    const ctx: any = makeCtx("/cf 0.1 SOL", "group");
    const deps: any = {
      isGroupChat: () => true,
      parseAmount: async () => ({ success: false, error: "sol_not_supported", solError: "No SOL please" }),
      inferMaxPlayers: () => ({ ok: true, value: 2 }),
      wallet: { getTokenBalance: async () => 0, getTokenMetadata: async () => ({ decimals: 9 }), formatTokenBalance: () => "0" },
      gameManager: { createGame: async () => ({ success: false, error: "x" }), createGameMessage: async () => 0 },
    };
    await handleCoinflipCommand(ctx, deps);
    expect(String(ctx.__calls[0][1])).toContain("No SOL please");
  });

  test("infer players error is surfaced", async () => {
    const ctx: any = makeCtx("/cf 10", "group");
    const deps: any = {
      isGroupChat: () => true,
      parseAmount: async () => ({
        success: true,
        data: {
          amount: 10_000_000,
          tokenMint: "M",
          tokenTicker: "TOK",
          isSol: false,
          formattedAmount: "10 TOK",
          tokenWasSpecified: false,
        },
      }),
      inferMaxPlayers: () => ({ ok: false, error: "players must be between 2-100" }),
      wallet: { getTokenBalance: async () => 0, getTokenMetadata: async () => ({ decimals: 6 }), formatTokenBalance: () => "0" },
      gameManager: { createGame: async () => ({ success: false, error: "x" }), createGameMessage: async () => 0 },
    };
    await handleCoinflipCommand(ctx, deps);
    expect(String(ctx.__calls[0][1])).toContain("Coinflip players must be between 2-100");
  });

  test("insufficient balance message contains formatted values", async () => {
    const ctx: any = makeCtx("/cf 1 TOK", "group");
    const deps: any = {
      isGroupChat: () => true,
      parseAmount: async () => ({
        success: true,
        data: {
          amount: 1_000_000,
          tokenMint: "M",
          tokenTicker: "TOK",
          isSol: false,
          formattedAmount: "1 TOK",
          tokenWasSpecified: true,
        },
      }),
      inferMaxPlayers: () => ({ ok: true, value: 2 }),
      wallet: {
        getTokenBalance: async () => 500_000, // 0.5 TOK
        getTokenMetadata: async () => ({ decimals: 6 }),
        formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
      },
      gameManager: { createGame: async () => ({ success: false, error: "x" }), createGameMessage: async () => 0 },
    };
    await handleCoinflipCommand(ctx, deps);
    const msg = String(ctx.__calls[0][1]);
    expect(msg).toContain("Insufficient balance");
    expect(msg).toContain("You have 0.5 TOK, need 1 TOK");
  });

  test("success path calls createGameMessage with expected args", async () => {
    const ctx: any = makeCtx("/cf 1 TIMBA", "group");
    let created = 0;
    const calls: any[] = [];
    const deps: any = {
      isGroupChat: () => true,
      parseAmount: async () => ({
        success: true,
        data: {
          amount: 1_000_000,
          tokenMint: "T",
          tokenTicker: "TIMBA",
          isSol: false,
          formattedAmount: "1 TIMBA",
          tokenWasSpecified: true,
        },
      }),
      inferMaxPlayers: () => ({ ok: true, value: 2 }),
      wallet: {
        getTokenBalance: async () => 2_000_000,
        getTokenMetadata: async () => ({ decimals: 6 }),
        formatTokenBalance: (_: number, __: number) => "2",
      },
      gameManager: {
        createGame: async () => ({ success: true, gameAddress: "GADDR", autoJoinResult: { success: true } }),
        createGameMessage: async (...args: any[]) => { created++; calls.push(["create", ...args]); return 42; },
      },
    };
    await handleCoinflipCommand(ctx, deps);
    expect(created).toBe(1);
    expect(calls[0][0]).toBe("create");
    // args: ctx, gameAddress, "Coinflip", amount, creatorUsername, tokenTicker, "Active"
    expect(calls[0][2]).toBe("GADDR");
    expect(calls[0][3]).toBe("Coinflip");
    expect(calls[0][4]).toBe(1_000_000);
    expect(calls[0][5]).toBe("@alice");
    expect(calls[0][6]).toBe("TIMBA");
    expect(calls[0][7]).toBe("Active");
  });

  test("auto-join failure replies and still creates message", async () => {
    const ctx: any = makeCtx("/cf 1 TIMBA", "group");
    let created = 0;
    const deps: any = {
      isGroupChat: () => true,
      parseAmount: async () => ({
        success: true,
        data: { amount: 1_000_000, tokenMint: "T", tokenTicker: "TIMBA", isSol: false, formattedAmount: "1 TIMBA" },
      }),
      inferMaxPlayers: () => ({ ok: true, value: 2 }),
      wallet: {
        getTokenBalance: async () => 2_000_000,
        getTokenMetadata: async () => ({ decimals: 6 }),
        formatTokenBalance: (_: number, __: number) => "2",
      },
      gameManager: {
        createGame: async () => ({ success: true, gameAddress: "GADDR", autoJoinResult: { success: false, error: "Autojoin failed." } }),
        createGameMessage: async () => { created++; return 1; },
      },
    };
    await handleCoinflipCommand(ctx, deps);
    const replyMsg = String(ctx.__calls[0][1]);
    expect(replyMsg).toContain("Autojoin failed.");
    expect(created).toBe(1);
  });

  test("unexpected errors are caught and reported", async () => {
    const ctx: any = makeCtx("/cf 1 TIMBA", "group");
    const deps: any = {
      isGroupChat: () => true,
      parseAmount: async () => { throw new Error("boom"); },
      inferMaxPlayers: () => ({ ok: true, value: 2 }),
      wallet: {
        getTokenBalance: async () => 0,
        getTokenMetadata: async () => ({ decimals: 6 }),
        formatTokenBalance: () => "0",
      },
      gameManager: {
        createGame: async () => ({ success: false, error: "x" }),
        createGameMessage: async () => 0,
      },
    };
    await handleCoinflipCommand(ctx, deps);
    expect(String(ctx.__calls[0][1])).toContain("Failed to create game");
  });
});

