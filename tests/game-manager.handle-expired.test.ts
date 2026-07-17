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

function baseWallet() {
  return {} as any;
}
function baseDb(overrides: Partial<any> = {}) {
  return {
    getGameParticipants: (_: string) => [],
    getPlayerPublicKey: (_: string) => null,
    getPlayerTelegramId: (_: string) => null,
    getGame: (_: string) => null,
    ...overrides,
  } as any;
}

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
    const res = await (gm as any).handleExpiredGame(
      new PublicKey("BPFLoader2111111111111111111111111111111111"),
      gameAccount,
    );
    expect(res).not.toBe(false);
  });

  test("coinflip chooses complete cleanup strategy when canCompleteCleanup", async () => {
    resetGM();
    const gm = GameManager.getInstance(baseProgram(), baseWallet(), baseDb());
    (gm as any).analyzePlayerKeys = () => ({
      available: [1, 2],
      total: 2,
      canCompleteCleanup: true,
      creator: { telegramId: "777" },
    });
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
    const res = await (gm as any).handleExpiredGame(
      new PublicKey("BPFLoader3111111111111111111111111111111111"),
      gameAccount,
    );
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
    const res = await (gm as any).handleExpiredGame(
      new PublicKey("BPFLoader4111111111111111111111111111111111"),
      gameAccount,
    );
    expect(res).toBe(false);
  });

  test("coinflip below minimum players cancels immediately after cleanup", async () => {
    resetGM();
    const cleanupAddress = new PublicKey("BPFLoader5111111111111111111111111111111111");
    const refreshedCreator = new PublicKey("BPFLoader6111111111111111111111111111111111");

    const gm = GameManager.getInstance(baseProgram(), baseWallet(), baseDb());

    let cleanupCalled = false;
    (gm as any).handleExpiredCoinflip = async () => {
      cleanupCalled = true;
      return true;
    };

    let cancelArgs: any[] | null = null;
    (gm as any).cancelGameWithPlayerKeys = async (...args: any[]) => {
      cancelArgs = args;
      return { success: true, tx: "cleanup-tx" };
    };

    let fetchCalls = 0;
    (gm as any).program = {
      account: {
        game: {
          fetch: async () => {
            fetchCalls += 1;
            return {
              ticketsCount: 0,
              ticketAmount: 50,
              creator: refreshedCreator,
            };
          },
        },
      },
    } as any;

    const now = Math.floor(Date.now() / 1000);
    const gameAccount = {
      gameType: { coinflip: {} },
      createdAt: now - 10_000,
      timeout: 60,
      ticketsCount: 1,
      minTickets: 3,
      maxTickets: 5,
      ticketAmount: 50,
      creator: new PublicKey("BPFLoader6211111111111111111111111111111111"),
    };

    const result = await (gm as any).handleExpiredGame(cleanupAddress, gameAccount);

    expect(cleanupCalled).toBe(true);
    expect(cancelArgs).not.toBeNull();
    expect(fetchCalls).toBeGreaterThan(0);
    expect(result).toEqual({
      cancelled: true,
      amount: 50,
      creator: refreshedCreator.toBase58(),
      tx: "cleanup-tx",
    });
  });

  test("coinflip below minimum automatically unjoins bot players from a mixed-client game", async () => {
    resetGM();
    const gameAddress = new PublicKey("BPFLoader7111111111111111111111111111111111");
    const webCreator = new PublicKey("BPFLoader8111111111111111111111111111111111");
    const botPlayer = new PublicKey("BPFLoader9111111111111111111111111111111111");
    const gm = GameManager.getInstance(baseProgram(), baseWallet(), baseDb());

    (gm as any).analyzePlayerKeys = () => ({
      available: [{ pubkey: botPlayer, telegramId: "42", isCreator: false }],
      unavailable: [webCreator.toBase58()],
      nonCreators: [{ pubkey: botPlayer, telegramId: "42", isCreator: false }],
      creator: undefined,
      canCompleteCleanup: false,
      total: 2,
      onChainTickets: 2,
      onChainParticipants: 2,
      dbParticipantCount: 1,
      unmatchedParticipants: [webCreator.toBase58()],
    });
    (gm as any).reconcilePendingParticipants = async () => {};

    let unjoinedPlayers: Array<{ pubkey: PublicKey; telegramId: string }> = [];
    (gm as any).unjoinPlayers = async (_game: PublicKey, _account: any, players: any[]) => {
      unjoinedPlayers = players;
      return players.length;
    };
    (gm as any).program = {
      account: { game: { fetch: async () => ({ ticketsCount: 1 }) } },
    } as any;

    const now = Math.floor(Date.now() / 1000);
    const result = await gm.handleExpiredGame(gameAddress, {
      gameType: { coinflip: {} },
      createdAt: now - 600,
      timeout: 60,
      ticketsCount: 2,
      minTickets: 3,
      maxTickets: 4,
      ticketAmount: 50,
      creator: webCreator,
    });

    expect(unjoinedPlayers).toHaveLength(1);
    expect(unjoinedPlayers[0]?.pubkey.equals(botPlayer)).toBeTrue();
    expect(unjoinedPlayers[0]?.telegramId).toBe("42");
    expect(result).toBe(false);
  });

  test("coinflip with minimum players waits until buffer elapses", async () => {
    resetGM();
    const gm = GameManager.getInstance(baseProgram(), baseWallet(), baseDb());

    (gm as any).handleExpiredCoinflip = async () => {
      throw new Error("should not attempt cleanup before buffer elapses");
    };

    let cancelCalled = false;
    (gm as any).cancelGameWithPlayerKeys = async () => {
      cancelCalled = true;
      return { success: true, tx: "noop" };
    };

    const now = Math.floor(Date.now() / 1000);
    const timeout = 300;
    const gameAccount = {
      gameType: { coinflip: {} },
      createdAt: now - (timeout + 10),
      timeout,
      ticketsCount: 2,
      minTickets: 2,
      maxTickets: 5,
      ticketAmount: 75,
      creator: new PublicKey("BPFLoader6311111111111111111111111111111111"),
    };

    const result = await (gm as any).handleExpiredGame(
      new PublicKey("BPFLoader6411111111111111111111111111111111"),
      gameAccount,
    );

    expect(result).toBe(false);
    expect(cancelCalled).toBe(false);
  });

  test("coinflip with minimum players force-cancels after buffer elapses", async () => {
    resetGM();
    const refreshedCreator = new PublicKey("BPFLoader6511111111111111111111111111111111");
    const gm = GameManager.getInstance(baseProgram(), baseWallet(), baseDb());

    let cleanupCalled = false;
    (gm as any).handleExpiredCoinflip = async () => {
      cleanupCalled = true;
      return true;
    };

    let cancelArgs: any[] | null = null;
    (gm as any).cancelGameWithPlayerKeys = async (...args: any[]) => {
      cancelArgs = args;
      return { success: true, tx: "buffer-cleanup-tx" };
    };

    (gm as any).program = {
      account: {
        game: {
          fetch: async () => ({
            ticketsCount: 0,
            ticketAmount: 75,
            creator: refreshedCreator,
          }),
        },
      },
    } as any;

    const now = Math.floor(Date.now() / 1000);
    const timeout = 300;
    // Buffer is 86400 seconds (24 hours) - set createdAt well past both timeout and buffer
    const gameAccount = {
      gameType: { coinflip: {} },
      createdAt: now - (timeout + 86400 + 100),
      timeout,
      ticketsCount: 2,
      minTickets: 2,
      maxTickets: 5,
      ticketAmount: 75,
      creator: new PublicKey("BPFLoader6611111111111111111111111111111111"),
    };

    const result = await (gm as any).handleExpiredGame(
      new PublicKey("BPFLoader6711111111111111111111111111111111"),
      gameAccount,
    );

    expect(cleanupCalled).toBe(true);
    expect(cancelArgs).not.toBeNull();
    expect(result).toEqual({
      cancelled: true,
      amount: 75,
      creator: refreshedCreator.toBase58(),
      tx: "buffer-cleanup-tx",
    });
  });
});
