import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";

const reset = () => {
  GameManager.resetForTest();
};

describe("GameManager membership checks", () => {
  test("uses DB membership fast-path without fetching the on-chain game account", async () => {
    reset();

    const gamePda = (await Keypair.generate()).publicKey;
    const playerPubkey = (await Keypair.generate()).publicKey;
    const telegramId = "123";

    const program = {
      account: {
        game: {
          fetch: async () => {
            throw new Error("should not fetch on-chain");
          },
        },
      },
    } as any;

    const wallet = {
      getBlockchainTime: async () => 1,
      formatTokenBalance: () => "0",
    } as any;

    const db = {
      getPlayerTelegramId: (_pub: string) => telegramId,
      isGameParticipant: (_gameAddress: string, _telegram: string) => true,
    } as any;

    const gm = GameManager.getInstance(program, wallet, db);
    const isInGame = await (gm as any).isPlayerInGame(gamePda as PublicKey, playerPubkey);
    expect(isInGame).toBe(true);
  });
});
