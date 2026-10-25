import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PublicKey } from "#solana";
import { ChatDatabase } from "../src/utils/chat-database";
import { GameManager } from "../src/utils/game";
import { formatPlayerAddress } from "../src/utils/game-ui";
import { resetTestDatabase } from "./helpers/database";

const GAME_PDA = new PublicKey("BPFLoader1111111111111111111111111111111111");
const GAME_ADDRESS = GAME_PDA.toBase58();
const CREATOR_KEY = "BPFLoader2111111111111111111111111111111111";
const MEDIA_CHAT_ID = 424_242;
const TELEGRAM_MESSAGE_CHAR_LIMIT = 4096;

const makeManager = (overrides: { wallet?: any; gameDb?: any; program?: any } = {}): any =>
  GameManager.getInstance(
    overrides.program ?? { account: { game: {} } },
    {
      formatSolBalance: (value: number | bigint | string) => `${value}`,
      formatTokenBalance: (value: number | bigint | string, decimals: number) =>
        `${value}@${decimals}`,
      getTokenMetadata: async () => ({ decimals: 6 }),
      getBlockchainTime: async () => 1_700_000_000,
      ...overrides.wallet,
    } as any,
    (overrides.gameDb ?? {}) as any,
  ) as any;

describe("GameManager coverage-a: username normalisation and priming", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("rejects values that cannot be a username", () => {
    const gm = makeManager();
    expect(gm.normalizeUsernameForLookup(undefined)).toBeNull();
    expect(gm.normalizeUsernameForLookup(42)).toBeNull();
    expect(gm.normalizeUsernameForLookup("   ")).toBeNull();
    expect(gm.normalizeUsernameForLookup("@")).toBeNull();
    expect(gm.normalizeUsernameForLookup(" @Alice ")).toBe("alice");
  });

  test("only caches ids that are numeric and usernames that normalise to something", () => {
    const gm = makeManager();

    gm.cacheTelegramIdForUsername("12x", "alice");
    gm.cacheTelegramIdForUsername("12", "@");
    expect(gm.normalizedUsernameToIdCache.get("alice")).toBeUndefined();

    gm.cacheTelegramIdForUsername(" 12 ", "@Alice");
    expect(gm.normalizedUsernameToIdCache.get("alice")).toBe("12");
  });

  test("remembering a username ignores invalid ids, blank names and handles with no name", () => {
    const saved: unknown[][] = [];
    const gm = makeManager({
      gameDb: { saveUsernameMapping: (...args: unknown[]) => saved.push(args) },
    });

    gm.rememberTelegramUsername("not-a-number", "alice", true);
    gm.rememberTelegramUsername("12", "   ", true);
    gm.rememberTelegramUsername("12", "@", true);

    expect(saved).toEqual([]);
    expect(gm.usernameHints.size).toBe(0);

    gm.rememberTelegramUsername("12", "Alice Display");
    expect(gm.usernameHints.get("12")).toBe("Alice Display");
    expect(saved).toEqual([]);

    gm.rememberTelegramUsername("12", "@alice", true);
    expect(saved).toEqual([["alice", "12", "@alice"]]);
  });

  test("priming ignores empty usernames and invalid ids but caches a valid one", () => {
    const gm = makeManager({ gameDb: { saveUsernameMapping: () => {} } });
    const ctx = { chat: { id: 5 } } as any;

    gm.primeUsernameCache(ctx, "12", null);
    gm.primeUsernameCache(ctx, "12", "");
    gm.primeUsernameCache(ctx, "abc", "alice");
    gm.primeUsernameCache(ctx, "12", "   ");
    expect(gm.usernameCache.get(gm.buildUsernameCacheKey(ctx, "12"))).toBeUndefined();
    expect(gm.usernameHints.size).toBe(0);

    gm.primeUsernameCache(ctx, "12", " alice ");
    expect(gm.usernameCache.get(gm.buildUsernameCacheKey(ctx, "12"))).toBe("alice");
  });
});

