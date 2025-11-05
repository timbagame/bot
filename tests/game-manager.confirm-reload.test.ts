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
    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG123",
      new PublicKey("BPFLoader1111111111111111111111111111111111"),
      "Player join",
      new PublicKey("BPFLoader2111111111111111111111111111111111")
    );
    expect(confirmed).toBe("SIG123");
  });

  test("confirmTransactionWithRecovery resubmits using the latest failed signature", async () => {
    resetGM();
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
    } as any;
    const program = {
      account: { game: { fetchNullable: async () => ({}) } },
      provider: {},
    } as any;
    const gm = GameManager.getInstance(program, wallet, { getGameParticipants: () => [] } as any);

    const resubmitAttempts: Array<{ attempt: number; previousSignature: string }> = [];
    const finalSignature = await (gm as any).confirmTransactionWithRecovery(
      "SIG_ORIGINAL",
      new PublicKey("BPFLoader1111111111111111111111111111111111"),
      "Game creation",
      undefined,
      async (attempt: number, previousSignature: string) => {
        resubmitAttempts.push({ attempt, previousSignature });
        if (attempt === 0) {
          const error = new Error("resubmit failed");
          (error as any).lastSignature = "SIG_FROM_ERROR";
          throw error;
        }
        return "SIG_SUCCESS";
      }
    );

    expect(finalSignature).toBe("SIG_SUCCESS");
    expect(resubmitAttempts).toEqual([
      { attempt: 0, previousSignature: "SIG_ORIGINAL" },
      { attempt: 1, previousSignature: "SIG_FROM_ERROR" },
    ]);
  });

  test("confirmTransactionWithRecovery treats expirations as recoverable", async () => {
    resetGM();
    const wallet = {
      confirmTransaction: async () => {
        throw new Error(
          "Transaction abc expired before confirmation (last valid block height 10, current 15)"
        );
      },
    } as any;
    const program = {
      account: { game: { fetchNullable: async () => ({}) } },
      provider: {},
    } as any;
    const gm = GameManager.getInstance(program, wallet, { getGameParticipants: () => [] } as any);
    (gm as any).isPlayerInGame = async () => true;
    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG-EXP",
      new PublicKey("BPFLoader1111111111111111111111111111111111"),
      "Player join",
      new PublicKey("BPFLoader2111111111111111111111111111111111")
    );
    expect(confirmed).toBe("SIG-EXP");
  });

  test("confirmTransactionWithRecovery falls back to signature history status", async () => {
    resetGM();
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
    } as any;
    const program = {
      account: { game: { fetchNullable: async () => null } },
      provider: {},
    } as any;
    const gm = GameManager.getInstance(program, wallet, {
      getGameParticipants: () => [],
    } as any);

    let historyChecks = 0;
    (gm as any).isSignatureConfirmedFromHistory = async () => {
      historyChecks += 1;
      return true;
    };

    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG-HISTORY",
      new PublicKey("BPFLoader1111111111111111111111111111111111"),
      "Game creation"
    );

    expect(confirmed).toBe("SIG-HISTORY");
    expect(historyChecks).toBeGreaterThanOrEqual(1);
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
      connection: {
        getSignatureStatuses: async () => ({ value: [null] }),
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

  test("handleGameAutoJoinPure retries public joins that expire", async () => {
    resetGM();
    const sendSignatures = ["SIG_ATTEMPT_1", "SIG_ATTEMPT_2"];
    let sendCalls = 0;
    const wallet = {
      sendTransaction: async () => {
        const sig = sendSignatures[Math.min(sendCalls, sendSignatures.length - 1)];
        sendCalls += 1;
        return sig;
      },
    } as any;

    let fetchCalls = 0;
    const program = {
      account: {
        game: {
          fetch: async () => {
            fetchCalls += 1;
            return { isPrivate: false };
          },
        },
      },
      methods: {
        joinGame: () => ({
          accounts: () => ({
            instruction: async () => ({}),
          }),
        }),
      },
      provider: {},
    } as any;

    const participantSaves: Array<{ signature: string | null }> = [];
    const gameDb = {
      saveGameParticipant: (
        _game: string,
        _telegramId: string,
        _creatorPubkey: string,
        participant: { joinSignature: string | null }
      ) => {
        participantSaves.push({ signature: participant.joinSignature });
      },
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).buildJoinAccounts = async () => ({});
    (gm as any).verifyParticipantJoin = async () => true;

    let confirmCalls = 0;
    (gm as any).confirmTransactionWithRecovery = async () => {
      confirmCalls += 1;
      if (confirmCalls === 1) {
        throw new Error(
          "Transaction expired before confirmation (last valid block height 10, current 15)"
        );
      }
      return "SIG_ATTEMPT_2";
    };

    const gamePda = new PublicKey("BPFLoader3111111111111111111111111111111111");
    const player = Keypair.generate();
    const result = await (gm as any).handleGameAutoJoinPure(
      gamePda,
      player,
      123n,
      player.publicKey.toBase58(),
      "coinflip",
      0
    );

    expect(result.success).toBe(true);
    expect(confirmCalls).toBe(2);
    expect(sendCalls).toBe(2);
    expect(fetchCalls).toBeGreaterThanOrEqual(2);
    expect(participantSaves.length).toBeGreaterThanOrEqual(2);
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
