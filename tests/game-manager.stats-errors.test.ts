import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("getActiveGameStats returns fallback when fetch fails", async () => {
  resetGM();
  const program = { account: { game: { fetch: async () => { throw new Error("boom"); } } } } as any;
  const gm = GameManager.getInstance(program, {} as any, {} as any);
  const s = await (gm as any).getActiveGameStats(new PublicKey("BPFLoader1111111111111111111111111111111111"), 1_000_000_000);
  expect(s.currentTickets).toBe(0);
  expect(s.totalPot).toBe(1_000_000_000);
  expect(s.expirationInfo).toBe("");
});

