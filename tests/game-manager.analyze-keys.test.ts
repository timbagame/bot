import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("analyzePlayerKeys classifies available/unavailable and creator", () => {
  resetGM();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const wallet = {} as any;
  const creator = new PublicKey("BPFLoader1111111111111111111111111111111111");
  const db = {
    getGameParticipants: (_addr: string) => ["777", "888"],
    getPlayerPublicKey: (id: string) => (id === "777" ? creator.toBase58() : null),
  } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const info = (gm as any).analyzePlayerKeys({ creator }, "GAMEADDR");
  expect(info.available.length).toBe(1);
  expect(info.unavailable.length).toBe(1);
  expect(info.creator).toBeDefined();
  expect(info.nonCreators.length).toBe(0);
  expect(info.canCompleteCleanup).toBe(false);
});

