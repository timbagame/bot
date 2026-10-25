import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";
import { DEFAULT_TOKEN_TICKER, WSOL_MINT } from "../src/utils/constants";

const GAME = "BPFLoader9999999999999999999999999999999999";
const CREATOR = "BPFLoader1111111111111111111111111111111111";
const PLAYER = "BPFLoader2111111111111111111111111111111111";

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

function warned(fragment: string): boolean {
  return warnSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(fragment));
}

function errored(fragment: string): boolean {
  return errorSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes(fragment));
}

function makeManager(db: Record<string, unknown>, program?: unknown, wallet?: unknown) {
  return GameManager.getInstance(
    (program ?? { account: { game: { fetch: async () => ({}) } } }) as any,
    (wallet ?? {}) as any,
    db as any,
  ) as any;
}

describe("processActiveGames", () => {
  test("drops rows without an address or with an invalid address", async () => {
    const gm = makeManager({});
    gm.getGameInfo = async (_ctx: unknown, pda: PublicKey) => `info:${pda.toBase58()}`;

    const result = await gm.processActiveGames({} as any, [
      { game_address: "" },
      { game_address: "not-a-key" },
      { game_address: GAME },
    ]);

    expect(result).toEqual([`info:${GAME}`]);
    expect(errored("Game data missing address")).toBe(true);
    expect(errored("Invalid game address format")).toBe(true);
  });

  test("drops a game whose info lookup throws synchronously", async () => {
    const gm = makeManager({});
    gm.getGameInfo = (_ctx: unknown, pda: PublicKey) => {
      if (pda.toBase58() === GAME) throw new Error("boom");
      return Promise.resolve("ok");
    };

    const result = await gm.processActiveGames({} as any, [
      { game_address: GAME },
      { game_address: CREATOR },
    ]);

    expect(result).toEqual(["ok"]);
    expect(
      errorSpy.mock.calls.some((c: unknown[]) =>
        String(c[0]).startsWith("Error fetching game " + GAME),
      ),
    ).toBe(true);
  });
});

describe("reloadGameMessages", () => {
  test("restores per-chat messages from the message table", async () => {
    const gm = makeManager({
      getAllGames: () => [{ game_address: GAME, message_id: 1, chat_id: 1 }],
      getGameMessages: () => [
        { chatId: 10, messageId: 100 },
        { chatId: 11, messageId: 101 },
      ],
    });

    await gm.reloadGameMessages();

    const map = gm.activeGameMessages.get(GAME) as Map<number, unknown>;
    expect([...map.entries()]).toEqual([
      [10, { messageId: 100, chatId: 10, usesVideo: true }],
      [11, { messageId: 101, chatId: 11, usesVideo: true }],
    ]);
  });

  test("logs and survives a failing message lookup", async () => {
    const gm = makeManager({
      getAllGames: () => [{ game_address: GAME }],
      getGameMessages: () => {
        throw new Error("db locked");
      },
    });

    await gm.reloadGameMessages();

    expect(errored("Error reloading game messages:")).toBe(true);
    expect(gm.activeGameMessages.has(GAME)).toBe(false);
  });
});

