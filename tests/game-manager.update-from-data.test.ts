import { test, expect, vi } from "bun:test";
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

test("updateGameMessageFromData does not let a stale active update overwrite a terminal game", async () => {
  resetGM();
  const program = { account: { game: { fetch: async () => ({}) } } } as any;
  const db = {
    getGame: (_: string) => ({
      game_type: "coinflip",
      amount: 1_000_000_000,
      token_ticker: "TOK",
      status: "completed",
      winner_address: "cancelled",
      total_amount: 2_000_000_000,
    }),
  } as any;
  const gm = GameManager.getInstance(program, {} as any, db);
  (gm as any).getGameCreatorUsername = async () => "@creator";
  const captured: any[] = [];
  (gm as any).updateGameMessage = async (...args: any[]) => captured.push(args);

  await gm.updateGameMessageFromData({} as any, "terminal-game", "Active");

  expect(captured).toHaveLength(1);
  expect(captured[0][5]).toBe("Completed");
  expect(captured[0][7]).toBe("cancelled");
  expect(captured[0][8]).toBe(2_000_000_000);
});

test("updateGameMessageFromData renders terminal state when it is persisted during lookup", async () => {
  resetGM();
  const gameAddress = new PublicKey("BPFLoader5111111111111111111111111111111111").toBase58();
  const gameData: any = {
    game_type: "coinflip",
    amount: 1_000_000_000,
    token_ticker: "TOK",
    status: "active",
    total_amount: 1_000_000_000,
  };
  const db = {
    getGame: () => ({ ...gameData }),
    getGameMessages: () => [],
  } as any;
  const gm = GameManager.getInstance(
    { account: { game: { fetch: async () => ({}) } } } as any,
    {} as any,
    db,
  );
  const formatCalls: string[] = [];
  (gm as any).formatGameMessage = vi.fn(async (...args: any[]) => {
    formatCalls.push(args[5]);
    return { messageText: `status=${args[5]}`, keyboard: [] };
  });

  let releaseUsername!: () => void;
  const usernameReady = new Promise<void>((resolve) => {
    releaseUsername = resolve;
  });
  (gm as any).getGameCreatorUsername = async () => {
    await usernameReady;
    return "@creator";
  };
  (gm as any).activeGameMessages.set(
    gameAddress,
    new Map([[1, { messageId: 42, chatId: 1, usesVideo: false }]]),
  );
  const editMessageText = vi.fn().mockResolvedValue(undefined);
  const ctx = { chat: { id: 1 }, api: { editMessageText } } as any;

  const update = gm.updateGameMessageFromData(ctx, gameAddress, "Active");
  await Promise.resolve();
  gameData.status = "completed";
  gameData.winner_address = "WinnerPubkey";
  gameData.total_amount = 2_000_000_000;
  releaseUsername();
  await update;

  expect(formatCalls).toEqual(["Completed"]);
  expect(editMessageText).toHaveBeenCalledTimes(1);
  expect(editMessageText.mock.calls[0]?.[2]).toContain("status=Completed");
});

