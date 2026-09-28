import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import BN from "bn.js";
import { Keypair } from "#solana";
import {
  botModule,
  callsTo,
  failApiMethod,
  resetCalls,
  useBotHarness,
} from "./helpers/bot-harness";

useBotHarness();

const CHAT = -7_700;
let gameAddress: string;
let game: Record<string, unknown> | null;
let chatSettings: Record<string, unknown> | null;
let creatorPublicKey: string | null;
let updates: ReturnType<typeof mock>;
let savedManager: any;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let debugSpy: ReturnType<typeof spyOn>;

const target = { chatId: CHAT, messageId: 42 };

beforeEach(async () => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  debugSpy = spyOn(console, "debug").mockImplementation(() => {});
  gameAddress = (await Keypair.generate()).publicKey.toBase58();
  game = { status: "active", game_type: "coinflip", chat_id: CHAT, amount: 1_000 };
  chatSettings = null;
  creatorPublicKey = null;
  botModule.__test_clearJoinNotificationBuckets();
  botModule.__test_setGameMessageUpdateDebounceMs(1);
  botModule.__test_setGameDatabase({
    getGame: () => game,
    getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
    getCreatorInfo: () => ({ telegramId: null, publicKey: creatorPublicKey }),
    getGameMessages: () => [],
  } as any);
  botModule.__test_setChatDatabase({
    getChatGameSettings: () => chatSettings,
  } as any);
  savedManager = botModule.__test_getGameManager();
  updates = mock(async () => undefined);
  botModule.__test_setGameManager({
    updateGameMessageFromData: updates,
    getPlayerUsername: async () => "<Alice>",
    getActiveGameMessages: () => new Map(),
  } as any);
});

afterEach(() => {
  botModule.__test_clearPendingGameMessageUpdates();
  botModule.__test_clearPendingPlayerEvents();
  botModule.__test_resetGameMessageUpdateDebounceMs();
  botModule.__test_resetGameDatabase();
  botModule.__test_resetChatDatabase();
  botModule.__test_setGameManager(savedManager);
  botModule.__test_clearJoinNotificationBuckets();
  for (const spy of [logSpy, warnSpy, errorSpy, debugSpy]) spy.mockRestore();
});

const joinEvent = async (totalAmount: unknown = new BN(2_500)) => ({
  gameKey: { toString: () => gameAddress },
  player: (await Keypair.generate()).publicKey,
  totalAmount,
  ticketsCount: 1,
  ticketIndex: 0,
  lastSlot: new BN(1),
  timestamp: new BN(1),
});

const settle = () => Bun.sleep(15);

describe("debounced game message updates", () => {
  test("an active game refreshes with the latest pot", async () => {
    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerUnjoined", [
      target,
    ]);
    await settle();

    expect(updates).toHaveBeenCalledTimes(1);
    expect((updates.mock.calls[0] as any[]).slice(1)).toEqual([
      gameAddress,
      "Active",
      undefined,
      2_500,
    ]);
  });

  test("a game completed meanwhile is rendered as completed with its winner", async () => {
    game = { status: "Completed", winner_address: "WinnerKey", total_amount: 9_000 };

    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerUnjoined", [
      target,
    ]);
    await settle();

    expect((updates.mock.calls[0] as any[]).slice(1)).toEqual([
      gameAddress,
      "Completed",
      "WinnerKey",
      2_500,
    ]);
  });

  test("completed games without a known pot fall back to the stored total, then the amount", async () => {
    const unknownPot = { toString: () => "n/a" };

    game = { status: "active", winner_address: "WinnerKey", total_amount: 9_000 };
    await botModule.__test_processPlayerEvent(
      (await joinEvent(unknownPot)) as any,
      "PlayerUnjoined",
      [target],
    );
    await settle();

    game = { status: "completed", amount: 3_000 };
    await botModule.__test_processPlayerEvent(
      (await joinEvent(unknownPot)) as any,
      "PlayerUnjoined",
      [target],
    );
    await settle();

    expect(updates.mock.calls.map((call: any[]) => [call[2], call[3], call[4]])).toEqual([
      ["Completed", "WinnerKey", 9_000],
      ["Completed", undefined, 3_000],
    ]);
  });

  test("nothing is rendered when the game manager goes away before the debounce fires", async () => {
    botModule.__test_setGameMessageUpdateDebounceMs(10);
    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerUnjoined", [
      target,
    ]);
    botModule.__test_setGameManager(undefined as any);
    await Bun.sleep(25);

    expect(updates).not.toHaveBeenCalled();
  });

  test("the debounce hook rejects negative or non-finite values", () => {
    expect(() => botModule.__test_setGameMessageUpdateDebounceMs(-1)).toThrow(
      "Debounce ms must be a finite non-negative number",
    );
    expect(() => botModule.__test_setGameMessageUpdateDebounceMs(Number.NaN)).toThrow();
  });
});

