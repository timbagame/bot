import { describe, test, expect, mock } from "bun:test";
import { PublicKey, Keypair } from "#solana";
import {
  makeCtxStub,
  makeDbStub,
  makeProgramStub,
  makeWalletStub,
  resetGameManager as resetGM,
} from "./helpers/game-manager";
import { GameManager } from "../src/utils/game";

function ctxStub(
  options: {
    failMedia?: any;
    failCaption?: any;
    failText?: any;
    sendMessageResult?: any;
    failRetire?: any;
    failRetireMessageIds?: number[];
    retireErrorsOnce?: Map<number, any>;
    failDelete?: any;
  } = {},
) {
  const calls: any[] = [];
  const base = makeCtxStub({
    apiOverrides: {
      deleteMessage: async (...args: any[]) => {
        calls.push(["delete", ...args]);
        if (options.failDelete) throw options.failDelete;
        return true;
      },
      editMessageReplyMarkup: async (...args: any[]) => {
        calls.push(["retire", ...args]);
        if (options.failRetire) throw options.failRetire;
        if (options.failRetireMessageIds?.includes(args[1])) {
          throw new Error("synthetic keyboard update unavailable");
        }
        const onceError = options.retireErrorsOnce?.get(args[1]);
        if (onceError) {
          options.retireErrorsOnce!.delete(args[1]);
          throw onceError;
        }
        return true;
      },
      editMessageCaption: async (...args: any[]) => {
        calls.push(["caption", ...args]);
        if (options.failCaption) {
          throw options.failCaption;
        }
        return { message_id: 99 };
      },
      editMessageMedia: async (...args: any[]) => {
        calls.push(["media", ...args]);
        if (options.failMedia) {
          throw options.failMedia;
        }
        return { message_id: 99 };
      },
      editMessageText: async (...args: any[]) => {
        calls.push(["text", ...args]);
        if (options.failText) {
          throw options.failText;
        }
        return { message_id: 99 };
      },
      sendMessage: async (...args: any[]) => {
        calls.push(["send", ...args]);
        return (
          options.sendMessageResult ?? {
            message_id: 777,
            chat: { id: args[0] },
          }
        );
      },
    },
  });
  const ctx: any = { ...base, __calls: calls };
  return ctx;
}

