import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";

const GAME = "BPFLoader1111111111111111111111111111111111";
const COMPLETED = "This game has already completed. Refresh to see the result.";

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  GameManager.resetForTest();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  GameManager.resetForTest();
});

describe("unjoinPlayerFromGame edge paths", () => {
  async function setup(options: {
    fetch?: () => Promise<any>;
    creator?: unknown;
    dbOverrides?: Record<string, unknown>;
    recover?: () => void;
  }) {
    const player = await Keypair.generate();
    const creator = await Keypair.generate();
    const gamePda = new PublicKey(GAME);
    const removed: any[][] = [];
    const savedMappings: any[][] = [];
    const db: any = {
      getGameParticipants: () => ["123"],
      getPlayerPublicKey: () => player.publicKey.toBase58(),
      getPlayerTelegramId: () => null,
      removeGameParticipant: (...args: any[]) => removed.push(args),
      savePlayerMapping: (...args: any[]) => savedMappings.push(args),
      ...options.dbOverrides,
    };
    const creatorValue = "creator" in options ? options.creator : creator.publicKey;
    const program = {
      account: {
        game: { fetch: options.fetch ?? (async () => ({ creator: creatorValue })) },
      },
      methods: {
        unjoinGame: () => ({
          accounts: () => ({ instruction: async () => ({ ix: "unjoin" }) }),
        }),
      },
    } as any;
    const gm = GameManager.getInstance(program, {} as any, db);
    (gm as any).recoverParticipantsFromChain = options.recover ?? (() => {});
    (gm as any).buildJoinAccounts = async () => ({ accounts: { game: gamePda } });
    const sends: any[][] = [];
    (gm as any).sendInstructionsWithFallback = async (...args: any[]) => {
      sends.push(args);
      return `SIG${sends.length}`;
    };
    (gm as any).confirmTransactionWithRecovery = async (signature: string) => signature;
    return { gm, player, creator, gamePda, removed, savedMappings, sends };
  }

  test("wraps a failing game account fetch with the game address and cause", async () => {
    const cause = new Error("rpc offline");
    const { gm, player, gamePda } = await setup({
      fetch: async () => {
        throw cause;
      },
    });

    const error = await (gm as any)
      .unjoinPlayerFromGame(gamePda, player, player.publicKey, "123")
      .catch((e: any) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Failed to fetch game account for ${GAME}: rpc offline`);
    expect(error.cause).toBe(cause);
  });

  test("stringifies non-Error fetch failures in the wrapped message", async () => {
    const { gm, player, gamePda } = await setup({
      fetch: async () => {
        throw "plain failure";
      },
    });

    await expect(
      (gm as any).unjoinPlayerFromGame(gamePda, player, player.publicKey, "123"),
    ).rejects.toThrow(`Failed to fetch game account for ${GAME}: plain failure`);
  });

  test("continues and warns when on-chain participant reconciliation fails", async () => {
    const failure = new Error("reconcile broke");
    const { gm, player, gamePda, sends, removed } = await setup({
      recover: () => {
        throw failure;
      },
    });

    await (gm as any).unjoinPlayerFromGame(gamePda, player, player.publicKey, "123");

    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Unable to reconcile on-chain participants for ${GAME}:`,
      failure,
    );
    expect(sends.length).toBe(1);
    expect(removed).toEqual([[GAME, "123"]]);
  });

  test("skipDbCheck persists a missing player mapping before unjoining", async () => {
    const { gm, player, gamePda, savedMappings, removed } = await setup({
      dbOverrides: { getPlayerPublicKey: () => "SomeOtherKey" },
    });

    await (gm as any).unjoinPlayerFromGame(gamePda, player, player.publicKey, "123", {
      skipDbCheck: true,
    });

    expect(savedMappings).toEqual([[player.publicKey.toBase58(), "123"]]);
    expect(removed).toEqual([[GAME, "123"]]);
  });

  test("skipDbCheck does not rewrite an already matching mapping", async () => {
    const { gm, player, gamePda, savedMappings } = await setup({});

    await (gm as any).unjoinPlayerFromGame(gamePda, player, player.publicKey, "123", {
      skipDbCheck: true,
    });

    expect(savedMappings).toEqual([]);
  });

  test("skipDbCheck warns but keeps going when persisting the mapping fails", async () => {
    const failure = new Error("db locked");
    const { gm, player, gamePda, sends } = await setup({
      dbOverrides: {
        getPlayerPublicKey: () => null,
        savePlayerMapping: () => {
          throw failure;
        },
      },
    });

    await (gm as any).unjoinPlayerFromGame(gamePda, player, player.publicKey, "123", {
      skipDbCheck: true,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "⚠️ Failed to persist mapping for 123 during cleanup:",
      failure,
    );
    expect(sends.length).toBe(1);
  });

  test("accepts a base58 string creator as the cleanup authority", async () => {
    const creatorKp = await Keypair.generate();
    const { gm, player, gamePda, sends } = await setup({
      creator: creatorKp.publicKey.toBase58(),
    });

    await (gm as any).unjoinPlayerFromGame(gamePda, creatorKp, player.publicKey, "123", {
      skipDbCheck: true,
    });

    expect(sends.length).toBe(1);
    expect(sends[0]![1]).toEqual([creatorKp]);
  });

  test("rejects a non-creator, non-player authority when the account has no creator", async () => {
    const impostor = await Keypair.generate();
    const { gm, player, gamePda, sends } = await setup({ creator: null });

    await expect(
      (gm as any).unjoinPlayerFromGame(gamePda, impostor, player.publicKey, "123", {
        skipDbCheck: true,
      }),
    ).rejects.toThrow(/Unauthorized unjoin attempt/);
    expect(sends).toEqual([]);
  });

  test("warns when removing the participant from the local DB fails", async () => {
    const failure = new Error("disk full");
    const { gm, player, gamePda, sends } = await setup({
      dbOverrides: {
        removeGameParticipant: () => {
          throw failure;
        },
      },
    });

    await (gm as any).unjoinPlayerFromGame(gamePda, player, player.publicKey, "123");

    expect(sends.length).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Failed to remove participant 123 from local DB for ${GAME}:`,
      failure,
    );
  });
});

describe("joinPrivateGame failure branches", () => {
  async function setup(options: {
    authorize?: () => Promise<any>;
    gameData?: any;
    gameApi?: any;
    sendTransaction?: (...args: any[]) => Promise<string>;
    setupInstructions?: unknown[];
    isPlayerInGame?: () => Promise<boolean>;
    confirm?: (...args: any[]) => Promise<string>;
  }) {
    const player = await Keypair.generate();
    const admin = await Keypair.generate();
    const program = {
      account: { game: options.gameApi ?? { fetchNullable: async () => ({ ok: 1 }) } },
      methods: {
        joinGame: () => ({ accounts: () => ({ instruction: async () => ({ ix: "join" }) }) }),
      },
    } as any;
    const wallet = {
      sendTransaction: options.sendTransaction ?? (async () => "SIG1"),
      getFriendlyErrorMessage: (error: any) => `friendly: ${error?.message}`,
    } as any;
    const db = {
      getGame: () => (options.gameData === undefined ? { token_mint: "mint" } : options.gameData),
    } as any;
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).oracleClient = {
      authorizePlayer:
        options.authorize ?? (async () => ({ authorized: true, operatorKeypair: admin })),
    };
    (gm as any).buildJoinAccounts = async () => ({
      accounts: { mock: true },
      setupInstructions: options.setupInstructions,
    });
    if (options.isPlayerInGame) (gm as any).isPlayerInGame = options.isPlayerInGame;
    (gm as any).confirmTransactionWithRecovery =
      options.confirm ?? (async (signature: string) => signature);
    const join = () => gm.joinPrivateGame(new PublicKey(GAME), player, 5, 9n);
    return { gm, join };
  }

  test("returns the oracle error when the player is not authorized", async () => {
    const { join } = await setup({
      authorize: async () => ({ authorized: false, error: "Challenge mismatch" }),
    });
    expect(await join()).toEqual({ success: false, error: "Challenge mismatch" });
  });

  test("falls back to a default message when authorization gives no reason", async () => {
    const { join } = await setup({ authorize: async () => ({ authorized: false }) });
    expect(await join()).toEqual({
      success: false,
      error: "Not authorized to join this private game",
    });
  });

  test("rejects games whose stored data lacks a token mint", async () => {
    const { join } = await setup({ gameData: { token_mint: null } });
    expect(await join()).toEqual({
      success: false,
      error: "Game data incomplete - token info missing",
    });
  });

  test("rejects when the game row is missing entirely", async () => {
    const { join } = await setup({ gameData: null });
    expect((await join()).error).toBe("Game data incomplete - token info missing");
  });

  test("uses fetch when fetchNullable is not available and joins", async () => {
    let fetchCalls = 0;
    const { join } = await setup({
      gameApi: {
        fetch: async () => {
          fetchCalls += 1;
          return { ok: 1 };
        },
      },
    });
    expect(await join()).toEqual({ success: true, tx: "SIG1" });
    expect(fetchCalls).toBe(1);
  });

  test("treats a missing-account fetch failure as a completed game", async () => {
    const { join } = await setup({
      gameApi: {
        fetch: async () => {
          throw new Error("Account does not exist abc");
        },
      },
    });
    expect(await join()).toEqual({ success: false, error: COMPLETED });
  });

  test("surfaces other fetch failures through the friendly error mapper", async () => {
    const { join } = await setup({
      gameApi: {
        fetchNullable: async () => {
          throw new Error("rpc exploded");
        },
      },
    });
    expect(await join()).toEqual({ success: false, error: "friendly: rpc exploded" });
    expect(errorSpy).toHaveBeenCalled();
  });

  test("returns the completed message when the game disappears before the retry", async () => {
    let loads = 0;
    const { join } = await setup({
      gameApi: {
        fetchNullable: async () => {
          loads += 1;
          return loads === 1 ? { ok: 1 } : null;
        },
      },
      sendTransaction: async () => {
        throw new Error("Transaction not confirmed in time");
      },
      isPlayerInGame: async () => false,
    });
    expect(await join()).toEqual({ success: false, error: COMPLETED });
    expect(loads).toBe(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  test("a failing membership check does not stop the retry", async () => {
    let sends = 0;
    const { join } = await setup({
      sendTransaction: async () => {
        sends += 1;
        if (sends === 1) throw new Error("timeout waiting for join");
        return "SIG_RETRY";
      },
      isPlayerInGame: async () => {
        throw new Error("lookup failed");
      },
    });
    expect(await join()).toEqual({ success: true, tx: "SIG_RETRY" });
    expect(sends).toBe(2);
  });

  test("returns success without resending when the player already joined", async () => {
    let sends = 0;
    const { join } = await setup({
      sendTransaction: async () => {
        sends += 1;
        throw new Error("blockhash expired before confirmation");
      },
      isPlayerInGame: async () => true,
    });
    expect(await join()).toEqual({ success: true, tx: undefined });
    expect(sends).toBe(1);
  });

  test("a missing account while sending maps to the completed message", async () => {
    const { join } = await setup({
      sendTransaction: async () => {
        throw new Error("Account does not exist");
      },
    });
    expect(await join()).toEqual({ success: false, error: COMPLETED });
  });

  for (const raw of [
    "AccountNotInitialized: associated token account",
    "AccountNotInitialized for player",
    "uninitialized account data",
  ]) {
    test(`wraps token account initialization failures (${raw})`, async () => {
      const { join } = await setup({
        setupInstructions: [{ ix: "create-ata" }],
        sendTransaction: async () => {
          throw new Error(raw);
        },
      });
      const result = await join();
      expect(result.success).toBe(false);
      expect(result.error).toBe(
        "friendly: Failed to initialize your token account for this game. Please try again or ensure you have enough SOL for fees.",
      );
    });
  }

  test("does not rewrite uninitialized errors when no setup instructions were needed", async () => {
    const { join } = await setup({
      sendTransaction: async () => {
        throw new Error("uninitialized account");
      },
    });
    expect(await join()).toEqual({ success: false, error: "friendly: uninitialized account" });
  });

  test("a second timeout on the last attempt is rethrown to the friendly mapper", async () => {
    let sends = 0;
    const { join } = await setup({
      sendTransaction: async () => {
        sends += 1;
        throw new Error("timeout again");
      },
      isPlayerInGame: async () => false,
    });
    expect(await join()).toEqual({ success: false, error: "friendly: timeout again" });
    expect(sends).toBe(2);
  });

  test("an oracle failure that reports a missing account maps to the expired message", async () => {
    const { join } = await setup({
      authorize: async () => {
        throw new Error("Account not found");
      },
    });
    expect(await join()).toEqual({ success: false, error: "Game not found or has expired." });
  });
});
