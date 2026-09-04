import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "#solana";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager processActiveGames/processRecentGames", () => {
  test("processActiveGames filters invalid entries and formats valid ones", async () => {
    resetGM();
    const gm = GameManager.getInstance({} as any, {} as any, {} as any);
    (gm as any).getGameInfo = async (_ctx: any, _pda: PublicKey) => "OK";
    const ctx = { chat: { id: 1, type: "private" } } as any;
    const out = await (gm as any).processActiveGames(ctx, [
      { game_address: null },
      { game_address: "invalid" },
      { game_address: new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58() },
    ]);
    expect(out).toEqual(["OK"]);
  });

  test("processRecentGames filters out entries on formatter error", async () => {
    resetGM();
    const gm = GameManager.getInstance({} as any, {} as any, {} as any);
    (gm as any).getCompletedGameInfo = async (_ctx: any, data: any) => {
      if (data.game_address === "bad") throw new Error("boom");
      return "Good";
    };
    const ctx = { chat: { id: 1, type: "private" } } as any;
    const out = await (gm as any).processRecentGames(
      ctx,
      [
        { game_address: "bad", winner_address: "cancelled", creator_telegram_id: "1" },
        { game_address: "good", winner_address: null, creator_telegram_id: "1" },
      ],
      "1",
      new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58(),
    );
    expect(out.length).toBe(1);
    expect(out[0]?.gameInfo).toBe("Good");
  });
});
