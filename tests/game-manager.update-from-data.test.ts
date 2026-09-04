import { test, expect } from "bun:test";
import { GameManager } from "../src/utils/game";
import { PublicKey } from "#solana";

function resetGM() {
  // @ts-ignore
  GameManager["instance"] = undefined;
}

test("updateGameMessageFromData skips when no game data", async () => {
  resetGM();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const wallet = {} as any;
  const db = { getGame: (_: string) => null } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  let called = false;
  (gm as any).updateGameMessage = async () => {
    called = true;
  };
  const ctx = {
    chat: { id: 1, type: "private" },
    api: { getChatMember: async () => ({ user: { username: "user777" } }) },
  } as any;
  await gm.updateGameMessageFromData(
    ctx,
    new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58(),
  );
  expect(called).toBe(false);
});

test("updateGameMessageFromData forwards fields to updateGameMessage", async () => {
  resetGM();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const wallet = {} as any;
  const db = {
    getGame: (_: string) => ({ game_type: "coinflip", amount: 1_000_000_000, token_ticker: "TOK" }),
  } as any;
  const gm = GameManager.getInstance(program, wallet, db);
  (gm as any).getGameCreatorUsername = async () => "@creator";
  const captured: any[] = [];
  (gm as any).updateGameMessage = async (...args: any[]) => {
    captured.push(args);
  };
  const ctx = {
    chat: { id: 1, type: "private" },
    api: { getChatMember: async () => ({ user: { username: "user777" } }) },
  } as any;
  const addr = new PublicKey("BPFLoader2111111111111111111111111111111111").toBase58();
  await gm.updateGameMessageFromData(ctx, addr, "Completed", "WinnerPubkey", 42);
  expect(captured.length).toBe(1);
  const [pCtx, pAddr, pType, pAmt, pCreator, pStatus, pTicker, pWinner, pTotal] = captured[0];
  expect(pCtx).toBe(ctx);
  expect(pAddr).toBe(addr);
  expect(String(pType).toLowerCase()).toBe("coinflip");
  expect(pAmt).toBe(1_000_000_000);
  expect(pCreator).toBe("@creator");
  expect(pStatus).toBe("Completed");
  expect(pTicker).toBe("TOK");
  expect(pWinner).toBe("WinnerPubkey");
  expect(pTotal).toBe(42);
});
