import { afterEach, beforeEach, describe, test, expect, spyOn } from "bun:test";
import { PublicKey, Keypair } from "#solana";
import { GameManager } from "../src/utils/game";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function baseProgram(gameAccount: any) {
  return { account: { game: { fetch: async () => gameAccount } } } as any;
}

async function baseWallet() {
  const kp = await Keypair.generate();
  return { getKeyPair: (_: bigint) => kp } as any;
}

function baseDb(overrides: Partial<any> = {}) {
  return {
    getGameParticipants: (_: string) => [],
    getPlayerPublicKey: (_: string) => null,
    getPlayerTelegramId: (_: string) => null,
    getGame: (_: string) => ({ status: "active" }),
    ...overrides,
  } as any;
}

describe("GameManager unjoin errors", () => {
  test("unjoinGame returns error when not in game", async () => {
    resetGM();
    const gm = GameManager.getInstance(baseProgram({}), await baseWallet(), baseDb());
    (gm as any).isPlayerInGame = async () => false;
    const res = await gm.unjoinGame(
      new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(),
      1n,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not in this game/i);
  });

  test("unjoinPlayerFromGame throws when no participants", async () => {
    resetGM();
    const gm = GameManager.getInstance(baseProgram({}), await baseWallet(), baseDb());
    await expect(
      (gm as any).unjoinPlayerFromGame(
        new PublicKey("BPFLoader2111111111111111111111111111111111"),
        await Keypair.generate(),
        new PublicKey("BPFLoader3111111111111111111111111111111111"),
      ),
    ).rejects.toThrow(/No participants/);
  });

  test("unjoinPlayerFromGame throws when player not tracked", async () => {
    resetGM();
    const db = baseDb({
      getGameParticipants: (_: string) => ["777"],
      getPlayerPublicKey: (_: string) =>
        new PublicKey("BPFLoader4111111111111111111111111111111111").toBase58(),
    });
    const gm = GameManager.getInstance(baseProgram({}), await baseWallet(), db);
    await expect(
      (gm as any).unjoinPlayerFromGame(
        new PublicKey("BPFLoader5111111111111111111111111111111111"),
        await Keypair.generate(),
        new PublicKey("BPFLoader6111111111111111111111111111111111"),
      ),
    ).rejects.toThrow(/Player not found/);
  });

  test("unjoinPlayerFromGame rejects skipDbCheck for unauthorized authority", async () => {
    resetGM();
    const creator = await Keypair.generate();
    const player = await Keypair.generate();
    const impostor = await Keypair.generate();
    const gameAccount = { creator: creator.publicKey };
    const db = baseDb({
      getGameParticipants: (_: string) => ["123"],
      getPlayerPublicKey: (_: string) => player.publicKey.toBase58(),
    });
    const gm = GameManager.getInstance(baseProgram(gameAccount), await baseWallet(), db);

    await expect(
      (gm as any).unjoinPlayerFromGame(
        new PublicKey("BPFLoader7111111111111111111111111111111111"),
        impostor,
        player.publicKey,
        "123",
        { skipDbCheck: true },
      ),
    ).rejects.toThrow(/Unauthorized unjoin attempt/);
  });

  test("unjoinPlayerFromGame sends, confirms with a resend path and untracks the player", async () => {
    resetGM();
    const creator = await Keypair.generate();
    const player = await Keypair.generate();
    const gamePda = new PublicKey("BPFLoader8111111111111111111111111111111111");
    const removed: any[][] = [];
    const db = baseDb({
      getGameParticipants: (_: string) => ["123"],
      getPlayerPublicKey: (_: string) => player.publicKey.toBase58(),
      removeGameParticipant: (...args: any[]) => removed.push(args),
    });
    const unjoinIx = { ix: "unjoin" };
    const accountsSeen: any[] = [];
    const program = {
      account: { game: { fetch: async () => ({ creator: creator.publicKey }) } },
      methods: {
        refundPlayer: () => ({
          accounts: (accounts: any) => {
            accountsSeen.push(accounts);
            return { instruction: async () => unjoinIx };
          },
        }),
      },
    } as any;
    const gm = GameManager.getInstance(program, await baseWallet(), db);
    (gm as any).recoverParticipantsFromChain = () => {};
    (gm as any).buildJoinAccounts = async () => ({ accounts: { game: gamePda } });
    const sends: any[][] = [];
    (gm as any).sendInstructionsWithFallback = async (...args: any[]) => {
      sends.push(args);
      return `SIG${sends.length}`;
    };
    const confirmations: any[][] = [];
    (gm as any).confirmTransactionWithRecovery = async (
      signature: string,
      pda: PublicKey,
      label: string,
      playerKey: PublicKey,
      resend: () => Promise<string>,
    ) => {
      confirmations.push([signature, pda, label, playerKey]);
      return await resend();
    };

    await (gm as any).unjoinPlayerFromGame(gamePda, player, player.publicKey, "123");

    expect(accountsSeen).toEqual([{ game: gamePda, authority: player.publicKey }]);
    expect(sends).toEqual([
      [[unjoinIx], [player], "Player unjoin transaction", { skipConfirmation: true }],
      [[unjoinIx], [player], "Player unjoin transaction"],
    ]);
    expect(confirmations).toEqual([["SIG1", gamePda, "Player unjoin", player.publicKey]]);
    expect(removed).toEqual([[gamePda.toBase58(), "123"]]);
  });

  describe("when the unjoin confirmation times out", () => {
    const spies: { mockRestore: () => void }[] = [];
    beforeEach(() => {
      for (const method of ["warn", "error"] as const) {
        spies.push(spyOn(console, method).mockImplementation(() => undefined));
      }
    });
    afterEach(() => {
      spies.splice(0).forEach((spy) => spy.mockRestore());
    });

    // Real unjoinPlayerFromGame, confirmTransactionWithRecovery and isPlayerInGame. Only the chain
    // (program, wallet) and the database are fakes.
    const setup = async (fetchNullable: () => Promise<unknown>) => {
      resetGM();
      const creator = await Keypair.generate();
      const player = await Keypair.generate();
      const gamePda = new PublicKey("BPFLoader8111111111111111111111111111111111");
      const removed: any[][] = [];
      const db = baseDb({
        getGameParticipants: (_: string) => ["123"],
        getPlayerPublicKey: (_: string) => player.publicKey.toBase58(),
        getPlayerTelegramId: (_: string) => "123",
        // The local row exists but was never confirmed on-chain, so the database can't answer.
        isGameParticipant: () => false,
        removeGameParticipant: (...args: any[]) => removed.push(args),
      });
      const program = {
        account: {
          game: {
            fetch: async () => ({ creator: creator.publicKey, participants: [] }),
            fetchNullable,
          },
        },
        methods: {
          refundPlayer: () => ({
            accounts: () => ({ instruction: async () => ({ ix: "unjoin" }) }),
          }),
        },
      } as any;
      const wallet = {
        getKeyPair: () => player,
        confirmTransaction: async () => {
          throw new Error("transaction confirmation timeout");
        },
        getConnection: () => ({ getSignatureStatuses: async () => ({ value: [null] }) }),
      } as any;
      const gm = GameManager.getInstance(program, wallet, db);
      (gm as any).recoverParticipantsFromChain = () => {};
      (gm as any).buildUnjoinAccounts = async () => ({});
      (gm as any).sendInstructionsWithFallback = async () => "SIG";
      return { gm: gm as any, gamePda, player, removed };
    };

    test("an RPC error while checking the game keeps the local record and throws", async () => {
      const { gm, gamePda, player, removed } = await setup(async () => {
        throw new Error("rpc down");
      });

      await expect(
        gm.unjoinPlayerFromGame(gamePda, player, player.publicKey, "123"),
      ).rejects.toThrow(/rpc down/);
      expect(removed).toEqual([]);
    });

    test("a game that is really gone counts as the player removed", async () => {
      const { gm, gamePda, player, removed } = await setup(async () => null);

      await gm.unjoinPlayerFromGame(gamePda, player, player.publicKey, "123");

      expect(removed).toEqual([[gamePda.toBase58(), "123"]]);
    });

    test("without fetchNullable, a missing-account error from fetch counts as removed", async () => {
      const { gm, gamePda, player, removed } = await setup(async () => null);
      let reads = 0;
      gm.program.account.game.fetchNullable = undefined;
      gm.program.account.game.fetch = async () => {
        // The first read loads the account to build the unjoin; the probe's read finds it closed.
        if (reads++ === 0) return { creator: player.publicKey, participants: [] };
        throw new Error("Account does not exist or has no data");
      };

      await gm.unjoinPlayerFromGame(gamePda, player, player.publicKey, "123");

      expect(removed).toEqual([[gamePda.toBase58(), "123"]]);
    });

    test("a player no longer in the on-chain list counts as removed", async () => {
      const { gm, gamePda, player, removed } = await setup(async () => ({ participants: [] }));

      await gm.unjoinPlayerFromGame(gamePda, player, player.publicKey, "123");

      expect(removed).toEqual([[gamePda.toBase58(), "123"]]);
    });

    test("a player still in the on-chain list is not removed", async () => {
      const { gm, gamePda, player, removed } = await setup(async () => ({
        participants: [player.publicKey],
      }));

      await expect(
        gm.unjoinPlayerFromGame(gamePda, player, player.publicKey, "123"),
      ).rejects.toThrow(/still pending|timeout/i);
      expect(removed).toEqual([]);
    });
  });
});

describe("GameManager join confirmation when the chain read fails", () => {
  test("a join still falls back to the signature status when the RPC errors on the membership probe", async () => {
    resetGM();
    const player = await Keypair.generate();
    const gamePda = new PublicKey("BPFLoader8111111111111111111111111111111111");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const error = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const program = {
        account: {
          game: {
            fetchNullable: async () => {
              throw new Error("rpc down");
            },
          },
        },
      } as any;
      const wallet = {
        confirmTransaction: async () => {
          throw new Error("transaction confirmation timeout");
        },
        getConnection: () => ({
          getSignatureStatuses: async () => ({
            value: [{ confirmationStatus: "confirmed", err: null }],
          }),
        }),
      } as any;
      const gm = GameManager.getInstance(program, wallet, baseDb()) as any;

      const signature = await gm.confirmTransactionWithRecovery(
        "SIG_JOIN",
        gamePda,
        "Player join",
        player.publicKey,
      );

      expect(signature).toBe("SIG_JOIN");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
