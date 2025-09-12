import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";

function resetGM() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("getPlayerUsername returns @username when mapping exists", async () => {
  resetGM();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const wallet = {} as any;
  const db = {
    getPlayerTelegramId: (_pk: string) => "777",
  } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: { username: "alice" } }) } } as any;
  const label = await gm.getPlayerUsername(ctx, "BPFLoader1111111111111111111111111111111111");
  expect(label).toBe("@alice");
});

