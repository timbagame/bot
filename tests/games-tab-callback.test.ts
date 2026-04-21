import { describe, test, expect, beforeAll, afterAll, vi } from "bun:test";

const originalNodeEnv = process.env.NODE_ENV;
const originalToken = process.env.TELEGRAM_TOKEN;
const originalMnemonic = process.env.MNEMONIC;
const originalSolanaNetwork = process.env.SOLANA_NETWORK;

if (originalNodeEnv === undefined) {
  process.env.NODE_ENV = "test";
}
if (originalToken === undefined) {
  process.env.TELEGRAM_TOKEN = "test-token";
}
if (originalMnemonic === undefined) {
  process.env.MNEMONIC =
    "test test test test test test test test test test test junk";
}
if (originalSolanaNetwork === undefined) {
  process.env.SOLANA_NETWORK = "http://localhost:8899";
}

describe("handleGamesTabCallback", () => {
  let botModule: typeof import("../src/bot");
  let originalGameManager: any;

  beforeAll(async () => {
    botModule = await import("../src/bot");
    originalGameManager = botModule.gameManager;
  });

  afterAll(() => {
    botModule.__test_setGameManager(originalGameManager as any);

    if (originalNodeEnv === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalToken === undefined) {
      Reflect.deleteProperty(process.env, "TELEGRAM_TOKEN");
    } else {
      process.env.TELEGRAM_TOKEN = originalToken;
    }
    if (originalMnemonic === undefined) {
      Reflect.deleteProperty(process.env, "MNEMONIC");
    } else {
      process.env.MNEMONIC = originalMnemonic;
    }
    if (originalSolanaNetwork === undefined) {
      Reflect.deleteProperty(process.env, "SOLANA_NETWORK");
    } else {
      process.env.SOLANA_NETWORK = originalSolanaNetwork;
    }
  });

  function makeCtx(opts: {
    fromId: number;
    callbackData: string;
    editMessageTextResult?: "ok" | "not_modified" | "other_error";
  }) {
    const calls: any[] = [];
    const ctx: any = {
      from: { id: opts.fromId },
      callbackQuery: { data: opts.callbackData },
      editMessageText: vi.fn(async () => {
        calls.push(["editMessageText"]);
        if (opts.editMessageTextResult === "not_modified") {
          const err: any = new Error("Bad Request: message is not modified");
          err.description = "Bad Request: message is not modified";
          throw err;
        }
        if (opts.editMessageTextResult === "other_error") {
          throw new Error("some other edit error");
        }
        return { message_id: 1 };
      }),
      answerCallbackQuery: vi.fn(async (...args: any[]) => {
        calls.push(["answerCallbackQuery", ...args]);
        return { ok: true };
      }),
      __calls: calls,
    };
    return ctx;
  }

  test("answers callback when already-selected tab is clicked", async () => {
    const stubGameManager = {
      getUserGamesHistory: vi.fn(async () => ({
        won: { games: [], totalAmount: 0 },
        lost: { games: [], totalAmount: 0 },
        cancelled: { games: [], totalAmount: 0 },
      })),
      formatGamesMessage: vi.fn(() => "Games message"),
      buildGamesKeyboard: vi.fn(() => [[{ text: "Won (0)", callback_data: "games_tab:won:0:123" }]]),
    } as any;

    botModule.__test_setGameManager(stubGameManager);

    const ctx = makeCtx({
      fromId: 123,
      callbackData: "games_tab:won:0:123",
      editMessageTextResult: "not_modified",
    });

    await botModule.__test_handleGamesTabCallback(ctx);

    expect(ctx.editMessageText).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
  });

  test("re-throws non-not-modified edit errors", async () => {
    const stubGameManager = {
      getUserGamesHistory: vi.fn(async () => ({
        won: { games: [], totalAmount: 0 },
        lost: { games: [], totalAmount: 0 },
        cancelled: { games: [], totalAmount: 0 },
      })),
      formatGamesMessage: vi.fn(() => "Games message"),
      buildGamesKeyboard: vi.fn(() => [[{ text: "Won (0)", callback_data: "games_tab:won:0:123" }]]),
    } as any;

    botModule.__test_setGameManager(stubGameManager);

    const ctx = makeCtx({
      fromId: 123,
      callbackData: "games_tab:won:0:123",
      editMessageTextResult: "other_error",
    });

    await expect(botModule.__test_handleGamesTabCallback(ctx)).rejects.toThrow("some other edit error");
  });

  test("rejects invalid callback data", async () => {
    const ctx = makeCtx({
      fromId: 123,
      callbackData: "games_tab:invalid:data",
    });

    await botModule.__test_handleGamesTabCallback(ctx);

    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("Invalid request.");
  });

  test("rejects non-owner caller", async () => {
    const ctx = makeCtx({
      fromId: 999,
      callbackData: "games_tab:won:0:123",
    });

    await botModule.__test_handleGamesTabCallback(ctx);

    expect(ctx.editMessageText).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith("This isn't your games list.");
  });

  test("edits message and answers callback on success", async () => {
    const stubGameManager = {
      getUserGamesHistory: vi.fn(async () => ({
        won: { games: [], totalAmount: 0 },
        lost: { games: [], totalAmount: 0 },
        cancelled: { games: [], totalAmount: 0 },
      })),
      formatGamesMessage: vi.fn(() => "Games message"),
      buildGamesKeyboard: vi.fn(() => [[{ text: "Won (0)", callback_data: "games_tab:won:0:123" }]]),
    } as any;

    botModule.__test_setGameManager(stubGameManager);

    const ctx = makeCtx({
      fromId: 123,
      callbackData: "games_tab:won:0:123",
      editMessageTextResult: "ok",
    });

    await botModule.__test_handleGamesTabCallback(ctx);

    expect(ctx.editMessageText).toHaveBeenCalledWith("Games message", {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: "Won (0)", callback_data: "games_tab:won:0:123" }]],
      },
      link_preview_options: { is_disabled: true },
    });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith();
  });
});
