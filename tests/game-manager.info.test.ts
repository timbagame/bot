import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";
import { sanitizeTelegramDisplayName } from "../src/utils/telegram-display";

function resetGM() {
  GameManager.resetForTest();
}

function programStub(gameAccount: any) {
  return {
    account: { game: { fetch: async () => gameAccount } },
  } as any;
}

function walletStub(opts?: { blockTime?: number; decimals?: number }) {
  const blockTime = opts?.blockTime ?? Math.floor(Date.now() / 1000);
  const decimals = opts?.decimals ?? 9;
  return {
    getBlockchainTime: async () => blockTime,
    getTokenMetadata: async () => ({ decimals }),
    formatTokenBalance: (amount: number, d: number) => (amount / Math.pow(10, d)).toFixed(0),
  } as any;
}

function dbStub(overrides: Partial<any> = {}, participants: string[] = []) {
  return {
    getGame: (_addr: string) => ({ token_mint: "MINT", token_ticker: "TOK", ...overrides }),
    getCreatorInfo: (_addr: string) => ({ telegramId: "777" }),
    getGameParticipants: () => participants,
    getPlayerTelegramId: (pk: string) => ({
      WINNER111: "999",
    } as Record<string, string>)[pk] || null,
    saveUsernameMapping: () => {},
    findTelegramIdByNormalizedUsername: () => null,
  } as any;
}

function ctxStub() {
  return {
    chat: { id: 42, type: "private" },
    api: {
      getChatMember: async (_chat: number, id: number) => ({ user: { username: `user${id}` } }),
    },
  } as any;
}

describe("GameManager.getGameInfo & getCompletedGameInfo", () => {
  test("getGameInfo formats active coinflip with creator", async () => {
    resetGM();
    const createdAt = 1_000_000;
    const timeout = 60;
    const gameAcc = {
      ticketAmount: 1_000_000_000,
      ticketsCount: 1,
      maxTickets: 2,
      createdAt,
      timeout,
      creator: new PublicKey("11111111111111111111111111111111"),
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(programStub(gameAcc), walletStub({ blockTime: createdAt + 30 }), dbStub());
    const info = await gm.getGameInfo(ctxStub(), new PublicKey("11111111111111111111111111111111"));
    expect(info).toContain("<b>Coinflip • 1 TOK</b>");
    expect(info).toContain(
      `Creator: ${sanitizeTelegramDisplayName("@user777")}`
    );
    expect(info).toContain("1/2 tickets");
    expect(info).toContain("Status:");
    expect(info).toContain("⏰ Expires in:");
  });

  test("getCompletedGameInfo shows winner line", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub({}), walletStub(), dbStub());
    const ctx = ctxStub();
    const out = await gm.getCompletedGameInfo(ctx, {
      creator_telegram_id: "777",
      amount: 1_000_000_000,
      token_ticker: "TOK",
      max_players: 3,
      game_type: "giveaway",
      winner_address: "WINNER111",
    });
    expect(out).toContain("Winner:");
    expect(out).toContain("user999");
    expect(out).toContain("Giveaway");
  });

  test("getCompletedGameInfo keeps original max ticket count", async () => {
    resetGM();
    const participants = ["101", "102", "103"];
    const gm = GameManager.getInstance(
      programStub({}),
      walletStub(),
      dbStub({ max_players: 10, min_players: 2 }, participants)
    );
    const ctx = ctxStub();
    const output = await gm.getCompletedGameInfo(ctx, {
      creator_telegram_id: "777",
      amount: 1_000_000_000,
      token_ticker: "TOK",
      max_players: 10,
      min_players: 2,
      game_type: "coinflip",
      token_mint: "MINT",
      game_address: new PublicKey("11111111111111111111111111111111").toBase58(),
      winner_address: "WINNER111",
    });

    expect(output).toContain("3/10 tickets");
  });

  test("getCompletedGameInfo falls back gracefully on non-numeric amount", async () => {
    resetGM();
    const gm = GameManager.getInstance(programStub({}), walletStub(), dbStub());
    const ctx = ctxStub();
    const message = await gm.getCompletedGameInfo(ctx, {
      creator_telegram_id: "777",
      amount: "oops",
      token_ticker: "TOK",
      max_players: 4,
      game_type: "coinflip",
      token_mint: "MINT",
      game_address: new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(),
      winner_address: "cancelled",
    });

    expect(message).not.toContain("NaN");
    expect(message).toContain("• 0 TOK");
  });
});