describe("GameManager coverage-a: getUsernameFromTelegramId without a network lookup", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    GameManager.resetForTest();
  });

  test("returns null and warns when the chat cannot be determined", async () => {
    const gm = makeManager();

    expect(await gm.getUsernameFromTelegramId({} as any, "12")).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect((warnSpy.mock.calls[0] as unknown[])[1]).toEqual(
      new Error("Chat context is required to resolve usernames"),
    );
  });

  test("serves the stored display name and caches it when network lookups are disabled", async () => {
    let apiCalls = 0;
    const gm = makeManager({
      gameDb: {
        getPlayerDisplayName: () => "Stored Alice",
        saveUsernameMapping: () => {},
      },
    });
    const ctx = {
      chat: { id: 5 },
      api: {
        getChatMember: async () => {
          apiCalls += 1;
          return { user: { username: "live" } };
        },
      },
    } as any;

    const first = await gm.getUsernameFromTelegramId(ctx, "12", { allowNetworkLookup: false });
    const second = await gm.getUsernameFromTelegramId(ctx, "12", { allowNetworkLookup: false });

    expect(first).toBe("Stored Alice");
    expect(second).toBe("Stored Alice");
    expect(apiCalls).toBe(0);
    expect(gm.usernameHints.get("12")).toBe("Stored Alice");
  });

  test("returns null when nothing is known and network lookups are disabled", async () => {
    const gm = makeManager({ gameDb: { getPlayerDisplayName: () => null } });
    const ctx = { chat: { id: 5 } } as any;

    expect(await gm.getUsernameFromTelegramId(ctx, "12", { allowNetworkLookup: false })).toBeNull();
  });
});

describe("GameManager coverage-a: creator and player display names", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  const ctx = { chat: { id: 5 } } as any;

  test("the creator is Unknown when the game has no creator record", async () => {
    const gm = makeManager({ gameDb: { getCreatorInfo: () => null } });
    expect(await gm.getGameCreatorUsername(ctx, GAME_ADDRESS)).toBe("Unknown");
  });

  test("the creator is Unknown when there is neither a usable id nor a wallet", async () => {
    const gm = makeManager({
      gameDb: { getCreatorInfo: () => ({ telegramId: "not-numeric", publicKey: null }) },
    });
    expect(await gm.getGameCreatorUsername(ctx, GAME_ADDRESS)).toBe("Unknown");
  });

  test("the creator falls back to the shortened wallet when the id has no username", async () => {
    const gm = makeManager({
      gameDb: { getCreatorInfo: () => ({ telegramId: null, publicKey: CREATOR_KEY }) },
    });
    expect(await gm.getGameCreatorUsername(ctx, GAME_ADDRESS)).toBe(
      formatPlayerAddress(CREATOR_KEY),
    );
  });

  test("a player with a Telegram id but no username shows as a shortened wallet", async () => {
    const gm = makeManager({ gameDb: { getPlayerTelegramId: () => "12" } });
    gm.getUsernameFromTelegramId = async () => null;

    expect(await gm.getPlayerUsername(ctx, CREATOR_KEY)).toBe(formatPlayerAddress(CREATOR_KEY));
  });
});

describe("GameManager coverage-a: token mint lookup", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("reports a missing mint account", async () => {
    const gm = makeManager();
    gm.cachedConnection = { getAccountInfo: async () => null };

    await expect(gm.resolveTokenProgramId(GAME_PDA)).rejects.toThrow(
      `Token mint ${GAME_ADDRESS} not found`,
    );
  });
});