describe("blockchain scan error handling", () => {
  test("scanBlockchainForOrphanedGames logs a failed scan instead of throwing", async () => {
    const gm = makeManager({});
    gm.findOrphanedGames = async () => {
      throw new Error("scan failed");
    };

    await gm.scanBlockchainForOrphanedGames();

    expect(errored("Error during blockchain scan")).toBe(true);
  });

  test("findOrphanedGames returns an empty list when the program query fails", async () => {
    const gm = makeManager(
      {},
      {
        account: {
          game: {
            all: async () => {
              throw new Error("rpc down");
            },
          },
        },
      },
    );

    expect(await gm.findOrphanedGames()).toEqual([]);
    expect(errored("Error scanning for orphaned games:")).toBe(true);
  });

  const nowSec = () => Math.floor(Date.now() / 1000);

  test("cancelOrphanedGame skips games that have not expired", async () => {
    const gm = makeManager(
      {},
      { account: { game: { fetch: async () => ({ createdAt: nowSec(), timeout: 3600 }) } } },
    );
    gm.handleExpiredCoinflip = async () => {
      throw new Error("must not run");
    };

    expect(await gm.cancelOrphanedGame(GAME)).toBe(false);
  });

  test("cancelOrphanedGame waits for the oracle when the game has enough tickets", async () => {
    const gm = makeManager(
      {},
      {
        account: {
          game: {
            fetch: async () => ({
              createdAt: nowSec() - 100,
              timeout: 10,
              ticketsCount: 2,
              minTickets: 2,
              maxTickets: 2,
              gameType: { coinflip: {} },
            }),
          },
        },
      },
    );
    gm.handleExpiredCoinflip = async () => {
      throw new Error("must not run");
    };

    expect(await gm.cancelOrphanedGame(GAME)).toBe(false);
  });
});

describe("handleExpiredCoinflip bookkeeping", () => {
  function makeCoinflip(db: Record<string, unknown>, info: Record<string, unknown> = {}) {
    const gm = makeManager({
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
      ...db,
    });
    gm.reconcilePendingParticipants = async () => {};
    gm.analyzePlayerKeys = () => ({
      available: [],
      unavailable: [],
      nonCreators: [],
      creator: undefined,
      canCompleteCleanup: false,
      total: 0,
      onChainTickets: undefined,
      onChainParticipants: undefined,
      dbParticipantCount: undefined,
      unmatchedParticipants: [],
      ...info,
    });
    const cancelled: unknown[][] = [];
    gm.cancelGameWithCreator = async (...args: unknown[]) => {
      cancelled.push(args);
      return true;
    };
    return { gm, cancelled };
  }

  test("warns about ticket versus participant-list and database mismatches", async () => {
    const { gm } = makeCoinflip(
      {},
      { onChainTickets: 3, onChainParticipants: 2, dbParticipantCount: 1 },
    );
    gm.executePartialCleanup = async () => "partial";

    const result = await gm.handleExpiredCoinflip(
      new PublicKey(GAME),
      { ticketsCount: 3, participants: [1, 2], creator: new PublicKey(CREATOR) },
      GAME,
    );

    expect(result).toBe("partial");
    expect(
      warned(`Participant mismatch for ${GAME}: on-chain tickets 3, participant list length 2`),
    ).toBe(true);
    expect(warned(`Database mismatch for ${GAME}: on-chain tickets 3, local participants 1`)).toBe(
      true,
    );
  });

  test("warns about unmapped participants and runs the complete cleanup when possible", async () => {
    const { gm } = makeCoinflip(
      {},
      {
        onChainTickets: 2,
        onChainParticipants: 2,
        dbParticipantCount: 2,
        unmatchedParticipants: ["x", "y"],
        canCompleteCleanup: true,
      },
    );
    gm.executeCompleteCleanup = async () => "complete";

    const result = await gm.handleExpiredCoinflip(
      new PublicKey(GAME),
      { ticketsCount: 2, participants: [1, 2], creator: new PublicKey(CREATOR) },
      GAME,
    );

    expect(result).toBe("complete");
    expect(warned(`Unable to map 2 participant(s) for ${GAME}`)).toBe(true);
  });

  test("keeps cancelling when removing a stale participant fails", async () => {
    const removed: string[] = [];
    const { gm, cancelled } = makeCoinflip({
      getGameParticipants: () => ["1", "2"],
      removeGameParticipant: (_addr: string, id: string) => {
        if (id === "1") throw new Error("locked");
        removed.push(id);
      },
      getCreatorTelegramId: () => "77",
    });

    const result = await gm.handleExpiredCoinflip(
      new PublicKey(GAME),
      { ticketsCount: 0, participants: [], creator: new PublicKey(CREATOR) },
      GAME,
    );

    expect(result).toBe(true);
    expect(removed).toEqual(["2"]);
    expect(warned("Failed to remove participant 1 from local DB")).toBe(true);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.slice(2)).toEqual(["77", GAME, "coinflip"]);
  });

  test("resolves the creator from the player mapping when the game row has none", async () => {
    const lookups: string[] = [];
    const { gm, cancelled } = makeCoinflip({
      getCreatorTelegramId: () => null,
      getPlayerTelegramId: (pubkey: string) => {
        lookups.push(pubkey);
        return "88";
      },
    });

    // A base58 string creator is converted to a PublicKey first.
    const result = await gm.handleExpiredCoinflip(
      new PublicKey(GAME),
      { ticketsCount: 0, participants: [], creator: CREATOR },
      GAME,
    );

    expect(result).toBe(true);
    expect(lookups).toEqual([CREATOR]);
    expect(cancelled[0]![2]).toBe("88");
  });

  test("falls back to the stored creator info", async () => {
    const { gm, cancelled } = makeCoinflip({
      getCreatorTelegramId: undefined,
      getPlayerTelegramId: undefined,
      getCreatorInfo: () => ({ telegramId: "99" }),
    });

    const result = await gm.handleExpiredCoinflip(
      new PublicKey(GAME),
      { ticketsCount: 0, participants: [], creator: new PublicKey(CREATOR) },
      GAME,
    );

    expect(result).toBe(true);
    expect(cancelled[0]![2]).toBe("99");
  });

  test("refuses to cancel when no source knows the creator", async () => {
    const { gm, cancelled } = makeCoinflip({
      getCreatorInfo: () => ({ telegramId: null }),
    });

    const result = await gm.handleExpiredCoinflip(
      new PublicKey(GAME),
      { ticketsCount: 0, participants: [], creator: "not-a-public-key" },
      GAME,
    );

    expect(result).toBe(false);
    expect(cancelled).toEqual([]);
    expect(warned(`Cannot cancel ${GAME}: creator Telegram ID is missing`)).toBe(true);
  });
});

