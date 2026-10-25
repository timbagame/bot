import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";
import { WSOL_MINT } from "../src/utils/constants";

const GAME_ADDRESS = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();
const STAKE = 1_000_000;
const SOL_BUFFER = 800_000;

let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  GameManager.resetForTest();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  GameManager.resetForTest();
});

type JoinOptions = {
  account?: Record<string, unknown>;
  fetch?: () => Promise<unknown>;
  gameRow?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
  db?: Record<string, unknown>;
  gm?: Record<string, unknown>;
  tokenBalances?: number[];
  solBalance?: number;
  setupInstructions?: unknown[];
};

async function setupJoin(options: JoinOptions = {}) {
  const playerKp = await Keypair.generate();
  const gameAccount = {
    isPrivate: false,
    ticketsCount: 0,
    maxTickets: 2,
    gameType: { coinflip: {} },
    ticketAmount: STAKE,
    ...options.account,
  };
  const program: any = {
    account: { game: { fetch: options.fetch ?? (async () => gameAccount) } },
    methods: {
      joinGame: () => ({
        accounts: () => ({ instruction: async () => ({ ix: "join" }) }),
      }),
    },
  };
  const tokenBalances = [...(options.tokenBalances ?? [2_000_000])];
  const getTokenBalance = vi.fn(async () =>
    tokenBalances.length > 1 ? tokenBalances.shift()! : tokenBalances[0]!,
  );
  const getBalance = vi.fn(async (_id: bigint, _opts?: { forceFresh?: boolean }) => {
    return options.solBalance ?? 5_000_000;
  });
  const wallet: any = {
    getKeyPair: async () => playerKp,
    getTokenMetadata: async () => ({ decimals: 6 }),
    getTokenBalance,
    getBalance,
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toString(),
    formatSolBalance: (lamports: number) => (lamports / 1_000_000_000).toString(),
    sendTransaction: vi.fn(async () => "JOIN_SIG"),
    clearCachedWalletData: vi.fn(),
    ...options.wallet,
  };
  const db: any = {
    getGame: () => ({
      status: "active",
      token_mint: "FakeMint",
      token_ticker: "TOK",
      ...options.gameRow,
    }),
    savePlayerMapping: vi.fn(),
    saveGameParticipant: vi.fn(),
    removeGameParticipant: vi.fn(),
    getGameParticipants: () => [],
    ...options.db,
  };
  const gm: any = GameManager.getInstance(program, wallet, db);
  gm.feeBudget = {
    getGameSafetyBufferLamports: async () => SOL_BUFFER,
    getWrapFeeBufferLamports: async () => 0,
  };
  gm.swapManager = { performJustInTimeSolSwap: vi.fn(async () => ({ swapped: false })) };
  gm.isPlayerInGame = vi.fn(async () => false);
  gm.buildJoinAccounts = vi.fn(async () => ({
    accounts: { game: GAME_ADDRESS },
    setupInstructions: options.setupInstructions ?? [],
  }));
  gm.confirmTransactionWithRecovery = vi.fn(async (signature: string) => signature);
  gm.verifyParticipantJoin = vi.fn(async () => true);
  Object.assign(gm, options.gm);
  return { gm, wallet, db, program, playerKp, getTokenBalance, getBalance };
}

