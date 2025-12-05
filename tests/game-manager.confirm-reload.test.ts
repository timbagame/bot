import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";
import { formatUserFriendlyError } from "../src/utils/errors";
import { TRANSACTION_RESUBMIT_ATTEMPTS } from "../src/utils/constants";

const DEFAULT_GAME_PDA = new PublicKey(
  "BPFLoader1111111111111111111111111111111111"
);
const DEFAULT_PLAYER_PUBKEY = new PublicKey(
  "BPFLoader2111111111111111111111111111111111"
);

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

const createDefaultProgram = () =>
  ({
    account: { game: { fetchNullable: async () => ({}) } },
    provider: {},
  }) as any;

const createDefaultGameDb = () =>
  ({
    getGameParticipants: () => [],
  }) as any;

function setupGameManager({
  wallet,
  program,
  gameDb,
}: {
  wallet: any;
  program?: any;
  gameDb?: any;
}) {
  resetGM();
  if (typeof wallet.getConnection !== "function") {
    wallet.getConnection = () => ({
      getSignatureStatuses: async () => ({ value: [null] }),
    });
  }
  const programStub = program ?? createDefaultProgram();
  const gameDbStub = gameDb ?? createDefaultGameDb();
  const gm = GameManager.getInstance(programStub, wallet, gameDbStub);
  return { gm, program: programStub, gameDb: gameDbStub };
}

