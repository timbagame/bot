import { expect, test, beforeEach } from "bun:test";
import fc from "fast-check";
import type { GameData } from "../src/types";
import { GameDatabase } from "../src/utils/game-database";
import { GAME_CREATION_RATE_LIMIT_WINDOW_MS } from "../src/utils/constants";
import { resetTestDatabase } from "./helpers/database";

beforeEach(() => {
  resetTestDatabase("games.sqlite");
  GameDatabase.resetForTesting();
});

test("saveGame is idempotent and preserves terminal state during hydration races", () => {
  const db = GameDatabase.getInstance();

  db.saveGame("race-game", "creator-wallet", 100, "coinflip", "mint", "TOK", 2, 2);
  db.completeGame("race-game", "winner-wallet", 1234, 200);

  db.saveGame("race-game", "creator-telegram", 100, "coinflip", "mint", "TOK", 2, 2, 999);

  const game = db.getGame("race-game")!;
  expect(game.creator_telegram_id).toBe("creator-telegram");
  expect(game.chat_id).toBe(999);
  expect(game.status).toBe("completed");
  expect(game.winner_address).toBe("winner-wallet");
  expect(game.completed_at).toBe(1234);
});

test("GameDatabase: CRUD for games, mappings, participants, and slot updates", () => {
  const db = GameDatabase.getInstance();

  // Save a game and basic getters
  db.saveGame("gameA", "tg_creator", 1000, "coinflip", "mintX", "XXX", 8, 2, 12345);
  expect(db.gameExists("gameA")).toBe(true);
  const game = db.getGame("gameA")!;
  expect(game.creator_telegram_id).toBe("tg_creator");
  expect(db.getCreatorTelegramId("gameA")).toBe("tg_creator");

  db.recordGameParticipantJoined("gameA", "pub_creator", 0, 1);
  db.recordGameParticipantJoined("gameA", "pub_p2", 1, 2);
  expect(db.getGameParticipantAddresses("gameA")).toEqual(["pub_creator", "pub_p2"]);
  db.recordGameParticipantJoined("gameA", "pub_p3", 2, 3);
  db.recordGameParticipantUnjoined("gameA", "pub_p2", 1, 2, "pub_p3");
  expect(db.getGameParticipantAddresses("gameA")).toEqual(["pub_creator", "pub_p3"]);

  // Save message/chat ids - chat_id should be preserved from creation
  db.saveGameMessage("gameA", 777, 999);
  const withMsg = db.getGame("gameA")!;
  expect(withMsg.message_id).toBe(777);
  expect(withMsg.chat_id).toBe(12345); // Origin chat_id preserved, not overwritten to 999
  const activeByChat = db.getActiveGamesByChat(12345); // Query by origin chat_id
  expect(activeByChat.map((g) => g.game_address)).toContain("gameA");
  db.clearGameMessage("gameA");
  const clearedMsg = db.getGame("gameA")!;
  expect(clearedMsg.message_id).toBeNull();
  expect(clearedMsg.chat_id).toBe(12345); // chat_id preserved after clear

  // Player mapping roundtrip
  db.savePlayerMapping("pub_creator", "tg_creator", "@astro");
  expect(db.getPlayerTelegramId("pub_creator")).toBe("tg_creator");
  expect(db.getPlayerPublicKey("tg_creator")).toBe("pub_creator");
  expect(db.getAllPlayerMappings().length).toBe(1);
  expect(db.getPlayerDisplayName("tg_creator")).toBe("@astro");

  // Creator info join
  const creatorInfo = db.getCreatorInfo("gameA")!;
  expect(creatorInfo.telegramId).toBe("tg_creator");
  expect(creatorInfo.publicKey).toBe("pub_creator");

  // Participants CRUD
  db.saveGameParticipant("gameA", "tg_creator", "pub_creator");
  db.saveGameParticipant("gameA", "tg_p2", "pub_p2");
  db.saveGameParticipant("gameA", "tg_pending", "pub_pending", {
    status: "pending",
  });
  expect(db.getGameParticipants("gameA")).toEqual(["tg_creator", "tg_p2"]);
  expect(db.getGameParticipantsCount("gameA")).toBe(2);
  expect(db.getGameParticipantsPreview("gameA", 1)).toEqual(["tg_creator"]);
  expect(db.getGameParticipantsPreview("gameA", 100)).toEqual(["tg_creator", "tg_p2"]);
  expect(db.isGameParticipant("gameA", "tg_creator")).toBe(true);
  expect(db.isGameParticipant("gameA", "tg_pending")).toBe(false);
  expect(db.getPlayerParticipatedGames("tg_p2")).toEqual(["gameA"]);
  expect(db.getPlayerTelegramId("pub_pending")).toBe("tg_pending");

  // Active and Recent queries
  const activeForCreator = db.getActiveGames("tg_creator");
  expect(activeForCreator.length).toBe(1);
  expect(db.getActiveGamesByChat(98765).length).toBe(0);

  // Add mapping for participant and mark completion; query recents with mapping
  db.savePlayerMapping("pub_p2", "tg_p2");
  db.completeGame("gameA", "pub_p2", Date.now() - 100);
  const recentWithMap = db.getRecentGames("tg_p2", 10);
  expect(recentWithMap.length).toBe(1);

  // Branch where no public-key mapping exists
  db.saveGame("gameB", "tg_other", 2000, "coinflip");
  db.completeGame("gameB", "pub_w", Date.now());
  const recentNoMap = db.getRecentGames("tg_other", 10);
  expect(recentNoMap.some((g) => g.game_address === "gameB")).toBe(true);

  // Last slot with timestamp updates
  const t1 = Date.now();
  const updated1 = db.updateGameLastSlotWithTimestamp("gameA", "123", t1);
  expect(updated1).toBe(true);
  const tOlder = t1 - 1000;
  const updatedOlder = db.updateGameLastSlotWithTimestamp("gameA", "124", tOlder);
  expect(updatedOlder).toBe(false);
  const last = db.getGameLastSlotWithTimestamp("gameA");
  expect(last.lastSlot).toBe("123");
  expect(typeof last.timestamp).toBe("number");
  expect(db.getGameLastSlot("gameA")).toBe("123");

  // Remove participant and ensure list shrinks
  db.removeGameParticipant("gameA", "tg_p2");
  expect(db.getGameParticipants("gameA")).toEqual(["tg_creator"]);
});