describe("GameManager coverage-a: recreateMissingGameMessage", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    ChatDatabase.resetForTesting();
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    GameManager.resetForTest();
    ChatDatabase.resetForTesting();
    resetTestDatabase("chat-settings.sqlite");
  });

  const makeApi = () => {
    const calls: Array<{ method: string; chatId: number; media?: string; extra: any }> = [];
    const send =
      (method: string) =>
      async (chatId: number, ...rest: any[]) => {
        const hasMedia = typeof rest[0] === "string";
        calls.push({
          method,
          chatId,
          media: hasMedia ? rest[0] : undefined,
          extra: hasMedia ? rest[1] : (rest[1] ?? rest[0]),
        });
        return { message_id: 900 + calls.length, chat: { id: chatId } };
      };
    return {
      calls,
      api: {
        sendMessage: async (chatId: number, text: string, extra: any) => {
          calls.push({ method: "sendMessage", chatId, extra: { ...extra, text } });
          return { message_id: 900 + calls.length, chat: { id: chatId } };
        },
        sendVideo: send("sendVideo"),
        sendPhoto: send("sendPhoto"),
        sendAnimation: send("sendAnimation"),
      },
    };
  };

  test("gives up without sending anything when no chat id can be found", async () => {
    const gm = makeManager({ gameDb: { getGame: () => undefined } });
    const { api, calls } = makeApi();

    const recreated = await gm.recreateMissingGameMessage({ api } as any, GAME_ADDRESS, {
      messageText: "hello",
    });

    expect(recreated).toBe(false);
    expect(calls).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      `Unable to recreate Telegram message for ${GAME_ADDRESS}: missing chat id`,
    );
  });

  for (const mediaType of ["photo", "animation"] as const) {
    test(`resends a ${mediaType} card with the chat's custom media and tracks it`, async () => {
      ChatDatabase.getInstance().upsertChatGameSettings(MEDIA_CHAT_ID, {
        coinflip_video_id: `custom_${mediaType}_id`,
        coinflip_media_type: mediaType,
        set_by_telegram_id: "admin",
      });
      const saved: unknown[][] = [];
      const gm = makeManager({
        gameDb: { saveGameMessage: (...args: unknown[]) => saved.push(args) },
      });
      const ready: string[] = [];
      gm.gameMessageReadyListener = (address: string) => ready.push(address);
      const { api, calls } = makeApi();
      const keyboard = { inline_keyboard: [[{ text: "Join", callback_data: "join" }]] };

      const recreated = await gm.recreateMissingGameMessage(
        { api, callbackQuery: { message: { message_id: 77 } } } as any,
        GAME_ADDRESS,
        {
          chatId: MEDIA_CHAT_ID,
          messageText: "<b>card</b>",
          inlineKeyboard: keyboard,
          gameType: "coinflip",
        },
      );

      expect(recreated).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: mediaType === "photo" ? "sendPhoto" : "sendAnimation",
        chatId: MEDIA_CHAT_ID,
        media: `custom_${mediaType}_id`,
        extra: {
          caption: "<b>card</b>",
          parse_mode: "HTML",
          reply_markup: keyboard,
          reply_to_message_id: 77,
        },
      });
      expect(saved).toEqual([[GAME_ADDRESS, 901, MEDIA_CHAT_ID]]);
      expect(gm.getActiveGameMessages(GAME_ADDRESS)?.get(MEDIA_CHAT_ID)).toEqual({
        messageId: 901,
        chatId: MEDIA_CHAT_ID,
        usesVideo: true,
      });
      expect(ready).toEqual([GAME_ADDRESS]);
    });
  }
});

