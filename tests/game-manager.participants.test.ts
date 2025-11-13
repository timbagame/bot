import { describe, test, expect } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";
import { sanitizeTelegramDisplayName } from "../src/utils/telegram-display";

function reset() {
  GameManager.resetForTest();
}

function makeProgram(game: any) {
  return { account: { game: { fetch: async () => game } } } as any;
}

function makeWallet() {
  return {
    getBlockchainTime: async () => Math.floor(Date.now() / 1000),
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
    getTokenMetadata: async () => ({ decimals: 9 }),
  } as any;
}

function makeDb() {
  return {
    getGameParticipants: (_addr: string) => ["111", "222"],
    getGame: (_addr: string) => ({ token_mint: "M", token_ticker: "TOK" }),
    getPlayerTelegramId: (pub: string) => pub,
    saveUsernameMapping: () => {},
    findTelegramIdByNormalizedUsername: () => null,
  } as any;
}

function makeCtx() {
  return {
    chat: { id: 1, type: "private" },
    api: { getChatMember: async (_: number, id: number) => ({ user: { username: `user${id}` } }) },
  } as any;
}

describe("GameManager participants rendering", () => {
  test("shows participant usernames for active game", async () => {
    reset();
    const program = makeProgram({
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 2,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    });
    const gm = GameManager.getInstance(program, makeWallet(), makeDb());
    const ctx = makeCtx();
  const gamePda = new PublicKey("11111111111111111111111111111111");
    const res = await gm.formatGameMessage(ctx, gamePda, "coinflip", 1_000_000_000, "@creator", "Active", "TOK");
    expect(res.messageText).toContain(
      sanitizeTelegramDisplayName("@user111")
    );
    expect(res.messageText).toContain(
      sanitizeTelegramDisplayName("@user222")
    );
  });

  test("trims participant list to respect Telegram message limit", async () => {
    reset();
    const participantIds = Array.from({ length: 120 }, (_, i) => String(10_000 + i));
    const program = makeProgram({
      ticketsCount: participantIds.length,
      maxTickets: participantIds.length,
      minTickets: 2,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    });
    const gm = GameManager.getInstance(
      program,
      makeWallet(),
      {
        getGameParticipants: () => participantIds,
        getGame: () => ({ token_mint: "M", token_ticker: "TOK" }),
      } as any
    );
    (gm as any).getUsernameFromTelegramId = async (_ctx: any, id: string) =>
      `user${id}${"x".repeat(80)}`;
    const ctx = {
      chat: { id: 1, type: "group" },
      api: {},
    } as any;
  const gamePda = Keypair.generate().publicKey;

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK"
    );

    expect(res.messageText.length).toBeLessThanOrEqual(4096);
    expect(res.messageText).toMatch(/\n… and \d+ more/);
  });
});