test("getCompletedGameFinance groups completed pots and excludes cancellations", () => {
  const db = GameDatabase.getInstance();
  const now = Date.now();

  db.saveGame("finance-1", "creator", 100, "coinflip", "mint", "TOK");
  db.completeGame("finance-1", "winner", now - 100, 2_000);
  db.recordGameCompletionFinance("finance-1", {
    feeAmountRaw: "20",
    signature: "finance-signature",
    networkFeeLamports: 7_000,
  });
  db.saveGame("finance-2", "creator", 100, "coinflip", "mint", "TOK");
  db.completeGame("finance-2", "winner", now - 50, 3_000);
  db.saveGame("finance-cancelled", "creator", 100, "coinflip", "mint", "TOK");
  db.completeGame("finance-cancelled", "cancelled", now - 25, 4_000);

  expect(db.getCompletedGameFinance(now - 1_000, now + 1)).toEqual([
    {
      tokenMint: "mint",
      tokenTicker: "TOK",
      games: 2,
      exactFeeAmountRaw: "20",
      estimatedTotalAmountRaw: "3000",
      estimatedGames: 1,
      networkFeeLamports: "7000",
      estimatedNetworkTransactions: 1,
    },
  ]);

  expect(db.getGame("finance-1")).toMatchObject({
    fee_amount_raw: "20",
    completion_signature: "finance-signature",
    completion_network_fee_lamports: "7000",
  });
});

test("saveGameMessage preserves origin chat_id when message created in different chat", () => {
  const db = GameDatabase.getInstance();

  // Create game in chat A (simulating game creation in group A)
  const originalChatId = -1001111111111;
  db.saveGame(
    "game_origin",
    "creator_origin",
    100,
    "coinflip",
    "mint",
    "TOK",
    4,
    2,
    originalChatId,
  );

  // Verify game appears in /active for chat A
  const activeInChatA = db.getActiveGamesByChat(originalChatId);
  expect(activeInChatA.map((g) => g.game_address)).toContain("game_origin");

  // Simulate joining from /public in chat B - creates message in different chat
  const differentChatId = -1002222222222;
  db.saveGameMessage("game_origin", 999, differentChatId);

  // Game should still appear in /active for chat A (origin)
  const stillActiveInChatA = db.getActiveGamesByChat(originalChatId);
  expect(stillActiveInChatA.map((g) => g.game_address)).toContain("game_origin");

  // Game should NOT appear in /active for chat B (not created there)
  const notInChatB = db.getActiveGamesByChat(differentChatId);
  expect(notInChatB.map((g) => g.game_address)).not.toContain("game_origin");

  // The game_messages table should track the new message location
  const messages = db.getGameMessages("game_origin");
  expect(messages.some((m) => m.chatId === differentChatId && m.messageId === 999)).toBe(true);
});

test("reserves each game message destination exactly once", () => {
  const db = GameDatabase.getInstance();
  db.saveGame("delivery-game", "creator", 100, "coinflip", "mint", "TOK", 2, 2);

  expect(db.reserveGameMessageDelivery("delivery-game", -1001, 1_000)).toEqual({
    acquired: true,
  });
  expect(db.reserveGameMessageDelivery("delivery-game", -1001, 1_001)).toEqual({
    acquired: false,
    reason: "in-flight",
  });

  db.completeGameMessageDelivery("delivery-game", -1001, 42, 1_002);
  expect(db.reserveGameMessageDelivery("delivery-game", -1001, 1_003)).toEqual({
    acquired: false,
    reason: "sent",
    messageId: 42,
  });
  expect(db.getGameMessages("delivery-game")).toEqual([{ chatId: -1001, messageId: 42 }]);
});

