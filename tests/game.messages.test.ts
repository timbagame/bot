import { afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { Keypair, PublicKey } from "#solana";
import { GameManager } from "../src/utils/game";
import { formatPlayerAddress } from "../src/utils/game-ui";

const GAME = new PublicKey("BPFLoader1111111111111111111111111111111111").toBase58();
const CHAT = 4242;
const MSG = 55;

let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  GameManager.resetForTest();
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
  GameManager.resetForTest();
});

const telegramError = (description: string) =>
  Object.assign(new Error(description), { description, error_code: 400 });

function makeManager(dbOverrides: Record<string, unknown> = {}) {
  const db: any = {
    getGame: vi.fn(() => null),
    getGameMessages: vi.fn(() => []),
    saveGameMessage: vi.fn(),
    ...dbOverrides,
  };
  const wallet: any = {
    formatTokenBalance: (value: number, decimals: number) =>
      (value / Math.pow(10, decimals)).toString(),
  };
  const gm: any = GameManager.getInstance({} as any, wallet, db);
  return { gm, db, wallet };
}

describe("createGameMessage", () => {
  function makeCtx(overrides: Record<string, unknown> = {}) {
    const reply = vi.fn(async () => ({ message_id: 900, chat: { id: CHAT } }));
    const replyWithVideo = vi.fn(async () => ({ message_id: 901, chat: { id: CHAT } }));
    const replyWithPhoto = vi.fn(async () => ({ message_id: 902, chat: { id: CHAT } }));
    const replyWithAnimation = vi.fn(async () => ({ message_id: 903, chat: { id: CHAT } }));
    const ctx: any = {
      chat: { id: CHAT },
      message: { message_id: 11 },
      reply,
      replyWithVideo,
      replyWithPhoto,
      replyWithAnimation,
      ...overrides,
    };
    return { ctx, reply, replyWithVideo, replyWithPhoto, replyWithAnimation };
  }

  function stubPayload(gm: any, media?: { fileId: string; mediaType: string }) {
    gm.buildGameMessagePayload = vi.fn(async () => ({
      text: "<b>Card</b>",
      keyboard: [[{ text: "Join", callback_data: "join" }]],
      media,
    }));
  }

  test.each([
    ["photo", "replyWithPhoto", 902],
    ["animation", "replyWithAnimation", 903],
    ["video", "replyWithVideo", 901],
  ] as const)("sends a %s card with the matching reply method", async (mediaType, method, id) => {
    const { gm, db } = makeManager();
    stubPayload(gm, { fileId: "FAKE_FILE", mediaType });
    const made = makeCtx();
    const messageId = await gm.createGameMessage(made.ctx, GAME, "Coinflip", 1, "alice", "TOK");
    expect(messageId).toBe(id);
    const send = (made as any)[method];
    expect(send).toHaveBeenCalledWith("FAKE_FILE", {
      caption: "<b>Card</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "Join", callback_data: "join" }]] },
      reply_to_message_id: 11,
    });
    expect(made.reply).not.toHaveBeenCalled();
    expect(db.saveGameMessage).toHaveBeenCalledWith(GAME, id, CHAT);
    expect(gm.activeGameMessages.get(GAME).get(CHAT)).toEqual({
      messageId: id,
      chatId: CHAT,
      usesVideo: true,
    });
  });

  test("sends plain text when the card has no media", async () => {
    const { gm } = makeManager();
    stubPayload(gm, undefined);
    const made = makeCtx();
    const messageId = await gm.createGameMessage(made.ctx, GAME, "Coinflip", 1, "alice", "TOK");
    expect(messageId).toBe(900);
    expect(made.reply).toHaveBeenCalledTimes(1);
    expect(made.replyWithVideo).not.toHaveBeenCalled();
    expect(gm.activeGameMessages.get(GAME).get(CHAT).usesVideo).toBe(false);
  });

  test("sends plain text when the context cannot reply with video", async () => {
    const { gm } = makeManager();
    stubPayload(gm, { fileId: "FAKE_FILE", mediaType: "photo" });
    const made = makeCtx({ replyWithVideo: undefined });
    const messageId = await gm.createGameMessage(made.ctx, GAME, "Coinflip", 1, "alice", "TOK");
    expect(messageId).toBe(900);
    expect(made.replyWithPhoto).not.toHaveBeenCalled();
  });

  test("completes a reserved delivery with the sent message id", async () => {
    const reserveGameMessageDelivery = vi.fn(() => ({ acquired: true }));
    const completeGameMessageDelivery = vi.fn();
    const { gm, db } = makeManager({ reserveGameMessageDelivery, completeGameMessageDelivery });
    stubPayload(gm, undefined);
    const made = makeCtx();
    const messageId = await gm.createGameMessage(
      made.ctx,
      GAME,
      "Coinflip",
      1,
      "alice",
      "TOK",
      "Active",
      undefined,
      { reserveDelivery: true },
    );
    expect(messageId).toBe(900);
    expect(reserveGameMessageDelivery).toHaveBeenCalledWith(GAME, CHAT);
    expect(completeGameMessageDelivery).toHaveBeenCalledWith(GAME, CHAT, 900);
    expect(db.saveGameMessage).not.toHaveBeenCalled();
  });

  test("releases a reserved delivery and rethrows when the send fails", async () => {
    const releaseGameMessageDelivery = vi.fn();
    const { gm } = makeManager({
      reserveGameMessageDelivery: vi.fn(() => ({ acquired: true })),
      completeGameMessageDelivery: vi.fn(),
      releaseGameMessageDelivery,
    });
    stubPayload(gm, undefined);
    const made = makeCtx({
      reply: vi.fn(async () => {
        throw new Error("telegram down");
      }),
    });
    await expect(
      gm.createGameMessage(made.ctx, GAME, "Coinflip", 1, "alice", "TOK", "Active", undefined, {
        reserveDelivery: true,
      }),
    ).rejects.toThrow("telegram down");
    expect(releaseGameMessageDelivery).toHaveBeenCalledWith(GAME, CHAT);
  });

  test("rethrows a send failure without releasing when nothing was reserved", async () => {
    const releaseGameMessageDelivery = vi.fn();
    const { gm } = makeManager({ releaseGameMessageDelivery });
    stubPayload(gm, undefined);
    const made = makeCtx({
      reply: vi.fn(async () => {
        throw new Error("telegram down");
      }),
    });
    await expect(
      gm.createGameMessage(made.ctx, GAME, "Coinflip", 1, "alice", "TOK"),
    ).rejects.toThrow("telegram down");
    expect(releaseGameMessageDelivery).not.toHaveBeenCalled();
  });
});

