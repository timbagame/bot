import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function programStub() {
  return { account: { game: { fetch: async () => ({}) } } } as any;
}

function walletStub() {
  return {} as any;
}

function dbStub() {
  return {} as any;
}

describe("GameManager.getUsernameFromTelegramId", () => {
  test("returns null for invalid numeric ID", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: {} }) } } as any;
    const res = await gm.getUsernameFromTelegramId(ctx, "not-a-number");
    expect(res).toBeNull();
  });

  test("falls back to first_name when username missing", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const ctx = { chat: { id: 1, type: "private" }, api: { getChatMember: async () => ({ user: { first_name: "Alice" } }) } } as any;
    const res = await gm.getUsernameFromTelegramId(ctx, "777");
    expect(res).toBe("Alice");
  });
});

