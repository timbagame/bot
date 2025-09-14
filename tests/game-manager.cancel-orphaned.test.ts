import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager.cancelOrphanedGame and scan", () => {
  test("cancelOrphanedGame returns false when not expired", async () => {
    resetGM();
    const addr = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();
    const program = { account: { game: { fetch: async () => ({ gameType: { coinflip: {} }, ticketsCount: 0, maxTickets: 2 }) } } } as any;
    const gm = GameManager.getInstance(program, {} as any, { getGameParticipants: () => [] } as any);
    (gm as any).isGameExpiredWithBuffer = (_: any) => false;
    const ok = await (gm as any).cancelOrphanedGame(addr);
    expect(ok).toBe(false);
  });

  test("cancelOrphanedGame routes giveaway to handleExpiredGiveaway", async () => {
    resetGM();
    const addr = new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58();
    const program = { account: { game: { fetch: async () => ({ gameType: { giveaway: {} }, ticketsCount: 0, maxTickets: 2 }) } } } as any;
    const gm = GameManager.getInstance(program, {} as any, { getGameParticipants: () => [] } as any);
    (gm as any).isGameExpiredWithBuffer = (_: any) => true;
    (gm as any).handleExpiredGiveaway = async () => true;
    const ok = await (gm as any).cancelOrphanedGame(addr);
    expect(ok).toBe(true);
  });

  test("cancelOrphanedGame routes coinflip to handleExpiredCoinflip", async () => {
    resetGM();
    const addr = new PublicKey("BPFLoader3111111111111111111111111111111111").toBase58();
    const program = { account: { game: { fetch: async () => ({ gameType: { coinflip: {} }, ticketsCount: 1, maxTickets: 2 }) } } } as any;
    const gm = GameManager.getInstance(program, {} as any, { getGameParticipants: () => [] } as any);
    (gm as any).isGameExpiredWithBuffer = (_: any) => true;
    (gm as any).handleExpiredCoinflip = async () => true;
    const ok = await (gm as any).cancelOrphanedGame(addr);
    expect(ok).toBe(true);
  });

  test("cancelOrphanedGame treats missing account as already closed", async () => {
    resetGM();
    const addr = new PublicKey("BPFLoader4111111111111111111111111111111111").toBase58();
    const program = { account: { game: { fetch: async () => { throw new Error("Account does not exist"); } } } } as any;
    const gm = GameManager.getInstance(program, {} as any, { getGameParticipants: () => [] } as any);
    const ok = await (gm as any).cancelOrphanedGame(addr);
    expect(ok).toBe(true);
  });

  test("scanBlockchainForOrphanedGames invokes cancel on unknown games", async () => {
    resetGM();
    const a1 = new PublicKey("BPFLoader5111111111111111111111111111111111");
    const a2 = new PublicKey("BPFLoader6111111111111111111111111111111111");
    const program = { account: { game: { all: async () => [
      { publicKey: a1, account: { ticketsCount: 0, maxTickets: 2 } },
      { publicKey: a2, account: { ticketsCount: 1, maxTickets: 2 } },
    ] } } } as any;
    const db = { gameExists: (addr: string) => addr === a1.toBase58() } as any;
    const gm = GameManager.getInstance(program, {} as any, db);
    let calls: string[] = [];
    (gm as any).cancelOrphanedGame = async (addr: string) => { calls.push(addr); return true; };
    await gm.scanBlockchainForOrphanedGames();
    expect(calls).toContain(a2.toBase58());
  });
});