test("persists and retries confirmed game setup records", () => {
  const db = GameDatabase.getInstance();
  db.savePendingGameCreation({
    gameAddress: "pending-game",
    creatorTelegramId: "7",
    creatorDisplayName: "@creator",
    amount: 100,
    gameType: "coinflip",
    tokenMint: "mint",
    tokenTicker: "TOK",
    maxPlayers: 2,
    minPlayers: 2,
    chatId: -1001,
    timeoutSeconds: 3600,
    expiresAt: 3_601_000,
    transactionSignature: "signature",
    now: 1_000,
  });

  expect(db.getPendingGameCreations(1_000)).toHaveLength(1);
  db.recordPendingGameCreationAttempt("pending-game", "RPC unavailable", 2_000, 1_100);
  expect(db.getPendingGameCreations(1_100)).toHaveLength(0);
  expect(db.getPendingGameCreation("pending-game")).toMatchObject({
    state: "confirmed",
    attempts: 1,
    last_error: "RPC unavailable",
    next_attempt_at: 2_000,
  });
  db.clearPendingGameCreation("pending-game");
  expect(db.getPendingGameCreation("pending-game")).toBeNull();
});

test("persists game creation intent before broadcast and keeps its signature immutable", () => {
  const db = GameDatabase.getInstance();
  const input = {
    gameAddress: "durable-game",
    creatorTelegramId: "7",
    amount: 100,
    gameType: "coinflip",
    tokenMint: "mint",
    tokenTicker: "TOK",
    maxPlayers: 2,
    minPlayers: 2,
    chatId: -1001,
    timeoutSeconds: 3600,
    expiresAt: 3_601_000,
    transactionSignature: "prepared-signature",
    state: "prepared" as const,
    isPrivate: true,
    transactionBlockhash: "prepared-blockhash",
    lastValidBlockHeight: 123,
    signedTransactionBase64: "prepared-wire-transaction",
    replyToMessageId: 77,
    onChainCreatedAt: 1_000,
    now: 1_000,
  };

  db.savePendingGameCreation(input);
  expect(db.getPendingGameCreationForCreator("7")).toMatchObject({
    state: "prepared",
    is_private: 1,
    transaction_signature: "prepared-signature",
    transaction_blockhash: "prepared-blockhash",
    last_valid_block_height: 123,
    signed_transaction_base64: "prepared-wire-transaction",
    reply_to_message_id: 77,
    on_chain_created_at: 1_000,
  });

  db.setPendingGameCreationChainTiming("durable-game", 2_000, 3_602_000, 2_000);
  expect(db.getPendingGameCreation("durable-game")).toMatchObject({
    expires_at: 3_602_000,
    on_chain_created_at: 2_000,
  });

  db.saveGame("durable-game", "7", 100, "coinflip", "mint", "TOK", 2, 2);
  db.setGameChainTiming("durable-game", 2_000, 3_602_000);
  expect(db.getGame("durable-game")).toMatchObject({
    created_at: 2_000,
    expires_at: 3_602_000,
  });

  db.setPendingGameCreationState("durable-game", "unknown", {
    error: "confirmation timeout",
    now: 2_000,
  });
  expect(db.getPendingGameCreation("durable-game")).toMatchObject({
    state: "unknown",
    last_error: "confirmation timeout",
    transaction_signature: "prepared-signature",
  });

  expect(() =>
    db.savePendingGameCreation({
      ...input,
      transactionSignature: "different-signature",
    }),
  ).toThrow("different transaction");

  db.setPendingGameCreationState("durable-game", "failed", { now: 3_000 });
  expect(db.getPendingGameCreations(3_000)).toEqual([]);
  expect(db.getPendingGameCreationForCreator("7")).toBeNull();
});

test("submission admission is durable, serialized, and preserves transaction identity", () => {
  const db = GameDatabase.getInstance();
  db.savePendingGameCreation({
    gameAddress: "submission-race",
    creatorTelegramId: "7",
    amount: 100,
    gameType: "coinflip",
    tokenMint: "mint",
    tokenTicker: "TOK",
    maxPlayers: 2,
    minPlayers: 2,
    chatId: -1001,
    timeoutSeconds: 60,
    expiresAt: 61_000,
    transactionSignature: "stable-signature",
    state: "prepared",
    transactionBlockhash: "stable-blockhash",
    lastValidBlockHeight: 100,
    signedTransactionBase64: "stable-wire",
    now: 1_000,
  });

  expect(
    db.claimPendingGameCreationSubmission("submission-race", "worker-a", 5_000, 1_001),
  ).toEqual({ acquired: true });
  expect(db.getPendingGameCreation("submission-race")).toMatchObject({
    state: "submitted",
    submission_lease_id: "worker-a",
    transaction_signature: "stable-signature",
    signed_transaction_base64: "stable-wire",
  });
  expect(
    db.claimPendingGameCreationSubmission("submission-race", "worker-b", 6_000, 1_002),
  ).toMatchObject({ acquired: false, reason: "in-flight" });
  expect(
    db.setPendingGameCreationStateIfCurrent("submission-race", ["submitted"], "failed", {
      now: 1_002,
      clearSubmissionLease: true,
    }),
  ).toBe(false);

  // A crash after admission/broadcast cannot be mistaken for a never-sent
  // prepared record, even if the blockhash lifetime is being resolved.
  expect(db.failPreparedGameCreationIfCurrent("submission-race", "expired", 2_000)).toBe(false);
  expect(db.getPendingGameCreation("submission-race")).toMatchObject({
    state: "submitted",
    transaction_signature: "stable-signature",
    signed_transaction_base64: "stable-wire",
  });

  expect(
    db.finishPendingGameCreationSubmission("submission-race", "worker-a", "unknown", {
      error: "response lost",
      now: 2_001,
    }),
  ).toBe(true);
  expect(db.getPendingGameCreation("submission-race")).toMatchObject({
    state: "unknown",
    submission_lease_id: null,
    transaction_signature: "stable-signature",
    signed_transaction_base64: "stable-wire",
  });
});

