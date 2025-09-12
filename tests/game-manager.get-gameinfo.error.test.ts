import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("getGameInfo returns error string on fetch failure", async () => {
  resetGM();
  const program = { account: { game: { fetch: async () => { throw new Error("boom"); } } } } as any;
  const wallet = {} as any;
  const db = {} as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const out = await gm.getGameInfo({} as any, new PublicKey("BPFLoader1111111111111111111111111111111111"));
  expect(out).toContain("Error fetching game: boom");
});

