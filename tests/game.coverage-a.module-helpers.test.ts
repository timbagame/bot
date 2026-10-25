import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PublicKey } from "#solana";
import { GameManager, type GameHistoryEntry } from "../src/utils/game";

const GAME_PDA = new PublicKey("BPFLoader1111111111111111111111111111111111");
const PLAYER_KEY = "BPFLoader2111111111111111111111111111111111";

const makeManager = (overrides: { wallet?: any; gameDb?: any } = {}): any =>
  GameManager.getInstance(
    { account: { game: {} } } as any,
    {
      formatTokenBalance: (value: number, decimals: number) =>
        (value / Math.pow(10, decimals)).toString(),
      ...overrides.wallet,
    } as any,
    (overrides.gameDb ?? {}) as any,
  ) as any;

const entry = (overrides: Partial<GameHistoryEntry> = {}): GameHistoryEntry => ({
  gameAddress: "addr",
  amount: 5,
  tokenTicker: "TIMBA",
  tokenMint: "mint",
  tokenDecimals: 0,
  ticketCount: 1,
  maxTickets: 2,
  creatorDisplay: "",
  opponentDisplay: "",
  completedAt: Date.UTC(2025, 11, 19, 0, 2),
  explorerUrl: null,
  category: "won",
  ...overrides,
});

describe("GameManager coverage-a: compact amounts in the games history", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("abbreviates amounts with M and k suffixes and keeps small amounts exact", () => {
    const gm = makeManager();
    const line = (amount: number, tokenDecimals = 0) =>
      gm.formatCompactGameLine(entry({ amount, tokenDecimals }));

    expect(line(1_500_000)).toContain("1.5M TIMBA");
    expect(line(25_400_000)).toContain("25M TIMBA");
    expect(line(14_000)).toContain("14k TIMBA");
    expect(line(2_300)).toContain("2.3k TIMBA");
    expect(line(42)).toContain("42 TIMBA");
    expect(line(7)).toContain("7.0 TIMBA");
    // Raw token units are scaled by the token decimals first.
    expect(line(151_100_000, 6)).toContain("151 TIMBA");
    expect(line(3_200_000_000, 6)).toContain("3.2k TIMBA");
  });
});

describe("GameManager coverage-a: completed game categories and labels", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("an unresolved game someone else created counts as lost, and unknown game types are capitalised", async () => {
    const gm = makeManager();
    gm.getUsernameFromTelegramId = async () => "alice";
    gm.getPlayerUsername = async () => "winner";
    const ctx = { chat: { id: 1, type: "private" } } as any;

    const out = await gm.processRecentGames(
      ctx,
      [
        {
          winner_address: "",
          creator_telegram_id: "999",
          game_type: "lottery",
          amount: 5_000_000,
          token_ticker: "TIMBA",
          max_players: 4,
        },
        {
          winner_address: "",
          creator_telegram_id: "1",
          game_type: "coinflip",
          amount: 5_000_000,
          token_ticker: "TIMBA",
          max_players: 2,
        },
      ],
      "1",
      PLAYER_KEY,
    );

    expect(out.map((game: { category: string }) => game.category)).toEqual(["lost", "created"]);
    expect(out[0].gameInfo).toContain("Lottery");
    expect(out[0].gameInfo).not.toContain("🪙");
    expect(out[1].gameInfo).toContain("🪙 Coinflip");
  });
});

describe("GameManager coverage-a: pending creation request bookkeeping", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("pruning drops the entry entirely when every timestamp is outside the window", () => {
    const gm = makeManager();
    gm.trackPendingCreationRequest("77", 100);
    gm.trackPendingCreationRequest("77", 200);

    expect(gm.prunePendingCreationRequests("77", 1_000)).toBe(0);
    expect(gm.pendingCreationRequests.has("77")).toBe(false);
  });

  test("pruning keeps only the timestamps still inside the window", () => {
    const gm = makeManager();
    gm.trackPendingCreationRequest("77", 100);
    gm.trackPendingCreationRequest("77", 5_000);
    gm.trackPendingCreationRequest("77", 6_000);

    expect(gm.prunePendingCreationRequests("77", 1_000)).toBe(2);
    expect(gm.pendingCreationRequests.get("77")).toEqual([5_000, 6_000]);
    expect(gm.prunePendingCreationRequests("unknown", 1_000)).toBe(0);
  });

  test("clearing removes one matching timestamp and ignores unknown users or empty lists", () => {
    const gm = makeManager();
    gm.trackPendingCreationRequest("77", 5_000);
    gm.trackPendingCreationRequest("77", 6_000);

    gm.clearPendingCreationRequest("nobody", 5_000);
    gm.pendingCreationRequests.set("empty", []);
    gm.clearPendingCreationRequest("empty", 5_000);
    expect(gm.pendingCreationRequests.get("empty")).toEqual([]);

    gm.clearPendingCreationRequest("77", 5_000);
    expect(gm.pendingCreationRequests.get("77")).toEqual([6_000]);
  });
});

describe("GameManager coverage-a: expiration text without a wallet clock", () => {
  let nowSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    nowSpy = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });
  afterEach(() => {
    nowSpy.mockRestore();
    GameManager.resetForTest();
  });

  test("falls back to the local clock when no wallet manager is available", async () => {
    const gm = makeManager();
    gm.wallet = undefined;

    const stats = await gm.getActiveGameStats(GAME_PDA, 1_000_000n, undefined, {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 2,
      createdAt: 1_700_000_000,
      timeout: 120,
      gameType: { coinflip: {} },
    });

    expect(stats.expirationInfo).toBe("\n⏰ Expires in: 2m");
  });
});

describe("GameManager coverage-a: debug logging", () => {
  let previousDebug: string | undefined;

  beforeEach(() => {
    previousDebug = process.env["TIMBA_DEBUG"];
  });
  afterEach(() => {
    if (previousDebug === undefined) delete process.env["TIMBA_DEBUG"];
    else process.env["TIMBA_DEBUG"] = previousDebug;
  });

  const lookup = async (module: typeof import("../src/utils/game")) => {
    module.GameManager.resetForTest();
    const gm = module.GameManager.getInstance(
      { account: { game: {} } } as any,
      {} as any,
      { getPlayerTelegramId: () => null } as any,
    ) as any;
    gm.getPlayerTelegramIdWithRetry = async () => null;
    try {
      return await gm.getPlayerUsername({} as any, PLAYER_KEY);
    } finally {
      module.GameManager.resetForTest();
    }
  };

  test("writes debug lines when TIMBA_DEBUG is enabled at load time", async () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      process.env["TIMBA_DEBUG"] = "true";
      const module = await import(`../src/utils/game?${"coverage-a-debug-on"}`);

      await lookup(module);

      expect(debugSpy).toHaveBeenCalledWith(`🔍 Getting username for publicKey: ${PLAYER_KEY}`);
      expect(debugSpy).toHaveBeenCalledWith(`⚠️ No telegram ID found for publicKey: ${PLAYER_KEY}`);
    } finally {
      debugSpy.mockRestore();
    }
  });

  test("stays silent when TIMBA_DEBUG is not enabled", async () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => undefined);
    try {
      delete process.env["TIMBA_DEBUG"];
      const module = await import(`../src/utils/game?${"coverage-a-debug-off"}`);

      await lookup(module);

      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
    }
  });
});