test("retry metadata preserves prepared proof and resolves safely after expiry", () => {
  const db = GameDatabase.getInstance();
  db.savePendingGameCreation({
    gameAddress: "prepared-retry",
    creatorTelegramId: "8",
    amount: 100,
    gameType: "giveaway",
    tokenMint: "mint",
    tokenTicker: "TOK",
    maxPlayers: 2,
    minPlayers: 1,
    chatId: -1002,
    timeoutSeconds: 60,
    expiresAt: 61_000,
    transactionSignature: "prepared-retry-signature",
    state: "prepared",
    transactionBlockhash: "prepared-retry-blockhash",
    lastValidBlockHeight: 100,
    signedTransactionBase64: "prepared-retry-wire",
    now: 1_000,
  });

  db.recordPendingGameCreationAttempt("prepared-retry", "temporary RPC read failure", 2_000, 1_100);
  expect(db.getPendingGameCreation("prepared-retry")).toMatchObject({
    state: "prepared",
    attempts: 1,
    last_error: "temporary RPC read failure",
    next_attempt_at: 2_000,
  });
  expect(
    db.failPreparedGameCreationIfCurrent("prepared-retry", "prepared lifetime expired", 3_000),
  ).toBe(true);
  expect(db.getPendingGameCreationForCreator("8")).toBeNull();
  expect(db.getPendingGameCreationAuditRecords("prepared-retry")[0]).toMatchObject({
    state: "failed",
    last_error: "prepared lifetime expired",
  });
});

test("operator resolution is explicit, conditional, and auditable", () => {
  const db = GameDatabase.getInstance();
  db.savePendingGameCreation({
    gameAddress: "operator-resolution",
    creatorTelegramId: "9",
    amount: 100,
    gameType: "coinflip",
    tokenMint: "mint",
    tokenTicker: "TOK",
    maxPlayers: 2,
    minPlayers: 2,
    chatId: -1003,
    timeoutSeconds: 60,
    expiresAt: 61_000,
    transactionSignature: "operator-signature",
    state: "unknown",
    now: 1_000,
  });

  expect(
    db.claimPendingGameCreationSubmission("operator-resolution", "worker-a", 5_000, 1_001),
  ).toEqual({ acquired: true });
  expect(
    db.resolvePendingGameCreation(
      "operator-resolution",
      "submitted",
      "operator must not race an admitted network submission",
      "operator@example",
      1_002,
    ),
  ).toBe(false);
  expect(db.getPendingGameCreation("operator-resolution")?.state).toBe("submitted");
  expect(
    db.finishPendingGameCreationSubmission("operator-resolution", "worker-a", "unknown", {
      error: "response lost",
      now: 1_003,
    }),
  ).toBe(true);

  expect(
    db.resolvePendingGameCreation(
      "operator-resolution",
      "unknown",
      "verified signature has no confirmed transaction and no game account",
      "operator@example",
      2_000,
    ),
  ).toBe(true);
  expect(db.getPendingGameCreationForCreator("9")).toBeNull();
  expect(db.getPendingGameCreation("operator-resolution")).toMatchObject({
    state: "failed",
    resolution_reason: "verified signature has no confirmed transaction and no game account",
    resolved_by: "operator@example",
    resolved_at: 2_000,
  });
  expect(
    db.resolvePendingGameCreation("operator-resolution", "unknown", "stale retry", "another"),
  ).toBe(false);
});

