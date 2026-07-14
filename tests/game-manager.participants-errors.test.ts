import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function programStub(gameAcc: any) {
  return { account: { game: { fetch: async () => gameAcc } } } as any;
}

function walletStub() {
  return {
    getBlockchainTime: async () => 1_000_030,
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
  } as any;
}

const baseAcc = {
  ticketsCount: 1,
  maxTickets: 2,
  minTickets: 1,
  totalAmount: 0,
  createdAt: 1_000_000,
  timeout: 60,
  gameType: { coinflip: {} },
};

describe("GameManager participants error handling in message", () => {
  test("falls back to 'Player <id>...' when username lookup fails", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(baseAcc), walletStub(), {
      getGameParticipants: (_: string) => ["123456"],
    } as any);
    (gm as any).getUsernameFromTelegramId = async () => {
      throw new Error("boom");
    };
    const ctx = { chat: { id: 1, type: "private" }, api: {} } as any;
    const pda = new PublicKey("BPFLoader1111111111111111111111111111111111");
    const { messageText } = await gm.formatGameMessage(
      ctx,
      pda,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );
    expect(messageText).toContain("Player 123456...");
  });

  test("continues gracefully when getGamePlayers throws", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(baseAcc), walletStub(), {
      getGameParticipants: (_: string) => {
        throw new Error("db fail");
      },
    } as any);
    const ctx = { chat: { id: 1, type: "private" }, api: {} } as any;
    const pda = new PublicKey("BPFLoader2111111111111111111111111111111111");
    const res = await gm.formatGameMessage(
      ctx,
      pda,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );
    expect(typeof res.messageText).toBe("string");
  });
});
