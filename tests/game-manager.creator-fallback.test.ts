import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";

function reset() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("getGameCreatorUsername falls back to formatted address when no telegram id", async () => {
  reset();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const wallet = {} as any;
  const db = {
    getCreatorInfo: (_addr: string) => ({ publicKey: "BPFLoader1111111111111111111111111111111111" }),
  } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: {} }) } } as any;
  const label = await gm.getGameCreatorUsername(ctx, "11111111111111111111111111111111");
  expect(label).toBe("BPFLoader1111111111111111111111111111111111");
});