test("GameDatabase orders active game listings by earliest expiration first", () => {
  const db = GameDatabase.getInstance();
  const now = Date.now();
  const chatId = 123;
  const publicChatId = -999;

  db.saveGame(
    "gameSoon",
    "creator_1",
    100,
    "coinflip",
    "mint",
    "TOK",
    4,
    2,
    chatId,
    undefined,
    now + 10_000,
  );
  db.saveGame(
    "gameLater",
    "creator_2",
    200,
    "coinflip",
    "mint",
    "TOK",
    4,
    2,
    chatId,
    undefined,
    now + 20_000,
  );
  db.saveGame("gameNoExpiry", "creator_3", 300, "coinflip", "mint", "TOK", 4, 2, chatId);

  const activeInChat = db.getActiveGamesByChat(chatId);
  expect(activeInChat.map((game) => game.game_address)).toEqual([
    "gameSoon",
    "gameLater",
    "gameNoExpiry",
  ]);

  db.saveGame(
    "publicSoon",
    "creator_4",
    400,
    "coinflip",
    "mint",
    "TOK",
    4,
    2,
    publicChatId,
    undefined,
    now + 5_000,
  );
  db.saveGame(
    "publicLater",
    "creator_5",
    500,
    "coinflip",
    "mint",
    "TOK",
    4,
    2,
    publicChatId,
    undefined,
    now + 15_000,
  );
  db.saveGame("publicNoExpiry", "creator_6", 600, "coinflip", "mint", "TOK", 4, 2, publicChatId);

  const activePublic = db.getAllActivePublicGames();
  expect(activePublic.map((game) => game.game_address)).toEqual([
    "publicSoon",
    "publicLater",
    "publicNoExpiry",
  ]);
});

test("updateGameLastSlotWithTimestamp accepts equal timestamp updates", () => {
  const db = GameDatabase.getInstance();

  db.saveGame("slotGame", "creator_slot", 100, "coinflip");
  const now = Date.now();

  const first = db.updateGameLastSlotWithTimestamp("slotGame", "111", now);
  expect(first).toBe(true);

  const second = db.updateGameLastSlotWithTimestamp("slotGame", "222", now);
  expect(second).toBe(true);

  const last = db.getGameLastSlotWithTimestamp("slotGame");
  expect(last.lastSlot).toBe("222");
  expect(last.timestamp).toBe(now);
});

test("updateGameLastSlotWithTimestamp ignores duplicate slot updates", () => {
  const db = GameDatabase.getInstance();

  db.saveGame("dupSlotGame", "creator_dup", 100, "coinflip");
  const now = Date.now();

  const firstUpdate = db.updateGameLastSlotWithTimestamp("dupSlotGame", "555", now);
  expect(firstUpdate).toBe(true);

  const duplicateUpdate = db.updateGameLastSlotWithTimestamp("dupSlotGame", "555", now);
  expect(duplicateUpdate).toBe(false);

  const last = db.getGameLastSlotWithTimestamp("dupSlotGame");
  expect(last.lastSlot).toBe("555");
  expect(last.timestamp).toBe(now);
});

test("savePlayerMapping normalizes inputs and ignores blanks", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;

  db.savePlayerMapping("  pub_key  ", "  555  ", "  Astro  ");
  const mappings = db.getAllPlayerMappings();
  expect(mappings.length).toBe(1);
  const mapping = mappings[0]!;
  expect(mapping.public_key).toBe("pub_key");
  expect(mapping.telegram_id).toBe("555");

  const stored = sqlite
    .prepare(
      "SELECT public_key, telegram_id, display_name FROM player_mappings WHERE public_key = ?",
    )
    .get("pub_key");
  expect(stored.display_name).toBe("Astro");
  expect(db.getPlayerDisplayName("555")).toBe("Astro");
  expect(db.getPlayerPublicKey("555")).toBe("pub_key");
  expect(db.getPlayerTelegramId("pub_key")).toBe("555");

  db.savePlayerMapping("   ", "777");
  db.savePlayerMapping("valid", "   ");
  expect(db.getAllPlayerMappings().length).toBe(1);
});

test("getGamesExpiringBefore returns games with zero and large timeouts", () => {
  const db = GameDatabase.getInstance();
  const now = Date.now();
  const zeroAddress = "game_zero_expiry";
  const largeAddress = "game_large_expiry";

  db.saveGame(
    zeroAddress,
    "creator_zero",
    100,
    "coinflip",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    0,
    now,
  );

  const hugeTimeoutSeconds = 1_000_000_000;
  db.saveGame(
    largeAddress,
    "creator_large",
    200,
    "coinflip",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    hugeTimeoutSeconds,
    now + hugeTimeoutSeconds * 1000,
  );

  const immediate = db.getGamesExpiringBefore(now + 1000);
  expect(immediate.map((g) => g.game_address)).toContain(zeroAddress);

  const farFuture = now + hugeTimeoutSeconds * 1000 + 1_000;
  const farResults = db.getGamesExpiringBefore(farFuture);
  expect(farResults.map((g) => g.game_address)).toContain(largeAddress);
});

test("getGamesExpiringBefore can paginate large batches by excluding processed entries", () => {
  const db = GameDatabase.getInstance();
  const base = Date.now();
  const total = 60;
  const addresses = [];
  for (let i = 0; i < total; i += 1) {
    const addr = `paginated-${i}`;
    addresses.push(addr);
    db.saveGame(
      addr,
      `creator-${i}`,
      50,
      "coinflip",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      10,
      base,
    );
  }

  const seen = new Set<string>();
  const limit = 15;
  let batch: GameData[];
  const excludes: string[] = [];
  do {
    batch = db.getGamesExpiringBefore(base + 1000, limit, excludes);
    for (const game of batch) {
      seen.add(game.game_address);
      excludes.push(game.game_address);
    }
  } while (batch.length === limit);

  expect(seen.size).toBe(total);
});

