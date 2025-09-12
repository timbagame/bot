import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("cancelGameWithPlayerKeys returns error when creator mapping missing", async () => {
  resetGM();
  const program = { account: { game: { fetch: async () => ({ creator: new PublicKey("BPFLoader1111111111111111111111111111111111") }) } } } as any;
  const wallet = {} as any;
  const db = { getPlayerTelegramId: (_: string) => null } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const res = await (gm as any).cancelGameWithPlayerKeys(new PublicKey("BPFLoader2111111111111111111111111111111111"), "coinflip");
  expect(res.success).toBe(false);
  expect(res.error).toMatch(/Creator not found/i);
});