describe("GameManager coverage-a: formatAndSendGameMessage", () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    resetTestDatabase("chat-settings.sqlite");
    ChatDatabase.resetForTesting();
    GameManager.resetForTest();
    warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
    GameManager.resetForTest();
    ChatDatabase.resetForTesting();
    resetTestDatabase("chat-settings.sqlite");
  });

  const send = (gm: any, ctx: any, gameType = "unknown") =>
    gm.formatAndSendGameMessage(ctx, GAME_PDA, gameType, 1000, "alice", "Active", "TOK");

  const makeCtx = (overrides: Record<string, unknown> = {}) => {
    const replies: Array<{ method: string; args: unknown[] }> = [];
    const record =
      (method: string) =>
      async (...args: unknown[]) => {
        replies.push({ method, args });
        return { message_id: 31, chat: { id: MEDIA_CHAT_ID } };
      };
    return {
      replies,
      ctx: {
        chat: { id: MEDIA_CHAT_ID },
        reply: record("reply"),
        replyWithPhoto: record("replyWithPhoto"),
        replyWithAnimation: record("replyWithAnimation"),
        replyWithVideo: record("replyWithVideo"),
        ...overrides,
      } as any,
    };
  };

  test("an unavailable game without text or keyboard gets the placeholder text and a refresh button", async () => {
    const saved: unknown[][] = [];
    const recoveries: string[] = [];
    const gm = makeManager({
      gameDb: { saveGameMessage: (...args: unknown[]) => saved.push(args) },
    });
    gm.formatGameMessage = async () => ({
      messageText: "   ",
      keyboard: [],
      stateUnavailable: true,
    });
    gm.scheduleUnavailableStateRecovery = (_ctx: unknown, address: string) => {
      recoveries.push(address);
    };
    const { ctx, replies } = makeCtx();

    const message = await send(gm, ctx);

    expect(message.message_id).toBe(31);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.method).toBe("reply");
    const [text, extra] = replies[0]?.args as [string, any];
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe("   ");
    expect(extra.reply_markup).toEqual({
      inline_keyboard: [[{ text: "🔁 Refresh", callback_data: `refresh_${GAME_ADDRESS}` }]],
    });
    expect(saved).toEqual([[GAME_ADDRESS, 31, MEDIA_CHAT_ID]]);
    expect(gm.getActiveGameMessages(GAME_ADDRESS)?.get(MEDIA_CHAT_ID)?.usesVideo).toBe(false);
    expect(recoveries).toEqual([GAME_ADDRESS]);
  });

  for (const [mediaType, method] of [
    ["photo", "replyWithPhoto"],
    ["animation", "replyWithAnimation"],
  ] as const) {
    test(`sends the ${mediaType} configured for the chat with the card as caption`, async () => {
      ChatDatabase.getInstance().upsertChatGameSettings(MEDIA_CHAT_ID, {
        coinflip_video_id: `custom_${mediaType}_id`,
        coinflip_media_type: mediaType,
        set_by_telegram_id: "admin",
      });
      const gm = makeManager({ gameDb: { saveGameMessage: () => {} } });
      gm.formatGameMessage = async () => ({ messageText: "card", keyboard: [] });
      const { ctx, replies } = makeCtx();

      await send(gm, ctx, "coinflip");

      expect(replies).toHaveLength(1);
      expect(replies[0]?.method).toBe(method);
      expect(replies[0]?.args[0]).toBe(`custom_${mediaType}_id`);
      expect(replies[0]?.args[1]).toMatchObject({ caption: "card", parse_mode: "HTML" });
      expect(gm.getActiveGameMessages(GAME_ADDRESS)?.get(MEDIA_CHAT_ID)?.usesVideo).toBe(true);
    });
  }

  test("rethrows media errors that text cannot fix and stores nothing", async () => {
    ChatDatabase.getInstance().upsertChatGameSettings(MEDIA_CHAT_ID, {
      coinflip_video_id: "custom_photo_id",
      coinflip_media_type: "photo",
      set_by_telegram_id: "admin",
    });
    const saved: unknown[][] = [];
    const gm = makeManager({
      gameDb: { saveGameMessage: (...args: unknown[]) => saved.push(args) },
    });
    gm.formatGameMessage = async () => ({ messageText: "card", keyboard: [] });
    const { ctx, replies } = makeCtx({
      replyWithPhoto: async () => {
        throw new Error("Forbidden: bot was blocked by the user");
      },
    });

    await expect(send(gm, ctx, "coinflip")).rejects.toThrow("bot was blocked by the user");
    expect(replies).toEqual([]);
    expect(saved).toEqual([]);
  });
});

