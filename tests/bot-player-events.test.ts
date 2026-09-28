import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import BN from "bn.js";
import { Keypair } from "#solana";
import { botModule, resetCalls, useBotHarness } from "./helpers/bot-harness";

useBotHarness();

let gameDb: any;
let targets: Map<number, { chatId: number; messageId: number }>;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let updates: string[];
let originalManager: any;

beforeEach(() => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  botModule.__test_clearPendingPlayerEvents();
  botModule.__test_clearPendingGameMessageUpdates();
  updates = [];
  targets = new Map();
  gameDb = {
    updateGameLastSlotWithTimestamp: mock(() => true),
    recordGameParticipantJoined: mock(() => {}),
    recordGameParticipantUnjoined: mock(() => {}),
    getGameMessages: () => [],
    getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
    getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
    getGame: () => ({ game_type: "coinflip", chat_id: 1 }),
  };
  botModule.__test_setGameDatabase(gameDb);
  originalManager = botModule.__test_getGameManager();
  botModule.__test_setGameManager({
    getActiveGameMessages: () => targets,
    updateGameMessageFromData: async (_ctx: unknown, address: string) => {
      updates.push(address);
    },
    getPlayerUsername: async () => "@player",
  } as any);
});

afterEach(() => {
  botModule.__test_clearPendingPlayerEvents();
  botModule.__test_clearPendingGameMessageUpdates();
  botModule.__test_resetGameDatabase();
  botModule.__test_setGameManager(originalManager);
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

const event = async (overrides: Record<string, unknown> = {}) => ({
  gameKey: (await Keypair.generate()).publicKey,
  player: (await Keypair.generate()).publicKey,
  totalAmount: new BN(1000),
  ticketsCount: 2,
  ticketIndex: 1,
  lastSlot: new BN(55),
  timestamp: new BN(1_700_000_000),
  ...overrides,
});

describe("player program events", () => {
  test("a join records the participant and refreshes visible game cards", async () => {
    const joined = await event();
    targets.set(-5, { chatId: -5, messageId: 9 });

    await botModule.__test_handlePlayerJoinedProgramEvent(joined as any);

    const address = joined.gameKey.toString();
    expect(gameDb.updateGameLastSlotWithTimestamp).toHaveBeenCalledWith(
      address,
      "55",
      1_700_000_000,
    );
    expect(gameDb.recordGameParticipantJoined).toHaveBeenCalledWith(
      address,
      joined.player.toString(),
      1,
      2,
    );
    await Bun.sleep(5);
    expect(botModule.__test_getPendingPlayerEventsState(address)).toBeUndefined();
  });

  test("a leave records the moved participant", async () => {
    const moved = (await Keypair.generate()).publicKey;
    const left = await event({ movedParticipant: moved });

    await botModule.__test_handlePlayerUnjoinedProgramEvent(left as any);

    expect(gameDb.recordGameParticipantUnjoined).toHaveBeenCalledWith(
      left.gameKey.toString(),
      left.player.toString(),
      1,
      2,
      moved.toString(),
    );
  });

  test("events for games without a visible card are queued until one appears", async () => {
    const joined = await event();
    const address = joined.gameKey.toString();

    await botModule.__test_handlePlayerJoinedProgramEvent(joined as any);
    expect(botModule.__test_getPendingPlayerEventsState(address)).toBeDefined();

    targets.set(-5, { chatId: -5, messageId: 9 });
    await botModule.__test_handlePlayerJoinedProgramEvent(
      (await event({ gameKey: joined.gameKey, lastSlot: new BN(56) })) as any,
    );
    expect(botModule.__test_getPendingPlayerEventsState(address)).toBeUndefined();
  });

  test("stale events that do not advance the slot are ignored", async () => {
    gameDb.updateGameLastSlotWithTimestamp.mockImplementation(() => false);

    await botModule.__test_handlePlayerJoinedProgramEvent((await event()) as any);

    expect(gameDb.recordGameParticipantJoined).not.toHaveBeenCalled();
  });

  test("failures are logged instead of breaking the listener", async () => {
    gameDb.updateGameLastSlotWithTimestamp.mockImplementation(() => {
      throw new Error("db locked");
    });

    await botModule.__test_handlePlayerUnjoinedProgramEvent((await event()) as any);

    expect(errorSpy.mock.calls[0]?.[0]).toBe("Error processing PlayerUnjoined event:");
  });
});