test("getGamesExpiringBefore honors excludes and fills with oldest non-expiring", () => {
  const db = GameDatabase.getInstance();
  const now = Date.now();

  db.saveGame(
    "exp-1",
    "creator",
    50,
    "coinflip",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    15,
    now + 500,
  );
  db.saveGame(
    "exp-2",
    "creator",
    50,
    "coinflip",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    15,
    now + 800,
  );
  db.saveGame("no-exp-1", "creator", 50, "coinflip");
  db.saveGame("no-exp-2", "creator", 50, "coinflip");

  const results = db.getGamesExpiringBefore(now + 1_000, 3, ["exp-1"]);

  expect(results.map((g) => g.game_address)).toEqual(["exp-2", "no-exp-1", "no-exp-2"]);
});

test("findTelegramIdByUsername normalizes usernames", () => {
  const db = GameDatabase.getInstance();

  db.savePlayerMapping("pk_old", "111", "@CaseUser");
  db.savePlayerMapping("pk_new", "222", "caseuser");
  db.savePlayerMapping("pk_other", "333", "@otherUser");
  db.savePlayerMapping("pk_plain", "444", "alice");
  db.saveUsernameMapping("caseuser", "111", "@CaseUser");
  db.saveUsernameMapping("otheruser", "333", "@otherUser");

  expect(db.findTelegramIdByUsername("@CASEUSER")).toBe("111");
  expect(db.findTelegramIdByUsername("caseuser")).toBe("111");
  expect(db.findTelegramIdByUsername("otheruser")).toBe("333");
  expect(db.findTelegramIdByUsername("@alice")).toBeNull();
  expect(db.findTelegramIdByUsername("@missing")).toBeNull();
  expect(db.findTelegramIdByUsername("   ")).toBeNull();
});

test("saved display names never resolve accounts", () => {
  const db = GameDatabase.getInstance();
  db.savePlayerMapping("fictional-attacker-wallet", "222", "@victim");

  expect(db.getPlayerDisplayName("222")).toBe("@victim");
  expect(db.findTelegramIdByUsername("@victim")).toBeNull();
  expect(db.findTelegramIdByUsername("victim")).toBeNull();
});

test("arbitrary display names cannot claim or replace a verified username", () => {
  const db = GameDatabase.getInstance();
  let caseId = 0;
  fc.assert(
    fc.property(fc.stringMatching(/^[a-z][a-z0-9_]{4,15}$/), (handle) => {
      // A unique suffix keeps prior generated verified mappings out of this case.
      const username = `${handle}_${caseId++}`;
      db.savePlayerMapping(`attacker-${username}`, "222", `  @${username.toUpperCase()}  `);
      expect(db.findTelegramIdByUsername(` @${username} `)).toBeNull();

      db.saveUsernameMapping(username, "111", `@${username}`);
      db.savePlayerMapping(`new-attacker-${username}`, "333", `@${username}`);
      expect(db.findTelegramIdByUsername(` @${username.toUpperCase()} `)).toBe("111");
    }),
    { numRuns: 100 },
  );
});

test("username mapping lookup persists normalized usernames", () => {
  const db = GameDatabase.getInstance();

  db.saveUsernameMapping("caseuser", "888", "@CaseUser");

  expect(db.findTelegramIdByNormalizedUsername("caseuser")).toBe("888");
  expect(db.findTelegramIdByNormalizedUsername("CaseUser")).toBe("888");
  expect(db.findTelegramIdByUsername("@CASEUSER")).toBe("888");
  expect(db.findTelegramIdByUsername("@missing")).toBeNull();
});

test("renames remove old handles and stale invalidations preserve new owners", () => {
  const db = GameDatabase.getInstance();
  db.saveUsernameMapping("old", "111");
  db.saveUsernameMapping("new", "111");
  expect(db.findTelegramIdByUsername("@old")).toBeNull();
  expect(db.findTelegramIdByUsername("@new")).toBe("111");
  db.saveUsernameMapping("new", "222");
  db.deleteUsernameMapping("new", "111");
  expect(db.findTelegramIdByUsername("@new")).toBe("222");
  db.deleteUsernameMappingsForTelegramId("222");
  expect(db.findTelegramIdByUsername("@new")).toBeNull();
});

test("a failed rename rolls back removal of the old username", () => {
  const db = GameDatabase.getInstance();
  db.saveUsernameMapping("old", "111");
  const sqlite = (db as any).db;
  sqlite.exec(
    "CREATE TRIGGER fail_username BEFORE INSERT ON username_mappings BEGIN SELECT RAISE(ABORT, 'synthetic-save-failed'); END",
  );
  expect(() => db.saveUsernameMapping("new", "111")).toThrow("synthetic-save-failed");
  expect(db.findTelegramIdByUsername("@old")).toBe("111");
  expect(db.findTelegramIdByUsername("@new")).toBeNull();
});

