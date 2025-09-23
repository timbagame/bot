import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";

function resetGameManager() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function stubProgram() {
  return { account: { game: { fetch: async () => ({}) } } } as any;
}

const stubDb = { getGameParticipants: () => [] } as any;

const stubWallet = {} as any;

describe("GameManager expired coinflip handler", () => {
  test("prefers complete cleanup when creator key available", async () => {
    resetGameManager();
    const gm = GameManager.getInstance(stubProgram(), stubWallet, stubDb);
    const analyzeInfo = {
      available: [{ marker: "creator" }, { marker: "player" }],
      unavailable: [],
      nonCreators: [{ marker: "player" }],
      creator: { telegramId: "999" },
      canCompleteCleanup: true,
      total: 2,
    };

    const cleanupCalls: any[] = [];
    let partialCalled = false;

    (gm as any).analyzePlayerKeys = (account: any, address: string) => {
      expect(address).toBe("ADDR1");
      expect(account).toEqual({ creator: "CREATOR" });
      return analyzeInfo;
    };
    (gm as any).executeCompleteCleanup = async (...args: any[]) => {
      cleanupCalls.push(args);
      return true;
    };
    (gm as any).executePartialCleanup = async () => {
      partialCalled = true;
      return false;
    };

    const result = await (gm as any).handleExpiredCoinflip(
      new PublicKey("BPFLoader1111111111111111111111111111111111"),
      { creator: "CREATOR" },
      "ADDR1"
    );

    expect(result).toBe(true);
    expect(cleanupCalls.length).toBe(1);
    expect(cleanupCalls[0][0]).toBeInstanceOf(PublicKey);
    expect(cleanupCalls[0][1]).toEqual({ creator: "CREATOR" });
    expect(cleanupCalls[0][2]).toBe(analyzeInfo);
    expect(cleanupCalls[0][3]).toBe("ADDR1");
    expect(partialCalled).toBe(false);
  });

  test("falls back to partial cleanup when creator key missing", async () => {
    resetGameManager();
    const gm = GameManager.getInstance(stubProgram(), stubWallet, stubDb);
    const analyzeInfo = {
      available: [{ marker: "player" }],
      unavailable: ["no-key"],
      nonCreators: [{ marker: "player" }],
      creator: undefined,
      canCompleteCleanup: false,
      total: 1,
    };

    let completeCalled = false;
    const partialCalls: any[] = [];

    (gm as any).analyzePlayerKeys = () => analyzeInfo;
    (gm as any).executeCompleteCleanup = async () => {
      completeCalled = true;
      return true;
    };
    (gm as any).executePartialCleanup = async (...args: any[]) => {
      partialCalls.push(args);
      return false;
    };

    const result = await (gm as any).handleExpiredCoinflip(
      new PublicKey("BPFLoader2111111111111111111111111111111111"),
      { creator: "CREATOR2" },
      "ADDR2"
    );

    expect(result).toBe(false);
    expect(completeCalled).toBe(false);
    expect(partialCalls.length).toBe(1);
    expect(partialCalls[0][0]).toBeInstanceOf(PublicKey);
    expect(partialCalls[0][1]).toBe(analyzeInfo);
    expect(partialCalls[0][2]).toBe("ADDR2");
  });
});
