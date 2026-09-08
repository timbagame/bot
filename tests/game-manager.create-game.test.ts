import { describe, test, expect, vi } from "bun:test";
import {
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  partiallySignTransactionWithSigners,
} from "@solana/kit";
import { GameManager } from "../src/utils/game";
import { PublicKey, Keypair, TransactionInstruction } from "#solana";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "#token";
import { PDAManager } from "../src/utils/pda";
import { OraclePolicyError } from "../src/utils/oracle";
import {
  GAME_CREATION_RATE_LIMIT_WINDOW_MS,
  MAX_ACTIVE_GAMES_PER_CREATOR,
  MAX_GAMES_PER_CREATOR_WINDOW,
  WSOL_MINT,
} from "../src/utils/constants";
import { contractCapabilities } from "../src/utils/contract-idl";
import { decodeGameTransaction } from "../src/utils/game-transaction";

const TEST_ORACLE = await Keypair.generate();

async function signGameTransactionAsOracle(txBase64: string): Promise<string> {
  const transaction = decodeGameTransaction(txBase64);
  const signed = await partiallySignTransactionWithSigners([TEST_ORACLE], transaction);
  return getBase64EncodedWireTransaction(signed);
}

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function getGameManager(...args: Parameters<typeof GameManager.getInstance>): GameManager {
  const manager = GameManager.getInstance(...args);
  (manager as any).oracleClient.requireTokenPolicy = async (mint: string) => ({
    mint,
    enabled: true,
    minimumAmountRaw: "1",
    acceptedMinimumAmountRaw: "1",
    revision: 1,
    effectiveAt: "2026-09-02T00:00:00.000Z",
  });
  return manager;
}

function createConnectionStub(owner: PublicKey = TOKEN_PROGRAM_ID) {
  return {
    getAccountInfo: async () => ({ owner }),
    getAccountInfoAndContext: async () => ({ value: null }),
    getParsedAccountInfo: async () => ({
      value: { data: { parsed: { info: { decimals: 6 } } } },
    }),
    // Individual rent tests provide a size-aware implementation. Other unit tests
    // use a nominal positive value so rent does not dominate their fixture balances.
    getMinimumBalanceForRentExemption: async (size: number) => (size === 0 ? 890_880 : 1),
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
      initializeGame: (cfg: any, _hash: any) => ({
        accounts: (accs: any) => {
          captures["initializeGameAccounts"] = accs;
          captures["initializeGameConfig"] = cfg;
          return {
            instruction: async () =>
              new TransactionInstruction({
                programId,
                keys: [
                  { pubkey: accs.game, isSigner: false, isWritable: true },
                  { pubkey: accs.creator, isSigner: true, isWritable: true },
                  { pubkey: accs.oracleOperator, isSigner: true, isWritable: false },
                ],
                data: Buffer.alloc(0),
              }),
          };
        },
      }),
      joinGame: () => ({
        accounts: (accs: any) => {
          captures["joinGameAccounts"] = accs;
          return {
            instruction: async () => {
              const instruction = new TransactionInstruction({
                programId,
                keys: [
                  { pubkey: accs.game, isSigner: false, isWritable: true },
                  { pubkey: accs.player, isSigner: true, isWritable: true },
                  {
                    pubkey: accs.oracleOperator ?? programId,
                    isSigner: Boolean(accs.oracleOperator),
                    isWritable: false,
                  },
                ],
                data: Buffer.alloc(0),
              });
              captures["joinGameInstruction"] = instruction;
              return instruction;
            },
          };
        },
      }),
    },
    account: {
      game: {
        fetch: async () => {
          const accounts = captures["initializeGameAccounts"];
          const config = captures["initializeGameConfig"];
          const funds = accounts.gameVaultCtx ?? accounts.gameTokenCtx;
          return {
            creator: accounts.creator,
            tokenMint: funds.tokenMint,
            gameType: config.gameType,
            ticketAmount: config.amount,
            totalAmount: config.amount,
            maxTickets: config.maxTickets,
            minTickets: config.minTickets,
          };
        },
      },
    },
  } as any;
}