test("stale active work cannot erase a richer completion update", async () => {
  resetGM();
  const gameAddress = new PublicKey("BPFLoader6111111111111111111111111111111111").toBase58();
  const gameData: any = {
    game_type: "coinflip",
    amount: 1,
    token_ticker: "TOK",
    status: "active",
    total_amount: 1,
  };
  const db = {
    getGame: () => ({ ...gameData }),
  } as any;
  const gm = GameManager.getInstance(
    { account: { game: { fetch: async () => ({}) } } } as any,
    {} as any,
    db,
  );

  let releaseFirstLookup!: () => void;
  let firstLookupStarted!: () => void;
  const firstLookupReady = new Promise<void>((resolve) => {
    firstLookupStarted = resolve;
  });
  const firstLookupRelease = new Promise<void>((resolve) => {
    releaseFirstLookup = resolve;
  });
  let lookupCount = 0;
  (gm as any).getGameCreatorUsername = async () => {
    lookupCount += 1;
    if (lookupCount === 1) {
      firstLookupStarted();
      await firstLookupRelease;
    }
    return "@creator";
  };

  (gm as any).formatGameMessage = vi.fn(async (...args: any[]) => ({
    messageText: `status=${args[5]} total=${args[8]} signature=${args[9] ?? "none"}`,
    keyboard: [],
  }));
  (gm as any).activeGameMessages.set(
    gameAddress,
    new Map([[707, { messageId: 808, chatId: 707, usesVideo: false }]]),
  );
  const editMessageText = vi.fn().mockResolvedValue(undefined);
  const ctx = { chat: { id: 707 }, api: { editMessageText } } as any;

  const staleActiveUpdate = gm.updateGameMessageFromData(ctx, gameAddress, "Active", undefined, 1);
  await firstLookupReady;

  gameData.status = "completed";
  gameData.winner_address = "WinnerPubkey";
  gameData.total_amount = 2;

  const completionUpdate = gm.updateGameMessageFromData(
    ctx,
    gameAddress,
    "Completed",
    "WinnerPubkey",
    2,
    "CONFIRMED_SIGNATURE",
  );
  await completionUpdate;

  releaseFirstLookup();
  await staleActiveUpdate;

  expect(editMessageText).toHaveBeenCalledTimes(1);
  expect(editMessageText.mock.calls[0]?.[2]).toBe(
    "status=Completed total=2 signature=CONFIRMED_SIGNATURE",
  );
});

test("an older completion cannot erase a newer completion signature", async () => {
  resetGM();
  const gameAddress = new PublicKey("BPFLoader7111111111111111111111111111111111").toBase58();
  const gameData: any = {
    game_type: "coinflip",
    amount: 1,
    token_ticker: "TOK",
    status: "completed",
    winner_address: "WinnerPubkey",
    total_amount: 2,
  };
  const db = {
    getGame: () => ({ ...gameData }),
    recordGameCompletionFinance: (_address: string, finance: { signature?: string }) => {
      gameData.completion_signature = finance.signature;
    },
  } as any;
  const gm = GameManager.getInstance(
    { account: { game: { fetch: async () => ({}) } } } as any,
    {} as any,
    db,
  );

  let releaseFirstLookup!: () => void;
  let firstLookupStarted!: () => void;
  const firstLookupReady = new Promise<void>((resolve) => {
    firstLookupStarted = resolve;
  });
  const firstLookupRelease = new Promise<void>((resolve) => {
    releaseFirstLookup = resolve;
  });
  let lookupCount = 0;
  (gm as any).getGameCreatorUsername = async () => {
    lookupCount += 1;
    if (lookupCount === 1) {
      firstLookupStarted();
      await firstLookupRelease;
    }
    return "@creator";
  };

  (gm as any).formatGameMessage = vi.fn(async (...args: any[]) => ({
    messageText: `status=${args[5]} total=${args[8]} signature=${args[9] ?? "none"}`,
    keyboard: [],
  }));
  (gm as any).activeGameMessages.set(
    gameAddress,
    new Map([[707, { messageId: 808, chatId: 707, usesVideo: false }]]),
  );
  const editMessageText = vi.fn().mockResolvedValue(undefined);
  const ctx = { chat: { id: 707 }, api: { editMessageText } } as any;

  const olderCompletion = gm.updateGameMessageFromData(
    ctx,
    gameAddress,
    "Completed",
    "WinnerPubkey",
    2,
    "STALE_SIGNATURE",
  );
  await firstLookupReady;

  const newerCompletion = gm.updateGameMessageFromData(
    ctx,
    gameAddress,
    "Completed",
    "WinnerPubkey",
    2,
    "CONFIRMED_SIGNATURE",
  );
  await newerCompletion;

  releaseFirstLookup();
  await olderCompletion;

  expect(editMessageText).toHaveBeenCalledTimes(1);
  expect(editMessageText.mock.calls[0]?.[2]).toBe(
    "status=Completed total=2 signature=CONFIRMED_SIGNATURE",
  );
  expect(gameData.completion_signature).toBe("CONFIRMED_SIGNATURE");
});
