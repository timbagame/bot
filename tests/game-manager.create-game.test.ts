import { describe, test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PDAManager } from "../src/utils/pda";
import {
  GAME_CREATION_RATE_LIMIT_WINDOW_MS,
  MAX_ACTIVE_GAMES_PER_CREATOR,
  MAX_GAMES_PER_CREATOR_WINDOW,
  WSOL_MINT,
} from "../src/utils/constants";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function createConnectionStub(owner: PublicKey = TOKEN_PROGRAM_ID) {
  return {
    getAccountInfo: async () => ({ owner }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    }),
  } as any;
}

function makeProgram(connection = createConnectionStub()) {
  const programId = new PublicKey("BPFLoader1111111111111111111111111111111111");
  const captures: Record<string, any> = {};
  return {
    programId,
    provider: { connection },
    __captures: captures,
    methods: {
      initializeGame: (_cfg: any, _hash: any) => ({
        accounts: (accs: any) => {
          captures["initializeGameAccounts"] = accs;
          return {
            instruction: async () =>
              new TransactionInstruction({ programId, keys: [], data: Buffer.alloc(0) }),
          };
        },
      }),
      joinGame: () => ({
        accounts: (accs: any) => {
          captures["joinGameAccounts"] = accs;
          return {
            instruction: async () =>
              new TransactionInstruction({ programId, keys: [], data: Buffer.alloc(0) }),
          };
        },
      }),
    },
    account: { game: { fetch: async () => ({}) } },
  } as any;
}

function makeWallet(overrides: Record<string, any>) {
  const { connection: providedConnection, ...rest } = overrides;
  const connection = providedConnection ?? createConnectionStub();
  const wallet: any = {
    connection,
    getConnection: () => connection,
    getKeyPair: (_: bigint) => Keypair.generate(),
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toString(),
    ...rest,
  };

  wallet.connection = connection;
  if (!wallet.getConnection) {
    wallet.getConnection = () => connection;
  }
  wallet.getLatestBlockhash ??= async () => ({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1,
  });
  wallet.sendPartiallySignedTransaction ??= async (transaction: any) =>
    wallet.sendTransaction(transaction.instructions, []);

  return wallet;
}