describe("GameManager coverage-a: game message payloads", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  const params = {
    gameAddress: GAME_ADDRESS,
    gameType: "unknown",
    amount: 1000,
    creatorUsername: "alice",
    status: "Active",
    tokenTicker: "TOK",
  };

  test("substitutes placeholder text when the formatted card is blank", async () => {
    const gm = makeManager();

    const payload = await gm.buildGameMessagePayload({} as any, params, {
      messageText: " ",
      keyboard: [],
    });

    expect(payload.text.trim().length).toBeGreaterThan(0);
    expect(payload.text).not.toBe(" ");
    expect(payload.keyboard).toEqual([]);
  });

  test("offers a refresh button when the state is unavailable", async () => {
    const gm = makeManager();

    const payload = await gm.buildGameMessagePayload({} as any, params, {
      messageText: "card",
      keyboard: [],
      skipUpdate: true,
    });

    expect(payload.text).toBe("card");
    expect(payload.keyboard).toEqual([
      [{ text: "🔁 Refresh", callback_data: `refresh_${GAME_ADDRESS}` }],
    ]);
    expect(payload.skipUpdate).toBe(true);
  });
});

describe("GameManager coverage-a: getPrizeDisplay", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("labels a stored native SOL game as SOL when no ticker is known", async () => {
    const gm = makeManager({
      gameDb: { getGame: () => ({ token_ticker: null, token_mint: "SOL" }) },
      wallet: { formatSolBalance: (value: number) => `sol:${value}` },
    });

    const display = await gm.getPrizeDisplay(GAME_ADDRESS, 2_000_000_000);

    expect(display).toEqual({
      formattedAmount: "sol:2000000000",
      tokenTicker: "SOL",
      usdApproximation: null,
    });
  });
});

describe("GameManager coverage-a: createGameMessage delivery reservation", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  const create = (gm: any, ctx: any) =>
    gm.createGameMessage(ctx, GAME_ADDRESS, "unknown", 1000, "alice", "TOK", "Active", undefined, {
      reserveDelivery: true,
    });

  test("returns the existing message id when another worker already holds the delivery", async () => {
    const replies: unknown[] = [];
    const gm = makeManager({
      gameDb: { reserveGameMessageDelivery: () => ({ acquired: false, messageId: 55 }) },
    });
    const ctx = { chat: { id: 7 }, reply: async (...args: unknown[]) => replies.push(args) } as any;

    expect(await create(gm, ctx)).toBe(55);
    expect(replies).toEqual([]);
  });

  test("returns 0 when the delivery is held but no message id exists yet", async () => {
    const gm = makeManager({
      gameDb: { reserveGameMessageDelivery: () => ({ acquired: false }) },
    });

    expect(await create(gm, { chat: { id: 7 } } as any)).toBe(0);
  });

  test("completes the reserved delivery with the sent message id", async () => {
    const completed: unknown[][] = [];
    const saved: unknown[][] = [];
    const gm = makeManager({
      gameDb: {
        reserveGameMessageDelivery: () => ({ acquired: true }),
        completeGameMessageDelivery: (...args: unknown[]) => completed.push(args),
        saveGameMessage: (...args: unknown[]) => saved.push(args),
      },
    });
    gm.buildGameMessagePayload = async () => ({ text: "card", keyboard: [], media: undefined });
    const ctx = {
      chat: { id: 7 },
      reply: async () => ({ message_id: 66, chat: { id: 7 } }),
    } as any;

    expect(await create(gm, ctx)).toBe(66);
    expect(completed).toEqual([[GAME_ADDRESS, 7, 66]]);
    expect(saved).toEqual([]);
  });
});

