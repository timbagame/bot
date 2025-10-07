import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";

process.env["COINFLIP_START_VIDEO_ID"] ??= "test-coinflip-video-id";
process.env["START_VIDEO_ID"] ??= "test-start-video-id";

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
  return {
    getGameParticipants: (_: string) => [],
    getGame: (_: string) => ({ token_mint: "MINT", token_ticker: "TOK", game_type: "coinflip", ...overrides }),
    getCreatorInfo: (_: string) => ({ telegramId: "777" }),
    getPlayerTelegramId: (_: string) => null,
  } as any;
}

function ctxStub(options: { failMedia?: any; failCaption?: any } = {}) {
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
      editMessageText: async (...args: any[]) => { calls.push(["text", ...args]); return { message_id: 99 }; },
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
});
