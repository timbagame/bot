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

function baseWallet() {
  const kp = Keypair.generate();
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
    const gm = GameManager.getInstance(baseProgram({}), baseWallet(), baseDb());
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
    const gm = GameManager.getInstance(baseProgram({}), baseWallet(), baseDb());
    await expect(
      (gm as any).unjoinPlayerFromGame(
        new PublicKey("BPFLoader2111111111111111111111111111111111"),
        Keypair.generate(),
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
    const gm = GameManager.getInstance(baseProgram({}), baseWallet(), db);
    await expect(
      (gm as any).unjoinPlayerFromGame(
        new PublicKey("BPFLoader5111111111111111111111111111111111"),
        Keypair.generate(),
        new PublicKey("BPFLoader6111111111111111111111111111111111"),
      ),
    ).rejects.toThrow(/Player not found/);
  });

  test("unjoinPlayerFromGame rejects skipDbCheck for unauthorized authority", async () => {
    resetGM();
    const creator = Keypair.generate();
    const player = Keypair.generate();
    const impostor = Keypair.generate();
    const gameAccount = { creator: creator.publicKey };
    const db = baseDb({
      getGameParticipants: (_: string) => ["123"],
      getPlayerPublicKey: (_: string) => player.publicKey.toBase58(),
    });
    const gm = GameManager.getInstance(baseProgram(gameAccount), baseWallet(), db);

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
});
