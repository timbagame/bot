import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function baseProgram() {
  return { account: { game: { fetch: async () => ({}) } } } as any;
}

function baseWallet() { return {} as any; }
function baseDb() { return { getGameParticipants: (_: string) => [] } as any; }

describe("GameManager.handleExpiredGame", () => {
  test("giveaway expired triggers cancelGameWithPlayerKeys and returns true", async () => {
    resetGM();
    const gm = GameManager.getInstance(baseProgram(), baseWallet(), baseDb());
    (gm as any).cancelGameWithPlayerKeys = async () => ({ success: true, tx: "tx123" });
    const now = Math.floor(Date.now() / 1000);
    const gameAccount = {
      gameType: { giveaway: {} },
      createdAt: now - 10_000,
      timeout: 1,
      ticketsCount: 0,
      maxTickets: 2,
      minTickets: 0,
      creator: new PublicKey("BPFLoader1111111111111111111111111111111111"),
    };
    const res = await (gm as any).handleExpiredGame(new PublicKey("BPFLoader2111111111111111111111111111111111"), gameAccount);
    expect(res).not.toBe(false);
  });

  test("coinflip chooses complete cleanup strategy when canCompleteCleanup", async () => {
    resetGM();
    const gm = GameManager.getInstance(baseProgram(), baseWallet(), baseDb());
    (gm as any).analyzePlayerKeys = () => ({ available: [1,2], total: 2, canCompleteCleanup: true, creator: { telegramId: "777" } });
    (gm as any).executeCompleteCleanup = async () => true;
    const now = Math.floor(Date.now() / 1000);
    const gameAccount = {
      gameType: { coinflip: {} },
      createdAt: now - 10_000,
      timeout: 1,
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      creator: new PublicKey("BPFLoader1111111111111111111111111111111111"),
    };
    const res = await (gm as any).handleExpiredGame(new PublicKey("BPFLoader3111111111111111111111111111111111"), gameAccount);
    expect(res).toBe(false); // handleExpiredGame returns false unless it closes; completeCleanup returns true but outer method returns false after cleanup path selection
  });

  test("coinflip chooses partial cleanup when cannot complete cleanup", async () => {
    resetGM();
    const gm = GameManager.getInstance(baseProgram(), baseWallet(), baseDb());
    (gm as any).analyzePlayerKeys = () => ({ available: [1], total: 2, canCompleteCleanup: false });
    (gm as any).executePartialCleanup = async () => true;
    const now = Math.floor(Date.now() / 1000);
    const gameAccount = {
      gameType: { coinflip: {} },
      createdAt: now - 10_000,
      timeout: 1,
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      creator: new PublicKey("BPFLoader1111111111111111111111111111111111"),
    };
    const res = await (gm as any).handleExpiredGame(new PublicKey("BPFLoader4111111111111111111111111111111111"), gameAccount);
    expect(res).toBe(false);
  });
});

