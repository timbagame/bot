import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GameManager } from "../src/utils/game";

const GAME = "BPFLoader1111111111111111111111111111111111";
const CREATOR = "11111111111111111111111111111112";
const MINT = "So11111111111111111111111111111111111111112";

let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  GameManager.resetForTest();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  GameManager.resetForTest();
});

function makeManager(options: {
  account?: any;
  db?: Record<string, unknown>;
  wallet?: Record<string, unknown>;
}) {
  const now = Math.floor(Date.now() / 1000);
  const account =
    options.account === undefined
      ? {
          tokenMint: MINT,
          creator: CREATOR,
          createdAt: now,
          timeout: 3600,
          ticketAmount: 250,
          maxTickets: 4,
          minTickets: 2,
          gameType: { coinflip: {} },
        }
      : options.account;
  const gm = GameManager.getInstance(
    { account: { game: { fetch: async () => account } } } as any,
    { getTokenMetadata: async () => ({ symbol: "SOL" }), ...options.wallet } as any,
    options.db as any,
  );
  (gm as any).fetchGameAccountForRecovery = async () => account;
  return { gm, account, now };
}

describe("hydrateGameDataFromChain fallbacks", () => {
  test("accepts a string token mint, tolerates metadata failure and string creators", async () => {
    const saved: any[][] = [];
    const { gm, now } = makeManager({
      wallet: {
        getTokenMetadata: async () => {
          throw new Error("metadata offline");
        },
      },
      db: { saveGame: (...args: any[]) => saved.push(args) },
    });

    const result = await gm.ensureGameDataFromChain(GAME);

    expect(result).toMatchObject({
      game_address: GAME,
      creator_telegram_id: CREATOR,
      token_mint: MINT,
      amount: 250,
      game_type: "coinflip",
      status: "active",
      max_players: 4,
      min_players: 2,
      timeout_seconds: 3600,
      created_at: now * 1000,
      expires_at: (now + 3600) * 1000,
    });
    // Falls back to the default ticker because the metadata lookup failed.
    expect(result!.token_ticker).not.toBe("SOL");
    expect(saved).toHaveLength(1);
    expect(saved[0]![0]).toBe(GAME);
    expect(saved[0]![1]).toBe(CREATOR);
    expect(saved[0]![4]).toBe(MINT);
  });

  test("stringifies a missing creator and still hydrates", async () => {
    const { gm } = makeManager({
      account: { tokenMint: MINT, creator: undefined, ticketAmount: 5 },
      db: {},
    });

    const result = await gm.ensureGameDataFromChain(GAME);

    expect(result!.creator_telegram_id).toBe("unknown");
    expect(result!.amount).toBe(5);
    expect(result!.timeout_seconds).toBeUndefined();
    expect(result!.expires_at).toBeUndefined();
  });

  test("warns but continues when persisting the creator mapping fails", async () => {
    const failure = new Error("mapping write failed");
    const { gm } = makeManager({
      db: {
        savePlayerMapping: () => {
          throw failure;
        },
      },
    });

    const result = await gm.ensureGameDataFromChain(GAME);

    expect(result!.creator_telegram_id).toBe(CREATOR);
    expect(warnSpy).toHaveBeenCalledWith(
      `Failed to persist creator mapping for hydrated game ${GAME}:`,
      failure,
    );
  });

  test("warns but returns the hydrated data when saving the game fails", async () => {
    const failure = new Error("db readonly");
    const { gm } = makeManager({
      db: {
        saveGame: () => {
          throw failure;
        },
      },
    });

    const result = await gm.ensureGameDataFromChain(GAME);

    expect(result!.game_address).toBe(GAME);
    expect(warnSpy).toHaveBeenCalledWith(`Failed to hydrate game ${GAME} into local DB:`, failure);
  });

  test("prefers the stored row but falls back to hydrated data when reading it back throws", async () => {
    let reads = 0;
    const { gm } = makeManager({
      db: {
        getGame: () => {
          reads += 1;
          if (reads === 1) return null;
          throw new Error("read failed");
        },
        saveGame: () => {},
      },
    });

    const result = await gm.ensureGameDataFromChain(GAME);

    expect(reads).toBe(2);
    expect(result!.game_address).toBe(GAME);
    expect(result!.status).toBe("active");
  });

  test("returns the stored row after hydration when one exists", async () => {
    const stored = { game_address: GAME, status: "active", marker: "stored" };
    let reads = 0;
    const { gm } = makeManager({
      db: {
        getGame: () => {
          reads += 1;
          return reads === 1 ? null : stored;
        },
        saveGame: () => {},
      },
    });

    expect(await gm.ensureGameDataFromChain(GAME)).toBe(stored as any);
  });

  test("returns null when the token mint cannot be resolved", async () => {
    const { gm } = makeManager({ account: { tokenMint: 42, creator: CREATOR }, db: {} });
    expect(await gm.ensureGameDataFromChain(GAME)).toBeNull();
  });

  test("returns null when the game account no longer exists", async () => {
    const { gm } = makeManager({ account: null, db: {} });
    expect(await gm.ensureGameDataFromChain(GAME)).toBeNull();
  });

  test("returns null for an expired account", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { gm } = makeManager({
      account: { tokenMint: MINT, creator: CREATOR, createdAt: now - 7200, timeout: 60 },
      db: {},
    });
    expect(await gm.ensureGameDataFromChain(GAME)).toBeNull();
  });
});

describe("getPendingGameCreationMessages", () => {
  test("returns an empty list when the database cannot list game messages", () => {
    const { gm } = makeManager({ db: {} });
    expect((gm as any).getPendingGameCreationMessages(GAME)).toEqual([]);
  });

  test("returns an empty list when the database answers with a non-array", () => {
    const { gm } = makeManager({ db: { getGameMessages: () => null } });
    expect((gm as any).getPendingGameCreationMessages(GAME)).toEqual([]);
  });

  test("returns the stored messages", () => {
    const messages = [{ chatId: 1, messageId: 2 }];
    const { gm } = makeManager({ db: { getGameMessages: () => messages } });
    expect((gm as any).getPendingGameCreationMessages(GAME)).toBe(messages);
  });
});
