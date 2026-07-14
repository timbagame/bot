import { test, expect } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import { GameManager } from "../src/utils/game";

function reset() {
  // reset singleton
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("formatGameMessage omits winner line when cancelled", async () => {
  reset();
  const program = {
    account: {
      game: {
        fetch: async () => ({
          ticketsCount: 0,
          maxTickets: 2,
          minTickets: 1,
          createdAt: 1_000_000,
          timeout: 60,
        }),
      },
    },
  } as any;
  const wallet = {
    getBlockchainTime: async () => 1_000_030,
    formatTokenBalance: (n: number, d: number) => (n / Math.pow(10, d)).toFixed(0),
  } as any;
  const db = {
    getGameParticipants: () => [],
    getGame: () => ({ token_ticker: "TOK", game_type: "coinflip", winner_address: "cancelled" }),
  } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  const ctx = {
    chat: { id: 1, type: "private" },
    api: { getChatMember: async () => ({ user: { username: "user1" } }) },
  } as any;
  const res = await gm.formatGameMessage(
    ctx,
    new PublicKey("11111111111111111111111111111111"),
    "coinflip",
    1_000_000_000,
    "@creator",
    "Completed",
    "TOK",
    "cancelled",
  );
  expect(res.messageText).not.toContain("Winner:");
  expect(res.keyboard.length).toBe(0);
});
