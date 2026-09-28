import { describe, test, expect } from "bun:test";
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
        unjoinGame: () => ({
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
});
