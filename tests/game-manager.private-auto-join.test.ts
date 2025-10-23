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
      getConnection: () => ({
        getSignatureStatuses: async () => ({ value: [null] }),
      }) as any,
    } as any;

    const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");

    const gameAccount: any = { isPrivate: true, participantHashes: [] };
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
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);

    (gm as any).oracleClient = {
      authorizePlayer: async () => ({
        authorized: true,
        adminKeypair: adminKp,
      }),
    };
    (gm as any).buildJoinAccounts = async () => ({});

    const participantHash = (gm as any).computeParticipantHash(
      gamePda,
      playerKp.publicKey
    );
    gameAccount.participantHashes = [
      {
        toString: () => participantHash,
      },
    ];

    const originalSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = (
      handler: (...args: any[]) => void,
      _ms?: number,
      ...args: any[]
    ) => {
      handler(...args);
      return 0 as any;
    };

    let result;
    try {
      result = await (gm as any).handleGameAutoJoinPure(
        gamePda,
        playerKp,
        1n,
        playerKp.publicKey.toBase58(),
        "coinflip",
        42
      );
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }

    expect(result.success).toBe(true);
    expect(savedParticipants.length).toBe(1);
  });

  test("auto-join eventually succeeds after multiple confirmation polls", async () => {
    resetGM();

    const playerKp = Keypair.generate();
    const adminKp = Keypair.generate();

    let statusCalls = 0;
    const wallet = {
      getKeyPair: () => playerKp,
      sendTransaction: async () => "SIG123",
      confirmTransaction: async () => {
        throw new Error("transaction was not confirmed in 30 seconds");
      },
      getConnection: () => ({
        getSignatureStatuses: async () => {
          statusCalls += 1;
          if (statusCalls < 3) {
            return { value: [null] };
          }
          return {
            value: [
              {
                err: null,
                confirmationStatus: "confirmed",
              },
            ],
          };
        },
      }) as any,
    } as any;

    const gamePda = new PublicKey("BPFLoader1111111111111111111111111111111111");

    const gameAccount: any = { isPrivate: false, participantHashes: [] };
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
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);

    (gm as any).oracleClient = {
      authorizePlayer: async () => ({
        authorized: true,
        adminKeypair: adminKp,
      }),
    };
    (gm as any).buildJoinAccounts = async () => ({});

    const originalSetTimeout = globalThis.setTimeout;
    let timerCalls = 0;
    (globalThis as any).setTimeout = (
      handler: (...args: any[]) => void,
      _ms?: number,
      ...args: any[]
    ) => {
      timerCalls += 1;
      handler(...args);
      return timerCalls as any;
    };

    let result;
    try {
      result = await (gm as any).handleGameAutoJoinPure(
        gamePda,
        playerKp,
        1n,
        playerKp.publicKey.toBase58(),
        "coinflip",
        42
      );
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
    }

    expect(result.success).toBe(true);
    expect(savedParticipants.length).toBe(1);
    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });
});
