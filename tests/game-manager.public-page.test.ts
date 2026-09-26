import { afterEach, describe, expect, test, vi } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";

const now = () => Math.floor(Date.now() / 1000);

const makeGame = async (overrides: Record<string, unknown> = {}) => ({
  publicKey: (await Keypair.generate()).publicKey,
  account: {
    isPrivate: false,
    gameType: { coinflip: {} },
    ticketAmount: 1000,
    tokenMint: (await Keypair.generate()).publicKey,
    createdAt: now(),
    timeout: 3600,
    ticketsCount: 1,
    maxTickets: 2,
    minTickets: 2,
    ...overrides,
  },
});

const createManager = (program: any, wallet: any, gameDb: any = {}) =>
  new (GameManager as any)(program, wallet, gameDb, {}, {}, {}) as GameManager;

const stubFormatting = (manager: GameManager) => {
  const formatGameMessage = vi.fn(async (_ctx: any, gamePda: PublicKey, ..._rest: any[]) => ({
    messageText: `Game ${gamePda.toBase58()}`,
    keyboard: [],
  }));
  (manager as any).formatGameMessage = formatGameMessage;
  (manager as any).getGameCreatorUsername = vi.fn(async () => "@creator");
  return formatGameMessage;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GameManager.getActivePublicGamesPage", () => {
  test("formats only the requested page and reuses the program scan accounts", async () => {
    const sharedMint = (await Keypair.generate()).publicKey;
    const games = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        makeGame({ timeout: 600 + index, tokenMint: sharedMint }),
      ),
    );
    const program = {
      account: {
        game: {
          all: vi.fn(async () => games),
          fetchNullable: vi.fn(async () => {
            throw new Error("should not refetch");
          }),
          fetchMultiple: vi.fn(async () => {
            throw new Error("should not batch refetch");
          }),
        },
      },
    };
    const wallet = { getTokenMetadata: vi.fn(async () => ({ symbol: "TIMBA", decimals: 6 })) };
    const manager = createManager(program, wallet);
    const formatGameMessage = stubFormatting(manager);

    const result = await manager.getActivePublicGamesPage({} as any, { page: 1, pageSize: 5 });

    expect(result.totalGames).toBe(12);
    expect(result.page).toBe(1);
    expect(result.games.map((game) => game.gameAddress)).toEqual(
      games.slice(5, 10).map((game) => game.publicKey.toBase58()),
    );
    expect(formatGameMessage).toHaveBeenCalledTimes(5);
    expect(formatGameMessage.mock.calls[0]![10]).toMatchObject({ gameAccount: games[5]!.account });
    expect(program.account.game.fetchNullable).not.toHaveBeenCalled();
    expect(program.account.game.fetchMultiple).not.toHaveBeenCalled();
    // Metadata is resolved per distinct mint, not per game.
    expect(wallet.getTokenMetadata).toHaveBeenCalledTimes(1);

    // Out-of-range pages clamp to the last page.
    const clamped = await manager.getActivePublicGamesPage({} as any, { page: 99, pageSize: 5 });
    expect(clamped.page).toBe(2);
    expect(clamped.games).toHaveLength(2);
  });

  test("caches the public scan briefly and shares an in-flight scan", async () => {
    const games = [await makeGame()];
    const all = vi.fn(async () => games);
    const manager = createManager(
      { account: { game: { all } } },
      { getTokenMetadata: vi.fn(async () => ({ symbol: "TIMBA" })) },
    );
    stubFormatting(manager);

    await Promise.all([
      manager.getActivePublicGamesPage({} as any, { page: 0, pageSize: 5 }),
      manager.getActivePublicGamesPage({} as any, { page: 0, pageSize: 5 }),
    ]);
    await manager.getActivePublicGamesPage({} as any, { page: 0, pageSize: 5 });
    expect(all).toHaveBeenCalledTimes(1);

    manager.invalidatePublicGamesCache();
    await manager.getActivePublicGamesPage({} as any, { page: 0, pageSize: 5 });
    expect(all).toHaveBeenCalledTimes(2);

    const nowMs = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(nowMs + 60_000);
    await manager.getActivePublicGamesPage({} as any, { page: 0, pageSize: 5 });
    expect(all).toHaveBeenCalledTimes(3);
  });

  test("drops games that expire while the list is cached", async () => {
    const soon = await makeGame({ createdAt: now() - 100, timeout: 102 });
    const later = await makeGame();
    const manager = createManager(
      { account: { game: { all: vi.fn(async () => [soon, later]) } } },
      { getTokenMetadata: vi.fn(async () => ({ symbol: "TIMBA" })) },
    );
    stubFormatting(manager);

    const first = await manager.getActivePublicGamesPage({} as any, { page: 0, pageSize: 5 });
    expect(first.totalGames).toBe(2);

    const nowMs = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(nowMs + 5_000);
    const second = await manager.getActivePublicGamesPage({} as any, { page: 0, pageSize: 5 });
    expect(second.totalGames).toBe(1);
    expect(second.games[0]!.gameAddress).toBe(later.publicKey.toBase58());
  });

  test("filters by game type and ticker", async () => {
    const timbaMint = (await Keypair.generate()).publicKey;
    const coinflip = await makeGame({ tokenMint: timbaMint });
    const giveaway = await makeGame({
      gameType: { giveaway: {} },
      totalAmount: 5000,
      tokenMint: timbaMint,
    });
    const other = await makeGame();
    const manager = createManager(
      { account: { game: { all: vi.fn(async () => [coinflip, giveaway, other]) } } },
      {
        getTokenMetadata: vi.fn(async (mint: string) =>
          mint === timbaMint.toBase58() ? { symbol: "TIMBA" } : { symbol: "BONK" },
        ),
      },
    );
    stubFormatting(manager);

    const byType = await manager.getActivePublicGamesPage({} as any, {
      page: 0,
      pageSize: 5,
      filter: { gameType: "giveaway" },
    });
    expect(byType.games.map((game) => game.gameAddress)).toEqual([giveaway.publicKey.toBase58()]);

    const byTicker = await manager.getActivePublicGamesPage({} as any, {
      page: 0,
      pageSize: 5,
      filter: { ticker: "timba" },
    });
    expect(byTicker.totalGames).toBe(2);

    const both = await manager.getAllActivePublicGames({} as any, {
      gameType: "coinflip",
      ticker: "BONK",
    });
    expect(both.map((game) => game.gameAddress)).toEqual([other.publicKey.toBase58()]);
  });

  test("returns an empty page when nothing matches", async () => {
    const manager = createManager(
      { account: { game: { all: vi.fn(async () => []) } } },
      { getTokenMetadata: vi.fn() },
    );
    stubFormatting(manager);
    const result = await manager.getActivePublicGamesPage({} as any, { page: 3, pageSize: 5 });
    expect(result).toEqual({ games: [], totalGames: 0, page: 0 });
  });
});

