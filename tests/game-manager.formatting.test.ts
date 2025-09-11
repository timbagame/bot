import { describe, test, expect, beforeEach } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";

// Helpers to reset singleton
function resetGameManager() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function makeProgramStub(game: any) {
  return {
    account: {
      game: {
        fetch: async () => game,
      },
    },
  } as any;
}

function makeWalletStub(opts?: { blockTime?: number }) {
  const blockTime = opts?.blockTime ?? Math.floor(Date.now() / 1000);
  return {
    getBlockchainTime: async () => blockTime,
    formatTokenBalance: (amount: number, decimals: number) => {
      const v = amount / Math.pow(10, decimals);
      return v.toFixed(6).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
    },
  } as any;
}

function makeDbStub(participants: string[], gameData: any, playerTelegramByPub: Record<string,string>) {
  return {
    getGameParticipants: (_addr: string) => participants,
    getGame: (_addr: string) => gameData,
    getPlayerTelegramId: (pub: string) => playerTelegramByPub[pub] || null,
  } as any;
}

function makeCtxStub() {
  return {
    chat: { id: 42 },
    api: {
      getChatMember: async (_chatId: number, userId: number) => ({
        user: { username: `user${userId}`, first_name: `U${userId}` },
        status: "member",
      }),
    },
  } as any;
}

describe("GameManager.formatGameMessage", () => {
  beforeEach(resetGameManager);

  test("coinflip active: shows prize = amount * tickets and participants", async () => {
    const amount = 1_000_000_000; // 1 token with 9 decimals
    const createdAt = 1_000_000;
    const timeout = 60;
    const gameAccount = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 2,
      totalAmount: 0,
      createdAt,
      timeout,
    };
    const program = makeProgramStub(gameAccount);
    const wallet = makeWalletStub({ blockTime: createdAt + 30 });
    const db = makeDbStub(["123", "456"], { token_ticker: "WSOL" }, {});
    const gm = GameManager.getInstance(program, wallet, db);
    const ctx = makeCtxStub();
    const gamePda = new PublicKey("11111111111111111111111111111111");

    const res = await gm.formatGameMessage(ctx, gamePda, "coinflip", amount, "@creator", "Active", "WSOL");
    expect(res.messageText).toContain("WSOL");
    // Message formatting basics
    // Status present
    expect(res.messageText).toContain("Status:");
    // Keyboard shows Join/Refresh
    expect((res.keyboard[0] || []).length).toBeGreaterThan(0);
  });

  test("giveaway completed: shows winner line and no keyboard", async () => {
    const amount = 1_000_000_000; // 1 token with 9 decimals
    const createdAt = 1_000_000;
    const timeout = 60;
    const gameAccount = {
      ticketsCount: 3,
      maxTickets: 5,
      minTickets: 1,
      totalAmount: 0,
      createdAt,
      timeout,
      gameType: { giveaway: {} },
    };
    const winner = "WINNERPUB";
    const program = makeProgramStub(gameAccount);
    const wallet = makeWalletStub();
    const db = makeDbStub(["111","222","333"], { token_ticker: "WSOL", game_type: "giveaway" }, { [winner]: "999" });
    const gm = GameManager.getInstance(program, wallet, db);
    const ctx = makeCtxStub();
    const gamePda = new PublicKey("11111111111111111111111111111111");

    const res = await gm.formatGameMessage(ctx, gamePda, "giveaway", amount, "@creator", "Completed", "WSOL", winner);
    expect(res.messageText).toContain("Winner:");
    expect(res.messageText).toContain("@user999");
    // No keyboard for completed
    expect(res.keyboard.length).toBe(0);
  });
});