describe("processPlayerEvent guards", () => {
  test("events are dropped while the game manager is not ready", async () => {
    botModule.__test_setGameManager(undefined as any);

    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);

    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      `Game manager not ready to process PlayerJoined event for ${gameAddress}`,
    );
  });

  test("events without message targets are dropped", async () => {
    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", []);

    expect(warnSpy).toHaveBeenCalledWith("No message targets for PlayerJoined event");
    await settle();
    expect(updates).not.toHaveBeenCalled();
  });
});

describe("join announcements", () => {
  const announcements = () =>
    callsTo("sendMessage").filter((call) => String(call.payload.text).includes("joined"));

  test("announcements are off unless the chat enables them", async () => {
    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);
    expect(announcements()).toHaveLength(0);
  });

  test("the origin chat gets an escaped announcement replying to the game card", async () => {
    chatSettings = { join_notifications_per_minute: 5 };
    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);

    expect(announcements()[0]?.payload).toMatchObject({
      chat_id: CHAT,
      text: "👤 <b>&lt;Alice&gt;</b> joined the coinflip!",
      reply_to_message_id: 42,
    });
  });

  test("the creator's own join is not announced", async () => {
    chatSettings = { join_notifications_per_minute: 5 };
    const event = await joinEvent();
    creatorPublicKey = event.player.toBase58();

    await botModule.__test_processPlayerEvent(event as any, "PlayerJoined", [target]);

    expect(announcements()).toHaveLength(0);
  });

  test("announcements stop once a chat's per-minute limit is reached", async () => {
    chatSettings = { join_notifications_per_minute: 1 };

    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);
    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);

    expect(announcements()).toHaveLength(1);
    expect(botModule.__test_getJoinNotificationBucket(CHAT)?.count).toBe(1);
  });

  test("a failed announcement is logged", async () => {
    chatSettings = { join_notifications_per_minute: 5 };
    failApiMethod("sendMessage", "Bad Request: message to reply not found");

    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);

    expect(errorSpy).toHaveBeenCalledWith(
      "Error sending reply to game message:",
      expect.anything(),
    );
  });
});

describe("join announcement edge cases", () => {
  const announcements = () =>
    callsTo("sendMessage").filter((call) => String(call.payload.text).includes("joined"));

  beforeEach(() => {
    chatSettings = { join_notifications_per_minute: 5 };
  });

  test("other chats showing the game are only told when they opt in", async () => {
    const other = { chatId: CHAT - 1, messageId: 7 };

    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [other]);
    expect(announcements()).toHaveLength(0);

    chatSettings = { join_notifications_per_minute: 5, join_notifications_external: true };
    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [other]);
    expect(announcements().map((call) => call.payload.chat_id)).toEqual([CHAT - 1]);
  });

  test("events older than the recorded slot time are skipped", async () => {
    botModule.__test_setGameDatabase({
      getGame: () => game,
      getGameLastSlotWithTimestamp: () => ({ lastSlot: "9", timestamp: 100 }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
    } as any);

    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);
    await settle();

    expect(updates).not.toHaveBeenCalled();
    expect(announcements()).toHaveLength(0);
  });

  test("a failing name lookup only skips the announcement", async () => {
    botModule.__test_setGameManager({
      updateGameMessageFromData: updates,
      getPlayerUsername: async () => {
        throw new Error("rpc down");
      },
    } as any);

    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);
    await settle();

    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      `Error announcing player join for game ${gameAddress}:`,
    );
    expect(updates).toHaveBeenCalledTimes(1);
  });

  test("a failing creator lookup is logged", async () => {
    botModule.__test_setGameDatabase({
      getGame: () => game,
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => {
        throw new Error("db locked");
      },
    } as any);

    await botModule.__test_processPlayerEvent((await joinEvent()) as any, "PlayerJoined", [target]);

    expect(errorSpy.mock.calls[0]?.[0]).toBe(
      `Error processing PlayerJoined for game ${gameAddress}:`,
    );
  });
});

describe("pending player event flushing", () => {
  test("a notify with targets still missing keeps the events and retries later", async () => {
    const event = await joinEvent();
    botModule.__test_enqueuePendingPlayerEvent(gameAddress, {
      event: event as any,
      eventName: "PlayerJoined",
      receivedAt: Date.now(),
    });

    await botModule.__test_flushPendingPlayerEvents(gameAddress, "notify");

    expect(warnSpy).toHaveBeenCalledWith(
      `⚠️ Message targets still unavailable for ${gameAddress}; will retry pending events`,
    );
    const state = botModule.__test_getPendingPlayerEventsState(gameAddress);
    expect(state?.events).toHaveLength(1);
    expect(state?.timer).toBeDefined();
  });

  test("flushing a game with nothing pending does nothing", async () => {
    await botModule.__test_flushPendingPlayerEvents("NothingPending");
    expect(botModule.__test_getPendingPlayerEventsState("NothingPending")).toBeUndefined();
  });
});