describe("updateGameMessage generation tracking", () => {
  test("records a newer explicit generation as the latest", async () => {
    const { gm } = makeManager();
    gm.updateGameMessageInternal = vi.fn(async () => undefined);
    await gm.updateGameMessage(
      {} as any,
      GAME,
      "Coinflip",
      1,
      "alice",
      "Active",
      "TOK",
      undefined,
      undefined,
      undefined,
      5,
    );
    expect(gm.gameMessageUpdateGenerations.get(GAME)).toBe(5);
    expect(gm.updateGameMessageInternal).toHaveBeenCalledTimes(1);
    expect(gm.updateGameMessageInternal.mock.calls[0][10]).toBe(5);
  });
});

describe("updateGameMessageInternal", () => {
  type Edits = {
    text?: (...args: any[]) => Promise<unknown>;
    caption?: (...args: any[]) => Promise<unknown>;
    media?: (...args: any[]) => Promise<unknown>;
    markup?: (...args: any[]) => Promise<unknown>;
  };

  function setup(
    options: {
      usesVideo?: boolean;
      payloadMedia?: { fileId: string; mediaType: string };
      edits?: Edits;
      targets?: Array<{ chatId: number; messageId: number }>;
    } = {},
  ) {
    const { gm, db } = makeManager();
    const api = {
      editMessageText: vi.fn(options.edits?.text ?? (async () => ({ message_id: MSG }))),
      editMessageCaption: vi.fn(options.edits?.caption ?? (async () => ({ message_id: MSG }))),
      editMessageMedia: vi.fn(options.edits?.media ?? (async () => ({ message_id: MSG }))),
      editMessageReplyMarkup: vi.fn(options.edits?.markup ?? (async () => true)),
    };
    const ctx: any = { api };
    const keyboard = [[{ text: "Join", callback_data: "join" }]];
    gm.formatGameMessage = vi.fn(async () => ({ messageText: "FORMATTED", keyboard }));
    gm.buildGameMessagePayload = vi.fn(async () => ({
      text: "PAYLOAD",
      keyboard,
      media: options.payloadMedia,
    }));
    gm.getPersistedTerminalUpdate = vi.fn(() => null);
    gm.isSupersededActiveGameMessageUpdate = vi.fn(() => false);
    gm.recreateMissingGameMessage = vi.fn(async () => true);
    const targets = options.targets ?? [{ chatId: CHAT, messageId: MSG }];
    gm.activeGameMessages.set(
      GAME,
      new Map(
        targets.map((t) => [t.chatId, { ...t, usesVideo: options.usesVideo ?? false }] as const),
      ),
    );
    const run = (status = "Active", extra: unknown[] = []) =>
      gm.updateGameMessageInternal(ctx, GAME, "Coinflip", 1, "alice", status, "TOK", ...extra);
    return { gm, db, ctx, api, run, keyboard };
  }

  const queue = <T>(values: T[], fallback: T) => {
    const rest = [...values];
    return vi.fn(() => (rest.length > 0 ? rest.shift()! : fallback));
  };

  const terminal = { status: "Completed" as const, winnerAddress: "W", totalPot: 9 };

  describe("preparation", () => {
    test("does nothing when no message is tracked and the database has none", async () => {
      const { gm, api } = setup();
      gm.activeGameMessages.clear();
      await gm.updateGameMessageInternal(
        { api } as any,
        GAME,
        "Coinflip",
        1,
        "alice",
        "Active",
        "TOK",
      );
      expect(gm.formatGameMessage).not.toHaveBeenCalled();
      expect(api.editMessageText).not.toHaveBeenCalled();
    });

    test("warns and gives up when message targets cannot be loaded from the database", async () => {
      const { gm, db, api } = setup();
      gm.activeGameMessages.clear();
      const failure = new Error("db unavailable");
      db.getGameMessages = vi.fn(() => {
        throw failure;
      });
      await gm.updateGameMessageInternal(
        { api } as any,
        GAME,
        "Coinflip",
        1,
        "alice",
        "Active",
        "TOK",
      );
      expect(warnSpy).toHaveBeenCalledWith(
        `Error loading message targets from DB for ${GAME}:`,
        failure,
      );
      expect(gm.formatGameMessage).not.toHaveBeenCalled();
    });

    test("logs and stops when the card cannot be formatted", async () => {
      const { gm, run, api } = setup();
      const failure = new Error("format failed");
      gm.formatGameMessage = vi.fn(async () => {
        throw failure;
      });
      await run();
      expect(errorSpy).toHaveBeenCalledWith("Error in updateGameMessage (preparation):", failure);
      expect(api.editMessageText).not.toHaveBeenCalled();
    });

    test("redraws as completed when the game turned terminal while formatting", async () => {
      const { gm, run, api } = setup();
      gm.getPersistedTerminalUpdate = queue([null, terminal], terminal);
      await run("Active");
      const statuses = gm.formatGameMessage.mock.calls.map((c: unknown[]) => c[5]);
      expect(statuses).toEqual(["Active", "Completed"]);
      expect(api.editMessageText).toHaveBeenCalledTimes(1);
    });

    test("drops the update when a newer one supersedes it after formatting", async () => {
      const { gm, run, api } = setup();
      gm.isSupersededActiveGameMessageUpdate = queue([false, true], false);
      await run("Active", [undefined, undefined, undefined, 1]);
      expect(gm.formatGameMessage).toHaveBeenCalledTimes(1);
      expect(gm.buildGameMessagePayload).not.toHaveBeenCalled();
      expect(api.editMessageText).not.toHaveBeenCalled();
    });
  });

  describe("per-chat edits", () => {
    test("skips every other chat and redraws once when a terminal state shows up mid-way", async () => {
      const { gm, run, api } = setup({
        targets: [
          { chatId: 1, messageId: 10 },
          { chatId: 2, messageId: 20 },
        ],
      });
      // Calls: initial, before dispatch, first chat -> terminal, then redraw as completed.
      gm.getPersistedTerminalUpdate = queue([null, null, terminal], terminal);
      await run("Active");
      expect(gm.formatGameMessage.mock.calls.map((c: unknown[]) => c[5])).toEqual([
        "Active",
        "Completed",
      ]);
      const edited = api.editMessageText.mock.calls.map((c: unknown[]) => c[0]).sort();
      expect(edited).toEqual([1, 2]);
    });

    test("stops editing remaining chats once superseded before building the payload", async () => {
      const { gm, run, api } = setup({
        targets: [
          { chatId: 1, messageId: 10 },
          { chatId: 2, messageId: 20 },
        ],
      });
      gm.isSupersededActiveGameMessageUpdate = queue([false, false, true], false);
      await run("Active", [undefined, undefined, undefined, 1]);
      expect(api.editMessageText).not.toHaveBeenCalled();
      expect(gm.buildGameMessagePayload).not.toHaveBeenCalled();
    });

    test("stops editing when superseded after building the payload", async () => {
      const { gm, run, api } = setup();
      gm.isSupersededActiveGameMessageUpdate = queue([false, false, false, true], false);
      await run("Active", [undefined, undefined, undefined, 1]);
      expect(gm.buildGameMessagePayload).toHaveBeenCalledTimes(1);
      expect(api.editMessageText).not.toHaveBeenCalled();
    });
  });

  describe("text cards", () => {
    test("keeps the stale card when both text and caption edits fail", async () => {
      const { run, api } = setup({
        edits: {
          text: async () => {
            throw telegramError("Bad Request: there is no text in the message to edit");
          },
          caption: async () => {
            throw new Error("caption unavailable");
          },
        },
      });
      await run();
      expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        `Both text and caption edits failed for game ${GAME} chat ${CHAT}:`,
        expect.objectContaining({ message: "caption unavailable" }),
      );
    });

    test("ignores an unchanged text card", async () => {
      const { gm, run, api } = setup({
        edits: {
          text: async () => {
            throw telegramError("Bad Request: message is not modified");
          },
        },
      });
      await run();
      expect(api.editMessageText).toHaveBeenCalledTimes(1);
      expect(api.editMessageCaption).not.toHaveBeenCalled();
      expect(gm.activeGameMessages.get(GAME).get(CHAT).usesVideo).toBe(false);
    });

    test("does not recreate the card twice while a recreation is already running", async () => {
      const { gm, run } = setup({
        edits: {
          text: async () => {
            throw telegramError("Bad Request: message to edit not found");
          },
        },
      });
      gm.messageRecreationLocks.add(`${GAME}:${CHAT}`);
      await run();
      expect(gm.recreateMissingGameMessage).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      gm.messageRecreationLocks.clear();
    });

    test("recreates a deleted card and releases the lock afterwards", async () => {
      const { gm, run } = setup({
        edits: {
          text: async () => {
            throw telegramError("Bad Request: message to edit not found");
          },
        },
      });
      await run();
      expect(gm.recreateMissingGameMessage).toHaveBeenCalledTimes(1);
      expect(gm.messageRecreationLocks.has(`${GAME}:${CHAT}`)).toBe(false);
    });

    test("logs an unexpected edit failure for the chat", async () => {
      const failure = new Error("boom");
      const { run } = setup({
        edits: {
          text: async () => {
            throw failure;
          },
        },
      });
      await run();
      expect(errorSpy).toHaveBeenCalledWith(
        `Error in updateGameMessage for chat ${CHAT}:`,
        failure,
      );
    });
  });

  describe("restored video cards without media", () => {
    test("records that the card still carries media after a caption edit", async () => {
      const { gm, run, api } = setup({ usesVideo: true });
      gm.activeGameMessages.get(GAME).set(CHAT, { messageId: MSG, chatId: CHAT });
      await run();
      expect(api.editMessageCaption).toHaveBeenCalledWith(CHAT, MSG, {
        caption: "PAYLOAD",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Join", callback_data: "join" }]] },
      });
      expect(gm.activeGameMessages.get(GAME).get(CHAT)).toEqual({
        messageId: MSG,
        chatId: CHAT,
        usesVideo: true,
      });
    });

    test("ignores an unchanged caption", async () => {
      const { run, api } = setup({
        usesVideo: true,
        edits: {
          caption: async () => {
            throw telegramError("Bad Request: message is not modified");
          },
        },
      });
      await run();
      expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
      expect(api.editMessageText).not.toHaveBeenCalled();
    });

    test("warns when the caption and text edits both fail for unrelated reasons", async () => {
      const textFailure = new Error("text boom");
      const { run, api } = setup({
        usesVideo: true,
        edits: {
          caption: async () => {
            throw telegramError("Bad Request: wrong file identifier");
          },
          text: async () => {
            throw textFailure;
          },
        },
      });
      await run();
      expect(api.editMessageText).toHaveBeenCalledTimes(1);
      expect(api.editMessageReplyMarkup).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        `Unexpected error in caption edit path for game ${GAME} chat ${CHAT}:`,
        textFailure,
      );
    });
  });

  describe("media cards", () => {
    const media = { fileId: "FAKE_FILE", mediaType: "video" };

    test("ignores an unchanged caption on a media card", async () => {
      const { run, api } = setup({
        usesVideo: true,
        payloadMedia: media,
        edits: {
          caption: async () => {
            throw telegramError("Bad Request: message is not modified");
          },
        },
      });
      await run("Active");
      expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
      expect(api.editMessageText).not.toHaveBeenCalled();
    });

    test("does not recreate a missing media card while one is already being recreated", async () => {
      const { gm, run, api } = setup({
        usesVideo: true,
        payloadMedia: media,
        edits: {
          caption: async () => {
            throw telegramError("Bad Request: message to edit not found");
          },
        },
      });
      gm.messageRecreationLocks.add(`${GAME}:${CHAT}`);
      await run("Active");
      expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
      expect(gm.recreateMissingGameMessage).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Unexpected error in media edit path"),
        expect.anything(),
      );
      gm.messageRecreationLocks.clear();
    });

    test("rethrows a text failure that is not about missing content and warns", async () => {
      const textFailure = new Error("text boom");
      const { run, api } = setup({
        usesVideo: true,
        payloadMedia: media,
        edits: {
          caption: async () => {
            throw telegramError("Bad Request: wrong file identifier");
          },
          text: async () => {
            throw textFailure;
          },
        },
      });
      await run("Active");
      expect(api.editMessageReplyMarkup).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        `Unexpected error in media edit path for game ${GAME} chat ${CHAT}:`,
        textFailure,
      );
    });

    test("treats an unchanged caption as success while converting a media card to text", async () => {
      const { gm, run, api } = setup({
        usesVideo: true,
        payloadMedia: media,
        edits: {
          media: async () => {
            throw telegramError("Bad Request: wrong file identifier");
          },
          text: async () => {
            throw telegramError("Bad Request: there is no text in the message to edit");
          },
          caption: async () => {
            throw telegramError("Bad Request: message is not modified");
          },
        },
      });
      await run("Completed");
      expect(api.editMessageMedia).toHaveBeenCalledTimes(1);
      expect(api.editMessageCaption).toHaveBeenCalledTimes(1);
      expect(api.editMessageReplyMarkup).not.toHaveBeenCalled();
      expect(gm.recreateMissingGameMessage).not.toHaveBeenCalled();
      expect(gm.activeGameMessages.get(GAME).get(CHAT).usesVideo).toBe(true);
    });

    test("warns when the keyboard cannot be restored after a failed replacement", async () => {
      const restoreFailure = new Error("restore refused");
      let markupCalls = 0;
      const { gm, run, api, keyboard } = setup({
        usesVideo: true,
        payloadMedia: media,
        edits: {
          media: async () => {
            throw telegramError("Bad Request: wrong file identifier");
          },
          text: async () => {
            throw telegramError("Bad Request: message is not a text message");
          },
          caption: async () => {
            throw telegramError("Bad Request: wrong file identifier");
          },
          markup: async () => {
            markupCalls += 1;
            if (markupCalls > 1) throw restoreFailure;
            return true;
          },
        },
      });
      gm.recreateMissingGameMessage = vi.fn(async () => false);
      await run("Completed");
      expect(api.editMessageReplyMarkup).toHaveBeenCalledTimes(2);
      expect(api.editMessageReplyMarkup).toHaveBeenLastCalledWith(CHAT, MSG, {
        reply_markup: { inline_keyboard: keyboard },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        `Failed to restore game keyboard ${CHAT}:${MSG}:`,
        restoreFailure,
      );
    });

    test("drops a completion media edit that a newer edit replaced in the queue", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { gm, ctx, api } = setup({
        usesVideo: true,
        payloadMedia: media,
        edits: { media: async () => (await gate, { message_id: MSG }) },
      });
      const call = () =>
        gm.updateGameMessageInternal(ctx, GAME, "Coinflip", 1, "alice", "Completed", "TOK");
      const first = call();
      const second = call();
      const third = call();
      await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      await Promise.all([first, second, third]);
      // The first edit was in flight, the second was replaced, the third ran after the first.
      expect(api.editMessageMedia).toHaveBeenCalledTimes(2);
    });
  });
});