describe("analyzePlayerKeys", () => {
  function makeAnalyzer(db: Record<string, unknown>, unmatched: string[] = []) {
    const gm = makeManager({
      getGameParticipants: () => [],
      getPlayerTelegramId: () => null,
      getPlayerPublicKey: () => null,
      ...db,
    });
    gm.recoverParticipantsFromChain = () => ({ recovered: [], unmatchedParticipants: unmatched });
    return gm;
  }

  test("logs and carries on when the creator lookup throws", () => {
    const gm = makeAnalyzer({
      getPlayerTelegramId: () => {
        throw new Error("db closed");
      },
    });

    const info = gm.analyzePlayerKeys(
      new PublicKey(GAME),
      { ticketsCount: 1, participants: [], creator: new PublicKey(CREATOR) },
      GAME,
    );

    expect(warned(`Failed to look up creator Telegram ID for ${GAME}`)).toBe(true);
    // The creator has no Telegram ID, so it is reported as unavailable.
    expect(info.unavailable).toEqual([CREATOR]);
    expect(info.canCompleteCleanup).toBe(false);
    expect(info.total).toBe(1);
  });

  test("marks a participant with a malformed stored key as unavailable", () => {
    const gm = makeAnalyzer({
      getGameParticipants: () => ["5"],
      getPlayerPublicKey: (id: string) => (id === "5" ? "definitely-not-base58!" : null),
    });

    const info = gm.analyzePlayerKeys(
      new PublicKey(GAME),
      { ticketsCount: 1, participants: [], creator: new PublicKey(CREATOR) },
      GAME,
    );

    expect(info.unavailable).toContain("5");
    expect(info.available).toEqual([]);
  });

  test("adds the creator from the on-chain account when their stored key is missing", () => {
    const gm = makeAnalyzer({
      getPlayerTelegramId: (pubkey: string) => (pubkey === CREATOR ? "7" : null),
      getPlayerPublicKey: () => null,
    });

    const info = gm.analyzePlayerKeys(
      new PublicKey(GAME),
      { ticketsCount: 1, participants: [], creator: new PublicKey(CREATOR) },
      GAME,
    );

    expect(info.creator?.telegramId).toBe("7");
    expect(info.creator?.pubkey.toBase58()).toBe(CREATOR);
    expect(info.creator?.isCreator).toBe(true);
    expect(info.available).toHaveLength(1);
    // The creator's stored key was missing, so they are also listed as unavailable.
    expect(info.unavailable).toEqual(["7"]);
    expect(info.canCompleteCleanup).toBe(false);
  });

  test("reports unmatched on-chain participants as unavailable", () => {
    const gm = makeAnalyzer({}, ["UnmatchedA", "UnmatchedB"]);

    const info = gm.analyzePlayerKeys(
      new PublicKey(GAME),
      { ticketsCount: 2, participants: [1, 2], creator: new PublicKey(CREATOR) },
      GAME,
    );

    expect(info.unmatchedParticipants).toEqual(["UnmatchedA", "UnmatchedB"]);
    expect(info.unavailable).toEqual([CREATOR, "UnmatchedA", "UnmatchedB"]);
    expect(info.onChainParticipants).toBe(2);
    expect(info.total).toBe(2);
  });
});

