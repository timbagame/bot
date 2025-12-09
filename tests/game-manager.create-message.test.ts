import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function ctxStub(options: { videoError?: any } = {}) {
  const calls: any[] = [];
  const ctx: any = {
    message: { message_id: 9 },
    replyWithVideo: async (_vid: string, opts: any) => {
      calls.push(["video", opts]);
      if (options.videoError) {
        throw options.videoError;
      }
      return { message_id: 333, chat: { id: 3 } };
    },
    reply: async (text: string, opts: any) => {
      calls.push(["text", text, opts]);
      return { message_id: 444, chat: { id: 4 } };
    },
    __calls: calls,
  };
  return ctx;
}

describe("GameManager.createGameMessage", () => {
  test("sends video for coinflip and stores active message", async () => {
    resetGM();
    const program = { account: { game: { fetch: async () => ({ ticketsCount: 0, maxTickets: 2, minTickets: 2, createdAt: 1_000_000, timeout: 60, gameType: { coinflip: {} } }) } } } as any;
    const gm = GameManager.getInstance(program, { formatTokenBalance: (n: number) => String(n), getBlockchainTime: async () => Math.floor(Date.now()/1000) } as any, {
      saveGameMessage: (_addr: string, _msg: number, _chat: number) => {},
    } as any);
    const ctx = ctxStub();
    const addr = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();
    const id = await gm.createGameMessage(ctx as any, addr, "coinflip", 1_000_000_000, "@creator", "Active", "TOK");
    expect(id).toBe(333);
    expect((ctx as any).__calls[0][0]).toBe("video");
    const active = gm.getActiveGameMessages(addr)?.get(3);
    expect(active?.messageId).toBe(333);
    expect(active?.usesVideo).toBe(true);
  });

  test("sends video for giveaway and stores active message", async () => {
    resetGM();
    const program = { account: { game: { fetch: async () => ({ ticketsCount: 0, maxTickets: 2, minTickets: 2, createdAt: 1_000_000, timeout: 60, gameType: { giveaway: {} } }) } } } as any;
    const gm = GameManager.getInstance(program, { formatTokenBalance: (n: number) => String(n), getBlockchainTime: async () => Math.floor(Date.now()/1000) } as any, {
      saveGameMessage: (_addr: string, _msg: number, _chat: number) => {},
    } as any);
    const ctx = ctxStub();
    const addr = new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58();
    const id = await gm.createGameMessage(ctx as any, addr, "giveaway", 1_000_000_000, "@creator", "Active", "TOK");
    expect(id).toBe(333);
    expect((ctx as any).__calls[0][0]).toBe("video");
    const active = gm.getActiveGameMessages(addr)?.get(3);
    expect(active?.messageId).toBe(333);
    expect(active?.usesVideo).toBe(true);
  });

  test("falls back to text when coinflip video cannot be sent", async () => {
    resetGM();
    const program = { account: { game: { fetch: async () => ({ ticketsCount: 0, maxTickets: 2, minTickets: 2, createdAt: 1_000_000, timeout: 60, gameType: { coinflip: {} } }) } } } as any;
    const gm = GameManager.getInstance(program, { formatTokenBalance: (n: number) => String(n), getBlockchainTime: async () => Math.floor(Date.now()/1000) } as any, {
      saveGameMessage: (_addr: string, _msg: number, _chat: number) => {},
    } as any);
    const ctx = ctxStub({
      videoError: { description: "Bad Request: wrong file identifier/HTTP URL specified" },
    });
    const addr = new PublicKey("BPFLoader3111111111111111111111111111111111").toBase58();
    const id = await gm.createGameMessage(ctx as any, addr, "coinflip", 1_000_000_000, "@creator", "Active", "TOK");
    expect(id).toBe(444);
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("video");
    expect(calls[1][0]).toBe("text");
    const active = gm.getActiveGameMessages(addr)?.get(4);
    expect(active?.usesVideo).toBe(false);
  });
});
