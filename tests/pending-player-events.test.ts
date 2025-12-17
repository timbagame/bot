import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

process.env.TELEGRAM_TOKEN =
  process.env.TELEGRAM_TOKEN ?? "TEST_TELEGRAM_TOKEN";
process.env.MNEMONIC =
  process.env.MNEMONIC ??
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
process.env.SOLANA_NETWORK =
  process.env.SOLANA_NETWORK ?? "http://localhost:8899";

const botModulePromise = import("../src/bot");

describe("Pending player events", () => {
  let botModule: Awaited<typeof botModulePromise>;
  let originalSendMessage: any;
  let sendCalls: Array<{ chatId: number; text: string; options: any }>;

  beforeEach(async () => {
    botModule = await botModulePromise;
    sendCalls = [];

    originalSendMessage = botModule.bot.api.sendMessage.bind(botModule.bot.api);
    (botModule.bot.api as any).sendMessage = async (
      chatId: number,
      text: string,
      options: any
    ) => {
      sendCalls.push({ chatId, text, options });
      return { ok: true, result: { message_id: 999 } } as any;
    };

    botModule.__test_clearPendingPlayerEvents();
    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "<script>alert(1)</script>",
      getActiveGameMessages: () => {
        const m = new Map();
        m.set(77, { chatId: 77, messageId: 301 });
        return m;
      },
    } as any);
    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGameMessages: () => [],
    } as any);
  });

  afterEach(async () => {
    const module = await botModulePromise;
    (module.bot.api as any).sendMessage = originalSendMessage;
    module.__test_clearPendingPlayerEvents();
    module.__test_resetGameMessageUpdateDebounceMs?.();
    module.__test_resetJoinAnnouncementMaxTickets?.();
    module.__test_resetGameDatabase?.();
  });

  const baseGameKey = Keypair.generate().publicKey;

  const makePlayerEvent = (
    player: PublicKey,
    slot: number,
    timestamp: number
  ) => ({
    gameKey: baseGameKey,
    player,
    totalAmount: new BN(1000),
    ticketsCount: 1,
    ticketIndex: 0,
    lastSlot: new BN(slot),
    timestamp: new BN(timestamp),
  }) as any;

  test("player join announcements escape display names", async () => {
    const target = { chatId: 77, messageId: 301 };
    const event = makePlayerEvent(Keypair.generate().publicKey, 5, 10);

    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGame: () => ({ game_type: "coinflip" }),
    } as any);

    await botModule.__test_processPlayerEvent(
      event,
      "PlayerJoined",
      [target]
    );

    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(sendCalls[0]?.options?.parse_mode).toBe("HTML");
  });

  test("player join announcements show game type (coinflip)", async () => {
    const target = { chatId: 77, messageId: 301 };
    const event = makePlayerEvent(Keypair.generate().publicKey, 5, 10);

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "TestPlayer",
      getActiveGameMessages: () => {
        const m = new Map();
        m.set(77, { chatId: 77, messageId: 301 });
        return m;
      },
    } as any);

    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGame: () => ({ game_type: "coinflip" }),
      getGameMessages: () => [],
    } as any);

    await botModule.__test_processPlayerEvent(
      event,
      "PlayerJoined",
      [target]
    );

    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.text).toContain("joined the coinflip!");
  });

  test("player join announcements show game type (giveaway)", async () => {
    const target = { chatId: 77, messageId: 301 };
    const event = makePlayerEvent(Keypair.generate().publicKey, 5, 10);

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "TestPlayer",
      getActiveGameMessages: () => {
        const m = new Map();
        m.set(77, { chatId: 77, messageId: 301 });
        return m;
      },
    } as any);

    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGame: () => ({ game_type: "giveaway" }),
      getGameMessages: () => [],
    } as any);

    await botModule.__test_processPlayerEvent(
      event,
      "PlayerJoined",
      [target]
    );

    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.text).toContain("joined the giveaway!");
  });

  test("player join announcements are disabled above ticket threshold", async () => {
    const target = { chatId: 77, messageId: 301 };
    const player = Keypair.generate().publicKey;

    botModule.__test_setJoinAnnouncementMaxTickets(1);

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async () => "TestPlayer",
      getActiveGameMessages: () => {
        const m = new Map();
        m.set(77, { chatId: 77, messageId: 301 });
        return m;
      },
    } as any);

    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGame: () => ({ game_type: "coinflip" }),
      getGameMessages: () => [],
    } as any);

    await botModule.__test_processPlayerEvent(
      { ...makePlayerEvent(player, 5, 10), ticketsCount: 2 } as any,
      "PlayerJoined",
      [target]
    );

    expect(sendCalls.length).toBe(0);
  });

  test("player event message updates are coalesced per game", async () => {
    const isolatedModule = await import(`../src/bot?debounce-test=${Date.now()}`);

    const target = { chatId: 77, messageId: 301 };
    const player = Keypair.generate().publicKey;

    isolatedModule.__test_setJoinAnnouncementMaxTickets(0);
    isolatedModule.__test_setGameMessageUpdateDebounceMs(10);

    const updateCalls: Array<{ gameAddress: string; totalPot?: number }> = [];
    isolatedModule.__test_setGameManager({
      updateGameMessageFromData: async (
        _ctx: any,
        gameAddress: string,
        _status: string,
        _winner?: any,
        totalPot?: number
      ) => {
        updateCalls.push({ gameAddress, totalPot });
      },
      getPlayerUsername: async () => "TestPlayer",
      getActiveGameMessages: () => {
        const m = new Map();
        m.set(77, { chatId: 77, messageId: 301 });
        return m;
      },
    } as any);

    isolatedModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGameMessages: () => [],
    } as any);

    const eventA = { ...makePlayerEvent(player, 5, 10), totalAmount: new BN(1000) };
    const eventB = { ...makePlayerEvent(player, 6, 11), totalAmount: new BN(2000) };
    const eventC = { ...makePlayerEvent(player, 7, 12), totalAmount: new BN(3000) };

    await isolatedModule.__test_processPlayerEvent(eventA as any, "PlayerUnjoined", [
      target,
    ]);
    await isolatedModule.__test_processPlayerEvent(eventB as any, "PlayerUnjoined", [
      target,
    ]);
    await isolatedModule.__test_processPlayerEvent(eventC as any, "PlayerUnjoined", [
      target,
    ]);

    expect(updateCalls.length).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0]?.gameAddress).toBe(baseGameKey.toBase58());
    expect(updateCalls[0]?.totalPot).toBe(3000);
  });

  test("auto-join for game creator is not announced", async () => {
    const target = { chatId: 77, messageId: 301 };
    const creatorKeypair = Keypair.generate();
    const event = makePlayerEvent(creatorKeypair.publicKey, 5, 10);

    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({
        telegramId: "creator-telegram",
        publicKey: creatorKeypair.publicKey.toBase58(),
      }),
    } as any);

    await botModule.__test_processPlayerEvent(
      event,
      "PlayerJoined",
      [target]
    );

    expect(sendCalls.length).toBe(0);
  });

  test("flushPendingPlayerEvents processes events enqueued mid-flush", async () => {
    const gameAddress = "GAME123";
    const firstPlayer = Keypair.generate().publicKey;
    const secondPlayer = Keypair.generate().publicKey;

    const names = new Map<string, string>([
      [firstPlayer.toBase58(), "First"],
      [secondPlayer.toBase58(), "Second"],
    ]);

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async (_ctx: any, pubkey: string) =>
        names.get(pubkey) ?? "Unknown",
      getActiveGameMessages: () => {
        const m = new Map();
        m.set(77, { chatId: 77, messageId: 301 });
        return m;
      },
    } as any);

    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGame: () => ({ game_type: "coinflip" }),
      getGameMessages: () => [],
    } as any);

    let enqueueTriggered = false;
    (botModule.bot.api as any).sendMessage = async (
      chatId: number,
      text: string,
      options: any
    ) => {
      sendCalls.push({ chatId, text, options });
      if (!enqueueTriggered) {
        enqueueTriggered = true;
        botModule.__test_enqueuePendingPlayerEvent(gameAddress, {
          event: makePlayerEvent(secondPlayer, 6, 20),
          eventName: "PlayerJoined",
          receivedAt: Date.now(),
        });
      }
      return { ok: true, result: { message_id: 1000 + sendCalls.length } } as any;
    };

    botModule.__test_enqueuePendingPlayerEvent(gameAddress, {
      event: makePlayerEvent(firstPlayer, 5, 10),
      eventName: "PlayerJoined",
      receivedAt: Date.now(),
    });

    await botModule.__test_flushPendingPlayerEvents(gameAddress, "notify");

    // New event added during flush should remain queued.
    expect(sendCalls.length).toBe(1);
    expect(
      botModule.__test_getPendingPlayerEventsState(gameAddress)?.events.length
    ).toBe(1);

    await botModule.__test_flushPendingPlayerEvents(gameAddress, "retry");

    expect(sendCalls.length).toBe(2);
    expect(sendCalls[0]?.text).toContain("First");
    expect(sendCalls[1]?.text).toContain("Second");
    expect(botModule.__test_getPendingPlayerEventsState(gameAddress)).toBeUndefined();
  });

  test("pending events near age limit flush once target becomes available", async () => {
    const gameAddress = "BOUNDARY_GAME";
    const player = Keypair.generate().publicKey;
    const names = new Map<string, string>([[player.toBase58(), "Boundary"]]);

    let targetReady = false;
    let dbRecord: any = null;
    const target = { chatId: 88, messageId: 409 };

    botModule.__test_setGameManager({
      updateGameMessageFromData: async () => {},
      getPlayerUsername: async (_ctx: any, pubkey: string) =>
        names.get(pubkey) ?? "Unknown",
      getActiveGameMessages: () => {
        if (!targetReady) return null;
        const m = new Map();
        m.set(target.chatId, target);
        return m;
      },
    } as any);

    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
      getGame: () => dbRecord,
      getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
      getGameMessages: () => [],
    } as any);

    const eventReceivedAt = Date.now() - (15_000 - 100);

    botModule.__test_enqueuePendingPlayerEvent(gameAddress, {
      event: makePlayerEvent(player, 7, 30),
      eventName: "PlayerJoined",
      receivedAt: eventReceivedAt,
    });

    await botModule.__test_flushPendingPlayerEvents(gameAddress, "notify");

    const pendingState = botModule.__test_getPendingPlayerEventsState(gameAddress);
    expect(pendingState?.events.length).toBe(1);

    if (pendingState?.timer) {
      clearTimeout(pendingState.timer);
      pendingState.timer = undefined;
    }

    targetReady = true;
    dbRecord = { chat_id: target.chatId, message_id: target.messageId };

    await botModule.__test_flushPendingPlayerEvents(gameAddress, "notify");

    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.text).toContain("Boundary");
    expect(botModule.__test_getPendingPlayerEventsState(gameAddress)).toBeUndefined();
  });

  test("stale pending events are dropped after exceeding max age", async () => {
    const gameAddress = "STALE_GAME";
    const warnings: string[] = [];
    const originalWarn = console.warn;

    try {
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((item) => String(item)).join(" "));
      };

      botModule.__test_setGameManager({
        updateGameMessageFromData: async () => {},
        getPlayerUsername: async () => "Late", // unused
        getActiveGameMessages: () => null,
      } as any);

      botModule.__test_setGameDatabase({
        getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
        getGame: () => null,
        getCreatorInfo: () => ({ telegramId: null, publicKey: null }),
        getGameMessages: () => [],
      } as any);

      botModule.__test_enqueuePendingPlayerEvent(gameAddress, {
        event: makePlayerEvent(Keypair.generate().publicKey, 3, 5),
        eventName: "PlayerJoined",
        receivedAt: Date.now() - 20_000,
      });

      await botModule.__test_flushPendingPlayerEvents(gameAddress, "retry");

      expect(sendCalls.length).toBe(0);
      expect(botModule.__test_getPendingPlayerEventsState(gameAddress)).toBeUndefined();
      expect(warnings.some((msg) => msg.includes("Dropping stale PlayerJoined event"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });
});
