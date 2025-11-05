import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

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
      getActiveGameMessage: () => ({ chatId: 77, messageId: 301 }),
    } as any);
    botModule.__test_setGameDatabase({
      getGameLastSlotWithTimestamp: () => ({ lastSlot: null, timestamp: null }),
    } as any);
  });

  afterEach(async () => {
    const module = await botModulePromise;
    (module.bot.api as any).sendMessage = originalSendMessage;
    module.__test_clearPendingPlayerEvents();
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

    await botModule.__test_processPlayerEventWithTarget(
      event,
      "PlayerJoined",
      target
    );

    expect(sendCalls.length).toBe(1);
    expect(sendCalls[0]?.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(sendCalls[0]?.options?.parse_mode).toBe("HTML");
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
      getActiveGameMessage: () => ({ chatId: 77, messageId: 301 }),
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
});