describe("GameManager confirm/reload helpers", () => {
  test("confirmTransactionWithRecovery handles timeout and verifies success", async () => {
    const wallet = {
      confirmTransaction: async (_: string) => {
        throw new Error("transaction was not confirmed");
      },
    } as any;
    const participantDb = {
      ...createDefaultGameDb(),
      getGameParticipants: () => ["123"],
      getPlayerTelegramId: (pubkey: string) =>
        pubkey === DEFAULT_PLAYER_PUBKEY.toBase58() ? "123" : null,
      getPlayerPublicKey: () => DEFAULT_PLAYER_PUBKEY.toBase58(),
    };
    const { gm } = setupGameManager({ wallet, gameDb: participantDb });
    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG123",
      DEFAULT_GAME_PDA,
      "Player join",
      DEFAULT_PLAYER_PUBKEY
    );
    expect(confirmed).toBe("SIG123");
  });

  test("confirmTransactionWithRecovery resubmits using the latest failed signature", async () => {
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
    } as any;
    const { gm } = setupGameManager({ wallet });

    const resubmitAttempts: Array<{ attempt: number; previousSignature: string }> = [];
    const finalSignature = await (gm as any).confirmTransactionWithRecovery(
      "SIG_ORIGINAL",
      DEFAULT_GAME_PDA,
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
    const wallet = {
      confirmTransaction: async () => {
        throw new Error(
          "Transaction abc expired before confirmation (last valid block height 10, current 15)"
        );
      },
    } as any;
    const participantDb = {
      ...createDefaultGameDb(),
      getGameParticipants: () => ["123"],
      getPlayerTelegramId: (pubkey: string) =>
        pubkey === DEFAULT_PLAYER_PUBKEY.toBase58() ? "123" : null,
      getPlayerPublicKey: () => DEFAULT_PLAYER_PUBKEY.toBase58(),
    };
    const { gm } = setupGameManager({ wallet, gameDb: participantDb });
    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG-EXP",
      DEFAULT_GAME_PDA,
      "Player join",
      DEFAULT_PLAYER_PUBKEY
    );
    expect(confirmed).toBe("SIG-EXP");
  });

  test("confirmTransactionWithRecovery falls back to signature history status", async () => {
    const statuses = [
      { confirmations: 0, confirmationStatus: "processed" },
      { confirmations: 1, confirmationStatus: "confirmed" },
    ];
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
      getConnection: () => ({
        getSignatureStatuses: async () => ({ value: [statuses.shift() ?? null] }),
      }),
    } as any;
    const program = createDefaultProgram();
    const { gm } = setupGameManager({ wallet, program });

    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG-HISTORY",
      DEFAULT_GAME_PDA,
      "Game creation"
    );

    expect(confirmed).toBe("SIG-HISTORY");
  });

  test("confirmTransactionWithRecovery honors player unjoin probe", async () => {
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
    } as any;
    const { gm } = setupGameManager({ wallet });
    (gm as any).isPlayerInGame = async () => false;

    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG-UNJOIN",
      DEFAULT_GAME_PDA,
      "Player unjoin",
      DEFAULT_PLAYER_PUBKEY
    );

    expect(confirmed).toBe("SIG-UNJOIN");
  });

  test("confirmTransactionWithRecovery honors game close probe", async () => {
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
    } as any;
    const program = {
      account: {
        game: {
          fetchNullable: async () => null,
        },
      },
      provider: {},
    } as any;
    const { gm } = setupGameManager({ wallet, program });

    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG-CLOSE",
      DEFAULT_GAME_PDA,
      "Game close"
    );

    expect(confirmed).toBe("SIG-CLOSE");
  });

  test("confirmTransactionWithRecovery succeeds with empty retry plan", async () => {
    const statuses = [
      { confirmations: 0, confirmationStatus: "processed" },
      { confirmations: 1, confirmationStatus: "confirmed" },
    ];
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
      getConnection: () => ({
        getSignatureStatuses: async () => ({ value: [statuses.shift() ?? null] }),
      }),
    } as any;
    const { gm } = setupGameManager({ wallet });
    (gm as any).isPlayerInGame = async () => true;

    const confirmed = await (gm as any).confirmTransactionWithRecovery(
      "SIG-EMPTY-RETRY",
      DEFAULT_GAME_PDA,
      "Player join",
      DEFAULT_PLAYER_PUBKEY,
      undefined,
      { retryDelays: [0] }
    );

    expect(confirmed).toBe("SIG-EMPTY-RETRY");
  });

  test("confirmTransactionWithRecovery surfaces probe failures when player lookup throws", async () => {
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
      getConnection: () => ({
        getSignatureStatuses: async () => ({ value: [null] }),
      }),
    } as any;
    const { gm } = setupGameManager({ wallet });
    (gm as any).isPlayerInGame = async () => {
      throw new Error("probe blew up");
    };

    await expect(
      (gm as any).confirmTransactionWithRecovery(
        "SIG-JOIN-PROBE",
        DEFAULT_GAME_PDA,
        "Player join",
        DEFAULT_PLAYER_PUBKEY
      )
    ).rejects.toThrow(/probe blew up/);
  });

  test("confirmTransactionWithRecovery can run concurrently for multiple signatures", async () => {
    const statusMap: Record<string, any[]> = {
      SIG_CONC_1: [
        { confirmations: 0, confirmationStatus: "processed" },
        { confirmations: 1, confirmationStatus: "confirmed" },
      ],
      SIG_CONC_2: [
        { confirmations: 0, confirmationStatus: "processed" },
        { confirmations: 1, confirmationStatus: "confirmed" },
      ],
    };

    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
      getConnection: () => ({
        getSignatureStatuses: async (signatures: string[]) => ({
          value: signatures.map(
            (sig) => (statusMap[sig]?.shift() as any) ?? null
          ),
        }),
      }),
    } as any;
    const participantDb = {
      ...createDefaultGameDb(),
      getGameParticipants: () => ["123"],
      getPlayerTelegramId: () => "123",
      getPlayerPublicKey: () => DEFAULT_PLAYER_PUBKEY.toBase58(),
    };
    const { gm } = setupGameManager({ wallet, gameDb: participantDb });

    const [sig1, sig2] = await Promise.all(
      ["SIG_CONC_1", "SIG_CONC_2"].map((signature) =>
        (gm as any).confirmTransactionWithRecovery(
          signature,
          DEFAULT_GAME_PDA,
          "Player join",
          DEFAULT_PLAYER_PUBKEY
        )
      )
    );

    expect(sig1).toBe("SIG_CONC_1");
    expect(sig2).toBe("SIG_CONC_2");
  });

  test("confirmTransactionWithRecovery preserves last resubmit error after max attempts", async () => {
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("transaction confirmation timeout");
      },
      getConnection: () => ({
        getSignatureStatuses: async () => ({ value: [null] }),
      }),
    } as any;
    const emptyDb = {
      ...createDefaultGameDb(),
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
    };
    const { gm } = setupGameManager({ wallet, gameDb: emptyDb });

    let attempts = 0;

    let capturedError: Error | null = null;

    try {
      await (gm as any).confirmTransactionWithRecovery(
        "SIG-RESUBMIT-FAIL",
        DEFAULT_GAME_PDA,
        "Player join",
        DEFAULT_PLAYER_PUBKEY,
        async () => {
          attempts += 1;
          const err = new Error(`resubmit attempt ${attempts}`);
          throw err;
        },
        { retryDelays: [] }
      );
      throw new Error("Expected failure");
    } catch (error: any) {
      capturedError = error;
      expect(error.message).toMatch(/transaction confirmation timeout/);
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toMatch(
        /resubmit attempt/
      );
    }

    expect(attempts).toBe(TRANSACTION_RESUBMIT_ATTEMPTS);
    expect(capturedError).not.toBeNull();
  });

  test("confirmTransactionWithRecovery preserves timeout message when recovery fails", async () => {
    const wallet = {
      confirmTransaction: async () => {
        const err = new Error(
          "transaction confirmation timeout: RPC node did not respond"
        );
        return Promise.reject(err);
      },
      getConnection: () => ({
        getSignatureStatuses: async () => ({ value: [null] }),
      }),
    } as any;
    const program = {
      account: { game: { fetchNullable: async () => null } },
      provider: {},
    } as any;
    const { gm } = setupGameManager({ wallet, program });
    const signature = "SIG";

    try {
      await (gm as any).confirmTransactionWithRecovery(
        signature,
        DEFAULT_GAME_PDA,
        "Game creation",
        undefined,
        undefined,
        { retryDelays: [] }
      );
      throw new Error("Expected transaction confirmation to fail");
    } catch (error: any) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("transaction confirmation timeout");
      expect(error.cause).toBeInstanceOf(Error);
      expect((error.cause as Error).message).toContain(
        "Game account not found after timeout"
      );
      const friendly = await formatUserFriendlyError(error);
      expect(friendly).toContain("Transaction confirmation timed out");
    }
  });

  test("handleGameAutoJoinPure retries public joins that expire", async () => {
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

    const { gm } = setupGameManager({ wallet, program, gameDb });
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
    const wallet = {
      confirmTransaction: async () => {
        throw new Error("boom");
      },
    } as any;
    const { gm } = setupGameManager({ wallet, program: {} as any, gameDb: createDefaultGameDb() });
    await expect(
      (gm as any).confirmTransactionWithRecovery(
        "SIG",
        DEFAULT_GAME_PDA,
        "Game creation"
      )
    ).rejects.toThrow(/boom/);
  });

  test("isPlayerInGame falls back to on-chain participant hashes", async () => {
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

    const { gm } = setupGameManager({
      wallet: {} as any,
      program,
      gameDb: {
        getGameParticipants: () => [],
        getPlayerTelegramId: () => null,
      } as any,
    });

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
    const db = {
      getAllGames: () => [
        { game_address: "ADDR1", message_id: 10, chat_id: 100 },
        { game_address: "ADDR2", message_id: 20, chat_id: 200 },
      ],
    } as any;
    const { gm } = setupGameManager({
      wallet: {} as any,
      program: {} as any,
      gameDb: db,
    });
    await gm.reloadGameMessages();
    expect(gm.getActiveGameMessage("ADDR1")?.messageId).toBe(10);
    expect(gm.getActiveGameMessage("ADDR2")?.chatId).toBe(200);
  });
});
