import { describe, test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";

function reset() { // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

function makeProgram(game: any) {
  return { account: { game: { fetch: async () => game } } } as any;
}

function makeWallet() {
  return {
    getBlockchainTime: async () => Math.floor(Date.now() / 1000),
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
  } as any;
}

function makeDb() {
  return {
    getGameParticipants: (_addr: string) => ["111", "222"],
    getGame: (_addr: string) => ({ token_mint: "M", token_ticker: "TOK" }),
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
    expect(res.messageText).toContain("@user111");
    expect(res.messageText).toContain("@user222");
  });
});
