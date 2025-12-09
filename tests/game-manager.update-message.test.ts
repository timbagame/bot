import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  makeCtxStub,
  makeDbStub,
  makeProgramStub,
  makeWalletStub,
  resetGameManager as resetGM,
} from "./helpers/game-manager";
import { GameManager } from "../src/utils/game";

function ctxStub(options: { failMedia?: any; failCaption?: any; failText?: any; sendMessageResult?: any } = {}) {
  const calls: any[] = [];
  const base = makeCtxStub({
    apiOverrides: {
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
  });
  const ctx: any = { ...base, __calls: calls };
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
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub()
    );
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111111").toBase58();
    // seed active message
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 42, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
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
    const active = gm.getActiveGameMessages(addr)?.get(1);
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
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "coinflip" } })
    );
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111112").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 43, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
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
    const active = gm.getActiveGameMessages(addr)?.get(1);
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
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "giveaway" } })
    );
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111113").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 44, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);
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
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub()
    );
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111114").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 45, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);
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
    const active = gm.getActiveGameMessages(addr)?.get(1);
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
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "coinflip" } })
    );
    const ctx = ctxStub({ failMedia: { description: "Bad Request: wrong file identifier/HTTP URL specified" } });
    const addr = new PublicKey("11111111111111111111111111111115").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 46, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
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
    const active = gm.getActiveGameMessages(addr)?.get(1);
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
    const database = makeDbStub();
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      database
    );
    const missingError = {
      description: "Bad Request: message to edit not found",
    };
    const ctx = ctxStub({
      failText: missingError,
      sendMessageResult: { message_id: 888, chat: { id: 1 } },
    });
    ctx.chat = { id: 1, type: "supergroup" };
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 47, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);

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
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(active?.messageId).toBe(888);
    const saved = (database as any).__savedMessages.pop();
    expect(saved).toEqual({ address: addr, messageId: 888, chatId: 1 });
  });

  test("deduplicates concurrent recreation attempts per game address", async () => {
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
    const database = makeDbStub();
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      database
    );
    const missingError = {
      description: "Bad Request: message to edit not found",
    };
    const ctx = ctxStub({
      failText: missingError,
      sendMessageResult: { message_id: 555, chat: { id: 1 } },
    });
    ctx.chat = { id: 1, type: "supergroup" };
    const originalSend = ctx.api.sendMessage;
    ctx.api.sendMessage = async (...args: any[]) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return originalSend(...args);
    };
    const addr = new PublicKey("11111111111111111111111111111117").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 45, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);

    await Promise.all([
      gm.updateGameMessage(
        ctx as any,
        addr,
        "coinflip",
        1_000_000_000,
        "@creator",
        "Active",
        "TOK"
      ),
      gm.updateGameMessage(
        ctx as any,
        addr,
        "coinflip",
        1_000_000_000,
        "@creator",
        "Active",
        "TOK"
      ),
    ]);

    expect((database as any).__savedMessages).toHaveLength(1);
    const sendCalls = ctx.__calls.filter((call: any[]) => call[0] === "send");
    expect(sendCalls).toHaveLength(1);
  });
});
