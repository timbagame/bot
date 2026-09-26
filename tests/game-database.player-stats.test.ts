import { beforeEach, describe, expect, test } from "bun:test";
import { GameDatabase } from "../src/utils/game-database";

const CHAT = -100200300;
const NEW_CHAT = -100200399;

let db: GameDatabase;

beforeEach(() => {
  GameDatabase.resetForTesting();
  db = GameDatabase.getInstance();
});

const playCompletedGame = (
  gameAddress: string,
  options: {
    creator: string;
    creatorKey: string;
    opponent: string;
    opponentKey: string;
    winnerKey: string;
    amount?: number;
    tokenMint?: string;
    totalPot?: number;
    gameType?: string;
  },
) => {
  const amount = options.amount ?? 1_000;
  db.saveGame(
    gameAddress,
    options.creator,
    amount,
    options.gameType ?? "coinflip",
    options.tokenMint ?? "SOL",
    "SOL",
    2,
    2,
    CHAT,
  );
  db.saveGameParticipant(gameAddress, options.creator, options.creatorKey);
  db.saveGameParticipant(gameAddress, options.opponent, options.opponentKey);
  db.completeGame(gameAddress, options.winnerKey, undefined, options.totalPot);
};

describe("GameDatabase.getPlayerGlobalStats", () => {
  test("returns null for players without completed games", () => {
    db.savePlayerMapping("PK_NEW", "NEW_PLAYER");
    expect(db.getPlayerGlobalStats("NEW_PLAYER")).toBeNull();
    expect(db.getPlayerGlobalStats("UNKNOWN")).toBeNull();
  });

  test("aggregates wins, losses, volume and per-token net amounts", () => {
    db.savePlayerMapping("PK_ALICE", "ALICE", "alice");
    db.savePlayerMapping("PK_BOB", "BOB", "bob");

    playCompletedGame("GAME_1", {
      creator: "ALICE",
      creatorKey: "PK_ALICE",
      opponent: "BOB",
      opponentKey: "PK_BOB",
      winnerKey: "PK_ALICE",
      amount: 1_000,
      totalPot: 2_000,
    });
    playCompletedGame("GAME_2", {
      creator: "BOB",
      creatorKey: "PK_BOB",
      opponent: "ALICE",
      opponentKey: "PK_ALICE",
      winnerKey: "PK_BOB",
      amount: 500,
      tokenMint: "MINT_X",
    });
    playCompletedGame("GAME_3", {
      creator: "BOB",
      creatorKey: "PK_BOB",
      opponent: "ALICE",
      opponentKey: "PK_ALICE",
      winnerKey: "PK_ALICE",
      amount: 300,
      tokenMint: "MINT_X",
    });
    // Cancelled and giveaway games never count.
    playCompletedGame("GAME_CANCELLED", {
      creator: "ALICE",
      creatorKey: "PK_ALICE",
      opponent: "BOB",
      opponentKey: "PK_BOB",
      winnerKey: "cancelled",
    });
    playCompletedGame("GAME_GIVEAWAY", {
      creator: "ALICE",
      creatorKey: "PK_ALICE",
      opponent: "BOB",
      opponentKey: "PK_BOB",
      winnerKey: "PK_ALICE",
      gameType: "giveaway",
    });

    const stats = db.getPlayerGlobalStats("ALICE");
    expect(stats).not.toBeNull();
    expect(stats!.telegramId).toBe("ALICE");
    expect(stats!.totalGames).toBe(3);
    expect(stats!.gamesWon).toBe(2);
    expect(stats!.gamesCreated).toBe(1);
    expect(stats!.gamesJoined).toBe(3);
    expect(stats!.totalVolume).toBe(1_800);
    expect(stats!.winRate).toBeCloseTo(66.7, 1);
    expect(stats!.wonAmountByToken?.["SOL"]).toBe(1_000);
    expect(stats!.lostAmountByToken?.["SOL"]).toBe(0);
    expect(stats!.wonAmountByToken?.["MINT_X"]).toBe(300);
    expect(stats!.lostAmountByToken?.["MINT_X"]).toBe(500);
    expect(stats!.netAmountByToken["MINT_X"]).toBe(-200);

    const bob = db.getPlayerGlobalStats("BOB");
    expect(bob!.gamesWon).toBe(1);
    expect(bob!.netAmountByToken["SOL"]).toBe(-1_000);
  });

  test("surfaces query failures through the shared error handler", () => {
    const broken = GameDatabase.getInstance() as any;
    const originalGet = broken.get;
    broken.get = () => {
      throw new Error("db closed");
    };
    try {
      expect(() => db.getPlayerGlobalStats("ALICE")).toThrow("db closed");
    } finally {
      broken.get = originalGet;
    }
  });
});

