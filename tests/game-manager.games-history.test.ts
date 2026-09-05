import { describe, test, expect, beforeEach } from "bun:test";
import { GameManager } from "../src/utils/game";
import { Keypair } from "#solana";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

describe("GameManager.getUserGamesHistory", () => {
  let gm: GameManager;
  let player: Awaited<ReturnType<typeof Keypair.generate>>;
  let playerPkStr: string;

  beforeEach(async () => {
    resetGM();
    player = await Keypair.generate();
    playerPkStr = player.publicKey.toBase58();

    const program = { account: { game: { fetch: async () => ({}) } } } as any;
    const wallet = {
      getKeyPair: (_: bigint) => player,
      getTokenMetadata: async () => ({ decimals: 6 }),
      formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
    } as any;

    const db = {
      getActiveGames: async () => [],
      getRecentGames: async (_id: string, _limit: number) => [
        {
          game_address: "wonGame1",
          winner_address: playerPkStr,
          creator_telegram_id: "777",
          completed_at: Date.now() - 1000,
          amount: 151_100_000,
          token_ticker: "TIMBA",
          token_mint: "TIMBA_MINT",
          max_players: 2,
        },
        {
          game_address: "wonGame2",
          winner_address: playerPkStr,
          creator_telegram_id: "777",
          completed_at: Date.now() - 2000,
          amount: 14_000_000,
          token_ticker: "TIMBA",
          token_mint: "TIMBA_MINT",
          max_players: 2,
        },
        {
          game_address: "lostGame",
          winner_address: (await Keypair.generate()).publicKey.toBase58(),
          creator_telegram_id: "888",
          completed_at: Date.now() - 3000,
          amount: 154_000_000,
          token_ticker: "TIMBA",
          token_mint: "TIMBA_MINT",
          max_players: 10,
        },
        {
          game_address: "cancelledGame",
          winner_address: "cancelled",
          creator_telegram_id: "999",
          completed_at: Date.now() - 4000,
          amount: 14_000_000,
          token_ticker: "TIMBA",
          token_mint: "TIMBA_MINT",
          max_players: 2,
        },
      ],
      getGame: (_: string) => ({ token_mint: "MINT", token_ticker: "TIMBA" }),
      getCreatorInfo: (_: string) => ({ telegramId: "777" }),
      getGameParticipants: () => [{ telegram_id: "12345" }, { telegram_id: "777" }],
      getPlayerGlobalStats: (_: string) => ({
        telegramId: "12345",
        totalGames: 4,
        gamesWon: 2,
        gamesCreated: 0,
        gamesJoined: 4,
        totalVolume: 333000000,
        winRate: 50,
        netAmountByToken: {
          TIMBA_MINT: 11_100_000,
        },
        wonAmountByToken: {
          TIMBA_MINT: 165_100_000, // Raw won amount
        },
        lostAmountByToken: {
          TIMBA_MINT: 154_000_000, // Raw lost amount
        },
      }),
    } as any;

    gm = GameManager.getInstance(program, wallet, db);
    // Patch username lookup to avoid network calls
    (gm as any).getUsernameFromTelegramId = async () => "@testuser";
    (gm as any).getPlayerUsername = async () => "@opponent";
  });

  test("returns structured game history with correct categorization", async () => {
    const ctx = { chat: { id: 1, type: "private" }, api: {}, from: { id: 12345 } } as any;
    const result = await gm.getUserGamesHistory(ctx, BigInt(12345));

    expect(result.won.games.length).toBe(2);
    expect(result.lost.games.length).toBe(1);
    expect(result.cancelled.games.length).toBe(1);
    expect(result.primaryTicker).toBe("TIMBA");
  });

  test("calculates totals correctly", async () => {
    const ctx = { chat: { id: 1, type: "private" }, api: {}, from: { id: 12345 } } as any;
    const result = await gm.getUserGamesHistory(ctx, BigInt(12345));

    // 151.1M + 14M = 165.1M
    expect(result.won.totalAmount).toBe(165_100_000);
    // 154M
    expect(result.lost.totalAmount).toBe(154_000_000);
    expect(result.cancelled.count).toBe(1);
  });

  test("formatCompactGameLine produces single-line output", async () => {
    const ctx = { chat: { id: 1, type: "private" }, api: {}, from: { id: 12345 } } as any;
    const result = await gm.getUserGamesHistory(ctx, BigInt(12345));

    const wonGame = result.won.games[0]!;
    const line = gm.formatCompactGameLine(wonGame);

    // Should start with emoji
    expect(line.startsWith("✅")).toBe(true);
    // Should contain amount (clickable or code)
    expect(line.includes("151")).toBe(true);
    // Should contain ticket ratio
    expect(line.includes("2/2")).toBe(true);
    // Should be a single line (no newlines)
    expect(line.includes("\n")).toBe(false);
  });

  test("formatGamesHeader produces net summary", async () => {
    const ctx = { chat: { id: 1, type: "private" }, api: {}, from: { id: 12345 } } as any;
    const result = await gm.getUserGamesHistory(ctx, BigInt(12345));

    const header = gm.formatGamesHeader("@testuser", result);

    // Should contain title
    expect(header.includes("🎲")).toBe(true);
    expect(header.includes("Games")).toBe(true);
    // Should contain net
    expect(header.includes("Net")).toBe(true);
    // Should contain Net value
    expect(header.includes("Won")).toBe(true);
  });

  test("formatGamesMessage includes header and game lines", async () => {
    const ctx = { chat: { id: 1, type: "private" }, api: {}, from: { id: 12345 } } as any;
    const result = await gm.getUserGamesHistory(ctx, BigInt(12345));

    const message = gm.formatGamesMessage("@testuser", result, "all", 0);

    // Should have header
    expect(message.includes("🎲")).toBe(true);
    // Should have game count
    expect(message.includes("All (4)")).toBe(true);
    // Should have at least one game line
    expect(message.includes("✅") || message.includes("❌") || message.includes("🚫")).toBe(true);
  });

  test("buildGamesKeyboard creates tab buttons", async () => {
    const ctx = { chat: { id: 1, type: "private" }, api: {}, from: { id: 12345 } } as any;
    const result = await gm.getUserGamesHistory(ctx, BigInt(12345));

    const keyboard = gm.buildGamesKeyboard("12345", result, "all", 0);

    // Should have at least 2 rows (tabs + navigation)
    expect(keyboard.length).toBeGreaterThanOrEqual(2);

    // First row should have 4 tab buttons
    expect(keyboard[0]!.length).toBe(4);

    // Tab buttons should have the right labels
    const tabLabels = keyboard[0]!.map((btn: any) => btn.text);
    expect(tabLabels.some((l: string) => l.includes("Won"))).toBe(true);
    expect(tabLabels.some((l: string) => l.includes("Lost"))).toBe(true);
    expect(tabLabels.some((l: string) => l.includes("All"))).toBe(true);
  });
});