describe("GameManager coverage-a: formatGameMessage details", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  const account = {
    ticketsCount: 0,
    maxTickets: 2,
    minTickets: 2,
    createdAt: 1_700_000_000,
    timeout: 600,
    gameType: { coinflip: {} },
  };

  const format = (gm: any, creator: string, options: Record<string, unknown> = {}) =>
    gm.formatGameMessage(
      { chat: { id: 5 } } as any,
      GAME_PDA,
      "coinflip",
      1_000_000n,
      creator,
      "Active",
      "TOK",
      undefined,
      undefined,
      undefined,
      { gameAccount: account, ...options },
    );

  test("links the creator's wallet when the creator is shown as a shortened address", async () => {
    const gm = makeManager({
      gameDb: {
        getGame: () => ({}),
        getCreatorInfo: () => ({ publicKey: CREATOR_KEY }),
      },
    });

    const withWallet = await format(gm, formatPlayerAddress(CREATOR_KEY));
    const withName = await format(gm, "alice");

    expect(withWallet.messageText).toContain(`https://timba.cc/players/${CREATOR_KEY}`);
    expect(withName.messageText).not.toContain("https://timba.cc/players/");
    expect(withName.messageText).toContain("alice");
  });

  test("derives the prize USD value from the entry price when one is available", async () => {
    const gm = makeManager({
      gameDb: { getGame: () => ({ token_mint: "MintX" }), getGameParticipants: () => [] },
    });
    gm.getUsdApproximation = async () => ({ text: "$1.00", price: 3 });
    const seenPots: unknown[] = [];
    const realFormatUsd = gm.formatUsdValue.bind(gm);
    gm.formatUsdValue = (value: unknown, decimals: number, price: number) => {
      seenPots.push(value);
      return realFormatUsd(value, decimals, price);
    };

    const result = await gm.formatGameMessage(
      { chat: { id: 5 } } as any,
      GAME_PDA,
      "coinflip",
      1_000_000n,
      "alice",
      "Active",
      "TOK",
      undefined,
      4_000_000n,
      undefined,
      { gameAccount: { ...account, ticketsCount: 2 } },
    );

    expect(seenPots).toEqual([4_000_000n]);
    expect(result.messageText).toContain("($1.00)");
    expect(result.messageText).toContain("($12)");
  });

  test("truncates a card that is still too long once participants are dropped", async () => {
    const gm = makeManager({ gameDb: { getGame: () => ({}) } });

    const result = await format(gm, "x".repeat(TELEGRAM_MESSAGE_CHAR_LIMIT + 500), {
      suppressMentions: true,
    });

    expect(result.messageText.length).toBe(TELEGRAM_MESSAGE_CHAR_LIMIT);
    expect(result.messageText.endsWith("…")).toBe(true);
  });

  test("shows suppressed-mention winner names for a completed game", async () => {
    const gm = makeManager({ gameDb: { getGame: () => ({}) } });
    gm.getPlayerUsername = async () => "@Winner";

    const withMentions = await gm.getWinnerInfo(
      {} as any,
      "Completed",
      CREATOR_KEY,
      undefined,
      false,
    );
    const suppressed = await gm.getWinnerInfo({} as any, "Completed", CREATOR_KEY, undefined, true);

    expect(withMentions).toContain("Winner:");
    expect(suppressed).toContain("Winner:");
    expect(suppressed).toContain("Winner");
  });
});

describe("GameManager coverage-a: stored completed game totals", () => {
  beforeEach(() => {
    GameManager.resetForTest();
  });
  afterEach(() => {
    GameManager.resetForTest();
  });

  test("prefers a stored legacy total over deriving the pot from the entry fee", async () => {
    const gm = makeManager({
      gameDb: {
        getGame: () => ({ total_amount: 5_000, max_players: 2, game_type: "coinflip" }),
        getGameParticipants: () => ["1", "2"],
      },
    });

    const stats = await gm.getCompletedGameStats(GAME_PDA, 1_000n);

    expect(stats.totalPot).toBe(5_000n);
    expect(stats.currentTickets).toBe(2);
    expect(stats.maxTickets).toBe(2);
  });
});