describe("GameDatabase chat migration and bookkeeping", () => {
  test("migrateChatId moves games, message targets, reservations and pending creations", () => {
    db.saveGame("MIG_GAME", "CREATOR", 1_000, "coinflip", "SOL", "SOL", 2, 2, CHAT);
    db.saveGameMessage("MIG_GAME", 77, CHAT);
    db.reserveGameMessageDelivery("MIG_RESERVED", CHAT);
    db.savePendingGameCreation({
      gameAddress: "MIG_PENDING",
      creatorTelegramId: "CREATOR",
      amount: 1_000,
      gameType: "coinflip",
      tokenMint: "SOL",
      tokenTicker: "SOL",
      maxPlayers: 2,
      minPlayers: 2,
      chatId: CHAT,
      timeoutSeconds: 60,
      expiresAt: Date.now() + 60_000,
      transactionSignature: "SIG",
    });

    db.migrateChatId(CHAT, CHAT);
    expect(db.getGame("MIG_GAME")?.chat_id).toBe(CHAT);

    db.migrateChatId(CHAT, NEW_CHAT);

    expect(db.getGame("MIG_GAME")?.chat_id).toBe(NEW_CHAT);
    expect(db.getGameMessages("MIG_GAME")).toEqual([{ chatId: NEW_CHAT, messageId: 77 }]);
    expect(db.reserveGameMessageDelivery("MIG_RESERVED", CHAT)).toEqual({ acquired: true });
    expect(db.reserveGameMessageDelivery("MIG_RESERVED", NEW_CHAT)).toEqual({
      acquired: false,
      reason: "in-flight",
    });
    expect(db.getPendingGameCreation("MIG_PENDING")?.chat_id).toBe(NEW_CHAT);
  });

  test("releaseGameMessageDelivery frees an in-flight reservation only", () => {
    expect(db.reserveGameMessageDelivery("REL_GAME", CHAT)).toEqual({ acquired: true });
    expect(db.reserveGameMessageDelivery("REL_GAME", CHAT).acquired).toBe(false);
    db.releaseGameMessageDelivery("REL_GAME", CHAT);
    expect(db.reserveGameMessageDelivery("REL_GAME", CHAT)).toEqual({ acquired: true });

    db.completeGameMessageDelivery("REL_GAME", CHAT, 55);
    db.releaseGameMessageDelivery("REL_GAME", CHAT);
    expect(db.reserveGameMessageDelivery("REL_GAME", CHAT)).toEqual({
      acquired: false,
      reason: "sent",
      messageId: 55,
    });
  });

  test("setGameOriginChat updates the stored origin chat", () => {
    db.saveGame("ORIGIN_GAME", "CREATOR", 1_000, "coinflip", "SOL", "SOL", 2, 2, CHAT);
    db.setGameOriginChat("ORIGIN_GAME", NEW_CHAT);
    expect(db.getGame("ORIGIN_GAME")?.chat_id).toBe(NEW_CHAT);
  });

  test("getPendingParticipants lists only pending participants in join order", () => {
    db.saveGame("PEND_GAME", "CREATOR", 1_000, "giveaway", "SOL", "SOL", 10, 2, CHAT);
    db.saveGameParticipant("PEND_GAME", "P1", "PK1", {
      status: "pending",
      joinSignature: "SIG1",
    });
    db.saveGameParticipant("PEND_GAME", "P2", "PK2", { status: "confirmed" });

    const pending = db.getPendingParticipants("PEND_GAME");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      telegram_id: "P1",
      public_key: "PK1",
      join_signature: "SIG1",
      last_verified_at: null,
    });
  });

  test("countActiveGamesByCreator counts only active games", () => {
    expect(db.countActiveGamesByCreator("COUNTER")).toBe(0);
    db.saveGame("ACTIVE_1", "COUNTER", 1_000, "coinflip", "SOL", "SOL", 2, 2, CHAT);
    db.saveGame("ACTIVE_2", "COUNTER", 1_000, "coinflip", "SOL", "SOL", 2, 2, CHAT);
    db.completeGame("ACTIVE_2", "PK");
    expect(db.countActiveGamesByCreator("COUNTER")).toBe(1);
  });

  test("saveMembershipCacheBatch stores every entry for later lookups", () => {
    db.saveMembershipCacheBatch(CHAT, [
      { telegramId: "M1", isMember: true },
      { telegramId: "M2", isMember: false },
    ]);
    const cached = db.getCachedMemberships(CHAT, ["M1", "M2", "M3"]);
    expect(cached.get("M1")).toBe(true);
    expect(cached.get("M2")).toBe(false);
    expect(cached.has("M3")).toBe(false);
  });

  test("saveMembershipCacheBatch swallows storage errors", () => {
    const instance = db as any;
    const originalTransaction = instance.db.transaction;
    instance.db.transaction = () => {
      throw new Error("locked");
    };
    try {
      expect(() =>
        db.saveMembershipCacheBatch(CHAT, [{ telegramId: "M1", isMember: true }]),
      ).not.toThrow();
    } finally {
      instance.db.transaction = originalTransaction;
    }
  });
});
