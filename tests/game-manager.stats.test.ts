import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "#solana";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function walletStub(blockTime: number) {
  return {
    getBlockchainTime: async () => blockTime,
  } as any;
}

describe("GameManager Stats", () => {
  describe("getActiveGameStats", () => {
    test("computes totalPot for giveaway and coinflip", async () => {
      resetGM();
      const createdAt = 1_000_000;
      const timeout = 60;
      const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");
      const program = {
        account: {
          game: {
            fetch: async () => ({
              ticketsCount: 3,
              maxTickets: 5,
              minTickets: 2,
              createdAt,
              timeout,
              gameType: { giveaway: {} },
              totalAmount: 0,
            }),
          },
        },
      } as any;
      const gm1 = GameManager.getInstance(program, walletStub(createdAt + 30), {} as any);
      const s1 = await (gm1 as any).getActiveGameStats(gamePda, 1_000_000_000);
      expect(s1.totalPot).toBe(1_000_000_000n);
      expect(String(s1.expirationInfo)).toContain("⏰");

      resetGM();
      const program2 = {
        account: {
          game: {
            fetch: async () => ({
              ticketsCount: 4,
              maxTickets: 4,
              minTickets: 2,
              createdAt,
              timeout,
              gameType: { coinflip: {} },
              totalAmount: 0,
            }),
          },
        },
      } as any;
      const gm2 = GameManager.getInstance(program2, walletStub(createdAt + 30), {} as any);
      const s2 = await (gm2 as any).getActiveGameStats(gamePda, 1_000_000_000);
      expect(s2.totalPot).toBe(4_000_000_000n);
    });

    test("returns fallback when fetch fails", async () => {
      resetGM();
      const program = {
        account: {
          game: {
            fetch: async () => {
              throw new Error("boom");
            },
          },
        },
      } as any;
      const gm = GameManager.getInstance(program, {} as any, {} as any);
      const s = await (gm as any).getActiveGameStats(
        new PublicKey("BPFLoader1111111111111111111111111111111111"),
        1_000_000_000,
      );
      expect(s.currentTickets).toBe(0);
      expect(s.totalPot).toBe(1_000_000_000n);
      expect(s.expirationInfo).toBe("");
    });
  });

  describe("getCompletedGameStats", () => {
    test("coinflip uses participants * amount", async () => {
      resetGM();
      const gm = GameManager.getInstance(
        {} as any,
        {} as any,
        {
          getGameParticipants: (_: string) => ["A", "B", "C"],
          getGame: (_: string) => ({ game_type: "coinflip" }),
        } as any,
      );
      const s = await (gm as any).getCompletedGameStats(
        new PublicKey("BPFLoader2111111111111111111111111111111111"),
        1_000_000_000,
      );
      expect(s.currentTickets).toBe(3);
      expect(s.totalPot).toBe(3_000_000_000n);
    });

    test("giveaway uses base amount", async () => {
      resetGM();
      const gm2 = GameManager.getInstance(
        {} as any,
        {} as any,
        {
          getGameParticipants: (_: string) => ["A"],
          getGame: (_: string) => ({ game_type: "giveaway" }),
        } as any,
      );
      const s2 = await (gm2 as any).getCompletedGameStats(
        new PublicKey("BPFLoader3111111111111111111111111111111111"),
        1_000_000_000,
      );
      expect(s2.totalPot).toBe(1_000_000_000n);
    });
  });
});
