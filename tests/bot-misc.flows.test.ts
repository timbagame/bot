import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import BN from "bn.js";
import {
  bot,
  botModule,
  lastText,
  resetCalls,
  restoreStubs,
  sendText,
  stub,
  useBotHarness,
  wallet,
} from "./helpers/bot-harness";

useBotHarness();

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("active game keyboards", () => {
  test("join buttons are relabelled with the stake while other buttons are kept", () => {
    const keyboard = botModule.__test_buildActiveGamesKeyboard([
      {
        messageText: "<b>Coinflip • 5k TIMBA ($5)</b>\nDetails",
        gameAddress: "Game1",
        keyboard: [
          [
            { text: "🎮 Join", callback_data: "join_Game1" },
            { text: "🔄", callback_data: "refresh_Game1" },
            { text: "Leave", callback_data: "unjoin_Game1" },
          ],
        ],
      },
    ] as any);

    const actions = keyboard[1]!;
    expect(actions.map((button: any) => button.callback_data)).toEqual([
      "join_Game1",
      "unjoin_Game1",
    ]);
    expect(actions[0]!.text).not.toBe("🎮 Join");
    expect(actions[0]!.text).toContain("5k");
    expect(actions[1]).toEqual({ text: "Leave", callback_data: "unjoin_Game1" });
  });
});

describe("trade confirmation provider labels", () => {
  const summaryFor = (provider: string) =>
    botModule.__test_formatTradeConfirmationSummary({
      payToken: "SOL",
      payDisplay: "1",
      payRawAmount: 1_000_000_000,
      payDecimals: 9,
      receiveToken: "WSOL",
      receiveDecimals: 9,
      quote: { provider, outputAmount: "1000000000" } as any,
    });

  test("wrap and unwrap quotes name the native converter", () => {
    expect(JSON.stringify(summaryFor("wrap"))).toContain("<b>Provider:</b> Wrap");
    expect(JSON.stringify(summaryFor("unwrap"))).toContain("<b>Provider:</b> Unwrap");
    expect(JSON.stringify(summaryFor("jupiter"))).toContain("<b>Provider:</b> Jupiter");
  });
});

describe("pending player event scheduling", () => {
  afterEach(() => botModule.__test_clearPendingPlayerEvents());

  test("several queued events share one retry timer", () => {
    const payload = (n: number) => ({
      event: { gameKey: { toString: () => "QueuedGame" }, totalAmount: new BN(n) } as any,
      eventName: "PlayerJoined",
      receivedAt: Date.now(),
    });

    botModule.__test_enqueuePendingPlayerEvent("QueuedGame", payload(1));
    const timer = botModule.__test_getPendingPlayerEventsState("QueuedGame")?.timer;
    botModule.__test_enqueuePendingPlayerEvent("QueuedGame", payload(2));

    const state = botModule.__test_getPendingPlayerEventsState("QueuedGame")!;
    expect(state.events).toHaveLength(2);
    expect(state.timer).toBe(timer);
    clearTimeout(state.timer);
  });
});

describe("completion job bookkeeping", () => {
  afterEach(() => {
    botModule.__test_resetProcessGameCompletionHandler();
    botModule.__test_resetGameDatabase();
    botModule.__test_resetCompletionJobs();
  });

  test("a completion job stuck for over two minutes no longer blocks a new one", async () => {
    botModule.__test_setGameDatabase({} as any);
    let release!: () => void;
    const handler = mock(() => new Promise<void>((resolve) => (release = resolve)));
    botModule.__test_setProcessGameCompletionHandler(handler as any);

    const stuck = botModule.__test_runProcessGameCompletion("StuckGame", "Winner");
    await Bun.sleep(0);
    expect(botModule.__test_isCompletionJobActive("StuckGame")).toBe(true);

    const realNow = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(realNow + 3 * 60_000);
    handler.mockImplementation(async () => undefined);
    try {
      expect(await botModule.__test_runProcessGameCompletion("StuckGame", "Winner")).toBe(true);
    } finally {
      nowSpy.mockRestore();
      release();
      await stuck;
    }
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe("transaction cache test hooks", () => {
  test("setting an empty entry removes it", () => {
    botModule.__test_setTransactionCacheEntry("hook-key", { targetToken: "BONK" } as any);
    expect(botModule.__test_getTransactionCacheEntry("hook-key")).toMatchObject({
      targetToken: "BONK",
    });

    botModule.__test_setTransactionCacheEntry("hook-key", null);
    expect(botModule.__test_getTransactionCacheEntry("hook-key")).toBeUndefined();
  });
});

describe("/withdraw argument edge cases", () => {
  test("an empty address argument is rejected", async () => {
    await sendText("/withdraw  1 SOL", { userId: 64_001 });
    expect(lastText()).toBe("Invalid wallet address. Please provide a valid Solana address.");
  });

  test("anonymous senders are ignored", async () => {
    const transfer = mock(async () => "sig");
    stub(wallet, "transferSol", transfer);

    await bot.handleUpdate({
      update_id: 96_000_001,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -64_002, type: "supergroup", title: "Group" },
        sender_chat: { id: -64_002, type: "supergroup", title: "Group" },
        text: "/withdraw 11111111111111111111111111111112 1",
        entities: [{ type: "bot_command", offset: 0, length: 9 }],
      },
    } as any);

    expect(transfer).not.toHaveBeenCalled();
  });
});
