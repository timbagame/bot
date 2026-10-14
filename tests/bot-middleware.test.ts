import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BotError } from "grammy";
import {
  bot,
  botModule,
  resetCalls,
  restoreStubs,
  sendText,
  useBotHarness,
} from "./helpers/bot-harness";
import { FaucetDatabase } from "../src/utils/faucet-database";

useBotHarness();

let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let originalGameManager: typeof botModule.gameManager;
beforeEach(() => {
  resetCalls();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  originalGameManager = botModule.gameManager;
});
afterEach(() => {
  botModule.__test_setGameManager(originalGameManager);
  restoreStubs();
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("global error boundary", () => {
  const report = (update: Record<string, unknown> | undefined) =>
    bot.errorHandler(new BotError(new Error("handler exploded"), { update } as any));

  test.each([
    [{ callback_query: {} }, "callback_query"],
    [{ message: {} }, "message"],
    [{ edited_message: {} }, "update"],
    [undefined, "update"],
  ])("names the kind of update that failed: %p", async (update, path) => {
    await report(update);
    expect(errorSpy).toHaveBeenCalledWith(`Bot error while handling ${path}:`, expect.any(Error));
  });
});

describe("group to supergroup migration", () => {
  const migrate = (oldChatId: number, migrateTo: unknown) =>
    bot.handleUpdate({
      update_id: 77_000_000 + Math.floor(Math.random() * 1_000_000),
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: oldChatId, type: "group", title: "Old" },
        from: { id: 5, is_bot: false, first_name: "Admin" },
        migrate_to_chat_id: migrateTo,
      },
    } as any);

  test("moves chat, game and faucet state to the new chat id", async () => {
    const chatDb = botModule.__test_getChatDatabase();
    const gameDb = botModule.__test_getGameDatabase();
    const faucets = FaucetDatabase.getInstance();
    const moved: string[] = [];
    const spies = [
      spyOn(chatDb, "migrateChatId").mockImplementation(() => moved.push("chat") as any),
      spyOn(gameDb, "migrateChatId").mockImplementation(() => moved.push("game") as any),
      spyOn(faucets, "migrateChatId").mockImplementation(() => moved.push("faucet") as any),
    ];
    try {
      await migrate(-10, -1_000_000_010);

      expect(moved).toEqual(["chat", "game", "faucet"]);
      expect((spies[0]!.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([-10, -1_000_000_010]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("ignores a missing target and logs failures", async () => {
    const chatDb = botModule.__test_getChatDatabase();
    const spy = spyOn(chatDb, "migrateChatId").mockImplementation(() => {
      throw new Error("db locked");
    });
    try {
      await migrate(-11, 0);
      expect(spy).not.toHaveBeenCalled();

      await migrate(-11, -1_000_000_011);
      expect(
        errorSpy.mock.calls.some((call: unknown[]) =>
          String(call[0]).includes("Failed to migrate Telegram chat state -11"),
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("username priming", () => {
  test("primes the cache with the sender's handle and survives failures", async () => {
    const primeUsernameCache = mock((): void => {
      throw new Error("cache full");
    });
    botModule.__test_setGameManager({ primeUsernameCache } as any);

    await sendText("hello", { userId: 4242, username: "@@alice" });

    expect((primeUsernameCache.mock.calls[0] as unknown[]).slice(1)).toEqual([
      "4242",
      "@alice",
      true,
    ]);
    expect(
      warnSpy.mock.calls.some((call: unknown[]) => call[0] === "Failed to prime username cache:"),
    ).toBe(true);
  });

  test("skips handles that are only @ signs", async () => {
    const primeUsernameCache = mock(() => {});
    botModule.__test_setGameManager({ primeUsernameCache } as any);

    await sendText("hello", { userId: 4243, username: "@@" });

    expect(primeUsernameCache).not.toHaveBeenCalled();
  });
});
