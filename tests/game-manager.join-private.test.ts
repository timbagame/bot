import { describe, expect, test } from "bun:test";
import { GameManager } from "../src/utils/game";
import { Keypair, PublicKey } from "#solana";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager joinPrivateGame resilience", () => {
  test("returns completion message when the on-chain game account is missing", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const adminKp = await Keypair.generate();
    let sendCount = 0;

    const program = {
      account: {
        game: {
          fetch: async () => {
            throw new Error("fetch should not run when fetchNullable returns null");
          },
          fetchNullable: async () => null,
        },
      },
      methods: {
        joinGame: () => ({
          accounts: () => ({
            instruction: async () => ({}),
          }),
        }),
      },
    } as any;

    const wallet = {
      getKeyPair: () => playerKp,
      sendTransaction: async () => {
        sendCount += 1;
        throw new Error("sendTransaction should not be called");
      },
    } as any;

    const gameDb = {
      getGame: () => ({ token_mint: "mint" }),
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).oracleClient = {
      authorizePlayer: async () => ({
        authorized: true,
        operatorKeypair: adminKp,
      }),
    };

    const result = await gm.joinPrivateGame(
      new PublicKey("BPFLoader1111111111111111111111111111111111"),
      playerKp,
      99,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("This game has already completed. Refresh to see the result.");
    expect(sendCount).toBe(0);
  });

  test("retries once after a confirmation timeout before succeeding", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const adminKp = await Keypair.generate();
    const sendHistory: string[] = [];

    const program = {
      account: {
        game: {
          fetch: async () => ({ tokenMint: (await Keypair.generate()).publicKey.toBase58() }),
          fetchNullable: async () => ({
            tokenMint: (await Keypair.generate()).publicKey.toBase58(),
          }),
        },
      },
      methods: {
        joinGame: () => ({
          accounts: () => ({
            instruction: async () => ({}),
          }),
        }),
      },
    } as any;

    const wallet = {
      getKeyPair: () => playerKp,
      sendTransaction: async () => {
        const sig = `SIG${sendHistory.length + 1}`;
        sendHistory.push(sig);
        return sig;
      },
    } as any;

    const gameDb = {
      getGame: () => ({ token_mint: "mint" }),
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);

    (gm as any).oracleClient = {
      authorizePlayer: async () => ({
        authorized: true,
        operatorKeypair: adminKp,
      }),
    };

    (gm as any).buildJoinAccounts = async () => ({
      mock: true,
    });
    (gm as any).confirmTransactionWithRecovery = async () => {
      if (sendHistory.length === 1) {
        throw new Error("timeout while confirming private join");
      }
      return sendHistory[sendHistory.length - 1];
    };
    (gm as any).isPlayerInGame = async () => false;

    const result = await gm.joinPrivateGame(
      new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      playerKp,
      101,
    );

    expect(result.success).toBe(true);
    expect(sendHistory).toEqual(["SIG1", "SIG2"]);
  });

  test("confirmation recovery resends the full join instruction set", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const adminKp = await Keypair.generate();
    const setupIx = { ix: "setup" };
    const joinIx = { ix: "join" };
    const program = {
      account: { game: { fetchNullable: async () => ({ ticketsCount: 0 }) } },
      methods: {
        joinGame: () => ({ accounts: () => ({ instruction: async () => joinIx }) }),
      },
    } as any;
    const wallet = {
      getKeyPair: () => playerKp,
      sendTransaction: async () => "SIG_INITIAL",
    } as any;
    const gm = GameManager.getInstance(program, wallet, {
      getGame: () => ({ token_mint: "mint" }),
    } as any);
    (gm as any).oracleClient = {
      authorizePlayer: async () => ({ authorized: true, operatorKeypair: adminKp }),
    };
    (gm as any).buildJoinAccounts = async () => ({
      accounts: { mock: true },
      setupInstructions: [setupIx],
    });
    const resends: any[][] = [];
    (gm as any).sendInstructionsWithFallback = async (...args: any[]) => {
      resends.push(args);
      return "SIG_RESENT";
    };
    (gm as any).confirmTransactionWithRecovery = async (
      signature: string,
      _pda: PublicKey,
      _label: string,
      _player: PublicKey,
      resend: () => Promise<string>,
    ) => {
      expect(signature).toBe("SIG_INITIAL");
      return await resend();
    };

    const result = await gm.joinPrivateGame(
      new PublicKey("BPFLoader1111111111111111111111111111111111"),
      playerKp,
      99,
    );

    expect(result).toEqual({ success: true, tx: "SIG_RESENT" });
    expect(resends).toEqual([[[setupIx, joinIx], [playerKp, adminKp], "Player join transaction"]]);
  });
});
