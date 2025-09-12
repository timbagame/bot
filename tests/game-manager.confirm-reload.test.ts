import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "@solana/web3.js";

function resetGM() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager confirm/reload helpers", () => {
  test("confirmTransactionWithRecovery handles timeout and verifies success", async () => {
    resetGM();
    const wallet = {
      confirmTransaction: async (_: string) => { throw new Error("transaction was not confirmed"); },
    } as any;
    const program = { account: { game: { fetch: async () => ({}) } } } as any;
    const gm = GameManager.getInstance(program, wallet, { getGameParticipants: () => [] } as any);
    (gm as any).isPlayerInGame = async () => true;
    const ok = await (gm as any).confirmTransactionWithRecovery("SIG123", new PublicKey("BPFLoader1111111111111111111111111111111111"), "Player join", new PublicKey("BPFLoader2111111111111111111111111111111111"));
    expect(ok).toBe(true);
  });

  test("confirmTransactionWithRecovery rethrows non-timeout errors", async () => {
    resetGM();
    const wallet = { confirmTransaction: async () => { throw new Error("boom"); } } as any;
    const gm = GameManager.getInstance({} as any, wallet, { getGameParticipants: () => [] } as any);
    await expect((gm as any).confirmTransactionWithRecovery("SIG", new PublicKey("BPFLoader1111111111111111111111111111111111"), "Game creation")).rejects.toThrow(/boom/);
  });

  test("reloadGameMessages seeds active map from DB", async () => {
    resetGM();
    const db = {
      getAllGames: () => [
        { game_address: "ADDR1", message_id: 10, chat_id: 100 },
        { game_address: "ADDR2", message_id: 20, chat_id: 200 },
      ],
    } as any;
    const gm = GameManager.getInstance({} as any, {} as any, db);
    await gm.reloadGameMessages();
    expect(gm.getActiveGameMessage("ADDR1")?.messageId).toBe(10);
    expect(gm.getActiveGameMessage("ADDR2")?.chatId).toBe(200);
  });
});