describe("updateGameMessageFromData", () => {
  test("labels a game without a stored type generically", async () => {
    const { gm } = makeManager({
      getGame: vi.fn(() => ({
        status: "active",
        game_type: null,
        amount: 3,
        token_ticker: "TOK",
      })),
    });
    gm.getGameCreatorUsername = vi.fn(async () => "alice");
    gm.updateGameMessage = vi.fn(async () => undefined);
    await gm.updateGameMessageFromData({} as any, GAME);
    expect(gm.updateGameMessage).toHaveBeenCalledTimes(1);
    const args = gm.updateGameMessage.mock.calls[0];
    expect(args.slice(1, 8)).toEqual([GAME, "Game", 3, "alice", "Active", "TOK", undefined]);
  });

  test("logs instead of throwing when the update fails", async () => {
    const failure = new Error("db read failed");
    const { gm } = makeManager({
      getGame: vi.fn(() => {
        throw failure;
      }),
    });
    gm.updateGameMessage = vi.fn(async () => undefined);
    await gm.updateGameMessageFromData({} as any, GAME);
    expect(errorSpy).toHaveBeenCalledWith(`Error updating game message for ${GAME}:`, failure);
    expect(gm.updateGameMessage).not.toHaveBeenCalled();
  });
});

describe("getCompletedGameInfo", () => {
  async function setup(gameOverrides: Record<string, unknown> = {}, dbOverrides = {}) {
    const { gm } = makeManager(dbOverrides);
    gm.getUsernameFromTelegramId = vi.fn(async () => "alice");
    gm.getPlayerUsername = vi.fn(async () => "bob");
    gm.resolveTokenFormattingInfo = vi.fn(async () => ({
      formatBalance: (value: number) => `${value / 1_000_000}`,
    }));
    const gameAddress = GAME;
    const winner = (await Keypair.generate()).publicKey.toBase58();
    const gameData = {
      game_address: gameAddress,
      creator_telegram_id: "1234567890",
      amount: 2_000_000,
      max_players: 2,
      game_type: "coinflip",
      token_ticker: "TOK",
      token_mint: "FakeMint",
      winner_address: winner,
      ...gameOverrides,
    };
    return { gm, gameData, winner };
  }

  test("still renders when the participant count cannot be read", async () => {
    const failure = new Error("count failed");
    const { gm, gameData } = await setup(
      {},
      {
        getGameParticipantsCount: vi.fn(() => {
          throw failure;
        }),
      },
    );
    const text = await gm.getCompletedGameInfo({} as any, gameData);
    expect(errorSpy).toHaveBeenCalledWith(
      "Error retrieving participant count for completed game:",
      failure,
    );
    expect(text).toContain("0/2 players");
  });

  test("falls back to default token formatting when the token cannot be resolved", async () => {
    const failure = new Error("resolve failed");
    const { gm, gameData } = await setup();
    gm.resolveTokenFormattingInfo = vi.fn(async () => {
      throw failure;
    });
    const text = await gm.getCompletedGameInfo({} as any, gameData);
    expect(errorSpy).toHaveBeenCalledWith(
      "Error resolving token formatting for completed game:",
      failure,
    );
    expect(text).toContain("2 TOK");
  });

  test("labels an unknown creator by the start of their Telegram id", async () => {
    const { gm, gameData } = await setup();
    gm.getUsernameFromTelegramId = vi.fn(async () => null);
    const text = await gm.getCompletedGameInfo({} as any, gameData);
    expect(text).toContain("Creator: Player 123456... • ");
  });

  test("links the winner's profile when no username is known for them", async () => {
    const { gm, gameData, winner } = await setup();
    gm.getPlayerUsername = vi.fn(async () => formatPlayerAddress(winner));
    const text = await gm.getCompletedGameInfo({} as any, gameData);
    expect(text).toContain(
      `Winner: <a href="https://timba.cc/players/${winner}">${formatPlayerAddress(winner)}</a>`,
    );
  });

  test("truncates a message that exceeds the Telegram limit", async () => {
    const { gm, gameData } = await setup({ token_ticker: "T".repeat(5000) });
    const text = await gm.getCompletedGameInfo({} as any, gameData);
    expect(text.length).toBe(4096);
    expect(text.endsWith("…")).toBe(true);
  });

  test("reports an error message when the creator lookup fails", async () => {
    const failure = new Error("lookup failed");
    const { gm, gameData } = await setup();
    gm.getUsernameFromTelegramId = vi.fn(async () => {
      throw failure;
    });
    const text = await gm.getCompletedGameInfo({} as any, gameData);
    expect(text).toBe("❌ Error loading game details");
    expect(errorSpy).toHaveBeenCalledWith("Error formatting completed game info:", failure);
  });
});
