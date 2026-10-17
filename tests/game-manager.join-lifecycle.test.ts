import { describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "#token";
import { GameManager } from "../src/utils/game";
import { contractCapabilities } from "../src/utils/contract-idl";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager join lifecycle", () => {
  test("joinGame records pending before confirming participant on-chain", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const tokenMint = new PublicKey("So11111111111111111111111111111111111111112");
    let capturedJoinAccounts: any;

    const program = {
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
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
          accounts: (accs: any) => {
            capturedJoinAccounts = accs;
            return {
              instruction: async () => ({}),
            };
          },
        }),
      },
    } as any;

    const wallet = {
      getKeyPair: () => playerKp,
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => 5_000_000_000,
      getBalance: async () => 5_000_000_000,
      sendTransaction: async (...args: any[]) => {
        sendOptions.push(args[2]);
        return "SIG123";
      },
    } as any;
    const sendOptions: any[] = [];

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
    (gm as any).confirmTransactionWithRecovery = async () => "SIG123";
    let probeCount = 0;
    (gm as any).isPlayerInGame = async () => {
      probeCount += 1;
      return probeCount > 1;
    };
    const gameVault = (await Keypair.generate()).publicKey;
    const gameVaultTokenAccount = (await Keypair.generate()).publicKey;
    const playerTokenAccount = (await Keypair.generate()).publicKey;
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault,
      gameVaultTokenAccount,
    });
    (gm as any).deriveAta = async () => playerTokenAccount;

    const result = await gm.joinGame(
      new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(),
      1n,
    );

    expect(result.success).toBe(true);
    // Joins bid a priority fee so they are not dropped when the network is busy.
    expect(sendOptions).toEqual([{ priorityFee: true }]);
    expect(participantCalls.length).toBe(2);
    const [pendingCall, confirmedCall] = participantCalls;
    expect(pendingCall[3]?.status).toBe("pending");
    expect(pendingCall[3]?.joinSignature).toBe("SIG123");
    expect(confirmedCall[3]?.status).toBe("confirmed");
    expect(confirmedCall[3]?.joinSignature).toBe("SIG123");
    expect(typeof confirmedCall[3]?.lastVerifiedAt).toBe("number");
    expect(removed.length).toBe(0);

    expect(capturedJoinAccounts).toBeDefined();
    const fundsContextKey = contractCapabilities.gameTokenAccount ? "gameTokenCtx" : "gameVaultCtx";
    expect(Object.keys(capturedJoinAccounts).sort()).toEqual(
      ["game", fundsContextKey, "oracle", "oracleOperator", "player", "playerTokenAccount"].sort(),
    );
    const ctx = capturedJoinAccounts[fundsContextKey];
    expect(ctx).toBeDefined();
    expect(ctx.tokenMint.toBase58()).toBe(tokenMint.toBase58());
    expect(ctx.gameVault.toBase58()).toBe(gameVault.toBase58());
    expect((ctx.gameVaultTokenAccount ?? ctx.gameTokenAccount).toBase58()).toBe(
      gameVaultTokenAccount.toBase58(),
    );
    expect(ctx.tokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(ctx.associatedTokenProgram.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    expect(capturedJoinAccounts.playerTokenAccount.toBase58()).toBe(playerTokenAccount.toBase58());
    // Direct joins populate the optional signer slot with the player.
    expect(capturedJoinAccounts.oracleOperator?.toBase58()).toBe(playerKp.publicKey.toBase58());
    expect(capturedJoinAccounts.tokenMint).toBeUndefined();
    expect(capturedJoinAccounts.tokenProgram).toBeUndefined();
    expect(capturedJoinAccounts.gameVault).toBeUndefined();
    expect(capturedJoinAccounts.gameVaultTokenAccount).toBeUndefined();
  });

  test("joinGame surfaces syncing error when on-chain confirmation is delayed", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const tokenMint = new PublicKey("So11111111111111111111111111111111111111112");
    let capturedJoinAccounts: any;

    const program = {
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
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
          accounts: (accs: any) => {
            capturedJoinAccounts = accs;
            return {
              instruction: async () => ({}),
            };
          },
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
    (gm as any).confirmTransactionWithRecovery = async () => "SIG321";
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).verifyParticipantJoin = async () => false;
    const gameVault = (await Keypair.generate()).publicKey;
    const gameVaultTokenAccount = (await Keypair.generate()).publicKey;
    const playerTokenAccount = (await Keypair.generate()).publicKey;
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault,
      gameVaultTokenAccount,
    });
    (gm as any).deriveAta = async () => playerTokenAccount;

    const result = await gm.joinGame(
      new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58(),
      2n,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still syncing/i);
    expect(participantCalls.length).toBe(1);
    expect(participantCalls[0][3]?.status).toBe("pending");
    expect(participantCalls[0][3]?.joinSignature).toBe("SIG321");

    expect(capturedJoinAccounts).toBeDefined();
    const fundsContextKey = contractCapabilities.gameTokenAccount ? "gameTokenCtx" : "gameVaultCtx";
    const ctx = capturedJoinAccounts[fundsContextKey];
    expect(ctx.tokenMint.toBase58()).toBe(tokenMint.toBase58());
    expect(ctx.gameVault.toBase58()).toBe(gameVault.toBase58());
    expect((ctx.gameVaultTokenAccount ?? ctx.gameTokenAccount).toBase58()).toBe(
      gameVaultTokenAccount.toBase58(),
    );
    expect(ctx.tokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(ctx.associatedTokenProgram.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    expect(capturedJoinAccounts.playerTokenAccount.toBase58()).toBe(playerTokenAccount.toBase58());
    expect(capturedJoinAccounts.tokenMint).toBeUndefined();
    expect(capturedJoinAccounts.tokenProgram).toBeUndefined();
    expect(capturedJoinAccounts.gameVault).toBeUndefined();
    expect(capturedJoinAccounts.gameVaultTokenAccount).toBeUndefined();
  });

  test("joinGame asks oracle to complete when verified join fills the game", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const tokenMint = new PublicKey("So11111111111111111111111111111111111111112");
    const gameAccounts = [
      {
        isPrivate: false,
        ticketsCount: 1,
        maxTickets: 2,
        gameType: { coinflip: {} },
        ticketAmount: 1_000_000_000,
        tokenMint,
      },
      {
        isPrivate: false,
        ticketsCount: 2,
        maxTickets: 2,
        gameType: { coinflip: {} },
        ticketAmount: 1_000_000_000,
        tokenMint,
      },
    ];
    let fetchCount = 0;

    const program = {
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
      account: {
        game: {
          fetch: async () => gameAccounts[Math.min(fetchCount++, gameAccounts.length - 1)],
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
    const gameDb = {
      getGame: () => ({
        status: "active",
        token_mint: tokenMint.toBase58(),
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
    (gm as any).confirmTransactionWithRecovery = async () => "SIG123";
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).verifyParticipantJoin = async () => true;
    const completionRequests: string[] = [];
    (gm as any).oracleClient = {
      requestGameCompletion: async (gameAddress: string) => {
        completionRequests.push(gameAddress);
        return true;
      },
    };

    const gameVault = (await Keypair.generate()).publicKey;
    const gameVaultTokenAccount = (await Keypair.generate()).publicKey;
    const playerTokenAccount = (await Keypair.generate()).publicKey;
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault,
      gameVaultTokenAccount,
    });
    (gm as any).deriveAta = async () => playerTokenAccount;

    const gameAddress = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();
    const result = await gm.joinGame(gameAddress, 3n);

    expect(result.success).toBe(true);
    expect(completionRequests).toEqual([gameAddress]);
    expect(participantCalls.length).toBe(1);
  });

  test("verifyParticipantJoin promotes pending entry when player appears on-chain", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const program = { account: { game: { fetch: async () => ({}) } } } as any;
    const wallet = {} as any;

    const participantCalls: any[] = [];
    const gameDb = {
      saveGameParticipant: (...args: any[]) => participantCalls.push(args),
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).isPlayerInGame = async () => true;

    const gamePda = new PublicKey("BPFLoader3111111111111111111111111111111111");
    const success = await (gm as any).verifyParticipantJoin(gamePda, playerKp.publicKey, "123", {
      joinSignature: "SIG999",
      maxAttempts: 1,
    });

    expect(success).toBe(true);
    expect(participantCalls.length).toBe(1);
    expect(participantCalls[0][3]?.status).toBe("confirmed");
    expect(participantCalls[0][3]?.joinSignature).toBe("SIG999");
  });

  test("verifyParticipantJoin accepts a confirmed join whose game already closed", async () => {
    const verify = async (game: Record<string, unknown>, joinSignature: string | null) => {
      resetGM();
      const participantCalls: any[] = [];
      const gameDb = {
        saveGameParticipant: (...args: any[]) => participantCalls.push(args),
      } as any;
      const gm = GameManager.getInstance({ account: { game } } as any, {} as any, gameDb);
      (gm as any).isPlayerInGame = async () => false;
      const success = await (gm as any).verifyParticipantJoin(
        new PublicKey("BPFLoader3111111111111111111111111111111111"),
        (await Keypair.generate()).publicKey,
        "123",
        { joinSignature, maxAttempts: 1 },
      );
      return { success, participantCalls };
    };

    // The last seat let the Oracle settle and close the game before the read.
    const closed = await verify({ fetchNullable: async () => null }, "SIG-LAST");
    expect(closed.success).toBe(true);
    expect(closed.participantCalls[0][3]).toMatchObject({
      status: "confirmed",
      joinSignature: "SIG-LAST",
    });

    // Without a confirmed signature, or without proof the account is gone, keep waiting.
    expect((await verify({ fetchNullable: async () => null }, null)).success).toBe(false);
    expect((await verify({ fetchNullable: async () => ({}) }, "SIG")).success).toBe(false);
    expect((await verify({ fetch: async () => ({}) }, "SIG")).success).toBe(false);
    const rpcDown = await verify(
      {
        fetchNullable: async () => {
          throw new Error("RPC unavailable");
        },
      },
      "SIG",
    );
    expect(rpcDown.success).toBe(false);
    expect(rpcDown.participantCalls).toEqual([]);
  });

  test("reconcilePendingParticipants confirms successes and prunes stale entries", async () => {
    resetGM();

    const program = { account: { game: { fetch: async () => ({}) } } } as any;
    const wallet = {} as any;

    const now = Date.now();
    const confirmedPubkey = (await Keypair.generate()).publicKey.toBase58();
    const stalePubkey = (await Keypair.generate()).publicKey.toBase58();
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
      getPlayerPublicKey: (telegramId: string) => (telegramId === "222" ? stalePubkey : null),
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    let verifyInvocations = 0;
    (gm as any).verifyParticipantJoin = async (
      gamePda: PublicKey,
      pubkey: PublicKey,
      telegramId: string,
    ) => {
      verifyInvocations += 1;
      if (telegramId === "111") {
        gameDb.saveGameParticipant(gamePda.toBase58(), telegramId, pubkey.toBase58(), {
          status: "confirmed",
          joinSignature: "S1",
        });
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

  test("joinGame returns completion message when on-chain account is missing", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const sendSignatures: string[] = [];

    const program = {
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
      account: {
        game: {
          fetch: async () => {
            throw new Error("fetch should not be called when fetchNullable returns null");
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
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 1_000_000,
      getBalance: async () => 1_000_000,
      sendTransaction: async () => {
        sendSignatures.push("unexpected");
        throw new Error("sendTransaction should not be reached");
      },
    } as any;

    const gameDb = {
      getGame: () => ({
        status: "active",
        token_mint: "Mint",
        token_ticker: "TOK",
      }),
      savePlayerMapping: () => {},
      saveGameParticipant: () => {},
      removeGameParticipant: () => {},
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
    } as any;

    const gm = GameManager.getInstance(program, wallet, gameDb);
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => ({ swapped: false }),
    };

    const result = await gm.joinGame(
      new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(),
      5n,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("This game has already completed. Refresh to see the result.");
    expect(sendSignatures.length).toBe(0);
  });

  test("joinGame retries the transaction once after a confirmation timeout", async () => {
    resetGM();

    const playerKp = await Keypair.generate();
    const tokenMint = new PublicKey("So11111111111111111111111111111111111111112");

    const program = {
      programId: new PublicKey("32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"),
      account: {
        game: {
          fetch: async () => ({
            isPrivate: false,
            ticketsCount: 0,
            maxTickets: 2,
            gameType: { coinflip: {} },
            ticketAmount: 500_000,
            tokenMint,
          }),
          fetchNullable: async () => ({
            isPrivate: false,
            ticketsCount: 0,
            maxTickets: 2,
            gameType: { coinflip: {} },
            ticketAmount: 500_000,
            tokenMint,
          }),
        },
      },
      methods: {
        joinGame: () => ({
          accounts: (accs: any) => ({
            instruction: async () => accs,
          }),
        }),
      },
    } as any;

    const sendSignatures: string[] = [];
    const wallet = {
      getKeyPair: () => playerKp,
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => 5_000_000_000,
      getBalance: async () => 5_000_000_000,
      sendTransaction: async () => {
        const sig = `SIG${sendSignatures.length + 1}`;
        sendSignatures.push(sig);
        return sig;
      },
    } as any;

    const participantCalls: any[] = [];
    const confirmedCalls: any[] = [];
    const gameDb = {
      getGame: () => ({
        status: "active",
        token_mint: tokenMint.toBase58(),
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

    const gameVault = (await Keypair.generate()).publicKey;
    const gameVaultTokenAccount = (await Keypair.generate()).publicKey;
    const playerTokenAccount = (await Keypair.generate()).publicKey;

    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault,
      gameVaultTokenAccount,
    });
    (gm as any).deriveAta = async () => playerTokenAccount;

    let confirmCalls = 0;
    (gm as any).confirmTransactionWithRecovery = async () => {
      confirmCalls += 1;
      if (confirmCalls === 1) {
        throw new Error("timeout while confirming");
      }
      return "SIG2";
    };
    (gm as any).isPlayerInGame = async () => false;
    (gm as any).verifyParticipantJoin = async (
      _gamePda: PublicKey,
      _player: PublicKey,
      telegramId: string,
      options: { joinSignature?: string | null },
    ) => {
      confirmedCalls.push({ telegramId, joinSignature: options.joinSignature });
      return true;
    };

    const result = await gm.joinGame(
      new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(),
      7n,
    );

    expect(result.success).toBe(true);
    expect(sendSignatures).toEqual(["SIG1", "SIG2"]);
    expect(confirmCalls).toBe(2);
    expect(participantCalls.length).toBe(2);
    expect(confirmedCalls).toEqual([{ telegramId: "7", joinSignature: "SIG2" }]);
  });
});

describe("GameManager game transactions", () => {
  test("bid a priority fee with or without wallet resubmits", async () => {
    resetGM();
    const calls: any[] = [];
    const wallet: any = {
      sendAndConfirmWithResubmits: async (...args: any[]) => {
        calls.push(["resubmits", args[2]]);
        return "SIG_A";
      },
    };
    const gm = GameManager.getInstance({ programId: PublicKey.default } as any, wallet, {} as any);
    const payer = await Keypair.generate();

    expect(await (gm as any).sendInstructionsWithFallback([], [payer], "Game op")).toBe("SIG_A");

    delete wallet.sendAndConfirmWithResubmits;
    wallet.sendTransaction = async (...args: any[]) => {
      calls.push(["send", args[2]]);
      return "SIG_B";
    };
    wallet.confirmTransaction = async () => {};
    expect(await (gm as any).sendInstructionsWithFallback([], [payer], "Game op")).toBe("SIG_B");

    expect(calls).toEqual([
      ["resubmits", { operationLabel: "Game op", skipConfirmation: undefined, priorityFee: true }],
      ["send", { priorityFee: true }],
    ]);
  });
});
