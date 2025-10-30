import { describe, expect, test } from "bun:test";
import { handleCoinflipCommand } from "../src/handlers/game";

type ChatType = "private" | "group" | "supergroup";

type TestContext = {
  from: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: ChatType };
  message: { text: string };
  reply: (...args: any[]) => Promise<any>;
  __calls: any[];
};

const makeCtx = (text: string, chatType: ChatType = "group"): TestContext => {
  const calls: any[] = [];
  return {
    from: { id: 1, username: "alice", first_name: "Alice" },
    chat: { id: 100, type: chatType },
    message: { text },
    reply: async (...args: any[]) => {
      calls.push(["reply", ...args]);
      return { ok: true } as any;
    },
    __calls: calls,
  };
};

describe("game handler: coinflip command", () => {
  test("rejects in private chat", async () => {
    const ctx: any = makeCtx("/cf 10", "private");
    const interactiveCalls: any[] = [];
    const commandCalls: any[] = [];

    const deps: any = {
      isGroupChat: () => false,
      showInteractiveSetup: async () => {
        interactiveCalls.push(true);
      },
      createGameViaCommand: async () => {
        commandCalls.push(true);
      },
      resolveTokenOverride: async () => null,
    };

    await handleCoinflipCommand(ctx, deps);

    expect(ctx.__calls.length).toBe(1);
    expect(String(ctx.__calls[0][1])).toContain("only be created in groups");
    expect(interactiveCalls.length).toBe(0);
    expect(commandCalls.length).toBe(0);
  });

  test("no args opens interactive setup", async () => {
    const ctx: any = makeCtx("/cf");
    const interactiveCalls: any[] = [];
    const commandCalls: any[] = [];

    const deps: any = {
      isGroupChat: () => true,
      showInteractiveSetup: async (_ctx: any, telegramId: bigint) => {
        interactiveCalls.push([_ctx, telegramId]);
      },
      createGameViaCommand: async () => {
        commandCalls.push(true);
      },
      resolveTokenOverride: async () => null,
    };

    await handleCoinflipCommand(ctx, deps);

    expect(interactiveCalls.length).toBe(1);
    expect(interactiveCalls[0][0]).toBe(ctx);
    expect(interactiveCalls[0][1]).toBe(1n);
    expect(commandCalls.length).toBe(0);
    expect(ctx.__calls.length).toBe(0);
  });

  test("arguments delegate to command handler", async () => {
    const ctx: any = makeCtx("/cf 25");
    const interactiveCalls: any[] = [];
    const commandCalls: any[] = [];

    const deps: any = {
      isGroupChat: () => true,
      showInteractiveSetup: async (
        forwardedCtx: any,
        telegramId: bigint,
        override?: any
      ) => {
        interactiveCalls.push({ forwardedCtx, telegramId, override });
      },
      createGameViaCommand: async (
        forwardedCtx: any,
        args: string[],
        telegramId: bigint
      ) => {
        commandCalls.push({ forwardedCtx, args, telegramId });
      },
      resolveTokenOverride: async () => null,
    };

    await handleCoinflipCommand(ctx, deps);

    expect(interactiveCalls.length).toBe(0);
    expect(commandCalls.length).toBe(1);
    expect(commandCalls[0].forwardedCtx).toBe(ctx);
    expect(commandCalls[0].args).toEqual(["/cf", "25"]);
    expect(commandCalls[0].telegramId).toBe(1n);
  });

  test("token-only argument opens interactive setup with override", async () => {
    const ctx: any = makeCtx("/cf TIMBA");
    const interactiveCalls: any[] = [];
    const commandCalls: any[] = [];

    const deps: any = {
      isGroupChat: () => true,
      showInteractiveSetup: async (
        forwardedCtx: any,
        telegramId: bigint,
        override?: any
      ) => {
        interactiveCalls.push({ forwardedCtx, telegramId, override });
      },
      createGameViaCommand: async () => {
        commandCalls.push(true);
      },
      resolveTokenOverride: async (tokenInput: string) => {
        if (tokenInput === "TIMBA") {
          return {
            tokenMint: "TIMBA_MINT",
            tokenTicker: "TIMBA",
            tokenDecimals: 6,
          };
        }
        return null;
      },
    };

    await handleCoinflipCommand(ctx, deps);

    expect(commandCalls.length).toBe(0);
    expect(interactiveCalls.length).toBe(1);
    expect(interactiveCalls[0].forwardedCtx).toBe(ctx);
    expect(interactiveCalls[0].telegramId).toBe(1n);
    expect(interactiveCalls[0].override).toEqual({
      tokenMint: "TIMBA_MINT",
      tokenTicker: "TIMBA",
      tokenDecimals: 6,
    });
  });
});