function makeWallet(overrides: Record<string, any>) {
  const { connection: providedConnection, ...rest } = overrides;
  const connection = providedConnection ?? createConnectionStub();
  const wallet: any = {
    connection,
    getConnection: () => connection,
    getKeyPair: async (_: bigint) => await Keypair.generate(),
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
  wallet.sendFullySignedGameTransaction ??= async (transaction: any) => {
    wallet.__lastGameTransaction = transaction;
    return wallet.sendTransaction?.([], []) ?? "SIG";
  };

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
    const gm = getGameManager(makeProgram(wallet.connection), wallet, {
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
    const gm = getGameManager(makeProgram(wallet.connection), wallet, {
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
    const gm = getGameManager(makeProgram(wallet.connection), wallet, {
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
    const gm = getGameManager(makeProgram(wallet.connection), wallet, db);
    // Patch oracle client on the instance
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => false,
    };
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

  test("fails closed with a safe message when Oracle disables the token", async () => {
    if (!contractCapabilities.oracleTokenPolicy) return;
    resetGM();
    const wallet = makeWallet({});
    const gm = getGameManager(makeProgram(wallet.connection), wallet, {
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any);
    (gm as any).oracleClient.requireTokenPolicy = async () => {
      throw new OraclePolicyError("token_disabled", "sensitive operator detail");
    };

    const result = await gm.createGame(
      "coinflip",
      {
        amount: 1,
        tokenMint: PublicKey.default.toBase58(),
        tokenTicker: "TEST",
        isSol: false,
      },
      2,
      2,
      60,
      1n,
    );

    expect(result).toEqual({
      success: false,
      error: "❌ This token is temporarily disabled for new games.",
    });
    expect(result.error).not.toContain("sensitive operator detail");
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
    const gm = getGameManager(makeProgram(wallet.connection), wallet, db);
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
    const gm = getGameManager(makeProgram(wallet.connection), wallet, db);
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

    const gm = getGameManager(makeProgram(wallet.connection), wallet, db);

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

    const pendingRequests = Array.from({ length: MAX_GAMES_PER_CREATOR_WINDOW }, () =>
      gm.createGame(...baseArgs),
    );

    await Promise.resolve();
    expect(metadataDeferrals.length).toBe(MAX_GAMES_PER_CREATOR_WINDOW);

    const blockedResult = await gm.createGame(...baseArgs);
    expect(blockedResult.success).toBe(false);
    const blockedError = String(blockedResult.error || "");
    expect(blockedError.toLowerCase()).toContain("rate limit");
    expect(blockedError).toContain(String(MAX_GAMES_PER_CREATOR_WINDOW));
    expect(blockedError).toContain("Some requests are still processing.");

    metadataDeferrals.forEach((reject) => reject(new Error("abort")));
    await Promise.allSettled(pendingRequests);
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

      const gm = getGameManager(makeProgram(wallet.connection), wallet, db);

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

      const gm = getGameManager(makeProgram(wallet.connection), wallet, db);

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

    const gm = getGameManager(makeProgram(wallet.connection), wallet, db);

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

      const gm = getGameManager(makeProgram(wallet.connection), wallet, db);

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
    const gm = getGameManager(program, wallet, db);
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "0".repeat(64),
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: signGameTransactionAsOracle,
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
    const gm = getGameManager(program, wallet, db);
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "1".repeat(64),
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: signGameTransactionAsOracle,
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
    let sendCalls = 0;
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      sendTransaction: async () => {
        sendCalls += 1;
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
    const gm = getGameManager(program, wallet, db);
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "deadbeef",
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: async (transaction: string) => {
        signingCalls += 1;
        return signGameTransactionAsOracle(transaction);
      },
      hexToBuffer: (_: string) => Buffer.from("deadbeef", "hex"),
    };
    const gameVault = (await Keypair.generate()).publicKey;
    const gameVaultTokenAccount = (await Keypair.generate()).publicKey;
    const creatorTokenAccount = (await Keypair.generate()).publicKey;
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault,
      gameVaultTokenAccount,
    });
    (gm as any).deriveAta = async () => creatorTokenAccount;
    // Derivation and confirmation patched
    const pda = new PublicKey("11111111111111111111111111111111");
    const original = (PDAManager as any).getGamePDA;
    (PDAManager as any).getGamePDA = () => pda;
    (gm as any).confirmTransactionWithRecovery = async (
      _signature: string,
      _gamePda: PublicKey,
      _label: string,
      _player: PublicKey | undefined,
      resubmit: (attempt: number, previousSignature: string) => Promise<string>,
    ) => {
      await resubmit(0, "SIG");
      return "CONFIRMED_SIG";
    };

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
    expect(sendCalls).toBe(2);
    const compiledMessage = getCompiledTransactionMessageDecoder().decode(
      wallet.__lastGameTransaction.messageBytes,
    );
    expect(compiledMessage.version).toBe("legacy");
    if (compiledMessage.version !== "legacy") {
      throw new Error("Expected a legacy game transaction");
    }
    expect(compiledMessage.instructions).toHaveLength(
      contractCapabilities.gameTokenAccount ? 2 : 3,
    );
    if (!contractCapabilities.gameTokenAccount) {
      const setupInstruction = compiledMessage.instructions[0]!;
      expect(compiledMessage.staticAccounts[setupInstruction.programAddressIndex]).toBe(
        ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      );
      const setupAccounts = (setupInstruction.accountIndices ?? []).map(
        (index) => compiledMessage.staticAccounts[index],
      );
      expect(setupAccounts).toContain(gameVaultTokenAccount.toBase58());
      expect(setupAccounts).toContain(gameVault.toBase58());
    }
    expect(res.gameAddress).toBe(pda.toBase58());
    expect(saved.length).toBe(1);

    const captures = (program as any).__captures;
    const accounts = captures["initializeGameAccounts"];
    expect(captures["joinGameAccounts"].oracleOperator).toBeUndefined();
    expect((captures["joinGameInstruction"] as TransactionInstruction).keys[2]).toEqual({
      pubkey: program.programId,
      isSigner: false,
      isWritable: false,
    });
    expect(accounts).toBeDefined();
    const fundsContextKey = contractCapabilities.gameTokenAccount ? "gameTokenCtx" : "gameVaultCtx";
    expect(accounts[fundsContextKey]).toBeDefined();
    expect(Object.keys(accounts).sort()).toEqual(
      [
        "creator",
        "creatorTokenAccount",
        "game",
        fundsContextKey,
        "oracle",
        "oracleOperator",
        "systemProgram",
      ].sort(),
    );
    const ctx = accounts[fundsContextKey];
    expect(Object.keys(ctx).sort()).toEqual(
      (contractCapabilities.gameTokenAccount
        ? [
            "associatedTokenProgram",
            "gameToken",
            "gameTokenAccount",
            "gameVault",
            "tokenMint",
            "tokenProgram",
          ]
        : [
            "associatedTokenProgram",
            "gameVault",
            "gameVaultTokenAccount",
            "tokenMint",
            "tokenProgram",
          ]
      ).sort(),
    );
    expect(ctx.tokenMint.toBase58()).toBe("11111111111111111111111111111111");
    expect(ctx.gameVault.toBase58()).toBe(gameVault.toBase58());
    expect((ctx.gameVaultTokenAccount ?? ctx.gameTokenAccount).toBase58()).toBe(
      gameVaultTokenAccount.toBase58(),
    );
    expect(ctx.tokenProgram.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(ctx.associatedTokenProgram.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    expect(accounts.creatorTokenAccount.toBase58()).toBe(creatorTokenAccount.toBase58());
    expect(accounts.tokenMint).toBeUndefined();
    expect(accounts.tokenProgram).toBeUndefined();
    expect(accounts.associatedTokenProgram).toBeUndefined();
    expect(accounts.gameVault).toBeUndefined();
    expect(accounts.gameVaultTokenAccount).toBeUndefined();

    // restore
    (PDAManager as any).getGamePDA = original;
  });

  test.each(["RPC timeout", "Account does not exist", "unavailable", "mismatch"])(
    "recovers confirmed creation safely after %s",
    async (failure) => {
      resetGM();
      const wallet = makeWallet({
        getTokenMetadata: async () => ({ decimals: 6 }),
        getTokenBalance: async () => 2_000_000,
        getBalance: async () => 3_000_000,
        sendTransaction: vi.fn(async () => "SIG"),
      });
      const saveGame = vi.fn();
      const saveGameParticipant = vi.fn();
      const savePendingGameCreation = vi.fn();
      const db = {
        savePlayerMapping: () => {},
        saveGame,
        saveGameParticipant,
        savePendingGameCreation,
        claimPendingGameCreationSubmission: () => ({ acquired: true }),
        finishPendingGameCreationSubmission: () => true,
        countActiveGamesByCreator: () => 0,
        countRecentGamesByCreator: () => 0,
      } as any;
      const program = makeProgram(wallet.connection);
      const fetchAccount = program.account.game.fetch;
      let reads = 0;
      program.account.game.fetch = async () => {
        reads += 1;
        if (failure === "unavailable" || (reads === 1 && failure !== "mismatch")) {
          throw new Error(failure);
        }
        const account = await fetchAccount();
        return failure === "mismatch" ? { ...account, maxTickets: 99 } : account;
      };
      const gm = getGameManager(program, wallet, db);
      (gm as any).oracleClient = {
        requireTokenPolicy: async () => ({}),
        isHealthy: async () => true,
        generateGameSecrets: async () => ({
          randomHash: "f".repeat(64),
          oracleOperator: TEST_ORACLE.publicKey.toBase58(),
        }),
        signGameTransaction: vi.fn(signGameTransactionAsOracle),
        hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
      };
      (gm as any).resolveGameVaultAccounts = async () => ({
        tokenProgram: TOKEN_PROGRAM_ID,
        gameVault: (await Keypair.generate()).publicKey,
        gameVaultTokenAccount: (await Keypair.generate()).publicKey,
      });
      (gm as any).deriveAta = async () => (await Keypair.generate()).publicKey;
      (gm as any).confirmTransactionWithRecovery = async () => "CONFIRMED_SIG";

      const result = await gm.createGame(
        "coinflip",
        {
          amount: 1_000_000,
          tokenMint: PublicKey.default.toBase58(),
          tokenTicker: "TIMBA",
          isSol: false,
        },
        2,
        2,
        60,
        1n,
        undefined,
        8200,
      );

      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
      expect((gm as any).oracleClient.signGameTransaction).toHaveBeenCalledTimes(1);
      if (failure === "unavailable" || failure === "mismatch") {
        expect(result.success).toBe(false);
        expect(saveGame).not.toHaveBeenCalled();
        expect(saveGameParticipant).not.toHaveBeenCalled();
        expect(result.gameAddress).toBe(program.__captures.initializeGameAccounts.game.toBase58());
        expect(result.confirmedSignature).toBe("CONFIRMED_SIG");
        expect(savePendingGameCreation).toHaveBeenCalledWith(
          expect.objectContaining({
            gameAddress: result.gameAddress,
            chatId: 8200,
            transactionSignature: expect.any(String),
            signedTransactionBase64: expect.any(String),
          }),
        );
        expect(reads).toBe(failure === "unavailable" ? 7 : 1);
      } else {
        expect(result.success).toBe(true);
        expect(reads).toBe(2);
        expect(saveGame).toHaveBeenCalledTimes(1);
        expect(saveGameParticipant).toHaveBeenCalledWith(
          result.gameAddress,
          "1",
          expect.any(String),
          expect.objectContaining({ status: "confirmed", joinSignature: "CONFIRMED_SIG" }),
        );
      }
    },
  );

  test("persists the signed creation intent before the first broadcast", async () => {
    resetGM();
    const events: string[] = [];
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      sendFullySignedGameTransaction: vi.fn(async () => {
        events.push("broadcast");
        return "SIG";
      }),
    });
    const savePendingGameCreation = vi.fn((input: { state?: string }) => {
      events.push(`persist:${input.state ?? "legacy"}`);
    });
    const claimPendingGameCreationSubmission = vi.fn(() => {
      events.push("admit");
      return { acquired: true };
    });
    const finishPendingGameCreationSubmission = vi.fn(() => {
      events.push("finish");
      return true;
    });
    const db = {
      savePlayerMapping: () => {},
      saveGame: vi.fn(),
      saveGameParticipant: vi.fn(),
      savePendingGameCreation,
      claimPendingGameCreationSubmission,
      finishPendingGameCreationSubmission,
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const program = makeProgram(wallet.connection);
    const gm = getGameManager(program, wallet, db);
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "f".repeat(64),
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: vi.fn(signGameTransactionAsOracle),
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault: (await Keypair.generate()).publicKey,
      gameVaultTokenAccount: (await Keypair.generate()).publicKey,
    });
    (gm as any).deriveAta = async () => (await Keypair.generate()).publicKey;
    (gm as any).confirmTransactionWithRecovery = async () => "SIG";

    try {
      const result = await gm.createGame(
        "coinflip",
        {
          amount: 1_000_000,
          tokenMint: PublicKey.default.toBase58(),
          tokenTicker: "TIMBA",
          isSol: false,
        },
        2,
        2,
        60,
        1n,
        { isPrivate: false },
        8200,
      );

      expect(result.success).toBe(true);
      expect(savePendingGameCreation).toHaveBeenCalledWith(
        expect.objectContaining({ state: "prepared", isPrivate: false }),
      );
      expect(events.indexOf("persist:prepared")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("persist:prepared")).toBeLessThan(events.indexOf("admit"));
      expect(events.indexOf("admit")).toBeLessThan(events.indexOf("broadcast"));
    } finally {
      resetGM();
    }
  });

  test("fails closed when initial durable submission admission fails", async () => {
    resetGM();
    const savePendingGameCreation = vi.fn();
    const claimPendingGameCreationSubmission = vi.fn(() => {
      throw new Error("database is read-only");
    });
    const sendFullySignedGameTransaction = vi.fn(async () => "SIG");
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      sendFullySignedGameTransaction,
    });
    const db = {
      savePlayerMapping: () => {},
      saveGame: vi.fn(),
      saveGameParticipant: vi.fn(),
      savePendingGameCreation,
      claimPendingGameCreationSubmission,
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const program = makeProgram(wallet.connection);
    const gm = getGameManager(program, wallet, db);
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "f".repeat(64),
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: signGameTransactionAsOracle,
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault: (await Keypair.generate()).publicKey,
      gameVaultTokenAccount: (await Keypair.generate()).publicKey,
    });
    (gm as any).deriveAta = async () => (await Keypair.generate()).publicKey;

    try {
      const result = await gm.createGame(
        "coinflip",
        {
          amount: 1_000_000,
          tokenMint: PublicKey.default.toBase58(),
          tokenTicker: "TIMBA",
          isSol: false,
        },
        2,
        2,
        60,
        1n,
        { isPrivate: false },
        8200,
      );

      expect(result.success).toBe(false);
      expect(savePendingGameCreation).toHaveBeenCalledWith(
        expect.objectContaining({ state: "prepared", signedTransactionBase64: expect.any(String) }),
      );
      expect(claimPendingGameCreationSubmission).toHaveBeenCalledTimes(1);
      expect(sendFullySignedGameTransaction).not.toHaveBeenCalled();
    } finally {
      resetGM();
    }
  });

  test("fails closed when recovery submission admission fails", async () => {
    resetGM();
    const sendFullySignedGameTransaction = vi.fn(async () => "SIG");
    const claimPendingGameCreationSubmission = vi.fn(() => {
      throw new Error("database is unavailable");
    });
    const gm = Object.create(GameManager.prototype) as any;
    gm.gameDb = { claimPendingGameCreationSubmission };
    gm.wallet = { sendFullySignedGameTransaction };

    const pending = {
      game_address: "11111111111111111111111111111111",
      transaction_signature: "signature",
      state: "submitted" as const,
      signed_transaction_base64: "exact-signed-wire-bytes",
      transaction_blockhash: "11111111111111111111111111111111",
      last_valid_block_height: 100,
    } as any;

    await expect((gm as any).rebroadcastPendingGameCreation(pending)).rejects.toThrow(
      "database is unavailable",
    );
    expect(claimPendingGameCreationSubmission).toHaveBeenCalledTimes(1);
    expect(sendFullySignedGameTransaction).not.toHaveBeenCalled();
  });

  test("keeps an unknown broadcast recoverable instead of starting a second creation", async () => {
    resetGM();
    let sendAttempts = 0;
    let recoverySendSignature: string | null = null;
    const wallet = makeWallet({
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 2_000_000,
      getBalance: async () => 3_000_000,
      getTransactionOutcome: async () => "unknown",
      sendFullySignedGameTransaction: vi.fn(async () => {
        sendAttempts += 1;
        if (sendAttempts === 1) throw new Error("RPC response lost");
        return recoverySendSignature ?? "SIG";
      }),
    });
    const savePendingGameCreation = vi.fn();
    const setPendingGameCreationState = vi.fn();
    const claimPendingGameCreationSubmission = vi.fn(() => ({ acquired: true }));
    const finishPendingGameCreationSubmission = vi.fn(() => true);
    const db = {
      savePlayerMapping: () => {},
      savePendingGameCreation,
      setPendingGameCreationState,
      claimPendingGameCreationSubmission,
      finishPendingGameCreationSubmission,
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const program = makeProgram(wallet.connection);
    const gm = getGameManager(program, wallet, db);
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "f".repeat(64),
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: vi.fn(signGameTransactionAsOracle),
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault: (await Keypair.generate()).publicKey,
      gameVaultTokenAccount: (await Keypair.generate()).publicKey,
    });
    (gm as any).deriveAta = async () => (await Keypair.generate()).publicKey;
    const confirmSpy = vi.fn();
    (gm as any).confirmTransactionWithRecovery = confirmSpy;

    try {
      const result = await gm.createGame(
        "coinflip",
        {
          amount: 1_000_000,
          tokenMint: PublicKey.default.toBase58(),
          tokenTicker: "TIMBA",
          isSol: false,
        },
        2,
        2,
        60,
        1n,
        { isPrivate: false },
        8200,
      );

      expect(result).toMatchObject({
        success: false,
        gameAddress: expect.any(String),
        confirmedSignature: expect.any(String),
      });
      expect(savePendingGameCreation).toHaveBeenCalledWith(
        expect.objectContaining({ state: "prepared", signedTransactionBase64: expect.any(String) }),
      );
      expect(setPendingGameCreationState).toHaveBeenCalledWith(
        result.gameAddress,
        "unknown",
        expect.objectContaining({ error: "RPC response lost" }),
      );
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(wallet.sendFullySignedGameTransaction).toHaveBeenCalledTimes(1);

      const prepared = savePendingGameCreation.mock.calls[0]?.[0];
      recoverySendSignature = prepared.transactionSignature;
      expect(prepared).toEqual(
        expect.objectContaining({
          state: "prepared",
          signedTransactionBase64: expect.any(String),
          transactionSignature: expect.any(String),
        }),
      );

      (program.account.game.fetch as any) = vi.fn(async () => null);
      const pending = {
        game_address: prepared.gameAddress,
        creator_telegram_id: "1",
        creator_display_name: null,
        amount: 1_000_000,
        game_type: "coinflip",
        token_mint: PublicKey.default.toBase58(),
        token_ticker: "TIMBA",
        max_players: 2,
        min_players: 2,
        chat_id: 8200,
        timeout_seconds: 60,
        expires_at: Date.now() + 60_000,
        transaction_signature: prepared.transactionSignature,
        state: "unknown" as const,
        is_private: 0,
        transaction_blockhash: prepared.transactionBlockhash,
        last_valid_block_height: prepared.lastValidBlockHeight,
        signed_transaction_base64: prepared.signedTransactionBase64,
        reply_to_message_id: null,
        on_chain_created_at: null,
        attempts: 0,
        last_error: null,
        next_attempt_at: Date.now(),
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      await expect(
        gm.recoverPendingGameCreation({ chat: { id: 8200 } } as any, pending),
      ).rejects.toThrow("not available yet");
      expect(wallet.sendFullySignedGameTransaction).toHaveBeenCalledTimes(2);
      expect(
        getBase64EncodedWireTransaction(wallet.sendFullySignedGameTransaction.mock.calls[1]![0]),
      ).toBe(prepared.signedTransactionBase64);
    } finally {
      resetGM();
    }
  });

  test("routes an expired confirmed creation through expiration cleanup", async () => {
    resetGM();
    const creator = await Keypair.generate();
    const tokenMint = await Keypair.generate();
    const gameAddress = (await Keypair.generate()).publicKey.toBase58();
    const createdAt = Math.floor(Date.now() / 1_000) - 120;
    const timeoutSeconds = 60;
    const gameAccount = {
      creator: creator.publicKey,
      tokenMint: tokenMint.publicKey,
      gameType: { coinflip: {} },
      ticketAmount: 100,
      totalAmount: 100,
      maxTickets: 2,
      minTickets: 2,
      ticketsCount: 0,
      timeout: timeoutSeconds,
      createdAt,
      isPrivate: false,
    };
    const wallet = makeWallet({
      getKeyPair: async () => creator,
      getTokenMetadata: async () => ({ symbol: "TOK", decimals: 6 }),
    });
    const program = makeProgram(wallet.connection);
    program.account.game.fetch = vi.fn(async () => gameAccount);
    const clearPendingGameCreation = vi.fn();
    const completeGame = vi.fn();
    const setPendingGameCreationState = vi.fn();
    const db = {
      getGame: () => null,
      saveGame: vi.fn(),
      savePlayerMapping: vi.fn(),
      getPlayerTelegramId: () => null,
      getGameMessages: () => [],
      clearPendingGameCreation,
      setPendingGameCreationState,
      completeGame,
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const gm = getGameManager(program, wallet, db);
    const handleExpiredGame = vi.fn().mockResolvedValue({
      cancelled: true,
      amount: 100,
      creator: creator.publicKey.toBase58(),
      tx: "CANCEL",
    });
    (gm as any).handleExpiredGame = handleExpiredGame;
    (gm as any).createGameMessage = vi.fn().mockResolvedValue(1);

    const pending = {
      game_address: gameAddress,
      creator_telegram_id: "1",
      creator_display_name: "@creator",
      amount: 100,
      game_type: "coinflip",
      token_mint: tokenMint.publicKey.toBase58(),
      token_ticker: "TOK",
      max_players: 2,
      min_players: 2,
      chat_id: 8200,
      timeout_seconds: timeoutSeconds,
      expires_at: (createdAt + timeoutSeconds) * 1_000,
      transaction_signature: "CREATE",
      state: "confirmed" as const,
      is_private: 0,
      transaction_blockhash: null,
      last_valid_block_height: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    try {
      await expect(
        gm.recoverPendingGameCreation({ chat: { id: 8200 } } as any, pending),
      ).resolves.toBe(true);
      expect(handleExpiredGame).toHaveBeenCalledWith(expect.any(PublicKey), gameAccount);
      expect(completeGame).toHaveBeenCalledWith(gameAddress, "cancelled", expect.any(Number), 100);
      expect(clearPendingGameCreation).toHaveBeenCalledWith(gameAddress);
    } finally {
      resetGM();
    }
  });

  test("keeps a confirmed creation intent while the account read lags", async () => {
    resetGM();
    const gameAddress = (await Keypair.generate()).publicKey.toBase58();
    const wallet = makeWallet({
      getTransactionOutcome: async () => "confirmed",
    });
    const program = makeProgram(wallet.connection);
    program.account.game.fetch = vi.fn(async () => null);
    const clearPendingGameCreation = vi.fn();
    const db = {
      getGame: () => null,
      clearPendingGameCreation,
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const gm = getGameManager(program, wallet, db);
    const pending = {
      game_address: gameAddress,
      creator_telegram_id: "1",
      creator_display_name: "@creator",
      amount: 100,
      game_type: "coinflip",
      token_mint: PublicKey.default.toBase58(),
      token_ticker: "TOK",
      max_players: 2,
      min_players: 2,
      chat_id: 8200,
      timeout_seconds: 60,
      expires_at: Date.now() + 60_000,
      transaction_signature: "CREATE",
      state: "confirmed" as const,
      is_private: 0,
      transaction_blockhash: null,
      last_valid_block_height: null,
      signed_transaction_base64: null,
      reply_to_message_id: null,
      on_chain_created_at: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await expect(
      gm.recoverPendingGameCreation({ chat: { id: 8200 } } as any, pending),
    ).rejects.toThrow("not available yet");
    expect(clearPendingGameCreation).not.toHaveBeenCalled();
  });

  test("keeps an expired legacy unknown intent for manual reconciliation", async () => {
    resetGM();
    const clearPendingGameCreation = vi.fn();
    const wallet = makeWallet({
      getTransactionOutcome: async () => "unknown",
      connection: {
        ...createConnectionStub(),
        getBlockHeight: async () => 1_000,
      },
    });
    const program = makeProgram(wallet.connection);
    program.account.game.fetch = vi.fn(async () => null);
    const db = {
      getGame: () => null,
      clearPendingGameCreation,
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const gm = getGameManager(program, wallet, db);
    const pending = {
      game_address: "11111111111111111111111111111111",
      creator_telegram_id: "1",
      creator_display_name: null,
      amount: 100,
      game_type: "coinflip",
      token_mint: PublicKey.default.toBase58(),
      token_ticker: "TOK",
      max_players: 2,
      min_players: 2,
      chat_id: 8200,
      timeout_seconds: 60,
      expires_at: Date.now() - 1_000,
      transaction_signature: "legacy-signature",
      state: "unknown" as const,
      is_private: null,
      transaction_blockhash: null,
      last_valid_block_height: 100,
      signed_transaction_base64: null,
      reply_to_message_id: null,
      on_chain_created_at: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await expect(
      gm.recoverPendingGameCreation({ chat: { id: 8200 } } as any, pending),
    ).rejects.toThrow("manual reconciliation");
    expect(clearPendingGameCreation).not.toHaveBeenCalled();
  });

  test("marks confirmed before Telegram delivery so retry metadata cannot erase it", async () => {
    resetGM();
    const creator = await Keypair.generate();
    const tokenMint = await Keypair.generate();
    const gameAddress = (await Keypair.generate()).publicKey.toBase58();
    const createdAt = Math.floor(Date.now() / 1_000) - 5;
    const gameAccount = {
      creator: creator.publicKey,
      tokenMint: tokenMint.publicKey,
      gameType: { coinflip: {} },
      ticketAmount: 100,
      totalAmount: 100,
      maxTickets: 2,
      minTickets: 2,
      ticketsCount: 0,
      timeout: 60,
      createdAt,
      isPrivate: false,
    };
    const wallet = makeWallet({
      getKeyPair: async () => creator,
      getTokenMetadata: async () => ({ symbol: "TOK", decimals: 6 }),
    });
    const program = makeProgram(wallet.connection);
    program.account.game.fetch = vi.fn(async () => gameAccount);
    let state = "submitted";
    const setPendingGameCreationState = vi.fn((_address: string, nextState: string) => {
      state = nextState;
    });
    const recordPendingGameCreationAttempt = vi.fn();
    const db = {
      getGame: () => null,
      getGameMessages: () => [],
      saveGame: vi.fn(),
      savePlayerMapping: vi.fn(),
      getPlayerTelegramId: () => null,
      setPendingGameCreationChainTiming: vi.fn(),
      setGameChainTiming: vi.fn(),
      setPendingGameCreationState,
      recordPendingGameCreationAttempt,
      clearPendingGameCreation: vi.fn(),
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const gm = getGameManager(program, wallet, db);
    (gm as any).createGameMessage = vi.fn().mockRejectedValue(new Error("Telegram unavailable"));
    const pending = {
      game_address: gameAddress,
      creator_telegram_id: "1",
      creator_display_name: "@creator",
      amount: 100,
      game_type: "coinflip",
      token_mint: tokenMint.publicKey.toBase58(),
      token_ticker: "TOK",
      max_players: 2,
      min_players: 2,
      chat_id: 8200,
      timeout_seconds: 60,
      expires_at: (createdAt + 60) * 1_000,
      transaction_signature: "CREATE",
      state: "submitted" as const,
      is_private: 0,
      transaction_blockhash: null,
      last_valid_block_height: null,
      signed_transaction_base64: null,
      reply_to_message_id: null,
      on_chain_created_at: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await expect(
      gm.recoverPendingGameCreation({ chat: { id: 8200 } } as any, pending),
    ).rejects.toThrow("Telegram unavailable");
    expect(state).toBe("confirmed");

    // The bot's retry bookkeeping updates attempts/error/backoff only; it
    // must not reinterpret a confirmed intent as unknown.
    recordPendingGameCreationAttempt(gameAddress, "Telegram unavailable", Date.now() + 60_000);
    expect(state).toBe("confirmed");
  });

  test("uses on-chain creation timing and the stored delivery target during recovery", async () => {
    resetGM();
    const creator = await Keypair.generate();
    const tokenMint = await Keypair.generate();
    const gameAddress = (await Keypair.generate()).publicKey.toBase58();
    const createdAt = Math.floor(Date.now() / 1_000) - 5;
    const timeoutSeconds = 60;
    const gameAccount = {
      creator: creator.publicKey,
      tokenMint: tokenMint.publicKey,
      gameType: { coinflip: {} },
      ticketAmount: 100,
      totalAmount: 100,
      maxTickets: 2,
      minTickets: 2,
      ticketsCount: 0,
      timeout: timeoutSeconds,
      createdAt,
      isPrivate: false,
    };
    const wallet = makeWallet({
      getKeyPair: async () => creator,
      getTokenMetadata: async () => ({ symbol: "TOK", decimals: 6 }),
    });
    const program = makeProgram(wallet.connection);
    program.account.game.fetch = vi.fn(async () => gameAccount);
    const setPendingGameCreationChainTiming = vi.fn();
    const setGameChainTiming = vi.fn();
    const setGameOriginChat = vi.fn();
    const setPendingGameCreationState = vi.fn();
    const clearPendingGameCreation = vi.fn();
    const db = {
      getGame: () => null,
      getGameMessages: () => [],
      saveGame: vi.fn(),
      savePlayerMapping: vi.fn(),
      getPlayerTelegramId: () => null,
      setPendingGameCreationChainTiming,
      setGameChainTiming,
      setGameOriginChat,
      setPendingGameCreationState,
      clearPendingGameCreation,
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const gm = getGameManager(program, wallet, db);
    const createGameMessage = vi.fn().mockResolvedValue(44);
    (gm as any).createGameMessage = createGameMessage;
    const pending = {
      game_address: gameAddress,
      creator_telegram_id: "1",
      creator_display_name: "@creator",
      amount: 100,
      game_type: "coinflip",
      token_mint: tokenMint.publicKey.toBase58(),
      token_ticker: "TOK",
      max_players: 2,
      min_players: 2,
      chat_id: -1001,
      timeout_seconds: timeoutSeconds,
      // Deliberately represents the old request-time estimate, five seconds
      // before the authoritative chain creation time.
      expires_at: (createdAt - 5 + timeoutSeconds) * 1_000,
      transaction_signature: "CREATE",
      state: "confirmed" as const,
      is_private: 0,
      transaction_blockhash: null,
      last_valid_block_height: null,
      signed_transaction_base64: null,
      reply_to_message_id: 77,
      on_chain_created_at: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: Date.now(),
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    await expect(
      gm.recoverPendingGameCreation({ chat: { id: -2002 }, api: {} } as any, pending),
    ).resolves.toBe(true);

    expect(setPendingGameCreationChainTiming).toHaveBeenCalledWith(
      gameAddress,
      createdAt * 1_000,
      (createdAt + timeoutSeconds) * 1_000,
      expect.any(Number),
    );
    expect(setGameChainTiming).toHaveBeenCalledWith(
      gameAddress,
      createdAt * 1_000,
      (createdAt + timeoutSeconds) * 1_000,
    );
    expect(setGameOriginChat).toHaveBeenCalledWith(gameAddress, -1001);
    expect(createGameMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chat: { id: -1001 } }),
      gameAddress,
      "coinflip",
      100,
      "@creator",
      "TOK",
      "Active",
      77,
      { reserveDelivery: true, winnerAddress: undefined, totalPot: undefined },
    );
    expect(clearPendingGameCreation).toHaveBeenCalledWith(gameAddress);
  });

  test("creates game after SOL swap refreshes cached balance", async () => {
    resetGM();
    const playerKp = await Keypair.generate();
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
    const gm = getGameManager(program, wallet, db);
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
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "cafebabe",
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: signGameTransactionAsOracle,
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    const gameVault = (await Keypair.generate()).publicKey;
    const gameVaultTokenAccount = (await Keypair.generate()).publicKey;
    const creatorTokenAccount = (await Keypair.generate()).publicKey;
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault,
      gameVaultTokenAccount,
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
    const gm = getGameManager(program, wallet, db);
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "a".repeat(64),
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: signGameTransactionAsOracle,
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault: (await Keypair.generate()).publicKey,
      gameVaultTokenAccount: (await Keypair.generate()).publicKey,
    });
    (gm as any).deriveAta = async () => (await Keypair.generate()).publicKey;
    (gm as any).confirmTransactionWithRecovery = async () => "CONFIRMED_SIG";

    const tokenMint = (await Keypair.generate()).publicKey.toBase58();
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
    const gm = getGameManager(makeProgram(wallet.connection), wallet, {
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
        return 890_880 + size * 6_960;
      },
    };
    const wallet = makeWallet({
      connection,
      getConnection: () => connection,
      getTokenMetadata: async () => ({ decimals: 6 }),
      getTokenBalance: async () => 10_000_000,
      getBalance: async () => 20_000_000,
      sendTransaction: async () => "SIG",
    });
    const db = {
      savePlayerMapping: () => {},
      saveGame: () => {},
      countActiveGamesByCreator: () => 0,
      countRecentGamesByCreator: () => 0,
    } as any;
    const program = makeProgram(connection);
    const gm = getGameManager(program, wallet, db);
    (gm as any).oracleClient = {
      requireTokenPolicy: async () => ({}),
      isHealthy: async () => true,
      generateGameSecrets: async () => ({
        randomHash: "a".repeat(64),
        oracleOperator: TEST_ORACLE.publicKey.toBase58(),
      }),
      signGameTransaction: async (transaction: string) => {
        signingCalls += 1;
        return signGameTransactionAsOracle(transaction);
      },
      hexToBuffer: (hex: string) => Buffer.from(hex, "hex"),
    };
    (gm as any).resolveGameVaultAccounts = async () => ({
      tokenProgram: TOKEN_PROGRAM_ID,
      gameVault: (await Keypair.generate()).publicKey,
      gameVaultTokenAccount: (await Keypair.generate()).publicKey,
    });
    (gm as any).deriveAta = async () => (await Keypair.generate()).publicKey;
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

      // Contract base size (126) + vec prefix (4) + 32 bytes per participant.
      const expectedSize2Players = 126 + 4 + 2 * 32;
      expect(capturedRentCalls).toContain(expectedSize2Players);

      // Reset for next test
      capturedRentCalls.length = 0;
      resetGM();

      const gm2 = getGameManager(program, wallet, db);
      (gm2 as any).oracleClient = (gm as any).oracleClient;
      (gm2 as any).resolveGameVaultAccounts = (gm as any).resolveGameVaultAccounts;
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

      const expectedSize50Players = 126 + 4 + 50 * 32;
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
    // Fixed test value; account-size correctness is covered above.
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
    const gm = getGameManager(program, wallet, db);

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

    let result: Awaited<ReturnType<typeof gm.createGame>>;
    try {
      // Attempt to create game - should fail but trigger JIT swap attempt
      result = await gm.createGame(
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
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("Unable to top up SOL balance automatically");
    expect(result!.error).not.toContain("Mock swap disabled");

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
      const gm = getGameManager(program, wallet, db);

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

  test("explains game funding with a concise shortfall and action", () => {
    resetGM();
    const wallet = makeWallet({});
    const gm = getGameManager(makeProgram(wallet.connection), wallet, {} as any);
    const plan = (gm as any).buildGameFundingPlan({
      currentSolLamports: 3_351_920,
      gameDepositLamports: 2_241_120,
      feeSafetyReserveLamports: 400_000,
      retainedWalletReserveLamports: 890_880,
      stakeRaw: 44_926_141_172,
      tokenBalanceRaw: 44_926_141_172,
    });

    const message = (gm as any).buildGameCreationShortfallMessage(plan, "44926.141172", "TIMBA");

    expect(message).toContain("You need about 0.000181 SOL more");
    expect(message).toContain("TIMBA balance only covers the stake");
    expect(message).toContain("Add SOL or create a smaller game");
    expect(message).not.toContain("Game deposit");
    expect(message).not.toContain("reserve");
    expect(message).not.toContain("SOL more SOL");
    resetGM();
  });
});