test("getPlayerTelegramId prioritizes confirmed participants over pending fallback", () => {
  const db = GameDatabase.getInstance();

  db.saveGame("pendingGame", "creator_pending", 100, "coinflip");
  db.saveGameParticipant("pendingGame", "tg_pending", "pub_shared", {
    status: "pending",
  });

  expect(db.getPlayerTelegramId("pub_shared")).toBe("tg_pending");

  db.saveGame("confirmedGame", "creator_confirmed", 100, "coinflip");
  db.saveGameParticipant("confirmedGame", "tg_confirmed", "pub_shared", {
    status: "confirmed",
  });

  expect(db.getPlayerTelegramId("pub_shared")).toBe("tg_confirmed");

  db.saveGame("pendingLater", "creator_pending2", 100, "coinflip");
  db.saveGameParticipant("pendingLater", "tg_pending2", "pub_shared", {
    status: "pending",
  });

  expect(db.getPlayerTelegramId("pub_shared")).toBe("tg_confirmed");
});

test("saveGameParticipant preserves confirmed status when pending write races", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;

  db.saveGame("raceGame", "creator_race", 100, "coinflip");

  db.saveGameParticipant("raceGame", "tg_race", "pub_race", {
    status: "pending",
    joinSignature: "sig_pending",
  });

  const verifiedAt = Date.now();
  db.saveGameParticipant("raceGame", "tg_race", "pub_race", {
    status: "confirmed",
    joinSignature: "sig_confirmed",
    lastVerifiedAt: verifiedAt,
  });

  db.saveGameParticipant("raceGame", "tg_race", "pub_race", {
    status: "pending",
  });

  const row = sqlite
    .prepare(
      "SELECT status, join_signature, last_verified_at FROM game_participants WHERE game_address = ? AND telegram_id = ?",
    )
    .get("raceGame", "tg_race");

  expect(row.status).toBe("confirmed");
  expect(row.join_signature).toBe("sig_confirmed");
  expect(row.last_verified_at).toBeGreaterThanOrEqual(verifiedAt);
});

test("GameDatabase read helpers return safe defaults on errors", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;
  const originalPrepare = sqlite.prepare.bind(sqlite);

  sqlite.prepare = () => {
    throw new Error("boom");
  };

  expect(db.getGamesByCreator(123n)).toEqual([]);
  expect(db.getGamesByPlayer(456n)).toEqual([]);
  expect(db.getPlayer("789")).toBeNull();

  sqlite.prepare = originalPrepare;
});

test("countRecentGamesByCreator respects rate-limit window boundaries", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;

  const creator = "creator_123";
  db.saveGame("game_old", creator, 100, "coinflip");
  db.saveGame("game_window_edge", creator, 150, "coinflip");
  db.saveGame("game_recent", creator, 200, "coinflip");

  const now = Date.now();
  const windowStart = now - GAME_CREATION_RATE_LIMIT_WINDOW_MS;

  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(windowStart - 1, "game_old");
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(windowStart, "game_window_edge");
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(windowStart + 1, "game_recent");

  const inclusiveCount = db.countRecentGamesByCreator(creator, windowStart);
  expect(inclusiveCount).toBe(2);

  const afterWindowCount = db.countRecentGamesByCreator(creator, windowStart + 1);
  expect(afterWindowCount).toBe(1);
});

test("cleanupOldGames deletes games and participants older than specified days", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;

  const now = Date.now();
  const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
  const twentyNineDaysAgo = now - 29 * 24 * 60 * 60 * 1000;

  // Create old game (31 days ago)
  db.saveGame("old_game", "creator_old", 100, "coinflip");
  db.saveGameParticipant("old_game", "participant_old", "pk_old");
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(thirtyOneDaysAgo, "old_game");

  // Create recent game (29 days ago)
  db.saveGame("recent_game", "creator_recent", 200, "coinflip");
  db.saveGameParticipant("recent_game", "participant_recent", "pk_recent");
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(twentyNineDaysAgo, "recent_game");

  // Verify both exist before cleanup
  expect(db.gameExists("old_game")).toBe(true);
  expect(db.gameExists("recent_game")).toBe(true);
  expect(db.getGameParticipants("old_game").length).toBe(1);
  expect(db.getGameParticipants("recent_game").length).toBe(1);

  // Run cleanup for 30 days
  const result = db.cleanupOldGames(30);

  // Old game should be deleted
  expect(db.gameExists("old_game")).toBe(false);
  expect(db.getGameParticipants("old_game").length).toBe(0);

  // Recent game should still exist
  expect(db.gameExists("recent_game")).toBe(true);
  expect(db.getGameParticipants("recent_game").length).toBe(1);

  // Verify returned counts
  expect(result.gamesDeleted).toBe(1);
  expect(result.participantsDeleted).toBe(1);
});