describe("GameManager.createGame", () => {
  test("surface helpful error when SOL auto-wrap cannot proceed", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => 0,
      // Enough to cover wrap amount + native rent, but not both + safety buffer
      getBalance: async () => 3_000_000,
      wrapSol: async () => {
        throw new Error("should not wrap");
      },
      formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
    });
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any);
    const res = await gm.createGame(
      "coinflip",
      {
        amount: 1_000_000,
        tokenMint: WSOL_MINT,
        tokenTicker: "WSOL",
        isSol: false,
        requestedNativeSol: true,
      },
      2,
      2,
      60,
      1n,
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Failed to wrap SOL automatically");
  });

  test("errors on insufficient balance with formatted message", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 500_000,
      getBalance: async () => 5_000_000,
    });
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any);
    const res = await gm.createGame(
      "coinflip",
      { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
    );
    expect(res.success).toBe(false);
    const message = String(res.error);
    expect(message).toContain("Not enough TOK");
    expect(message).toContain("Add more TOK");
  });

  test("escapes token ticker in balance error messages", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 100_000,
      getBalance: async () => 1_000_000,
    });
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any);
    const res = await gm.createGame(
      "coinflip",
      {
        amount: 200_000,
        tokenMint: "M",
        tokenTicker: "<script>",
        isSol: false,
      },
      2,
      2,
      60,
      1n,
    );
    expect(res.success).toBe(false);
    const message = String(res.error);
    expect(message).toContain("&lt;script&gt;");
    expect(message).not.toContain("<script>");
  });

  test("returns oracle unavailable when unhealthy", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
    });
    const db = {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);
    // Patch oracle client on the instance
    (gm as any).oracleClient = { isHealthy: async () => false };
    const res = await gm.createGame(
      "coinflip",
      { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Oracle service is unavailable");
  });

  test("fails fast when creator hits active game limit", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => {
        throw new Error("metadata should not be fetched when limit hit");
      },
      getTokenBalance: async () => {
        throw new Error("balance should not be checked when limit hit");
      },
      getBalance: async () => {
        throw new Error("SOL balance should not be checked when limit hit");
      },
    });
    const db = {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => MAX_ACTIVE_GAMES_PER_CREATOR,
      countRecentGamesByCreator: () => 0,
    } as any;
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);
    const res = await gm.createGame(
      "coinflip",
      { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
    );
    expect(res.success).toBe(false);
    const message = String(res.error);
    expect(message).toContain("limit reached");
    expect(message).toContain(String(MAX_ACTIVE_GAMES_PER_CREATOR));
  });

  test("fails fast when creator hits recent creation rate limit", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => {
        throw new Error("metadata should not be fetched when rate limit hit");
      },
      getTokenBalance: async () => {
        throw new Error("balance should not be checked when rate limit hit");
      },
      getBalance: async () => {
        throw new Error("SOL balance should not be checked when rate limit hit");
      },
    });
    const recentCount = MAX_GAMES_PER_CREATOR_WINDOW;
    const db = {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => recentCount,
    } as any;
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);
    const res = await gm.createGame(
      "coinflip",
      { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
    );

    expect(res.success).toBe(false);
    const message = String(res.error);
    expect(message.toLowerCase()).toContain("rate limit");
    expect(message).toContain(String(recentCount));
    expect(message).toContain(String(MAX_GAMES_PER_CREATOR_WINDOW));
    expect(message).toContain("Please wait");
    expect(message).toContain("last");
  });

  test("blocks overlapping game creation requests within the rate limit window", async () => {
    resetGM();
    const metadataDeferrals: ((reason?: any) => void)[] = [];
    const wallet = makeWallet({
      getTokenMetadata: () =>
        new Promise((_, reject) => {
          metadataDeferrals.push(reject);
        }),
      getTokenBalance: async () => 5_000_000,
      getBalance: async () => 5_000_000,
    });

    const db = {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;

    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);

    const sharedTimestamp = 1_700_000_000_000;
    const baseArgs: Parameters<GameManager["createGame"]> = [
      "coinflip",
      {
        amount: 1_000_000,
        tokenMint: "M",
        tokenTicker: "TOK",
        isSol: false,
      },
      2,
      2,
      60,
      1n,
      undefined,
      0,
      sharedTimestamp,
    ];

    const first = gm.createGame(...baseArgs);
    const second = gm.createGame(...baseArgs);
    const third = gm.createGame(...baseArgs);

    expect(metadataDeferrals.length).toBe(3);

    const fourthResult = await gm.createGame(...baseArgs);
    expect(fourthResult.success).toBe(false);
    const fourthError = String(fourthResult.error || "");
    expect(fourthError.toLowerCase()).toContain("rate limit");
    expect(fourthError).toContain(String(MAX_GAMES_PER_CREATOR_WINDOW));
    expect(fourthError).toContain("Some requests are still processing.");

    metadataDeferrals.forEach((reject) => reject(new Error("abort")));
    await Promise.allSettled([first, second, third]);
  });

  test("evaluates stale request timestamps against the current rate-limit window", async () => {
    resetGM();
    const fixedNow = 1_700_000_000_000;
    const originalNow = Date.now;
    let capturedWindowStart: number | undefined;

    try {
      Date.now = () => fixedNow;

      const wallet = makeWallet({
        getTokenMetadata: async () => {
          throw new Error("metadata unavailable");
        },
        getTokenBalance: async () => 2_000_000,
        getBalance: async () => 2_000_000,
      });

      const db = {
        savePlayerMapping: () => {},
        countActiveGamesByCreator: () => 0,
        countRecentGamesByCreator: (_id: string, windowStart: number) => {
          capturedWindowStart = windowStart;
          return 0;
        },
      } as any;

      const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);

      const staleTimestamp = fixedNow - 5 * GAME_CREATION_RATE_LIMIT_WINDOW_MS;
      const result = await gm.createGame(
        "coinflip",
        {
          amount: 1_000_000,
          tokenMint: "M",
          tokenTicker: "TOK",
          isSol: false,
        },
        2,
        2,
        60,
        1n,
        undefined,
        0,
        staleTimestamp,
      );

      expect(result.success).toBe(false);
      expect(String(result.error ?? "")).toContain("Something went wrong");
      expect(capturedWindowStart).toBe(fixedNow - GAME_CREATION_RATE_LIMIT_WINDOW_MS);
    } finally {
      Date.now = originalNow;
    }
  });

  test("treats non-finite request timestamps as now for rate limiting", async () => {
    resetGM();
    const fixedNow = 1_700_000_100_000;
    const originalNow = Date.now;
    const capturedWindowStarts: number[] = [];

    try {
      Date.now = () => fixedNow;

      const wallet = makeWallet({
        getTokenMetadata: async () => {
          throw new Error("metadata unavailable");
        },
        getTokenBalance: async () => 2_000_000,
        getBalance: async () => 2_000_000,
      });

      const db = {
        savePlayerMapping: () => {},
        countActiveGamesByCreator: () => 0,
        countRecentGamesByCreator: (_id: string, windowStart: number) => {
          capturedWindowStarts.push(windowStart);
          return 0;
        },
      } as any;

      const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);

      for (const ts of [Number.POSITIVE_INFINITY, Number.NaN]) {
        const res = await gm.createGame(
          "coinflip",
          {
            amount: 1_000_000,
            tokenMint: "M",
            tokenTicker: "TOK",
            isSol: false,
          },
          2,
          2,
          60,
          1n,
          undefined,
          0,
          ts,
        );

        expect(res.success).toBe(false);
        expect(String(res.error ?? "")).toContain("Something went wrong");
      }

      expect(capturedWindowStarts).toEqual([
        fixedNow - GAME_CREATION_RATE_LIMIT_WINDOW_MS,
        fixedNow - GAME_CREATION_RATE_LIMIT_WINDOW_MS,
      ]);
    } finally {
      Date.now = originalNow;
    }
  });

  test("clears pending and in-flight trackers after failed creations", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => {
        throw new Error("metadata unavailable");
      },
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 2_000_000,
    });

    const db = {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => MAX_ACTIVE_GAMES_PER_CREATOR - 1,
      countRecentGamesByCreator: () => 0,
    } as any;

    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);

    const creationArgs: Parameters<GameManager["createGame"]> = [
      "coinflip",
      { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
    ];

    const firstResult = await gm.createGame(...creationArgs);
    expect(firstResult.success).toBe(false);
    const firstError = String(firstResult.error ?? "");
    expect(firstError).toContain("Something went wrong");

    const gmAny = gm as any;
    expect(gmAny.inFlightGameCreations.get("1")).toBeUndefined();
    expect(gmAny.pendingCreationRequests.get("1")).toBeUndefined();

    const secondResult = await gm.createGame(...creationArgs);
    expect(secondResult.success).toBe(false);
    const secondError = String(secondResult.error ?? "");
    expect(secondError).toContain("Something went wrong");
    expect(secondError.toLowerCase()).not.toContain("limit");
  });

  test("clamps future request timestamps to the current window", async () => {
    resetGM();
    const fixedNow = 1_700_000_000_000;
    const originalNow = Date.now;
    let capturedWindowStart: number | undefined;

    try {
      Date.now = () => fixedNow;

      const wallet = makeWallet({
        getTokenMetadata: async () => ({ decimals: 6 }),
        getTokenBalance: async () => 1_000_000,
        getBalance: async () => 1_000_000,
      });

      const db = {
        savePlayerMapping: () => {},
        countActiveGamesByCreator: () => 0,
        countRecentGamesByCreator: (_id: string, windowStart: number) => {
          capturedWindowStart = windowStart;
          return MAX_GAMES_PER_CREATOR_WINDOW;
        },
      } as any;

      const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, db);

      const futureTimestamp = fixedNow + 60_000;
      const result = await gm.createGame(
        "coinflip",
        {
          amount: 1_000_000,
          tokenMint: "M",
          tokenTicker: "TOK",
          isSol: false,
        },
        2,
        2,
        60,
        1n,
        undefined,
        0,
        futureTimestamp,
      );

      expect(result.success).toBe(false);
      expect(capturedWindowStart).toBe(fixedNow - GAME_CREATION_RATE_LIMIT_WINDOW_MS);
    } finally {
      Date.now = originalNow;
    }
  });

  test("wraps native SOL when WSOL token specified explicitly", async () => {
    resetGM();
    let wsolBalance = 0;
    let solBalance = 4_000_000;
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => wsolBalance,
      getBalance: async () => solBalance,
      wrapSol: async (_telegramId: bigint, amount: number) => {
        wsolBalance += amount;
        solBalance -= amount + 15_000;
        return "WRAP_SIG";
      },
      sendTransaction: async () => "SIG",
      confirmTransaction: async () => true,
      formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
    });

    const db = {
      savePlayerMapping: () => {},
      saveGame: () => {},
      saveGameParticipant: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
      getGame: () => ({
        token_mint: WSOL_MINT,
        token_ticker: "WSOL",
        game_type: "coinflip",
        amount: 600_000,
        max_tickets: 2,
        min_tickets: 2,
        chat_id: 0,
      }),
    } as any;

    const program = makeProgram(wallet.connection);
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).oracleClient = {
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "0".repeat(64),
        oracleOperator: PublicKey.default.toBase58(),
      }),
      signGameTransaction: async (transaction: any) => transaction,
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    const res = await gm.createGame(
      "coinflip",
      {
        amount: 600_000,
        tokenMint: WSOL_MINT,
        tokenTicker: "WSOL",
        isSol: false,
        requestedNativeSol: false,
      },
      2,
      2,
      60,
      1n,
    );

    expect(res.success).toBe(true);
    expect(wsolBalance).toBeGreaterThanOrEqual(600_000);
  });

  test("handles delayed WSOL propagation after wrapping", async () => {
    resetGM();
    let wsolBalance = 0;
    let solBalance = 5_000_000;
    let balanceCalls = 0;
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 9 }),
      getTokenBalance: async () => {
        balanceCalls += 1;
        return balanceCalls >= 4 ? wsolBalance : 0;
      },
      getBalance: async () => solBalance,
      wrapSol: async (_telegramId: bigint, amount: number) => {
        wsolBalance = amount;
        solBalance -= amount + 15_000;
        return "WRAP_SIG";
      },
      sendTransaction: async () => "SIG",
      confirmTransaction: async () => true,
      formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toFixed(6),
    });

    const db = {
      savePlayerMapping: () => {},
      saveGame: () => {},
      saveGameParticipant: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
      getGame: () => ({
        token_mint: WSOL_MINT,
        token_ticker: "WSOL",
        game_type: "coinflip",
        amount: 800_000,
        max_tickets: 2,
        min_tickets: 2,
        chat_id: 0,
      }),
    } as any;

    const program = makeProgram(wallet.connection);
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).oracleClient = {
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "1".repeat(64),
        oracleOperator: PublicKey.default.toBase58(),
      }),
      signGameTransaction: async (transaction: any) => transaction,
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };

    const res = await gm.createGame(
      "coinflip",
      {
        amount: 800_000,
        tokenMint: WSOL_MINT,
        tokenTicker: "WSOL",
        isSol: false,
        requestedNativeSol: false,
      },
      2,
      2,
      60,
      1n,
    );

    expect(res.success).toBe(true);
    expect(balanceCalls).toBeGreaterThanOrEqual(4);
    expect(wsolBalance).toBeGreaterThanOrEqual(800_000);
  });

  test("happy path saves game and auto-joins creator", async () => {
    resetGM();
    let signingCalls = 0;
    let sentInstructionCount = 0;
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      sendTransaction: async (instructions: unknown[]) => {
        sentInstructionCount = instructions.length;
        return "SIG";
      },
    });
    const saved: any[] = [];
    const db = {
      savePlayerMapping: () => {},
      saveGame: (...args: any[]) => {
        saved.push(args);
      },
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const program = makeProgram(wallet.connection);
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).oracleClient = {
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "deadbeef",
        oracleOperator: PublicKey.default.toBase58(),
      }),
      signGameTransaction: async (transaction: any) => {
        signingCalls += 1;
        return transaction;
      },
      hexToBuffer: (_: string) => Buffer.from("deadbeef", "hex"),
    };
    const gameToken = Keypair.generate().publicKey;
    const gameVault = Keypair.generate().publicKey;
    const gameTokenAccount = Keypair.generate().publicKey;
    const creatorTokenAccount = Keypair.generate().publicKey;
    (gm as any).resolveGameTokenAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameToken,
      gameVault,
      gameTokenAccount,
    });
    (gm as any).deriveAta = async () => creatorTokenAccount;
    // Derivation and confirmation patched
    const pda = new PublicKey("11111111111111111111111111111111");
    const original = (PDAManager as any).getGamePDA;
    (PDAManager as any).getGamePDA = () => pda;
    (gm as any).confirmTransactionWithRecovery = async () => "CONFIRMED_SIG";

    const res = await gm.createGame(
      "coinflip",
      {
        amount: 1_000_000,
        tokenMint: "11111111111111111111111111111111",
        tokenTicker: "TIMBA",
        isSol: false,
      },
      2,
      2,
      60,
      1n,
      { isPrivate: false },
      100,
    );
    expect(res.success).toBe(true);
    expect(signingCalls).toBe(1);
    expect(sentInstructionCount).toBe(2);
    expect(res.gameAddress).toBe(pda.toBase58());
    expect(saved.length).toBe(1);

    const captures = (program as any).__captures;
    const accounts = captures["initializeGameAccounts"];
    expect(captures["joinGameAccounts"].oracleOperator).toBeUndefined();
    expect(accounts).toBeDefined();
    expect(accounts.gameTokenCtx).toBeDefined();
    const ctx = accounts.gameTokenCtx;
    expect(ctx.tokenMint.toBase58()).toBe("11111111111111111111111111111111");
    expect(ctx.gameToken.toBase58()).toBe(gameToken.toBase58());
    expect(ctx.gameVault.toBase58()).toBe(gameVault.toBase58());
    expect(ctx.gameTokenAccount.toBase58()).toBe(gameTokenAccount.toBase58());
    expect(ctx.tokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(ctx.associatedTokenProgram.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    expect(accounts.creatorTokenAccount.toBase58()).toBe(creatorTokenAccount.toBase58());
    expect(accounts.tokenMint).toBeUndefined();
    expect(accounts.tokenProgram).toBeUndefined();
    expect(accounts.associatedTokenProgram).toBeUndefined();
    expect(accounts.gameToken).toBeUndefined();
    expect(accounts.gameVault).toBeUndefined();
    expect(accounts.gameTokenAccount).toBeUndefined();

    // restore
    (PDAManager as any).getGamePDA = original;
  });

  test("creates game after SOL swap refreshes cached balance", async () => {
    resetGM();
    const playerKp = Keypair.generate();
    const initialLamports = 100_000;
    // Must be >= minSolBuffer (800k) + gameRent (0) + nativeRentExemption (890,880) = 1,690,880
    const refreshedLamports = 1_800_000;
    const telegramId = 1n;
    const balanceCalls: Array<{ forceFresh: boolean }> = [];
    const clearedIds: bigint[] = [];
    let cachedLamports: number | undefined = initialLamports;
    const wallet = makeWallet({
      getKeyPair: () => playerKp,
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async (_id: bigint, options: any = {}) => {
        const forceFresh = options?.forceFresh === true;
        balanceCalls.push({ forceFresh });
        if (forceFresh) {
          cachedLamports = refreshedLamports;
          return refreshedLamports;
        }
        return cachedLamports ?? initialLamports;
      },
      clearCachedWalletData: (id: bigint) => {
        clearedIds.push(id);
        cachedLamports = undefined;
      },
      sendTransaction: async () => "SIG",
    });
    const saved: any[] = [];
    const db = {
      savePlayerMapping: () => {},
      saveGame: (...args: any[]) => saved.push(args),
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const program = makeProgram(wallet.connection);
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).feeBudget = {
      getGameSafetyBufferLamports: async () => 800_000,
    };
    (gm as any).getGameCreationRentLamports = async () => 0;
    let swapCalls = 0;
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async () => {
        swapCalls += 1;
        return { swapped: true, lamportsReceived: refreshedLamports };
      },
    };
    (gm as any).oracleClient = {
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "cafebabe",
        oracleOperator: PublicKey.default.toBase58(),
      }),
      signGameTransaction: async (transaction: any) => transaction,
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    const gameToken = Keypair.generate().publicKey;
    const gameVault = Keypair.generate().publicKey;
    const gameTokenAccount = Keypair.generate().publicKey;
    const creatorTokenAccount = Keypair.generate().publicKey;
    (gm as any).resolveGameTokenAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameToken,
      gameVault,
      gameTokenAccount,
    });
    (gm as any).deriveAta = async () => creatorTokenAccount;
    const originalGetGamePda = (PDAManager as any).getGamePDA;
    const fixedPda = new PublicKey("11111111111111111111111111111111");
    (PDAManager as any).getGamePDA = () => fixedPda;
    (gm as any).confirmTransactionWithRecovery = async () => "CONFIRMED";

    try {
      const result = await gm.createGame(
        "giveaway",
        {
          amount: 1_000_000,
          tokenMint: "11111111111111111111111111111111",
          tokenTicker: "TOK",
          isSol: false,
        },
        5,
        1,
        60,
        telegramId,
      );

      expect(result.success).toBe(true);
      expect(result.gameAddress).toBe(fixedPda.toBase58());
      expect(saved.length).toBe(1);
      expect(swapCalls).toBe(1);
      expect(balanceCalls.some((call) => call.forceFresh)).toBe(true);
      expect(balanceCalls[0]?.forceFresh).toBe(false);
      expect(balanceCalls.at(-1)?.forceFresh).toBe(true);
      expect(clearedIds).toContain(telegramId);
      const cachedBalance = await wallet.getBalance(telegramId);
      expect(cachedBalance).toBe(refreshedLamports);
    } finally {
      (PDAManager as any).getGamePDA = originalGetGamePda;
      resetGM();
    }
  });

  test("prevents concurrent creations from exceeding active game cap", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      sendTransaction: async () => "SIG",
      confirmTransaction: async () => true,
    });

    let activeCount = MAX_ACTIVE_GAMES_PER_CREATOR - 1;
    const db = {
      savePlayerMapping: () => {},
      saveGame: () => {
        activeCount += 1;
      },
      saveGameParticipant: () => {},
      removeGameParticipant: () => {},
      countActiveGamesByCreator: () => activeCount,
      countRecentGamesByCreator: () => 0,
    } as any;

    const program = makeProgram(wallet.connection);
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).oracleClient = {
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "a".repeat(64),
        oracleOperator: PublicKey.default.toBase58(),
      }),
      signGameTransaction: async (transaction: any) => transaction,
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    (gm as any).resolveGameTokenAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameToken: Keypair.generate().publicKey,
      gameVault: Keypair.generate().publicKey,
      gameTokenAccount: Keypair.generate().publicKey,
    });
    (gm as any).deriveAta = async () => Keypair.generate().publicKey;
    (gm as any).confirmTransactionWithRecovery = async () => "CONFIRMED_SIG";

    const tokenMint = Keypair.generate().publicKey.toBase58();
    const creationArgs: Parameters<GameManager["createGame"]> = [
      "coinflip",
      { amount: 1_000_000, tokenMint, tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
    ];

    const [first, second] = await Promise.all([
      gm.createGame(...creationArgs),
      gm.createGame(...creationArgs),
    ]);

    const results = [first, second];
    const successes = results.filter((r) => r.success);
    const failures = results.filter((r) => !r.success);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    const failureMessage = String(failures[0]?.error ?? "");
    expect(failureMessage).toContain("limit reached");
    expect(failureMessage).toContain(String(MAX_ACTIVE_GAMES_PER_CREATOR));
    expect(activeCount).toBeGreaterThanOrEqual(MAX_ACTIVE_GAMES_PER_CREATOR);
  });

  test("errors are formatted via logAndFormatError when thrown", async () => {
    resetGM();
    const wallet = makeWallet({
      getTokenMetadata: async () => {
        throw new Error("metadata fail");
      },
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
    });
    const gm = GameManager.getInstance(makeProgram(wallet.connection), wallet, {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any);
    const res = await gm.createGame(
      "coinflip",
      { amount: 1_000_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
    );
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("Something went wrong");
  });

  test("calculates game rent based on maxTickets", async () => {
    resetGM();
    let signingCalls = 0;
    const capturedRentCalls: number[] = [];
    const connection = {
      ...createConnectionStub(),
      getMinimumBalanceForRentExemption: async (size: number) => {
        capturedRentCalls.push(size);
        // Return rent proportional to size (approx 6.96 lamports/byte)
        return Math.ceil(size * 6.96);
      },
    };
    const wallet = makeWallet({
      connection,
      getConnection: () => connection,
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 10_000_000,
      getBalance: async () => 10_000_000,
      sendTransaction: async () => "SIG",
    });
    const db = {
      savePlayerMapping: () => {},
      saveGame: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const program = makeProgram(connection);
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).oracleClient = {
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "a".repeat(64),
        oracleOperator: PublicKey.default.toBase58(),
      }),
      signGameTransaction: async (transaction: any) => {
        signingCalls += 1;
        return transaction;
      },
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    (gm as any).resolveGameTokenAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameToken: Keypair.generate().publicKey,
      gameVault: Keypair.generate().publicKey,
      gameTokenAccount: Keypair.generate().publicKey,
    });
    (gm as any).deriveAta = async () => Keypair.generate().publicKey;
    (gm as any).confirmTransactionWithRecovery = async () => "CONFIRMED";
    const originalGetGamePda = (PDAManager as any).getGamePDA;
    (PDAManager as any).getGamePDA = () => new PublicKey("11111111111111111111111111111111");

    try {
      // Create game with 2 players
      await gm.createGame(
        "coinflip",
        {
          amount: 100_000,
          tokenMint: "11111111111111111111111111111111",
          tokenTicker: "TOK",
          isSol: false,
        },
        2, // maxTickets = 2
        2,
        60,
        1n,
      );

      const firstInitializeAccounts = (program as any).__captures["initializeGameAccounts"];
      expect(firstInitializeAccounts.oracleOperator.toBase58()).not.toBe(
        firstInitializeAccounts.creator.toBase58(),
      );

      // Base size = 126 bytes + 32 bytes per participant public key
      const expectedSize2Players = 126 + 2 * 32;
      expect(capturedRentCalls).toContain(expectedSize2Players);

      // Reset for next test
      capturedRentCalls.length = 0;
      resetGM();

      const gm2 = GameManager.getInstance(program, wallet, db);
      (gm2 as any).oracleClient = (gm as any).oracleClient;
      (gm2 as any).resolveGameTokenAccounts = (gm as any).resolveGameTokenAccounts;
      (gm2 as any).deriveAta = (gm as any).deriveAta;
      (gm2 as any).confirmTransactionWithRecovery = (gm as any).confirmTransactionWithRecovery;

      // Create game with 50 players
      await gm2.createGame(
        "giveaway",
        {
          amount: 100_000,
          tokenMint: "11111111111111111111111111111111",
          tokenTicker: "TOK",
          isSol: false,
        },
        50, // maxTickets = 50
        1,
        60,
        2n,
      );

      const expectedSize50Players = 126 + 50 * 32;
      expect(capturedRentCalls).toContain(expectedSize50Players);
      expect(signingCalls).toBe(2);
    } finally {
      (PDAManager as any).getGamePDA = originalGetGamePda;
      resetGM();
    }
  });

  test("includes native account rent in required reserve calculation", async () => {
    resetGM();
    // Native account rent exemption is 890,880 lamports
    const NATIVE_RENT = 890_880;
    const minSolBuffer = 400_000;
    // For 2 players: 142 bytes * 6.96 ≈ 988 lamports
    const gameRent = 988;
    const requiredReserve = minSolBuffer + gameRent + NATIVE_RENT;

    // Set SOL balance just below the required reserve to trigger JIT swap check
    const belowRequiredBalance = requiredReserve - 100;

    let jitSwapCalled = false;
    let desiredLamportsArg: number | undefined;

    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 5_000_000, // Enough tokens
      getBalance: async () => belowRequiredBalance,
    });
    const db = {
      savePlayerMapping: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const program = makeProgram(wallet.connection);
    const gm = GameManager.getInstance(program, wallet, db);

    // Mock feeBudget
    (gm as any).feeBudget = {
      getGameSafetyBufferLamports: async () => minSolBuffer,
    };

    // Mock getGameCreationRentLamports to return a fixed value
    (gm as any).getGameCreationRentLamports = async () => gameRent;

    // Mock swapManager to capture the call
    (gm as any).swapManager = {
      performJustInTimeSolSwap: async (options: any) => {
        jitSwapCalled = true;
        desiredLamportsArg = options.desiredLamports;
        return { swapped: false, error: "Mock swap disabled" };
      },
    };

    try {
      // Attempt to create game - should fail but trigger JIT swap attempt
      await gm.createGame(
        "coinflip",
        { amount: 100_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
        2,
        2,
        60,
        1n,
      );
    } catch {
      // Expected to fail
    }

    // Verify JIT swap was called with correct desiredLamports
    expect(jitSwapCalled).toBe(true);
    // The desired lamports should include minSolBuffer + gameRent + nativeRent
    expect(desiredLamportsArg).toBe(minSolBuffer + gameRent + NATIVE_RENT);

    resetGM();
  });

  test("successful game creation with higher player count requires more SOL reserve", async () => {
    resetGM();
    const minSolBuffer = 400_000;

    // Track JIT swap calls with different player counts
    const jitSwapCalls: { maxTickets: number; desiredLamports: number }[] = [];

    const createTestGM = (maxTickets: number) => {
      resetGM();
      const wallet = makeWallet({
        getTokenMetadata: async () => ({ decimals: 6 }),
        getTokenBalance: async () => 10_000_000,
        getBalance: async () => 100_000, // Low balance to trigger JIT swap
      });
      const db = {
        savePlayerMapping: () => {},
        countActiveGamesByCreator: () => 0,
        countRecentGamesByCreator: () => 0,
      } as any;
      const program = makeProgram(wallet.connection);
      const gm = GameManager.getInstance(program, wallet, db);

      (gm as any).feeBudget = {
        getGameSafetyBufferLamports: async () => minSolBuffer,
      };

      // Use actual rent calculation
      const baseSize = 126;
      const bytesPerParticipant = 8;
      const accountSize = baseSize + maxTickets * bytesPerParticipant;
      const estimatedRent = Math.ceil(accountSize * 6.96);
      (gm as any).getGameCreationRentLamports = async () => estimatedRent;

      (gm as any).swapManager = {
        performJustInTimeSolSwap: async (options: any) => {
          jitSwapCalls.push({
            maxTickets,
            desiredLamports: options.desiredLamports,
          });
          return { swapped: false, error: "Mock" };
        },
      };

      return gm;
    };

    // Test with 2 players
    const gm2 = createTestGM(2);
    await gm2.createGame(
      "coinflip",
      { amount: 100_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      2,
      2,
      60,
      1n,
    );

    // Test with 50 players
    const gm50 = createTestGM(50);
    await gm50.createGame(
      "giveaway",
      { amount: 100_000, tokenMint: "M", tokenTicker: "TOK", isSol: false },
      50,
      1,
      60,
      2n,
    );

    expect(jitSwapCalls.length).toBe(2);

    const call2Players = jitSwapCalls.find((c) => c.maxTickets === 2);
    const call50Players = jitSwapCalls.find((c) => c.maxTickets === 50);

    expect(call2Players).toBeDefined();
    expect(call50Players).toBeDefined();

    // 50 player game should require more SOL than 2 player game
    // Difference should be approximately (50 - 2) * 8 * 6.96 = 2,670 lamports
    expect(call50Players!.desiredLamports).toBeGreaterThan(call2Players!.desiredLamports);

    // Verify the difference is proportional to player count difference
    const rentDifference = call50Players!.desiredLamports - call2Players!.desiredLamports;
    const playerDifference = 50 - 2;
    const expectedRentDifference = Math.ceil(playerDifference * 8 * 6.96);
    // Allow some tolerance for rounding
    expect(rentDifference).toBeGreaterThanOrEqual(expectedRentDifference - 10);
    expect(rentDifference).toBeLessThanOrEqual(expectedRentDifference + 10);

    resetGM();
  });
});
