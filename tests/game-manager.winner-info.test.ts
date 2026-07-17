import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { sanitizeTelegramDisplayName } from "../src/utils/telegram-display";

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

describe("GameManager.getWinnerInfo", () => {
  test("returns empty string when not completed or no winner", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const ctx = { chat: { id: 1, type: "private" } } as any;
    expect(await (gm as any).getWinnerInfo(ctx, "Active", undefined)).toBe("");
    expect(await (gm as any).getWinnerInfo(ctx, "Completed", undefined)).toBe("");
  });

  test("returns cancelled line for cancelled or null-address winner", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    const ctx = { chat: { id: 1, type: "private" } } as any;
    const nul = "11111111111111111111111111111111";
    expect(await (gm as any).getWinnerInfo(ctx, "Completed", "cancelled")).toContain("Cancelled");
    expect(await (gm as any).getWinnerInfo(ctx, "Completed", nul)).toContain("Cancelled");
  });

  test("returns Winner line with username when address present", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    (gm as any).getPlayerUsername = async () => "@champ";
    const ctx = { chat: { id: 1, type: "private" } } as any;
    const sanitizedHandle = sanitizeTelegramDisplayName("@champ");
    const line = await (gm as any).getWinnerInfo(ctx, "Completed", "SomePubkey");
    expect(line).toContain("Winner:");
    expect(line).toContain(sanitizedHandle);
  });

  test("adds Timba game link when transaction signature provided", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub(), walletStub(), dbStub());
    (gm as any).getPlayerUsername = async () => "@champ";
    const ctx = { chat: { id: 1, type: "private" } } as any;
    const line = await (gm as any).getWinnerInfo(ctx, "Completed", "SomePubkey", "sig123");
    expect(line).toContain("Winner:");
    expect(line).toContain(sanitizeTelegramDisplayName("@champ"));
    expect(line).toContain("https://timba.cc/games/sig123");
    expect(line).toContain("🔗 View game");
    expect(line).not.toContain("solscan.io");
  });
});
