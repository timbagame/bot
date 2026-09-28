import { describe, expect, test } from "bun:test";
import { PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";

function resetGameManager() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function stubProgram() {
  return { account: { game: { fetch: async () => ({}) } } } as any;
}

describe("GameManager expired giveaway handler", () => {
  test("closes immediately when expired and minimum tickets not reached", async () => {
    resetGameManager();
    const gm = GameManager.getInstance(stubProgram(), {} as any, {} as any);

    const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");
    const creator = new PublicKey("BPFLoader2111111111111111111111111111111111");

    const calls: any[] = [];
    (gm as any).cancelGameWithPlayerKeys = async (...args: any[]) => {
      calls.push(args);
      return { success: true, tx: "TX_CLOSE" };
    };

    const result = await gm.handleExpiredGame(gamePda, {
      gameType: { giveaway: {} },
      ticketsCount: 22,
      minTickets: 99,
      maxTickets: 100,
      createdAt: 0,
      timeout: 0,
      ticketAmount: 123,
      creator,
    });

    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe(gamePda);
    expect(calls[0][1]).toBe("giveaway");
    expect(result).toEqual({
      cancelled: true,
      amount: 123,
      creator: creator.toBase58(),
      tx: "TX_CLOSE",
    });
  });

  test("waits for the oracle buffer when minimum tickets were reached", async () => {
    resetGameManager();
    const gm = GameManager.getInstance(stubProgram(), {} as any, {} as any);

    const gamePda = new PublicKey("BPFLoader3111111111111111111111111111111111");
    const creator = new PublicKey("BPFLoader4111111111111111111111111111111111");

    let cancelCalled = false;
    (gm as any).cancelGameWithPlayerKeys = async () => {
      cancelCalled = true;
      return { success: true, tx: "TX_CLOSE" };
    };

    const now = Math.floor(Date.now() / 1000);
    const result = await gm.handleExpiredGame(gamePda, {
      gameType: { giveaway: {} },
      ticketsCount: 99,
      minTickets: 99,
      maxTickets: 100,
      createdAt: now - 60,
      timeout: 30,
      ticketAmount: 123,
      creator,
    });

    expect(cancelCalled).toBe(false);
    expect(result).toBe(false);
  });

  test("closes an unresolved giveaway after the oracle buffer", async () => {
    resetGameManager();
    const gm = GameManager.getInstance(stubProgram(), {} as any, {} as any);
    const gamePda = new PublicKey("BPFLoader5111111111111111111111111111111111");
    const creator = new PublicKey("BPFLoader6111111111111111111111111111111111");

    (gm as any).isGameExpiredWithBuffer = () => true;
    (gm as any).cancelGameWithPlayerKeys = async () => ({
      success: true,
      tx: "TX_BUFFER_CLOSE",
    });

    const result = await gm.handleExpiredGame(gamePda, {
      gameType: { giveaway: {} },
      ticketsCount: 99,
      minTickets: 99,
      maxTickets: 100,
      createdAt: 0,
      timeout: 0,
      ticketAmount: 123,
      creator,
    });

    expect(result).toEqual({
      cancelled: true,
      amount: 123,
      creator: creator.toBase58(),
      tx: "TX_BUFFER_CLOSE",
    });
  });
});

describe("GameManager orphaned giveaway cleanup", () => {
  const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  const setup = (results: Array<{ success: boolean }>) => {
    resetGameManager();
    const gm = GameManager.getInstance(stubProgram(), {} as any, {} as any);
    const calls: any[][] = [];
    (gm as any).cancelGameWithPlayerKeys = async (...args: any[]) => {
      calls.push(args);
      return results.shift() ?? { success: false };
    };
    return { gm, calls };
  };

  test("cancels empty or under-filled giveaways immediately and reports the outcome", async () => {
    const empty = setup([{ success: true }]);
    expect(
      await (empty.gm as any).handleExpiredGiveaway(
        gamePda,
        { gameType: { giveaway: {} }, ticketsCount: 0, minTickets: 0 },
        "ADDR",
      ),
    ).toBe(true);
    expect(empty.calls).toEqual([[gamePda, "giveaway"]]);

    const underFilled = setup([{ success: false }]);
    expect(
      await (underFilled.gm as any).handleExpiredGiveaway(
        gamePda,
        { gameType: { giveaway: {} }, ticketsCount: 2, minTickets: 5 },
        "ADDR",
      ),
    ).toBe(false);
    expect(underFilled.calls).toHaveLength(1);
  });

  test("waits for the oracle buffer before closing a giveaway that reached its minimum", async () => {
    const { gm, calls } = setup([]);
    const result = await (gm as any).handleExpiredGiveaway(
      gamePda,
      {
        gameType: { giveaway: {} },
        ticketsCount: 5,
        minTickets: 2,
        createdAt: nowSeconds() - 120,
        timeout: 60,
      },
      "ADDR",
    );
    expect(result).toBe(false);
    expect(calls).toEqual([]);
  });

  test("closes a filled giveaway once the buffer elapsed and reports cancellation failures", async () => {
    const expiredAccount = {
      gameType: { giveaway: {} },
      ticketsCount: 5,
      minTickets: 2,
      maxTickets: 10,
      createdAt: 0,
      timeout: 60,
    };

    const succeeded = setup([{ success: true }]);
    expect(await (succeeded.gm as any).handleExpiredGiveaway(gamePda, expiredAccount, "ADDR")).toBe(
      true,
    );
    expect(succeeded.calls).toEqual([[gamePda, "giveaway"]]);

    const failed = setup([{ success: false }]);
    expect(await (failed.gm as any).handleExpiredGiveaway(gamePda, expiredAccount, "ADDR")).toBe(
      false,
    );
    expect(failed.calls).toHaveLength(1);
  });
});
