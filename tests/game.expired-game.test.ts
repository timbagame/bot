import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "#solana";

const GAME_PDA = new PublicKey("BPFLoader2111111111111111111111111111111111");
const CREATOR = new PublicKey("BPFLoader1111111111111111111111111111111111");

function expiredAccount(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    gameType: { coinflip: {} },
    createdAt: now - 1_000_000,
    timeout: 1,
    ticketsCount: 0,
    maxTickets: 2,
    minTickets: 1,
    ticketAmount: 5,
    creator: CREATOR,
    ...overrides,
  };
}

let errorSpy: ReturnType<typeof spyOn>;

function makeManager(fetch: () => Promise<any> = async () => expiredAccount()) {
  const gm: any = GameManager.getInstance(
    { account: { game: { fetch } } } as any,
    {} as any,
    { getGameParticipants: () => [] } as any,
  );
  return gm;
}

beforeEach(() => {
  GameManager.resetForTest();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  GameManager.resetForTest();
});

describe("GameManager.handleExpiredGame edge paths", () => {
  test("leaves a game alone while it has not expired", async () => {
    const gm = makeManager();
    gm.cancelGameWithPlayerKeys = vi.fn();
    gm.handleExpiredCoinflip = vi.fn();
    const now = Math.floor(Date.now() / 1000);
    const result = await gm.handleExpiredGame(
      GAME_PDA,
      expiredAccount({ createdAt: now, timeout: 3_600 }),
    );
    expect(result).toBe(false);
    expect(gm.cancelGameWithPlayerKeys).not.toHaveBeenCalled();
    expect(gm.handleExpiredCoinflip).not.toHaveBeenCalled();
  });

  describe("giveaway with no tickets", () => {
    const giveaway = () => expiredAccount({ gameType: { giveaway: {} }, minTickets: 0 });

    test("reports false and logs when closing throws", async () => {
      const gm = makeManager();
      const failure = new Error("synthetic close failure");
      gm.cancelGameWithPlayerKeys = vi.fn(async () => {
        throw failure;
      });
      expect(await gm.handleExpiredGame(GAME_PDA, giveaway())).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith("Error closing expired giveaway:", failure);
    });

    test("reports false when closing is declined", async () => {
      const gm = makeManager();
      gm.cancelGameWithPlayerKeys = vi.fn(async () => ({ success: false, error: "nope" }));
      expect(await gm.handleExpiredGame(GAME_PDA, giveaway())).toBe(false);
      expect(gm.cancelGameWithPlayerKeys).toHaveBeenCalledWith(GAME_PDA, "giveaway");
    });
  });

  describe("coinflip with no tickets", () => {
    test("returns the cancellation details when the close succeeds", async () => {
      const gm = makeManager();
      gm.cancelGameWithPlayerKeys = vi.fn(async () => ({ success: true, tx: "TX_CLOSE" }));
      expect(await gm.handleExpiredGame(GAME_PDA, expiredAccount())).toEqual({
        cancelled: true,
        amount: 5,
        creator: CREATOR.toBase58(),
        tx: "TX_CLOSE",
      });
      expect(gm.cancelGameWithPlayerKeys).toHaveBeenCalledWith(GAME_PDA, "coinflip");
    });

    test("reports false when the close is declined", async () => {
      const gm = makeManager();
      gm.cancelGameWithPlayerKeys = vi.fn(async () => ({ success: false, error: "no creator" }));
      expect(await gm.handleExpiredGame(GAME_PDA, expiredAccount())).toBe(false);
    });

    test("reports false and logs when the close throws", async () => {
      const gm = makeManager();
      const failure = new Error("synthetic close failure");
      gm.cancelGameWithPlayerKeys = vi.fn(async () => {
        throw failure;
      });
      expect(await gm.handleExpiredGame(GAME_PDA, expiredAccount())).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        "Error closing expired coinflip with zero tickets:",
        failure,
      );
    });
  });

  describe("coinflip below the minimum after participant cleanup", () => {
    const underMinimum = () => expiredAccount({ ticketsCount: 1, minTickets: 2 });

    test("treats an already closed account as a successful close", async () => {
      const gm = makeManager(async () => {
        throw new Error("Account does not exist");
      });
      gm.handleExpiredCoinflip = vi.fn(async () => true);
      gm.cancelGameWithPlayerKeys = vi.fn();
      expect(await gm.handleExpiredGame(GAME_PDA, underMinimum())).toBe(false);
      expect(gm.cancelGameWithPlayerKeys).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test("logs other refresh failures and still reports false", async () => {
      const failure = new Error("rpc exploded");
      const gm = makeManager(async () => {
        throw failure;
      });
      gm.handleExpiredCoinflip = vi.fn(async () => true);
      expect(await gm.handleExpiredGame(GAME_PDA, underMinimum())).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith("Post-cleanup close attempt failed:", failure);
    });
  });

  describe("coinflip past the oracle buffer", () => {
    const enoughTickets = () => expiredAccount({ ticketsCount: 2, minTickets: 1 });

    test("closes the game when cleanup leaves no tickets", async () => {
      const gm = makeManager(async () => expiredAccount({ ticketsCount: 0, ticketAmount: 7 }));
      gm.handleExpiredCoinflip = vi.fn(async () => true);
      gm.cancelGameWithPlayerKeys = vi.fn(async () => ({ success: true, tx: "TX_BUFFER" }));
      expect(await gm.handleExpiredGame(GAME_PDA, enoughTickets())).toEqual({
        cancelled: true,
        amount: 7,
        creator: CREATOR.toBase58(),
        tx: "TX_BUFFER",
      });
    });

    test("reports false when tickets remain after cleanup", async () => {
      const gm = makeManager(async () => expiredAccount({ ticketsCount: 1 }));
      gm.handleExpiredCoinflip = vi.fn(async () => true);
      gm.cancelGameWithPlayerKeys = vi.fn();
      expect(await gm.handleExpiredGame(GAME_PDA, enoughTickets())).toBe(false);
      expect(gm.cancelGameWithPlayerKeys).not.toHaveBeenCalled();
    });

    test("reports false when cleanup did not finish", async () => {
      const gm = makeManager();
      gm.handleExpiredCoinflip = vi.fn(async () => false);
      expect(await gm.handleExpiredGame(GAME_PDA, enoughTickets())).toBe(false);
    });

    test("treats an already closed account as handled", async () => {
      const gm = makeManager(async () => {
        throw Object.assign(new Error("gone"), { code: "ACCOUNT_NOT_FOUND" });
      });
      gm.handleExpiredCoinflip = vi.fn(async () => true);
      expect(await gm.handleExpiredGame(GAME_PDA, enoughTickets())).toBe(false);
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test("logs other refresh failures", async () => {
      const failure = new Error("rpc exploded");
      const gm = makeManager(async () => {
        throw failure;
      });
      gm.handleExpiredCoinflip = vi.fn(async () => true);
      expect(await gm.handleExpiredGame(GAME_PDA, enoughTickets())).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith("Post-buffer cleanup close attempt failed:", failure);
    });

    test("does nothing for a game type it does not know how to unwind", async () => {
      const gm = makeManager();
      gm.handleExpiredCoinflip = vi.fn();
      gm.cancelGameWithPlayerKeys = vi.fn();
      const result = await gm.handleExpiredGame(
        GAME_PDA,
        expiredAccount({ gameType: { lottery: {} }, ticketsCount: 2, minTickets: 1 }),
      );
      expect(result).toBe(false);
      expect(gm.handleExpiredCoinflip).not.toHaveBeenCalled();
      expect(gm.cancelGameWithPlayerKeys).not.toHaveBeenCalled();
    });
  });
});