test("replacement survives restart and fences stale workers and concurrent replacements", () => {
  let db = GameDatabase.getInstance();
  db.savePendingGameCreation({
    gameAddress: "refresh",
    creatorTelegramId: "1",
    amount: 1,
    gameType: "coinflip",
    tokenMint: "mint",
    tokenTicker: "TOK",
    maxPlayers: 2,
    minPlayers: 2,
    chatId: 1,
    timeoutSeconds: 60,
    expiresAt: 90000,
    transactionSignature: "old",
    state: "unknown",
    transactionBlockhash: "old-hash",
    lastValidBlockHeight: 100,
    signedTransactionBase64: "old-wire",
    now: 1000,
  });
  db.saveCreationRecoveryCheckpoint("refresh", "old", "saved-progress");
  db = new (GameDatabase as any)();
  expect(db.getPendingGameCreation("refresh")?.recovery_checkpoint).toBe("saved-progress");
  const replacement = {
    signature: "new",
    blockhash: "new-hash",
    lastValidBlockHeight: 200,
    wire: "new-wire",
  };
  db.claimPendingGameCreationSubmission("refresh", "sender", 3000, 1001, "old");
  expect(db.replaceExpiredGameCreation("refresh", "old", replacement, 2000)).toBe(false);
  db.finishPendingGameCreationSubmission("refresh", "sender", "unknown", { now: 2000 });
  db.setPendingCreationMessage("refresh", 99);
  expect(db.replaceExpiredGameCreation("refresh", "old", replacement, 2001)).toBe(true);
  expect(db.replaceExpiredGameCreation("refresh", "old", replacement, 2002)).toBe(false);
  db = new (GameDatabase as any)(); // Reopen the same SQLite file without the test reset's deletion.
  expect(db.getPendingGameCreation("refresh")).toMatchObject({
    state: "prepared",
    transaction_signature: "new",
    signed_transaction_base64: "new-wire",
    replacement_count: 1,
    creation_message_id: 99,
    recovery_checkpoint: null,
  });
  expect(JSON.parse(db.getPendingGameCreation("refresh")!.replacement_history!)[0].signature).toBe(
    "old",
  );
  expect(
    db.claimPendingGameCreationSubmission("refresh", "stale", 4000, 2002, "old"),
  ).toMatchObject({ acquired: false, reason: "replaced" });
  expect(db.claimPendingGameCreationSubmission("refresh", "fresh", 4000, 2002, "new")).toEqual({
    acquired: true,
  });
  db.finishPendingGameCreationSubmission("refresh", "fresh", "unknown", { now: 2003 });
  db.saveCreationRecoveryCheckpoint("refresh", "old", "stale-progress");
  expect(db.getPendingGameCreation("refresh")?.recovery_checkpoint).toBeNull();
  expect(
    db.setPendingGameCreationStateIfCurrent("refresh", ["unknown"], "failed", {
      expectedSignature: "old",
      now: 2004,
    }),
  ).toBe(false);
  expect(
    db.replaceExpiredGameCreation("refresh", "new", { ...replacement, signature: "third" }, 2004),
  ).toBe(false);
});

test("a saved challenge reads back by game address and unknown games have none", () => {
  const db = GameDatabase.getInstance();

  db.saveGameChallenge("challenge_game", { telegramId: "5150", displayName: "@rival" }, 1_700);

  expect(db.getGameChallenge("challenge_game")).toEqual({
    telegramId: "5150",
    displayName: "@rival",
  });
  expect(db.getGameChallenge("open_game")).toBeNull();
});

test("a game's challenged player cannot be replaced", () => {
  const db = GameDatabase.getInstance();
  db.saveGameChallenge("challenge_game", { telegramId: "5150", displayName: "@rival" });

  expect(() =>
    db.saveGameChallenge("challenge_game", { telegramId: "6160", displayName: "@intruder" }),
  ).toThrow();
  expect(db.getGameChallenge("challenge_game")).toEqual({
    telegramId: "5150",
    displayName: "@rival",
  });
});

test("cleanupOldGames drops the challenges of the games it deletes only", () => {
  const db = GameDatabase.getInstance();
  const sqlite: any = (db as any).db;
  const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;

  db.saveGame("old_challenge", "creator_old", 100, "coinflip");
  db.saveGameChallenge("old_challenge", { telegramId: "5150", displayName: "@old" });
  sqlite
    .prepare("UPDATE games SET created_at = ? WHERE game_address = ?")
    .run(thirtyOneDaysAgo, "old_challenge");
  db.saveGame("live_challenge", "creator_live", 100, "coinflip");
  db.saveGameChallenge("live_challenge", { telegramId: "6160", displayName: "@live" });

  db.cleanupOldGames(30);

  expect(db.getGameChallenge("old_challenge")).toBeNull();
  expect(db.getGameChallenge("live_challenge")).toEqual({
    telegramId: "6160",
    displayName: "@live",
  });
});

test("cleanupOldGames drops old challenges whose game was never created", () => {
  const db = GameDatabase.getInstance();
  const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;

  db.saveGameChallenge(
    "failed_creation",
    { telegramId: "5150", displayName: "@old" },
    thirtyOneDaysAgo,
  );
  db.saveGameChallenge("creating_now", { telegramId: "6160", displayName: "@new" });

  db.cleanupOldGames(30);

  expect(db.getGameChallenge("failed_creation")).toBeNull();
  expect(db.getGameChallenge("creating_now")).toEqual({
    telegramId: "6160",
    displayName: "@new",
  });
});
