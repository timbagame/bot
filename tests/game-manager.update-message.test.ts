import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function programStub(gameAccount: any) {
  return {
    account: { game: { fetch: async () => gameAccount } },
  } as any;
}

function walletStub() {
  return {
    getBlockchainTime: async () => Math.floor(Date.now() / 1000),
    getTokenMetadata: async () => ({ decimals: 9 }),
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
  } as any;
}

function dbStub(overrides: Partial<any> = {}) {
  const savedMessages: Array<{ address: string; messageId: number; chatId: number }> = [];
  const clearedMessages: string[] = [];
  return {
    getGameParticipants: (_: string) => [],
    getGame: (_: string) => ({ token_mint: "MINT", token_ticker: "TOK", game_type: "coinflip", ...overrides }),
    getCreatorInfo: (_: string) => ({ telegramId: "777" }),
    getPlayerTelegramId: (_: string) => null,
    saveGameMessage: (address: string, messageId: number, chatId: number) => {
      savedMessages.push({ address, messageId, chatId });
    },
    clearGameMessage: (address: string) => {
      clearedMessages.push(address);
    },
    getPlayerDisplayName: () => null,
    __savedMessages: savedMessages,
    __clearedMessages: clearedMessages,
  } as any;
}

function ctxStub(options: { failMedia?: any; failCaption?: any; failText?: any; sendMessageResult?: any } = {}) {
  const calls: any[] = [];
  const ctx: any = {
    chat: { id: 1, type: "private" },
    api: {
      getChatMember: async (_chat: number, id: number) => ({ user: { username: `user${id}` } }),
      editMessageCaption: async (...args: any[]) => {
        calls.push(["caption", ...args]);
        if (options.failCaption) {
          throw options.failCaption;
        }
        return { message_id: 99 };
      },
      editMessageMedia: async (...args: any[]) => {
        calls.push(["media", ...args]);
        if (options.failMedia) {
          throw options.failMedia;
        }
        return { message_id: 99 };
      },
      editMessageText: async (...args: any[]) => {
        calls.push(["text", ...args]);
        if (options.failText) {
          throw options.failText;
        }
        return { message_id: 99 };
      },
      sendMessage: async (...args: any[]) => {
        calls.push(["send", ...args]);
        return (
          options.sendMessageResult ?? {
            message_id: 777,
            chat: { id: args[0] },
          }
        );
      },
    },
    __calls: calls,
  };
  return ctx;
}

describe("GameManager.updateGameMessage routing", () => {
  test("coinflip active -> edits caption only", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(programStub(gameAcc), walletStub(), dbStub());
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111111").toBase58();
    // seed active message
    (gm as any).activeGameMessages.set(addr, { chatId: 1, messageId: 42, usesVideo: true });
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK"
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("caption");
    const active = gm.getActiveGameMessage(addr);
    expect(active?.usesVideo).toBe(true);
  });

  test("coinflip completed -> edits media with winner video", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(programStub(gameAcc), walletStub(), dbStub({ game_type: "coinflip" }));
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111112").toBase58();
    (gm as any).activeGameMessages.set(addr, { chatId: 1, messageId: 43, usesVideo: true });
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Completed",
      "TOK",
      "SomeWinnerPubkey"
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("media");
    const active = gm.getActiveGameMessage(addr);
    expect(active?.usesVideo).toBe(true);
  });

  test("non-coinflip -> edits text", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 5,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { giveaway: {} },
    };
    const gm = GameManager.getInstance(programStub(gameAcc), walletStub(), dbStub({ game_type: "giveaway" }));
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111113").toBase58();
    (gm as any).activeGameMessages.set(addr, { chatId: 1, messageId: 44, usesVideo: false });
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "giveaway",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK"
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("text");
  });

  test("coinflip active without video support edits text", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(programStub(gameAcc), walletStub(), dbStub());
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111114").toBase58();
    (gm as any).activeGameMessages.set(addr, { chatId: 1, messageId: 45, usesVideo: false });
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK"
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("text");
    const active = gm.getActiveGameMessage(addr);
    expect(active?.usesVideo).toBe(false);
  });

  test("coinflip completed falls back to text when media update fails", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(programStub(gameAcc), walletStub(), dbStub({ game_type: "coinflip" }));
    const ctx = ctxStub({ failMedia: { description: "Bad Request: wrong file identifier/HTTP URL specified" } });
    const addr = new PublicKey("11111111111111111111111111111115").toBase58();
    (gm as any).activeGameMessages.set(addr, { chatId: 1, messageId: 46, usesVideo: true });
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Completed",
      "TOK",
      "SomeWinner"
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("media");
    expect(calls[1][0]).toBe("text");
    const active = gm.getActiveGameMessage(addr);
    expect(active?.usesVideo).toBe(false);
  });

  test("recreates missing message and preserves inline keyboard when edit target is gone", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const addr = new PublicKey("11111111111111111111111111111116").toBase58();
    const database = dbStub();
    const gm = GameManager.getInstance(programStub(gameAcc), walletStub(), database);
    const missingError = {
      description: "Bad Request: message to edit not found",
    };
    const ctx = ctxStub({
      failText: missingError,
      sendMessageResult: { message_id: 888, chat: { id: 1 } },
    });
    ctx.chat = { id: 1, type: "supergroup" };
    (gm as any).activeGameMessages.set(addr, { chatId: 1, messageId: 47, usesVideo: false });

    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK"
    );

    const calls = (ctx as any).__calls;
    const sendCall = calls.find((call: any[]) => call[0] === "send");
    expect(sendCall).toBeDefined();
    expect(sendCall?.[3]?.reply_markup?.inline_keyboard).toBeDefined();
    const active = gm.getActiveGameMessage(addr);
    expect(active?.messageId).toBe(888);
    const saved = (database as any).__savedMessages.pop();
    expect(saved).toEqual({ address: addr, messageId: 888, chatId: 1 });
    expect((database as any).__clearedMessages).toContain(addr);
  });
});
