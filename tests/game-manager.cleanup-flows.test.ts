import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";

function resetGM() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");

describe("GameManager cleanup flows", () => {
  test("unjoinPlayers returns count and calls unjoin per player", async () => {
    resetGM();
    const wallet = { getKeyPair: (_: bigint) => Keypair.generate() } as any;
    const gm = GameManager.getInstance({} as any, wallet, { getGameParticipants: () => [] } as any);
    const players = [
      { telegramId: "1", pubkey: new PublicKey("BPFLoader2111111111111111111111111111111111"), isCreator: false },
      { telegramId: "2", pubkey: new PublicKey("BPFLoader3111111111111111111111111111111111"), isCreator: true },
    ];
    let calls = 0;
    (gm as any).unjoinPlayerFromGame = async () => { calls++; };
    const n = await (gm as any).unjoinPlayers(gamePda, players);
    expect(n).toBe(2);
    expect(calls).toBe(2);
  });

  test("executeCompleteCleanup cancels when all unjoined", async () => {
    resetGM();
    const gm = GameManager.getInstance({} as any, {} as any, { getGameParticipants: () => [] } as any);
    (gm as any).unjoinPlayers = async (_p: any, list: any[]) => list.length;
    (gm as any).cancelGameWithCreator = async () => true;
    const ok = await (gm as any).executeCompleteCleanup(gamePda, {}, { available: [1,2], creator: { telegramId: "777" } }, "ADDR");
    expect(ok).toBe(true);
  });

  test("executeCompleteCleanup returns false when some players remain", async () => {
    resetGM();
    const gm = GameManager.getInstance({} as any, {} as any, { getGameParticipants: () => [] } as any);
    (gm as any).unjoinPlayers = async () => 1;
    const ok = await (gm as any).executeCompleteCleanup(gamePda, {}, { available: [1,2], creator: { telegramId: "777" } }, "ADDR");
    expect(ok).toBe(false);
  });

  test("executePartialCleanup returns true iff unjoinedCount>0", async () => {
    resetGM();
    const gm = GameManager.getInstance({} as any, {} as any, { getGameParticipants: () => [] } as any);
    (gm as any).unjoinPlayers = async () => 0;
    const a = await (gm as any).executePartialCleanup(gamePda, { available: [1,2] }, "ADDR");
    (gm as any).unjoinPlayers = async () => 1;
    const b = await (gm as any).executePartialCleanup(gamePda, { available: [1,2] }, "ADDR");
    expect(a).toBe(false);
    expect(b).toBe(true);
  });
});