describe("GameManager active list batching", () => {
  test("loads database-listed games with one batched account lookup", async () => {
    const present = (await Keypair.generate()).publicKey.toBase58();
    const missing = (await Keypair.generate()).publicKey.toBase58();
    const fetchMultiple = vi.fn(async (keys: PublicKey[]) =>
      keys.map((key) =>
        key.toBase58() === present ? { ticketsCount: 1, maxTickets: 4, minTickets: 2 } : null,
      ),
    );
    const fetchNullable = vi.fn();
    const gameDb = {
      getActiveGamesByChat: vi.fn(() => [
        { game_address: present, game_type: "coinflip", amount: 10, token_ticker: "T" },
        { game_address: missing, game_type: "coinflip", amount: 10, token_ticker: "T" },
        { game_address: "not-a-key", game_type: "coinflip" },
      ]),
    };
    const manager = createManager(
      { account: { game: { fetchMultiple, fetchNullable } } },
      {},
      gameDb,
    );
    stubFormatting(manager);

    const games = await manager.getChatActiveGames({} as any, -100);

    expect(fetchMultiple).toHaveBeenCalledTimes(1);
    expect(fetchMultiple.mock.calls[0]![0]).toHaveLength(2);
    expect(fetchNullable).not.toHaveBeenCalled();
    expect(games.map((game) => game.gameAddress)).toEqual([present]);
    expect(games[0]).toMatchObject({ currentTickets: 1, maxTickets: 4, minTickets: 2 });
  });

  test("falls back to single lookups when the batch call fails", async () => {
    const address = (await Keypair.generate()).publicKey.toBase58();
    const fetchNullable = vi.fn(async () => ({ ticketsCount: 0, maxTickets: 2 }));
    const gameDb = {
      getActiveGames: vi.fn(() => [{ game_address: address, game_type: "coinflip" }]),
    };
    const manager = createManager(
      {
        account: {
          game: {
            fetchMultiple: vi.fn(async () => {
              throw new Error("rpc down");
            }),
            fetchNullable,
          },
        },
      },
      {},
      gameDb,
    );
    stubFormatting(manager);

    const games = await manager.getUserActiveGames({} as any, 7n);
    expect(fetchNullable).toHaveBeenCalledTimes(1);
    expect(games).toHaveLength(1);
  });
});