describe("joinGame account fetch failures", () => {
  test("answers with the completion message when the account is reported missing", async () => {
    const { gm, wallet } = await setupJoin({
      fetch: async () => {
        throw new Error("Account does not exist or has no data");
      },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result).toEqual({
      success: false,
      error: "This game has already completed. Refresh to see the result.",
    });
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  test("reports other fetch failures as a friendly error and untracks the player", async () => {
    const { gm, db } = await setupJoin({
      fetch: async () => {
        throw new Error("rpc exploded");
      },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 7n);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Something went wrong");
    expect(db.removeGameParticipant).toHaveBeenCalledWith(GAME_ADDRESS, "7");
    expect(errorSpy).toHaveBeenCalledWith(
      `Error joining game ${GAME_ADDRESS}:`,
      expect.objectContaining({ message: "rpc exploded" }),
    );
  });

  test("still answers when untracking the player fails during cleanup", async () => {
    const { gm, db } = await setupJoin({
      fetch: async () => {
        throw new Error("rpc exploded");
      },
      db: {
        removeGameParticipant: vi.fn(() => {
          throw new Error("database locked");
        }),
      },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 7n);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Something went wrong");
    expect(db.removeGameParticipant).toHaveBeenCalledTimes(1);
  });
});

describe("joinGame SOL-backed games", () => {
  test("uses the balances left by wrapping SOL instead of swapping again", async () => {
    const ensureWrappedSolBalance = vi.fn(async () => ({
      success: true,
      tokenBalance: STAKE,
      solBalance: SOL_BUFFER + 1,
    }));
    const { gm, wallet } = await setupJoin({
      gameRow: { token_mint: WSOL_MINT, token_ticker: "WSOL" },
      tokenBalances: [0],
      solBalance: 100,
      gm: { ensureWrappedSolBalance },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result.success).toBe(true);
    expect(ensureWrappedSolBalance).toHaveBeenCalledWith(1n, STAKE, 0, 100, "join");
    // Wrapping left enough SOL for fees, so no swap is attempted.
    expect(gm.swapManager.performJustInTimeSolSwap).not.toHaveBeenCalled();
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("joinGame just-in-time SOL swap", () => {
  const swapped = () => ({
    swapManager: { performJustInTimeSolSwap: vi.fn(async () => ({ swapped: true })) },
  });

  test("joins after a swap that leaves the stake and fee reserve intact", async () => {
    const getBalance = vi.fn(async (_id: bigint, opts?: { forceFresh?: boolean }) =>
      opts?.forceFresh ? SOL_BUFFER + 10 : 100_000,
    );
    const { gm, wallet } = await setupJoin({
      solBalance: 100_000,
      wallet: { getBalance },
      tokenBalances: [2_000_000, 1_500_000],
      gm: swapped(),
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result.success).toBe(true);
    expect(gm.swapManager.performJustInTimeSolSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenMint: "FakeMint",
        availableTokenAmountRaw: 1_000_000,
        desiredLamports: SOL_BUFFER,
      }),
    );
    expect(wallet.clearCachedWalletData).toHaveBeenCalledWith(1n);
    expect(getBalance).toHaveBeenLastCalledWith(1n, { forceFresh: true });
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  test("stops when the swap leaves fewer tokens than the stake", async () => {
    const { gm, wallet } = await setupJoin({
      solBalance: 100_000,
      tokenBalances: [2_000_000, 900_000],
      gm: swapped(),
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result).toEqual({
      success: false,
      error:
        "Swap completed but only 0.9 TOK remain, which is below the required 1. Please top up your tokens and try again.",
    });
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  test("does not require tokens after a swap in a giveaway", async () => {
    const getBalance = vi.fn(async (_id: bigint, opts?: { forceFresh?: boolean }) =>
      opts?.forceFresh ? SOL_BUFFER + 10 : 100_000,
    );
    const { gm, wallet } = await setupJoin({
      account: { gameType: { giveaway: {} }, ticketAmount: STAKE },
      solBalance: 100_000,
      wallet: { getBalance },
      tokenBalances: [2_000_000, 10],
      gm: swapped(),
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result.success).toBe(true);
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  test("explains the missing SOL when the swap still leaves too little", async () => {
    const getBalance = vi.fn(async (_id: bigint, opts?: { forceFresh?: boolean }) =>
      opts?.forceFresh ? 300_000 : 100_000,
    );
    const { gm, wallet } = await setupJoin({
      solBalance: 100_000,
      wallet: { getBalance },
      tokenBalances: [2_000_000],
      gm: swapped(),
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result.success).toBe(false);
    expect(result.error).toContain("You need about 0.0005 SOL more to join this game.");
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("joinGame participant bookkeeping", () => {
  test("remembers a trimmed display name and saves it with the player mapping", async () => {
    const { gm, db, playerKp } = await setupJoin();
    const result = await gm.joinGame(GAME_ADDRESS, 12n, 99, "  Alice Fake  ");
    expect(result.success).toBe(true);
    expect(gm.usernameHints.get("12")).toBe("Alice Fake");
    expect(db.savePlayerMapping).toHaveBeenCalledWith(
      playerKp.publicKey.toBase58(),
      "12",
      "Alice Fake",
    );
  });

  test("ignores a blank display name", async () => {
    const { gm, db, playerKp } = await setupJoin();
    const result = await gm.joinGame(GAME_ADDRESS, 12n, 99, "   ");
    expect(result.success).toBe(true);
    expect(gm.usernameHints.has("12")).toBe(false);
    expect(db.savePlayerMapping).toHaveBeenCalledWith(playerKp.publicKey.toBase58(), "12");
  });

  test("records a private join as pending with the signature returned by the join helper", async () => {
    const joinPrivateGame = vi.fn(async () => ({ success: true, tx: "PRIVATE_SIG" }));
    const { gm, db, wallet, playerKp } = await setupJoin({
      account: { isPrivate: true },
      gm: { joinPrivateGame },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 12n, 99);
    expect(result.success).toBe(true);
    expect(joinPrivateGame).toHaveBeenCalledWith(new PublicKey(GAME_ADDRESS), playerKp, 99, 12n);
    expect(db.saveGameParticipant).toHaveBeenCalledWith(
      GAME_ADDRESS,
      "12",
      playerKp.publicKey.toBase58(),
      { status: "pending", joinSignature: "PRIVATE_SIG", lastVerifiedAt: null },
    );
    expect(gm.verifyParticipantJoin).toHaveBeenCalledWith(
      new PublicKey(GAME_ADDRESS),
      playerKp.publicKey,
      "12",
      { joinSignature: "PRIVATE_SIG" },
    );
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("joinGame retry after a confirmation timeout", () => {
  test("tolerates a failing membership probe and retries the join", async () => {
    let probes = 0;
    const isPlayerInGame = vi.fn(async () => {
      probes += 1;
      if (probes === 1) return false;
      throw new Error("probe unavailable");
    });
    let confirmations = 0;
    const confirmTransactionWithRecovery = vi.fn(async (signature: string) => {
      confirmations += 1;
      if (confirmations === 1) throw new Error("Transaction not confirmed: timeout");
      return signature;
    });
    const { gm, wallet } = await setupJoin({
      gm: { isPlayerInGame, confirmTransactionWithRecovery },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result.success).toBe(true);
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Player join attempt 1 for ${GAME_ADDRESS} timed out; retrying with a fresh blockhash.`,
    );
  });

  test("accepts the join without resending when the player turns out to be in the game", async () => {
    let probes = 0;
    const isPlayerInGame = vi.fn(async () => {
      probes += 1;
      return probes > 1;
    });
    const confirmTransactionWithRecovery = vi.fn(async () => {
      throw new Error("timeout waiting for confirmation");
    });
    const { gm, wallet, db } = await setupJoin({
      gm: { isPlayerInGame, confirmTransactionWithRecovery },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result.success).toBe(true);
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
    expect(gm.verifyParticipantJoin).toHaveBeenCalledTimes(1);
    expect(db.removeGameParticipant).not.toHaveBeenCalled();
  });

  test("explains a token account that could not be initialised", async () => {
    const confirmTransactionWithRecovery = vi.fn(async () => {
      throw new Error("Associated token account not initialized");
    });
    const { gm, db } = await setupJoin({
      setupInstructions: [{ ix: "create-ata" }],
      gm: { confirmTransactionWithRecovery },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result.success).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      `Error joining game ${GAME_ADDRESS}:`,
      expect.objectContaining({
        message: expect.stringContaining("Failed to initialize your token account"),
        cause: expect.objectContaining({ message: "Associated token account not initialized" }),
      }),
    );
    expect(db.removeGameParticipant).toHaveBeenCalledWith(GAME_ADDRESS, "1");
  });

  test("rethrows an unrelated send failure as a friendly error", async () => {
    const confirmTransactionWithRecovery = vi.fn(async () => {
      throw new Error("blockhash expired somewhere");
    });
    const { gm, db } = await setupJoin({
      setupInstructions: [{ ix: "create-ata" }],
      gm: { confirmTransactionWithRecovery },
    });
    const result = await gm.joinGame(GAME_ADDRESS, 1n);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Something went wrong");
    expect(errorSpy).toHaveBeenCalledWith(
      `Error joining game ${GAME_ADDRESS}:`,
      expect.objectContaining({ message: "blockhash expired somewhere" }),
    );
    expect(db.removeGameParticipant).toHaveBeenCalledWith(GAME_ADDRESS, "1");
  });
});

describe("unjoinGame", () => {
  async function setupUnjoin(options: { game?: unknown; inGame?: boolean } = {}) {
    const playerKp = await Keypair.generate();
    const db: any = {
      getGame: vi.fn(() => ("game" in options ? options.game : { status: "active" })),
    };
    const wallet: any = { getKeyPair: vi.fn(async () => playerKp) };
    const gm: any = GameManager.getInstance({} as any, wallet, db);
    gm.isPlayerInGame = vi.fn(async () => options.inGame ?? true);
    gm.unjoinPlayerFromGame = vi.fn(async () => undefined);
    return { gm, db, wallet, playerKp };
  }

  test("reports an unknown game without touching the chain", async () => {
    const { gm } = await setupUnjoin({ game: null });
    expect(await gm.unjoinGame(GAME_ADDRESS, 5n)).toEqual({
      success: false,
      error: "Game not found!",
    });
    expect(gm.isPlayerInGame).not.toHaveBeenCalled();
    expect(gm.unjoinPlayerFromGame).not.toHaveBeenCalled();
  });

  test("unjoins the player with their own key", async () => {
    const { gm, playerKp } = await setupUnjoin();
    expect(await gm.unjoinGame(GAME_ADDRESS, 5n)).toEqual({ success: true });
    expect(gm.unjoinPlayerFromGame).toHaveBeenCalledWith(
      new PublicKey(GAME_ADDRESS),
      playerKp,
      playerKp.publicKey,
      "5",
    );
  });

  test("turns an unjoin failure into a friendly error", async () => {
    const { gm } = await setupUnjoin();
    gm.unjoinPlayerFromGame = vi.fn(async () => {
      throw new Error("unjoin transaction failed");
    });
    const result = await gm.unjoinGame(GAME_ADDRESS, 5n);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Something went wrong");
    expect(errorSpy).toHaveBeenCalledWith(
      `Error unjoining game ${GAME_ADDRESS}:`,
      expect.objectContaining({ message: "unjoin transaction failed" }),
    );
  });
});

describe("unjoinPlayerFromGame account fetch", () => {
  test("wraps a failed game account read with its cause", async () => {
    const playerKp = await Keypair.generate();
    const failure = new Error("rpc exploded");
    const program: any = {
      account: {
        game: {
          fetch: async () => {
            throw failure;
          },
        },
      },
    };
    const db: any = {
      getGameParticipants: () => ["123"],
      getPlayerPublicKey: () => playerKp.publicKey.toBase58(),
    };
    const gm: any = GameManager.getInstance(program, {} as any, db);
    const error = await gm
      .unjoinPlayerFromGame(new PublicKey(GAME_ADDRESS), playerKp, playerKp.publicKey, "123")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Failed to fetch game account for ${GAME_ADDRESS}: rpc exploded`,
    );
    expect((error as Error).cause).toBe(failure);
  });
});
