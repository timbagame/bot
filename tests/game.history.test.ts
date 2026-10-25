import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Keypair } from "#solana";
import { GameManager, type GameHistoryEntry, type GameHistoryResult } from "../src/utils/game";
import * as priceService from "../src/utils/price-service";
import { WSOL_MINT } from "../src/utils/constants";
import { buildGameStateUnavailableMessage } from "../src/utils/game-ui";

let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let priceSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  GameManager.resetForTest();
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  priceSpy = spyOn(priceService, "getUsdPrice").mockResolvedValue(null);
});

afterEach(() => {
  priceSpy.mockRestore();
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  GameManager.resetForTest();
});

const CTX = { chat: { id: 1, type: "private" }, api: {}, from: { id: 12345 } } as any;

describe("getUserGamesHistory fallbacks", () => {
  async function build(options: {
    games: any[];
    wallet?: Record<string, unknown>;
    db?: Record<string, unknown>;
    stats?: any;
  }) {
    const player = await Keypair.generate();
    const wallet = {
      getKeyPair: () => player,
      getTokenMetadata: async () => ({ decimals: 6 }),
      ...options.wallet,
    } as any;
    const db = {
      getRecentGames: async () => options.games,
      getGameParticipants: () => [],
      getPlayerGlobalStats: () => options.stats ?? null,
      ...options.db,
    } as any;
    const program = { account: { game: { fetch: async () => ({}) } } } as any;
    const gm = GameManager.getInstance(program, wallet, db);
    (gm as any).getUsernameFromTelegramId = async () => "@creator";
    (gm as any).getPlayerUsername = async () => "@winner";
    return { gm, player };
  }

  const baseGame = (overrides: Record<string, unknown> = {}) => ({
    game_address: "GameAddr1",
    winner_address: "someone-else",
    creator_telegram_id: "777",
    completed_at: 1_700_000_000_000,
    amount: 5_000_000,
    token_ticker: "TIMBA",
    token_mint: "TIMBA_MINT",
    max_players: 2,
    ...overrides,
  });

  test("falls back to six decimals when token metadata lookup throws", async () => {
    const { gm } = await build({
      games: [baseGame()],
      wallet: {
        getTokenMetadata: async () => {
          throw new Error("metadata offline");
        },
      },
    });

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(result.lost.games).toHaveLength(1);
    expect(result.lost.games[0]!.tokenDecimals).toBe(6);
    expect(result.primaryDecimals).toBe(6);
  });

  test("uses getGameParticipantsCount and the stored max players when available", async () => {
    const counted: string[] = [];
    const { gm } = await build({
      games: [baseGame({ max_players: 9 })],
      db: {
        getGameParticipantsCount: (address: string) => {
          counted.push(address);
          return 4.9;
        },
      },
    });

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(counted).toEqual(["GameAddr1"]);
    expect(result.lost.games[0]!.ticketCount).toBe(4);
    expect(result.lost.games[0]!.maxTickets).toBe(9);
  });

  test("keeps zero counts when participant lookup throws", async () => {
    const { gm } = await build({
      games: [baseGame()],
      db: {
        getGameParticipantsCount: () => {
          throw new Error("db closed");
        },
      },
    });

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(result.lost.games[0]!.ticketCount).toBe(0);
    expect(result.lost.games[0]!.maxTickets).toBe(0);
  });

  test("uses a short player id when the creator has no username", async () => {
    const { gm } = await build({ games: [baseGame({ creator_telegram_id: "1234567890" })] });
    (gm as any).getUsernameFromTelegramId = async () => null;

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(result.lost.games[0]!.creatorDisplay).toBe("Player 123456...");
  });

  test("uses a short player id when the creator lookup throws", async () => {
    const { gm } = await build({ games: [baseGame({ creator_telegram_id: "1234567890" })] });
    (gm as any).getUsernameFromTelegramId = async () => {
      throw new Error("telegram down");
    };

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(result.lost.games[0]!.creatorDisplay).toBe("Player 123456...");
  });

  test("leaves the opponent blank when the winner has no username or lookup fails", async () => {
    const { gm } = await build({
      games: [baseGame({ game_address: "A" }), baseGame({ game_address: "B" })],
    });
    let calls = 0;
    (gm as any).getPlayerUsername = async () => {
      calls += 1;
      if (calls === 1) return null;
      throw new Error("lookup failed");
    };

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(calls).toBe(2);
    expect(result.lost.games.map((g) => g.opponentDisplay)).toEqual(["", ""]);
  });

  test("shows the winner as opponent for lost games", async () => {
    const { gm } = await build({ games: [baseGame()] });

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    // The sanitizer inserts a word joiner after "@" so the name cannot ping anyone.
    expect(result.lost.games[0]!.opponentDisplay.replace("\u2060", "")).toBe("@winner");
  });

  test("leaves the explorer link empty for entries without a game address", async () => {
    const { gm } = await build({ games: [baseGame({ game_address: "" })] });

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(result.lost.games[0]!.explorerUrl).toBeNull();
  });

  test("skips giveaways and created games", async () => {
    const { gm } = await build({
      games: [
        baseGame({ game_type: "GiveAway" }),
        baseGame({ winner_address: null, creator_telegram_id: "12345" }),
      ],
    });

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(result.lost.games).toHaveLength(0);
    expect(result.won.games).toHaveLength(0);
    expect(result.cancelled.count).toBe(0);
  });

  test("logs and skips a malformed entry without dropping the others", async () => {
    const { gm } = await build({
      games: [baseGame({ game_address: "Bad", game_type: 42 }), baseGame({ game_address: "Good" })],
    });

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(result.lost.games.map((g) => g.gameAddress)).toEqual(["Good"]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toBe("Error processing game Bad:");
  });

  test("looks up per-ticker prices and ignores lookup failures and non-positive prices", async () => {
    const { gm } = await build({
      games: [
        baseGame({ game_address: "A", token_ticker: "AAA", token_mint: "SOL" }),
        baseGame({ game_address: "B", token_ticker: "BBB", token_mint: "B_MINT" }),
        baseGame({ game_address: "C", token_ticker: "CCC", token_mint: "C_MINT" }),
      ],
    });
    priceSpy.mockImplementation((async ({ tokenMint }: { tokenMint: string }) => {
      if (tokenMint === "B_MINT") throw new Error("price api down");
      if (tokenMint === "C_MINT") return { price: 0 };
      return { price: 150 };
    }) as any);

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    expect(result.lost.games).toHaveLength(3);
    const asked = priceSpy.mock.calls.map((call: any[]) => call[0].tokenMint);
    expect(asked).toEqual([WSOL_MINT, "B_MINT", "C_MINT"]);
  });

  test("converts aggregated won and lost amounts to USD", async () => {
    const { gm } = await build({
      games: [],
      wallet: {
        getTokenMetadata: async (mint: string) => {
          if (mint === "ZERO_DEC") return { decimals: 0 };
          if (mint === "NO_DEC") return {};
          if (mint === "BROKEN") throw new Error("metadata missing");
          return { decimals: 6 };
        },
      },
      stats: {
        wonAmountByToken: {
          USDC_MINT: 3_000_000,
          SOL: 2_000_000_000,
          BROKEN: 5_000_000_000,
          EMPTY: 0,
          FAILS: 1_000_000_000,
        },
        lostAmountByToken: {
          ZERO_DEC: 4,
          NO_DEC: 2_000_000_000,
          BROKEN: 1_000_000_000,
          EMPTY: -5,
          FAILS: 1,
        },
      },
    });
    priceSpy.mockImplementation((async ({ tokenMint }: { tokenMint: string }) => {
      if (tokenMint === "FAILS") throw new Error("price api down");
      if (tokenMint === WSOL_MINT) return { price: 100 };
      if (tokenMint === "BROKEN") return { price: 0 };
      return { price: 2 };
    }) as any);

    const result = await gm.getUserGamesHistory(CTX, 12345n);

    // USDC: 3 * 2 = 6, SOL (9 decimals as 6? no: mocked metadata says 6): 2000 * 100
    expect(result.won.totalUsd).toBeCloseTo(3 * 2 + 2000 * 100, 6);
    // ZERO_DEC: 4 * 2 = 8, NO_DEC falls back to 9 decimals: 2 * 2 = 4
    expect(result.lost.totalUsd).toBeCloseTo(8 + 4, 6);
    const askedMints = priceSpy.mock.calls.map((call: any[]) => call[0].tokenMint);
    expect(askedMints).toContain(WSOL_MINT);
    expect(askedMints).not.toContain("SOL");
  });
});

describe("formatGamesHeader and formatGamesMessage", () => {
  const entry = (overrides: Partial<GameHistoryEntry> = {}): GameHistoryEntry => ({
    gameAddress: "Addr",
    amount: 5_000_000,
    tokenTicker: "TIMBA",
    tokenMint: "MINT",
    tokenDecimals: 6,
    ticketCount: 2,
    maxTickets: 2,
    creatorDisplay: "@creator",
    opponentDisplay: "@winner",
    completedAt: 1_700_000_000_000,
    explorerUrl: "https://solscan.io/account/Addr",
    category: "won",
    ...overrides,
  });

  const result = (
    won: GameHistoryEntry[],
    lost: GameHistoryEntry[],
    cancelled: GameHistoryEntry[],
    usd = { won: 0, lost: 0 },
  ): GameHistoryResult => ({
    won: { games: won, totalAmount: 0, totalUsd: usd.won },
    lost: { games: lost, totalAmount: 0, totalUsd: usd.lost },
    cancelled: { games: cancelled, count: cancelled.length },
    primaryTicker: "TIMBA",
    primaryDecimals: 6,
  });

  let gm: GameManager;
  beforeEach(() => {
    gm = GameManager.getInstance(
      { account: { game: { fetch: async () => ({}) } } } as any,
      {} as any,
      {} as any,
    );
  });

  test("abbreviates thousands of dollars in the header", () => {
    const header = gm.formatGamesHeader("@bob", result([], [], [], { won: 1500, lost: 25_000 }));
    expect(header).toContain("Won $1.5k");
    expect(header).toContain("Lost $25k");
    expect(header).toContain("Net: -$24k");
  });

  test("formats won, lost and cancelled tabs with their own titles", () => {
    const res = result(
      [entry({ category: "won" })],
      [entry({ category: "lost", gameAddress: "L1" }), entry({ category: "lost" })],
      [entry({ category: "cancelled", opponentDisplay: "" })],
    );
    const won = gm.formatGamesMessage("@bob", res, "won", 0);
    const lost = gm.formatGamesMessage("@bob", res, "lost", 0);
    const cancelled = gm.formatGamesMessage("@bob", res, "cancelled", 0);

    expect(won).toContain("✅ Won (1)");
    expect(lost).toContain("❌ Lost (2)");
    expect(cancelled).toContain("🚫 Cancelled (1)");
    expect(lost).toContain("vs @winner");
    expect(cancelled).toContain("by @creator");
  });

  test("reports an empty category", () => {
    const message = gm.formatGamesMessage("@bob", result([], [], []), "won", 0);
    expect(message.endsWith("\n\n<i>No games in this category.</i>")).toBe(true);
  });

  test("collapses identical games on the same page into a counted line", () => {
    const res = result([entry(), entry(), entry({ amount: 9_000_000 })], [], []);
    const message = gm.formatGamesMessage("@bob", res, "won", 0);
    const lines = message.split("\n").filter((line) => line.startsWith("• "));

    expect(lines).toHaveLength(2);
    expect(lines.filter((line) => line.endsWith(" ×2"))).toHaveLength(1);
  });

  test("paginates and clamps out-of-range pages", () => {
    const games = Array.from({ length: 7 }, (_, i) =>
      entry({ gameAddress: `G${i}`, amount: (i + 1) * 1_000_000 }),
    );
    const res = result(games, [], []);

    expect(gm.formatGamesMessage("@bob", res, "won", 0)).toContain("Page 1/2");
    expect(gm.formatGamesMessage("@bob", res, "won", 99)).toContain("Page 2/2");
    expect(gm.formatGamesMessage("@bob", res, "won", -3)).toContain("Page 1/2");
  });
});

describe("buildGamesKeyboard", () => {
  const manyGames = (category: GameHistoryEntry["category"], count: number): GameHistoryEntry[] =>
    Array.from({ length: count }, (_, i) => ({
      gameAddress: `${category}${i}`,
      amount: 1,
      tokenTicker: "T",
      tokenMint: "M",
      tokenDecimals: 6,
      ticketCount: 1,
      maxTickets: 2,
      creatorDisplay: "",
      opponentDisplay: "",
      completedAt: i,
      explorerUrl: null,
      category,
    }));

  const res = (): GameHistoryResult => ({
    won: { games: manyGames("won", 6), totalAmount: 0, totalUsd: 0 },
    lost: { games: manyGames("lost", 11), totalAmount: 0, totalUsd: 0 },
    cancelled: { games: manyGames("cancelled", 2), totalAmount: 0, totalUsd: 0 } as any,
    primaryTicker: "T",
    primaryDecimals: 6,
  });

  let gm: GameManager;
  beforeEach(() => {
    gm = GameManager.getInstance(
      { account: { game: { fetch: async () => ({}) } } } as any,
      {} as any,
      {} as any,
    );
  });

  test("first page of a multi-page tab offers refresh and next only", () => {
    const keyboard = gm.buildGamesKeyboard("42", res(), "won", 0);
    expect(keyboard[1]).toEqual([
      { text: "🔁 Refresh", callback_data: "games_refresh:42" },
      { text: "Next ▶", callback_data: "games_tab:won:1:42" },
    ]);
  });

  test("middle page offers prev, refresh and next", () => {
    const keyboard = gm.buildGamesKeyboard("42", res(), "lost", 1);
    expect(keyboard[1]!.map((b: any) => b.callback_data)).toEqual([
      "games_tab:lost:0:42",
      "games_refresh:42",
      "games_tab:lost:2:42",
    ]);
  });

  test("last page offers prev and refresh only", () => {
    const keyboard = gm.buildGamesKeyboard("42", res(), "lost", 2);
    expect(keyboard[1]!.map((b: any) => b.text)).toEqual(["◀ Prev", "🔁 Refresh"]);
  });

  test("the all tab counts every category and the cancelled tab uses its own list", () => {
    const all = gm.buildGamesKeyboard("42", res(), "all", 0);
    expect(all[0]!.map((b: any) => b.text)).toEqual([
      "Won (6)",
      "Lost (11)",
      "Canc (2)",
      "[All (19)]",
    ]);
    expect(all[1]!.map((b: any) => b.callback_data)).toEqual([
      "games_refresh:42",
      "games_tab:all:1:42",
    ]);

    const cancelled = gm.buildGamesKeyboard("42", res(), "cancelled", 0);
    expect(cancelled[0]![2].text).toBe("[Canc (2)]");
    expect(cancelled[1]).toEqual([{ text: "🔁 Refresh", callback_data: "games_refresh:42" }]);
  });
});

describe("formatActiveGamesList edge cases", () => {
  const GAME = "BPFLoader1111111111111111111111111111111111";

  function manager(gameApi: Record<string, unknown>) {
    const program = { account: { game: gameApi } } as any;
    return GameManager.getInstance(program, {} as any, {} as any);
  }

  test("skips entries without an address and invalid addresses without any batch lookup", async () => {
    let batchCalls = 0;
    const gm = manager({
      fetchMultiple: async () => {
        batchCalls += 1;
        return [];
      },
    });

    const rows = await (gm as any).formatActiveGamesList(CTX, [
      null,
      { game_type: "coinflip" },
      { game_address: "not-a-public-key" },
    ]);

    expect(rows).toEqual([]);
    expect(batchCalls).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toBe("Invalid game address");
  });

  test("falls back to the unavailable-state message when formatting returns no text", async () => {
    const gm = manager({});
    (gm as any).getGameCreatorUsername = async () => "@creator";
    (gm as any).formatGameMessage = async () => ({ messageText: "", keyboard: [] });

    const rows = await (gm as any).formatActiveGamesList(CTX, [
      {
        game_address: GAME,
        game_type: "coinflip",
        game_account: { ticketsCount: 1, maxTickets: 2, minTickets: 2 },
      },
    ]);

    expect(rows).toEqual([
      {
        messageText: buildGameStateUnavailableMessage(GAME, "coinflip"),
        keyboard: [],
        gameAddress: GAME,
        currentTickets: 1,
        maxTickets: 2,
        minTickets: 2,
      },
    ]);
  });
});
