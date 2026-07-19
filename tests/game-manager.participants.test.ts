import { describe, test, expect } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";
import { sanitizeTelegramDisplayName } from "../src/utils/telegram-display";
import { GAME_MESSAGE_PARTICIPANTS_PREVIEW_LIMIT } from "../src/utils/constants";

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
  test("keeps web wallet participants in completed games", async () => {
    reset();
    const webWallet = Keypair.generate().publicKey.toBase58();
    const telegramWallet = Keypair.generate().publicKey.toBase58();
    const gm = GameManager.getInstance(makeProgram({}), makeWallet(), {
      getGameParticipants: () => ["222"],
      getGameParticipantsPreview: () => ["222"],
      getGameParticipantAddresses: () => [webWallet, telegramWallet],
      getGame: () => ({
        token_mint: "M",
        token_ticker: "TOK",
        max_players: 2,
        min_players: 2,
      }),
      getPlayerTelegramId: (publicKey: string) => (publicKey === telegramWallet ? "222" : null),
      saveUsernameMapping: () => {},
      findTelegramIdByNormalizedUsername: () => null,
    } as any);
    const ctx = makeCtx();

    const res = await gm.formatGameMessage(
      ctx,
      Keypair.generate().publicKey,
      "coinflip",
      1_000_000_000,
      "Wallet creator",
      "Completed",
      "TOK",
      telegramWallet,
      2_000_000_000,
    );

    expect(res.messageText).toContain(`Wallet ${webWallet.slice(0, 4)}…${webWallet.slice(-4)}`);
    expect(res.messageText).toContain(`href="https://timba.cc/players/${webWallet}"`);
    expect(res.messageText).toContain(sanitizeTelegramDisplayName("@user222"));
    expect(res.messageText).toContain("2/2 tickets");
  });

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
    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );
    expect(res.messageText).toContain(sanitizeTelegramDisplayName("@user111"));
    expect(res.messageText).toContain(sanitizeTelegramDisplayName("@user222"));
  });

  test("uses DB preview fetch for huge games and uses on-chain ticket count for omitted total", async () => {
    reset();
    const previewCalls: number[] = [];
    const program = makeProgram({
      ticketsCount: 10_000,
      maxTickets: 10_000,
      minTickets: 2,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    });

    const gm = GameManager.getInstance(program, makeWallet(), {
      getGameParticipants: () => {
        throw new Error("should not load full participant list");
      },
      getGameParticipantsPreview: (_addr: string, limit: number) => {
        previewCalls.push(limit);
        return ["111", "222"];
      },
      getGame: () => ({ token_mint: "M", token_ticker: "TOK" }),
    } as any);

    (gm as any).getUsernameFromTelegramId = async (_ctx: any, telegramId: string) =>
      `@user${telegramId}`;

    const ctx = { chat: { id: 1, type: "group" }, api: {} } as any;
    const gamePda = new PublicKey("11111111111111111111111111111111");

    const res = await gm.formatGameMessage(
      ctx,
      gamePda,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );

    expect(previewCalls.length).toBe(1);
    expect(res.messageText).toContain(sanitizeTelegramDisplayName("@user111"));
    expect(res.messageText).toContain(sanitizeTelegramDisplayName("@user222"));
    expect(res.messageText).toContain("\n… and 9998 more");
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
    const gm = GameManager.getInstance(program, makeWallet(), {
      getGameParticipants: () => participantIds,
      getGame: () => ({ token_mint: "M", token_ticker: "TOK" }),
    } as any);
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
      "TOK",
    );

    expect(res.messageText.length).toBeLessThanOrEqual(4096);
    expect(res.messageText).toMatch(/\n… and \d+ more/);
  });

  test("caps participant processing for huge games", async () => {
    reset();
    const participantIds = Array.from(
      { length: GAME_MESSAGE_PARTICIPANTS_PREVIEW_LIMIT + 5000 },
      (_, i) => String(10_000 + i),
    );
    const program = makeProgram({
      ticketsCount: participantIds.length,
      maxTickets: participantIds.length,
      minTickets: 2,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    });
    const gm = GameManager.getInstance(program, makeWallet(), {
      getGameParticipants: () => participantIds,
      getGame: () => ({ token_mint: "M", token_ticker: "TOK" }),
    } as any);
    let calls = 0;
    (gm as any).getUsernameFromTelegramId = async (_ctx: any, _id: string) => {
      calls += 1;
      return "@u";
    };
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
      "TOK",
    );

    expect(calls).toBeLessThanOrEqual(GAME_MESSAGE_PARTICIPANTS_PREVIEW_LIMIT);
    expect(res.messageText).toMatch(/\n… and \d+ more/);
  });
});
