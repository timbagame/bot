import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";
import { formatUserFriendlyError } from "../src/utils/errors";

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
    const program = {
      account: { game: { fetchNullable: async () => ({}) } },
      provider: {},
    } as any;
    const gm = GameManager.getInstance(program, wallet, { getGameParticipants: () => [] } as any);
    (gm as any).isPlayerInGame = async () => true;
    const ok = await (gm as any).confirmTransactionWithRecovery("SIG123", new PublicKey("BPFLoader1111111111111111111111111111111111"), "Player join", new PublicKey("BPFLoader2111111111111111111111111111111111"));
    expect(ok).toBe(true);
  });

  test("confirmTransactionWithRecovery preserves timeout message when recovery fails", async () => {
    resetGM();
    const wallet = {
      confirmTransaction: async () => {
        const err = new Error(
          "transaction confirmation timeout: RPC node did not respond"
        );
        return Promise.reject(err);
      },
    } as any;
    const program = {
      account: { game: { fetchNullable: async () => null } },
      provider: {},
    } as any;
    const gm = GameManager.getInstance(program, wallet, { getGameParticipants: () => [] } as any);
    const signature = "SIG";
    const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");

    try {
      await (gm as any).confirmTransactionWithRecovery(
        signature,
        gamePda,
        "Game creation"
      );
      throw new Error("Expected transaction confirmation to fail");
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("transaction confirmation timeout");
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toContain(
        "Game account not found after timeout"
      );
      const friendly = formatUserFriendlyError(error);
      expect(friendly).toContain("Transaction confirmation timed out");
    }
  });

  test("confirmTransactionWithRecovery rethrows non-timeout errors", async () => {
    resetGM();
    const wallet = { confirmTransaction: async () => { throw new Error("boom"); } } as any;
    const gm = GameManager.getInstance({} as any, wallet, { getGameParticipants: () => [] } as any);
    await expect((gm as any).confirmTransactionWithRecovery("SIG", new PublicKey("BPFLoader1111111111111111111111111111111111"), "Game creation")).rejects.toThrow(/boom/);
  });

  test("isPlayerInGame falls back to on-chain participant hashes", async () => {
    resetGM();

    const player = Keypair.generate();
    const gamePda = new PublicKey("BPFLoader3111111111111111111111111111111111");

    const gameAccount: any = { participantHashes: [] };
    const program = {
      account: {
        game: {
          fetchNullable: async () => gameAccount,
        },
      },
      provider: {},
    } as any;

    const gm = GameManager.getInstance(
      program,
      {} as any,
      {
        getGameParticipants: () => [],
        getPlayerTelegramId: () => null,
      } as any
    );

    const participantHash = (gm as any).computeParticipantHash(
      gamePda,
      player.publicKey
    );
    gameAccount.participantHashes = [
      {
        toString: () => participantHash,
      },
    ];

    const inGame = await (gm as any).isPlayerInGame(gamePda, player.publicKey);
    expect(inGame).toBe(true);
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