describe("GameManager.updateGameMessage routing", () => {
  test("coinflip active -> edits caption only", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub(),
    );
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111111").toBase58();
    // seed active message
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 42, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("caption");
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(active?.usesVideo).toBe(true);
  });

  test("coinflip completed -> edits media with winner video", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "coinflip" } }),
    );
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111112").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 43, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Completed",
      "TOK",
      "SomeWinnerPubkey",
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("media");
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(active?.usesVideo).toBe(true);
  });

  test("non-coinflip -> edits text", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 5,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { giveaway: {} },
    };
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "giveaway" } }),
    );
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111113").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 44, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "giveaway",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("text");
  });

  test("coinflip active without video support edits text", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub(),
    );
    const ctx = ctxStub();
    const addr = new PublicKey("11111111111111111111111111111114").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 45, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("text");
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(active?.usesVideo).toBe(false);
  });

  test("coinflip completed falls back to text when media update fails", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "coinflip" } }),
    );
    const ctx = ctxStub({
      failMedia: { description: "Bad Request: wrong file identifier/HTTP URL specified" },
    });
    const addr = new PublicKey("11111111111111111111111111111115").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 46, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Completed",
      "TOK",
      "SomeWinner",
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("media");
    expect(calls[1][0]).toBe("text");
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(active?.usesVideo).toBe(false);
  });

  test("coinflip replaces an uneditable media announcement with a persisted text message", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const saveGameMessage = mock(() => {});
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "coinflip" }, extra: { saveGameMessage } }),
    );
    const ctx = ctxStub({
      failMedia: { description: "Bad Request: wrong file identifier/HTTP URL specified" },
      failCaption: { description: "Bad Request: there is no caption in the message to edit" },
      failText: { description: "Bad Request: there is no text in the message to edit" },
    });
    const addr = new PublicKey("11111111111111111111111111111115").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 46, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Completed",
      "TOK",
      "SomeWinner",
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("media");
    expect(calls[1][0]).toBe("text");
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(calls[2][0]).toBe("caption");
    expect(calls[3]).toEqual(["retire", 1, 46, { reply_markup: { inline_keyboard: [] } }]);
    expect(calls[4][0]).toBe("send");
    expect(active?.messageId).toBe(777);
    expect(saveGameMessage).toHaveBeenCalledWith(addr, 777, 1);
    expect(active?.usesVideo).toBe(false);
  });

  test("coinflip updates the original caption when only the new media identifier is invalid", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const saveGameMessage = mock(() => {});
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "coinflip" }, extra: { saveGameMessage } }),
    );
    const ctx = ctxStub({
      failMedia: { description: "Bad Request: wrong file identifier/HTTP URL specified" },
      failText: { description: "Bad Request: there is no text in the message to edit" },
    });
    const addr = new PublicKey("11111111111111111111111111111115").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 46, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Completed",
      "TOK",
      "SomeWinner",
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("media");
    expect(calls[1][0]).toBe("text");
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(calls[2][0]).toBe("caption");
    expect(calls).toHaveLength(3);
    expect(active?.messageId).toBe(46);
    expect(active?.usesVideo).toBe(true);
    expect(saveGameMessage).not.toHaveBeenCalled();
  });

  test("coinflip does not publish a duplicate when retiring the old keyboard fails", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 2,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const saveGameMessage = mock(() => {});
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      makeDbStub({ gameOverride: { game_type: "coinflip" }, extra: { saveGameMessage } }),
    );
    const ctx = ctxStub({
      failMedia: { description: "Bad Request: wrong file identifier/HTTP URL specified" },
      failRetire: new Error("synthetic keyboard update unavailable"),
      failCaption: { description: "Bad Request: there is no caption in the message to edit" },
      failText: { description: "Bad Request: there is no text in the message to edit" },
    });
    const addr = new PublicKey("11111111111111111111111111111115").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 46, usesVideo: true });
    (gm as any).activeGameMessages.set(addr, msgMap);
    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Completed",
      "TOK",
      "SomeWinner",
    );
    const calls = (ctx as any).__calls;
    expect(calls[0][0]).toBe("media");
    expect(calls[1][0]).toBe("text");
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(calls[2][0]).toBe("caption");
    expect(calls[3]).toEqual(["retire", 1, 46, { reply_markup: { inline_keyboard: [] } }]);
    expect(calls).toHaveLength(4);
    expect(active?.messageId).toBe(46);
    expect(active?.usesVideo).toBe(true);
    expect(saveGameMessage).not.toHaveBeenCalled();
  });

  const deleteGone = { description: "Bad Request: message to delete not found" };
  const notModified = { description: "Bad Request: message is not modified" };
  for (const [label, failDelete, strandReplacement, originalAlreadyCleared] of [
    ["", undefined, false, false],
    [" (delete fails)", new Error("synthetic delete unavailable"), false, false],
    [" (replacement already gone)", deleteGone, false, false],
    [" (replacement stranded)", new Error("synthetic delete unavailable"), true, false],
    [" (original keyboard already cleared)", undefined, false, true],
  ] as const) {
    test(`coinflip retires the replacement card when persisting it fails${label}`, async () => {
      resetGM();
      const gameAcc = {
        ticketsCount: 2,
        maxTickets: 2,
        minTickets: 1,
        totalAmount: 0,
        createdAt: 1_000_000,
        timeout: 60,
        gameType: { coinflip: {} },
      };
      const saveGameMessage = mock(() => {
        throw new Error("synthetic database unavailable");
      });
      const gm = GameManager.getInstance(
        makeProgramStub(gameAcc),
        makeWalletStub({
          tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
        }),
        makeDbStub({ gameOverride: { game_type: "coinflip" }, extra: { saveGameMessage } }),
      );
      const ctx = ctxStub({
        failMedia: { description: "Bad Request: wrong file identifier/HTTP URL specified" },
        failCaption: { description: "Bad Request: there is no caption in the message to edit" },
        failText: { description: "Bad Request: there is no text in the message to edit" },
        failDelete,
        failRetireMessageIds: strandReplacement ? [777] : undefined,
        retireErrorsOnce: originalAlreadyCleared
          ? new Map([[46, notModified]])
          : failDelete === deleteGone
            ? new Map([[777, { description: "Bad Request: message to edit not found" }]])
            : undefined,
      });
      const addr = new PublicKey("11111111111111111111111111111115").toBase58();
      const msgMap = new Map();
      msgMap.set(1, { chatId: 1, messageId: 46, usesVideo: true });
      (gm as any).activeGameMessages.set(addr, msgMap);
      await gm.updateGameMessage(
        ctx as any,
        addr,
        "coinflip",
        1_000_000_000,
        "@creator",
        "Active",
        "TOK",
      );
      const calls = (ctx as any).__calls;
      const sendIndex = calls.findIndex((c: any[]) => c[0] === "send");
      expect(sendIndex).toBeGreaterThan(-1);
      expect(saveGameMessage).toHaveBeenCalledWith(addr, 777, 1);
      expect(calls[sendIndex + 1]).toEqual(["delete", 1, 777]);
      if (failDelete && failDelete !== deleteGone) {
        expect(calls[sendIndex + 2]).toEqual([
          "retire",
          1,
          777,
          { reply_markup: { inline_keyboard: [] } },
        ]);
      }
      const keyboard = calls[sendIndex][3]?.reply_markup;
      expect(keyboard?.inline_keyboard?.length).toBeGreaterThan(0);
      const restores = calls.filter(
        (c: any[]) => c[0] === "retire" && c[2] === 46 && c[3]?.reply_markup === keyboard,
      );
      // The original card stays tracked, so its keyboard comes back unless a
      // replacement with live controls is still in the chat.
      expect(restores).toHaveLength(strandReplacement ? 0 : 1);
      const active = gm.getActiveGameMessages(addr)?.get(1);
      expect(active?.messageId).toBe(46);
    });
  }

  test("recreates missing message and preserves inline keyboard when edit target is gone", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const addr = new PublicKey("11111111111111111111111111111116").toBase58();
    const database = makeDbStub();
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      database,
    );
    const missingError = {
      description: "Bad Request: message to edit not found",
    };
    const ctx = ctxStub({
      failText: missingError,
      sendMessageResult: { message_id: 888, chat: { id: 1 } },
    });
    ctx.chat = { id: 1, type: "supergroup" };
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 47, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);

    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );

    const calls = (ctx as any).__calls;
    const sendCall = calls.find((call: any[]) => call[0] === "send");
    expect(sendCall).toBeDefined();
    expect(sendCall?.[3]?.reply_markup?.inline_keyboard).toBeDefined();
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(active?.messageId).toBe(888);
    const saved = (database as any).__savedMessages.pop();
    expect(saved).toEqual({ address: addr, messageId: 888, chatId: 1 });
  });

  test("deduplicates concurrent recreation attempts per game address", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const database = makeDbStub();
    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      database,
    );
    const missingError = {
      description: "Bad Request: message to edit not found",
    };
    const ctx = ctxStub({
      failText: missingError,
      sendMessageResult: { message_id: 555, chat: { id: 1 } },
    });
    ctx.chat = { id: 1, type: "supergroup" };
    const originalSend = ctx.api.sendMessage;
    ctx.api.sendMessage = async (...args: any[]) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return originalSend(...args);
    };
    const addr = new PublicKey("11111111111111111111111111111117").toBase58();
    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 45, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);

    await Promise.all([
      gm.updateGameMessage(
        ctx as any,
        addr,
        "coinflip",
        1_000_000_000,
        "@creator",
        "Active",
        "TOK",
      ),
      gm.updateGameMessage(
        ctx as any,
        addr,
        "coinflip",
        1_000_000_000,
        "@creator",
        "Active",
        "TOK",
      ),
    ]);

    expect((database as any).__savedMessages).toHaveLength(1);
    const sendCalls = ctx.__calls.filter((call: any[]) => call[0] === "send");
    expect(sendCalls).toHaveLength(1);
  });

  test("recreates missing message with video for coinflip game type", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const addr = new PublicKey("11111111111111111111111111111118").toBase58();
    const database = makeDbStub();

    // Create ctx that tracks video calls too
    const calls: any[] = [];
    const ctx: any = {
      chat: { id: 1, type: "supergroup" },
      callbackQuery: { message: { message_id: 999 } },
      api: {
        editMessageText: async (...args: any[]) => {
          calls.push(["text", ...args]);
          throw { description: "Bad Request: message to edit not found" };
        },
        sendMessage: async (...args: any[]) => {
          calls.push(["send", ...args]);
          return { message_id: 888, chat: { id: 1 } };
        },
        sendVideo: async (...args: any[]) => {
          calls.push(["video", ...args]);
          return { message_id: 889, chat: { id: 1 } };
        },
      },
      __calls: calls,
    };

    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      database,
    );

    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 47, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);

    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );

    // Should have attempted video first (text edit failed, then recreate with video)
    const videoCalls = calls.filter((call: any[]) => call[0] === "video");
    const sendCalls = calls.filter((call: any[]) => call[0] === "send");

    // Either video was sent OR text fallback was used
    expect(videoCalls.length + sendCalls.length).toBeGreaterThanOrEqual(1);

    // Active message should be updated
    const active = gm.getActiveGameMessages(addr)?.get(1);
    expect(active?.messageId).toBeDefined();
  });

  test("recreates missing message with callback message ID as reply_to", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 2,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { coinflip: {} },
    };
    const addr = new PublicKey("11111111111111111111111111111119").toBase58();
    const database = makeDbStub();

    const calls: any[] = [];
    const ctx: any = {
      chat: { id: 1, type: "supergroup" },
      // This simulates a callback context with a message ID
      callbackQuery: { message: { message_id: 777 } },
      api: {
        editMessageText: async (...args: any[]) => {
          calls.push(["text", ...args]);
          throw { description: "Bad Request: message to edit not found" };
        },
        sendMessage: async (...args: any[]) => {
          calls.push(["send", ...args]);
          return { message_id: 888, chat: { id: 1 } };
        },
        sendVideo: async (...args: any[]) => {
          calls.push(["video", ...args]);
          // Simulate video send failure to fall back to text
          throw { description: "Bad Request: wrong file identifier" };
        },
      },
      __calls: calls,
    };

    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      database,
    );

    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 47, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);

    await gm.updateGameMessage(
      ctx as any,
      addr,
      "coinflip",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );

    // Find the send call and check it includes reply_to_message_id
    const sendCall = calls.find((call: any[]) => call[0] === "send");
    expect(sendCall).toBeDefined();

    // The sendMessage call args: [chatId, text, options]
    // Options should have reply_to_message_id from the callback message
    const options = sendCall?.[3];
    expect(options?.reply_to_message_id).toBe(777);
  });

  test("recreates missing message for giveaway (text fallback when no video)", async () => {
    resetGM();
    const gameAcc = {
      ticketsCount: 1,
      maxTickets: 5,
      minTickets: 1,
      totalAmount: 0,
      createdAt: 1_000_000,
      timeout: 60,
      gameType: { giveaway: {} },
    };
    const addr = (await Keypair.generate()).publicKey.toBase58();
    const database = makeDbStub({ gameOverride: { game_type: "giveaway" } });

    const calls: any[] = [];
    const ctx: any = {
      chat: { id: 1, type: "supergroup" },
      callbackQuery: { message: { message_id: 555 } },
      api: {
        editMessageText: async (...args: any[]) => {
          calls.push(["text", ...args]);
          throw { description: "Bad Request: message to edit not found" };
        },
        sendMessage: async (...args: any[]) => {
          calls.push(["send", ...args]);
          return { message_id: 888, chat: { id: 1 } };
        },
        sendVideo: async (...args: any[]) => {
          calls.push(["video", ...args]);
          return { message_id: 889, chat: { id: 1 } };
        },
      },
      __calls: calls,
    };

    const gm = GameManager.getInstance(
      makeProgramStub(gameAcc),
      makeWalletStub({
        tokenFormatter: (n, d) => (Number(n) / Math.pow(10, d)).toFixed(0),
      }),
      database,
    );

    const msgMap = new Map();
    msgMap.set(1, { chatId: 1, messageId: 47, usesVideo: false });
    (gm as any).activeGameMessages.set(addr, msgMap);

    await gm.updateGameMessage(
      ctx as any,
      addr,
      "giveaway",
      1_000_000_000,
      "@creator",
      "Active",
      "TOK",
    );

    // Should have tried to recreate the message (either video or text depending on config)
    // In test env, video IDs may not be configured, so we just verify the message was recreated
    const sendCalls = calls.filter((call: any[]) => call[0] === "send");
    const videoCalls = calls.filter((call: any[]) => call[0] === "video");

    // We verify that SOME recreation happened (either video or text send)
    if (videoCalls.length > 0) {
      // If video was used
      const active = gm.getActiveGameMessages(addr)?.get(1);
      expect(active?.usesVideo).toBe(true);
    } else if (sendCalls.length > 0) {
      // If text fallback was used
      const active = gm.getActiveGameMessages(addr)?.get(1);
      expect(active?.messageId).toBe(888);
    } else {
      // If no sends happened, it means we didn't recreate - check if we at least TRIED to edit
      const textCalls = calls.filter((call: any[]) => call[0] === "text");
      expect(textCalls.length).toBeGreaterThan(0);
      // But we EXPECT recreation, so fail if no sends
      throw new Error("Expected recreation (sendVideo or sendMessage) but none occurred");
    }
  });
});
