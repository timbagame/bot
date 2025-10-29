import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";

function reset() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("getPlayerUsername falls back to address when mapping missing", async () => {
  reset();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const wallet = {} as any;
  const db = { getPlayerTelegramId: (_pk: string) => null } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: {} }) } } as any;
  const label = await gm.getPlayerUsername(ctx, "BPFLoader1111111111111111111111111111111111");
  expect(label).toBe("BPFLoader1111111111111111111111111111111111");
});