describe("unjoinPlayers edge paths", () => {
  type Player = { telegramId: string; pubkey: PublicKey; isCreator: boolean };
  const player = (telegramId: string, address: string, isCreator = false): Player => ({
    telegramId,
    pubkey: new PublicKey(address),
    isCreator,
  });

  function setup(options: {
    wallet?: Record<string, unknown>;
    game?: unknown;
    prepare?: (args: any) => Promise<{ success: boolean; reason?: string }>;
    unjoin?: (...args: any[]) => Promise<void>;
  }) {
    const gm = makeManager({ getGame: () => options.game ?? null }, undefined, {
      getTokenMetadata: async () => ({ decimals: 6 }),
      getKeyPair: async () => Keypair.generate(),
      ...options.wallet,
    });
    const prepareCalls: any[] = [];
    gm.ensureUnjoinFeePayerBalance = async (args: any) => {
      prepareCalls.push(args);
      return options.prepare ? options.prepare(args) : { success: true };
    };
    const unjoinCalls: any[][] = [];
    gm.unjoinPlayerFromGame = async (...args: any[]) => {
      unjoinCalls.push(args);
      if (options.unjoin) await options.unjoin(...args);
    };
    return { gm, prepareCalls, unjoinCalls };
  }

  const pda = new PublicKey(GAME);

  test("resolves the token mint from every supported shape", async () => {
    const seen: string[] = [];
    const wallet = {
      getTokenMetadata: async (mint: string) => {
        seen.push(mint);
        return { decimals: 9 };
      },
    };
    const mints: unknown[] = [
      new PublicKey(WSOL_MINT),
      { toBase58: () => "FromToBase58" },
      {
        toBase58: () => {
          throw new Error("nope");
        },
        toString: () => "FromToString",
      },
      Object.assign(Object.create(null), { marker: true }),
      {
        toString: () => {
          throw new Error("nope");
        },
      },
      undefined,
    ];

    for (const tokenMint of mints) {
      const { gm } = setup({ wallet });
      await gm.unjoinPlayers(pda, { tokenMint }, []);
    }

    expect(seen).toEqual([WSOL_MINT, "FromToBase58", "FromToString"]);
  });

  test("keeps going when token metadata cannot be loaded", async () => {
    const { gm, unjoinCalls } = setup({
      wallet: {
        getTokenMetadata: async () => {
          throw new Error("metadata offline");
        },
      },
    });

    const count = await gm.unjoinPlayers(pda, { tokenMint: WSOL_MINT }, [player("1", PLAYER)]);

    expect(count).toBe(1);
    expect(unjoinCalls).toHaveLength(1);
    expect(warned(`Failed to load token metadata for ${WSOL_MINT} during unjoin cleanup`)).toBe(
      true,
    );
  });

  test("picks the ticker from the database row, WSOL, or the default", async () => {
    const tickers: string[] = [];
    const run = async (game: unknown, tokenMint: string) => {
      const { gm, prepareCalls } = setup({ game });
      await gm.unjoinPlayers(pda, { tokenMint }, [player("1", PLAYER)]);
      tickers.push(prepareCalls[0].tokenTicker);
    };

    await run({ token_ticker: " bonk " }, "SomeMint");
    await run({ token_ticker: "   " }, WSOL_MINT);
    await run(null, WSOL_MINT);
    await run(null, "SomeMint");

    expect(tickers).toEqual([" BONK ", "SOL", "SOL", DEFAULT_TOKEN_TICKER.toUpperCase()]);
  });

  test("reports a player without a signing authority and tries the creator", async () => {
    const creatorKey = await Keypair.generate();
    const { gm, unjoinCalls } = setup({
      wallet: {
        getKeyPair: async (id: bigint) => {
          if (id === 1n) return creatorKey;
          throw new Error("no key");
        },
      },
    });

    const count = await gm.unjoinPlayers(
      pda,
      { tokenMint: WSOL_MINT },
      [player("404", PLAYER)],
      "1",
    );

    expect(count).toBe(1);
    expect(errored(`Failed to unjoin ${PLAYER}: missing signing authority`)).toBe(true);
    expect(unjoinCalls[0]![1]).toBe(creatorKey);
  });

  test("tries the player anyway when there is no creator fallback", async () => {
    const { gm, unjoinCalls } = setup({
      prepare: async () => ({ success: false, reason: "no sol" }),
    });

    const count = await gm.unjoinPlayers(pda, { tokenMint: WSOL_MINT }, [player("1", PLAYER)]);

    expect(count).toBe(1);
    expect(unjoinCalls).toHaveLength(1);
    expect(warned("Attempting with remaining balance.")).toBe(true);
  });

  test("falls back to the creator after the player's own unjoin fails", async () => {
    const creatorKey = await Keypair.generate();
    const playerKey = await Keypair.generate();
    const { gm, unjoinCalls, prepareCalls } = setup({
      wallet: { getKeyPair: async (id: bigint) => (id === 1n ? creatorKey : playerKey) },
      prepare: async (args) =>
        args.telegramId === "1" ? { success: false, reason: "creator broke" } : { success: true },
      unjoin: async (_pda: PublicKey, authority: Keypair) => {
        if (authority === playerKey) throw new Error("player tx failed");
      },
    });

    const count = await gm.unjoinPlayers(pda, { tokenMint: WSOL_MINT }, [player("2", PLAYER)], "1");

    expect(count).toBe(1);
    expect(unjoinCalls.map((call) => call[1])).toEqual([playerKey, creatorKey]);
    expect(prepareCalls.map((call) => call.telegramId)).toEqual(["2", "1"]);
    expect(errored(`Failed to unjoin ${PLAYER} with player authority:`)).toBe(true);
    expect(warned("Creator fallback lacks SOL for unjoin: creator broke")).toBe(true);
  });

  test("does not count a player when both the player and creator unjoin fail", async () => {
    const { gm, unjoinCalls } = setup({
      unjoin: async () => {
        throw new Error("rpc rejected");
      },
    });

    const count = await gm.unjoinPlayers(pda, { tokenMint: WSOL_MINT }, [player("2", PLAYER)], "1");

    expect(count).toBe(0);
    expect(unjoinCalls).toHaveLength(2);
    expect(errored(`Failed to unjoin ${PLAYER} using creator authority:`)).toBe(true);
  });
});
