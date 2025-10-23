import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager join lifecycle", () => {
  test("joinGame records pending before confirming participant on-chain", async () => {
    resetGM();

    const playerKp = Keypair.generate();
    const tokenMint = new PublicKey(
      "So11111111111111111111111111111111111111112"
    );

    const program = {
      programId: new PublicKey("7GWv6X48imfr7SonQRCgka8XSh42J4UP74DyhP1RWNP6"),
      account: {
        game: {
          fetch: async () => ({
            isPrivate: false,
            ticketsCount: 0,
            maxTickets: 2,
            gameType: { coinflip: {} },
            ticketAmount: 1_000_000_000,
            tokenMint,
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
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => 5_000_000_000,
      getBalance: async () => 5_000_000_000,
      sendTransaction: async () => "SIG123",
    } as any;

    const participantCalls: any[] = [];
    const removed: any[] = [];
    const gameDb = {
      getGame: () => ({
        status: "active",
        token_mint: "M",
        token_ticker: "TOK",
      }),
      savePlayerMapping: () => {},
      saveGameParticipant: (...args: any[]) => participantCalls.push(args),
      removeGameParticipant: (...args: any[]) => removed.push(args),
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => ({ swapped: false }),
    };
    (gm as any).confirmTransactionWithRecovery = async () => true;
    let probeCount = 0;
    (gm as any).isPlayerInGame = async () => {
      probeCount += 1;
      return probeCount > 1;
    };
    (gm as any).resolveGameTokenAccounts = async () => ({
      tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      gameToken: Keypair.generate().publicKey,
      gameVault: Keypair.generate().publicKey,
      gameTokenAccount: Keypair.generate().publicKey,
    });
    (gm as any).deriveAta = async () => Keypair.generate().publicKey;

    const result = await gm.joinGame(
      new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(),
      1n
    );

    expect(result.success).toBe(true);
    expect(participantCalls.length).toBe(2);
    const [pendingCall, confirmedCall] = participantCalls;
    expect(pendingCall[3]?.status).toBe("pending");
    expect(pendingCall[3]?.joinSignature).toBe("SIG123");
    expect(confirmedCall[3]?.status).toBe("confirmed");
    expect(confirmedCall[3]?.joinSignature).toBe("SIG123");
    expect(typeof confirmedCall[3]?.lastVerifiedAt).toBe("number");
    expect(removed.length).toBe(0);
  });

  test("joinGame surfaces syncing error when on-chain confirmation is delayed", async () => {
    resetGM();

    const playerKp = Keypair.generate();
    const tokenMint = new PublicKey(
      "So11111111111111111111111111111111111111112"
    );

    const program = {
      programId: new PublicKey("7GWv6X48imfr7SonQRCgka8XSh42J4UP74DyhP1RWNP6"),
      account: {
        game: {
          fetch: async () => ({
            isPrivate: false,
            ticketsCount: 0,
            maxTickets: 2,
            gameType: { coinflip: {} },
            ticketAmount: 1_000_000_000,
            tokenMint,
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
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => 5_000_000_000,
      getBalance: async () => 5_000_000_000,
      sendTransaction: async () => "SIG321",
    } as any;

    const participantCalls: any[] = [];
    const gameDb = {
      getGame: () => ({
        status: "active",
        token_mint: "M",
        token_ticker: "TOK",
      }),
      savePlayerMapping: () => {},
      saveGameParticipant: (...args: any[]) => participantCalls.push(args),
      removeGameParticipant: () => {},
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => ({ swapped: false }),
    };
    (gm as any).confirmTransactionWithRecovery = async () => true;
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).verifyParticipantJoin = async () => false;
    (gm as any).resolveGameTokenAccounts = async () => ({
      tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      gameToken: Keypair.generate().publicKey,
      gameVault: Keypair.generate().publicKey,
      gameTokenAccount: Keypair.generate().publicKey,
    });
    (gm as any).deriveAta = async () => Keypair.generate().publicKey;

    const result = await gm.joinGame(
      new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58(),
      2n
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still syncing/i);
    expect(participantCalls.length).toBe(1);
    expect(participantCalls[0][3]?.status).toBe("pending");
    expect(participantCalls[0][3]?.joinSignature).toBe("SIG321");
  });

  test("verifyParticipantJoin promotes pending entry when player appears on-chain", async () => {
    resetGM();

    const playerKp = Keypair.generate();
    const program = { account: { game: { fetch: async () => ({}) } } } as any;
    const wallet = {} as any;

    const participantCalls: any[] = [];
    const gameDb = {
      saveGameParticipant: (...args: any[]) => participantCalls.push(args),
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).isPlayerInGame = async () => true;

    const gamePda = new PublicKey("BPFLoader3111111111111111111111111111111111");
    const success = await (gm as any).verifyParticipantJoin(
      gamePda,
      playerKp.publicKey,
      "123",
      { joinSignature: "SIG999", maxAttempts: 1 }
    );

    expect(success).toBe(true);
    expect(participantCalls.length).toBe(1);
    expect(participantCalls[0][3]?.status).toBe("confirmed");
    expect(participantCalls[0][3]?.joinSignature).toBe("SIG999");
  });

  test("reconcilePendingParticipants confirms successes and prunes stale entries", async () => {
    resetGM();

    const program = { account: { game: { fetch: async () => ({}) } } } as any;
    const wallet = {} as any;

    const now = Date.now();
    const confirmedPubkey = Keypair.generate().publicKey.toBase58();
    const stalePubkey = Keypair.generate().publicKey.toBase58();
    const saveCalls: any[] = [];
    const removed: any[] = [];

    const pendingEntries = [
      {
        telegram_id: "111",
        public_key: confirmedPubkey,
        join_signature: "S1",
        joined_at: now - 1_000,
        last_verified_at: null,
      },
      {
        telegram_id: "222",
        public_key: stalePubkey,
        join_signature: "S2",
        joined_at: now - 10 * 60 * 1000,
        last_verified_at: null,
      },
    ];

    const gameDb = {
      getPendingParticipants: () => pendingEntries,
      saveGameParticipant: (...args: any[]) => saveCalls.push(args),
      removeGameParticipant: (...args: any[]) => removed.push(args),
      getPlayerPublicKey: (telegramId: string) =>
        telegramId === "222" ? stalePubkey : null,
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    let verifyInvocations = 0;
    (gm as any).verifyParticipantJoin = async (
      gamePda: PublicKey,
      pubkey: PublicKey,
      telegramId: string
    ) => {
      verifyInvocations += 1;
      if (telegramId === "111") {
        gameDb.saveGameParticipant(
          gamePda.toBase58(),
          telegramId,
          pubkey.toBase58(),
          { status: "confirmed", joinSignature: "S1" }
        );
        return true;
      }
      return false;
    };

    const gamePda = new PublicKey("BPFLoader4111111111111111111111111111111111");
    await (gm as any).reconcilePendingParticipants(gamePda);

    expect(verifyInvocations).toBe(2);
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0][1]).toBe("111");
    expect(saveCalls[0][3]?.status).toBe("confirmed");
    expect(removed.length).toBe(1);
    expect(removed[0][1]).toBe("222");
  });
});
