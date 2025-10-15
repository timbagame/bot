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
    chat: { id: 1, type: "private" },
    replyWithVideo: async (_vid: string, opts: any) => {
      calls.push(["video", opts]);
      if (options.videoError) {
        throw options.videoError;
      }
      return { message_id: 101, chat: { id: 1 } };
    },
    reply: async (text: string, opts: any) => {
      calls.push(["text", text, opts]);
      return { message_id: 202, chat: { id: 2 } };
    },
    __calls: calls,
  };
  return ctx;
}

describe("GameManager.formatAndSendGameMessage", () => {
  test("uses video for coinflip and sets active message", async () => {
    resetGM();
    const program = { account: { game: { fetch: async () => ({ ticketsCount: 0, maxTickets: 2, minTickets: 2, createdAt: 1_000_000, timeout: 60, gameType: { coinflip: {} } }) } } } as any;
    const gm = GameManager.getInstance(program, { formatTokenBalance: (n: number) => String(n) } as any, {
      saveGameMessage: (_addr: string, _msg: number, _chat: number) => {},
    } as any);
    const ctx = ctxStub();
    const pda = new PublicKey("BPFLoader1111111111111111111111111111111111");
    await gm.formatAndSendGameMessage(ctx as any, pda, "coinflip", 1_000_000_000, "@creator", "Active", "TOK");
    expect((ctx as any).__calls[0][0]).toBe("video");
    const saved = gm.getActiveGameMessage(pda.toBase58());
    expect(saved?.messageId).toBe(101);
    expect(saved?.usesVideo).toBe(true);
  });

  test("uses video for giveaway when configured and sets active message", async () => {
    resetGM();
    const program = { account: { game: { fetch: async () => ({ ticketsCount: 0, maxTickets: 2, minTickets: 2, createdAt: 1_000_000, timeout: 60, gameType: { giveaway: {} } }) } } } as any;
    const gm = GameManager.getInstance(program, { formatTokenBalance: (n: number) => String(n) } as any, {
      saveGameMessage: (_addr: string, _msg: number, _chat: number) => {},
    } as any);
    const ctx = ctxStub();
    const pda = new PublicKey("BPFLoader2111111111111111111111111111111111");
    await gm.formatAndSendGameMessage(ctx as any, pda, "giveaway", 1_000_000_000, "@creator", "Active", "TOK");
    expect((ctx as any).__calls[0][0]).toBe("video");
    const saved = gm.getActiveGameMessage(pda.toBase58());
    expect(saved?.messageId).toBe(101);
    expect(saved?.usesVideo).toBe(true);
  });

  test("falls back to text when coinflip video send fails", async () => {
    resetGM();
    const program = { account: { game: { fetch: async () => ({ ticketsCount: 0, maxTickets: 2, minTickets: 2, createdAt: 1_000_000, timeout: 60, gameType: { coinflip: {} } }) } } } as any;
    const gm = GameManager.getInstance(program, { formatTokenBalance: (n: number) => String(n) } as any, {
      saveGameMessage: (_addr: string, _msg: number, _chat: number) => {},
    } as any);
    const ctx = ctxStub({ videoError: { description: "Bad Request: wrong file identifier/HTTP URL specified" } });
    const pda = new PublicKey("BPFLoader3111111111111111111111111111111111");
    await gm.formatAndSendGameMessage(ctx as any, pda, "coinflip", 1_000_000_000, "@creator", "Active", "TOK");
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("video");
    expect(calls[1][0]).toBe("text");
    const saved = gm.getActiveGameMessage(pda.toBase58());
    expect(saved?.usesVideo).toBe(false);
  });
});
