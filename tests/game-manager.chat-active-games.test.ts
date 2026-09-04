import { beforeEach, describe, expect, test, vi } from "bun:test";
import { PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";

function resetGM() {
  // @ts-expect-error - test helper to reset singleton
  GameManager["instance"] = undefined;
}

describe("GameManager.getChatActiveGames", () => {
  beforeEach(() => {
    resetGM();
  });

  test("returns chat-scoped active games with join callbacks", async () => {
    const gameAddress = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();

    const gameDb = {
      getActiveGamesByChat: vi.fn(() => [
        {
          game_address: gameAddress,
          game_type: "coinflip",
          amount: 1000,
          token_ticker: "TOK",
          status: "active",
          winner_address: null,
        },
      ]),
    } as any;

    const gm = GameManager.getInstance({} as any, {} as any, gameDb);

    (gm as any).formatGameMessage = vi.fn(async () => ({
      messageText: "Game summary",
      keyboard: [[{ text: "🎮 Join", callback_data: `join_${gameAddress}` }]],
    }));
    (gm as any).getGameCreatorUsername = vi.fn(async () => "@creator");

    const ctx = { chat: { id: -100, type: "supergroup" } } as any;
    const games = await gm.getChatActiveGames(ctx, -100);

    expect(gameDb.getActiveGamesByChat).toHaveBeenCalledWith(-100);
    expect(games).toHaveLength(1);

    const firstGame = games[0]!;
    const callbacks = firstGame.keyboard.flat().map((b: any) => b.callback_data);

    expect(callbacks).toContain(`join_${gameAddress}`);
    expect(firstGame.messageText).toContain("Game summary");
  });
});
