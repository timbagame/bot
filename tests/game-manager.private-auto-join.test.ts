import { describe, expect, test } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair } from "@solana/web3.js";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager private auto-join recovery", () => {
  test("auto-join succeeds when confirmation times out but player is in game", async () => {
    resetGM();

    const playerKp = Keypair.generate();
    const adminKp = Keypair.generate();

    const wallet = {
      getKeyPair: () => playerKp,
      sendTransaction: async () => "SIG123",
      confirmTransaction: async () => {
        throw new Error("transaction was not confirmed in 30 seconds");
      },
      getConnection: () => ({}) as any,
    } as any;

    const gameAccount = { isPrivate: true };
    const program = {
      provider: {},
      account: {
        game: {
          fetch: async () => gameAccount,
          fetchNullable: async () => gameAccount,
        },
      },
      methods: {
        joinGame: () => ({
          accounts: (_: any) => ({
            instruction: async () => ({}),
          }),
        }),
      },
    } as any;

    const savedParticipants: any[] = [];
    const gameDb = {
      getGame: () => ({ token_mint: "mint" }),
      saveGameParticipant: (...args: any[]) => {
        savedParticipants.push(args);
      },
      savePlayerMapping: () => {},
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);

    (gm as any).oracleClient = {
      authorizePlayer: async () => ({
        authorized: true,
        adminKeypair: adminKp,
      }),
    };
    (gm as any).buildJoinAccounts = async () => ({});
    (gm as any).isPlayerInGame = async () => true;

    const result = await (gm as any).handleGameAutoJoinPure(
      new PublicKey("BPFLoader1111111111111111111111111111111111"),
      playerKp,
      1n,
      playerKp.publicKey.toBase58(),
      "coinflip",
      42
    );

    expect(result.success).toBe(true);
    expect(savedParticipants.length).toBe(1);
  });
});
